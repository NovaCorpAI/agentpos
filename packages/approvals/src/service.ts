/**
 * Approval queue (M2).
 *
 * Two rules give this module its shape:
 *  - Silence never approves. A request that reaches its TTL is rejected and the quote released.
 *  - The merchant approves a snapshot, not a cart id. If the quote drifts after approval, the
 *    approval no longer applies and the agent must re-quote. Nobody is charged in between.
 */
import { randomBytes } from "node:crypto";
import { AgentGateError } from "@agentgate/core";
import type { Logger } from "@agentgate/core";
import { silentLogger } from "@agentgate/core";
import { hashSnapshot } from "./snapshot.js";
import type {
  ApprovalLinks,
  ApprovalRequest,
  ApprovalSnapshot,
  ApprovalStatus,
  ApprovalStore,
  NotificationChannel,
} from "./types.js";

export const DEFAULT_TTL_MINUTES = 30;

export interface ApprovalServiceOptions {
  store: ApprovalStore;
  /** Minutes the merchant has to decide before the request auto-rejects. */
  ttlMinutes?: number;
  channels?: NotificationChannel[];
  /** Builds the URLs included in notifications. */
  links?: (request: ApprovalRequest) => ApprovalLinks;
  /**
   * Called on every state change, including the automatic expiry. The audit chain (M4) subscribes
   * here so that "nobody answered" is recorded as firmly as "the merchant said yes".
   * Never throws into the queue: an observer that fails is logged and ignored.
   */
  onEvent?: (event: ApprovalEvent, request: ApprovalRequest) => void;
  logger?: Logger;
}

export type ApprovalEvent = "requested" | "resolved" | "expired";

export type GateResult =
  | { status: "approved"; request: ApprovalRequest }
  | { status: "pending"; request: ApprovalRequest };

export class ApprovalService {
  private readonly ttlMinutes: number;
  private readonly channels: NotificationChannel[];
  private readonly logger: Logger;

  constructor(private readonly opts: ApprovalServiceOptions) {
    this.ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    this.channels = opts.channels ?? [];
    this.logger = opts.logger ?? silentLogger;
  }

  get store(): ApprovalStore {
    return this.opts.store;
  }

  /**
   * Decides whether a cart may proceed to payment. Creates the request and notifies the merchant
   * the first time; afterwards it reports the standing decision. Never charges anyone.
   */
  async gate(snapshot: ApprovalSnapshot, now: Date = new Date()): Promise<GateResult> {
    const hash = hashSnapshot(snapshot);
    const existing = this.expireIfDue(this.opts.store.getByCart(snapshot.cartId), now);

    if (existing) {
      if (existing.snapshotHash !== hash) {
        // The cart changed under an existing approval: void it rather than honour a stale one.
        throw new AgentGateError(
          "APPROVAL_SNAPSHOT_CHANGED",
          "The order changed after it was sent for approval",
          {
            hint: "Create a new cart; the previous approval no longer applies and nothing was charged.",
            details: {
              approvalId: existing.id,
              approvedHash: existing.snapshotHash,
              currentHash: hash,
            },
          },
        );
      }
      switch (existing.status) {
        case "approved":
          return { status: "approved", request: existing };
        case "pending":
          return { status: "pending", request: existing };
        case "rejected":
          throw new AgentGateError(
            "APPROVAL_REJECTED",
            existing.reason ?? "The merchant rejected this order",
            {
              hint: "Nothing was charged. Do not retry this cart.",
              details: { approvalId: existing.id },
            },
          );
        case "expired":
          throw new AgentGateError(
            "APPROVAL_EXPIRED",
            "The approval request expired without a decision",
            {
              hint: "Nothing was charged. Create a new cart to ask again.",
              details: { approvalId: existing.id, expiredAt: existing.expiresAt },
            },
          );
      }
    }

    const request: ApprovalRequest = {
      id: `apr_${randomBytes(9).toString("base64url")}`,
      cartId: snapshot.cartId,
      snapshotHash: hash,
      snapshot,
      status: "pending",
      notified: [],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMinutes * 60_000).toISOString(),
    };
    this.opts.store.save(request);
    this.emit("requested", request);
    this.logger.info("approval.requested", {
      approvalId: request.id,
      cartId: request.cartId,
      total: snapshot.totalMinor,
      expiresAt: request.expiresAt,
    });
    await this.notify(request);
    return { status: "pending", request: this.opts.store.get(request.id) ?? request };
  }

  /** Best effort: a channel failure must not block the queue. */
  private async notify(request: ApprovalRequest): Promise<void> {
    if (this.channels.length === 0) return;
    const links = this.opts.links?.(request) ?? { poll: "", resolve: "" };
    const delivered: string[] = [];
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.notify(request, links);
          delivered.push(channel.name);
        } catch (err) {
          this.logger.warn("approval.notify_failed", {
            approvalId: request.id,
            channel: channel.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    if (delivered.length > 0) this.opts.store.save({ ...request, notified: delivered });
    this.logger.info("approval.notified", { approvalId: request.id, channels: delivered });
  }

  /**
   * Applies the merchant's decision. Idempotent: resolving twice returns the first outcome
   * instead of flipping it, so a retried webhook can never turn a rejection into an approval.
   */
  resolve(
    id: string,
    decision: "approve" | "reject",
    reason?: string,
    now: Date = new Date(),
  ): ApprovalRequest {
    const found = this.opts.store.get(id);
    if (!found) {
      throw new AgentGateError("APPROVAL_NOT_FOUND", `Unknown approval '${id}'`, {
        hint: "Check the id from the notification or `agentgate approvals list`.",
      });
    }
    const request = this.expireIfDue(found, now) as ApprovalRequest;
    if (request.status !== "pending") {
      this.logger.info("approval.resolve_ignored", {
        approvalId: id,
        status: request.status,
        attempted: decision,
      });
      return request; // idempotent, and a decided request is never re-decided
    }
    const resolved: ApprovalRequest = {
      ...request,
      status: decision === "approve" ? "approved" : "rejected",
      ...(reason !== undefined ? { reason } : {}),
      resolvedAt: now.toISOString(),
    };
    this.opts.store.save(resolved);
    this.emit("resolved", resolved);
    this.logger.info("approval.resolved", {
      approvalId: id,
      status: resolved.status,
      cartId: resolved.cartId,
    });
    return resolved;
  }

  get(id: string): ApprovalRequest {
    const found = this.opts.store.get(id);
    if (!found) {
      throw new AgentGateError("APPROVAL_NOT_FOUND", `Unknown approval '${id}'`, {
        hint: "The id comes from the checkout response or the merchant notification.",
      });
    }
    return this.expireIfDue(found, new Date()) as ApprovalRequest;
  }

  list(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
    const now = new Date();
    return this.opts.store.list(options).map((r) => this.expireIfDue(r, now) as ApprovalRequest);
  }

  /** Sweeps the queue; call periodically so expiries are recorded even without traffic. */
  expirePending(now: Date = new Date()): ApprovalRequest[] {
    return this.opts.store
      .list({ status: "pending" })
      .map((r) => this.expireIfDue(r, now) as ApprovalRequest)
      .filter((r) => r.status === "expired");
  }

  /** Silence is never consent: a pending request past its TTL becomes expired, and is persisted. */
  private expireIfDue(
    request: ApprovalRequest | undefined,
    now: Date,
  ): ApprovalRequest | undefined {
    if (!request || request.status !== "pending") return request;
    if (new Date(request.expiresAt).getTime() > now.getTime()) return request;
    const expired: ApprovalRequest = {
      ...request,
      status: "expired",
      reason: "No decision before the deadline; rejected automatically.",
      resolvedAt: now.toISOString(),
    };
    this.opts.store.save(expired);
    this.emit("expired", expired);
    this.logger.info("approval.expired", { approvalId: request.id, cartId: request.cartId });
    return expired;
  }

  private emit(event: ApprovalEvent, request: ApprovalRequest): void {
    try {
      this.opts.onEvent?.(event, request);
    } catch (err) {
      this.logger.error("approval.observer_failed", {
        event,
        approvalId: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** In-memory store for tests and for sites that do not persist approvals. */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly byId = new Map<string, ApprovalRequest>();

  save(request: ApprovalRequest): void {
    this.byId.set(request.id, request);
  }
  get(id: string): ApprovalRequest | undefined {
    return this.byId.get(id);
  }
  getByCart(cartId: string): ApprovalRequest | undefined {
    return [...this.byId.values()]
      .filter((r) => r.cartId === cartId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }
  list(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
    return [...this.byId.values()]
      .filter((r) => !options.status || r.status === options.status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, options.limit ?? 100);
  }
}
