/**
 * The signing bridge, buyer side: `agentpos-buyer watch <buyer-web-url>` polls a buyer-web
 * instance for proposals the human already approved, pays each one with the LOCAL wallet
 * through the existing BuyerService (createCart + buy, the exact machinery a direct purchase
 * uses, so the profile mandate applies unchanged), and reports the outcome back.
 *
 * Custody rule (CONTRIBUTING.md): the wallet key never leaves this machine. buyer-web only ever
 * learns the transaction hash. The bearer token authorizes this daemon against the buyer's
 * OWN buyer-web instance and nothing else; it is read from AGENTPOS_SIGNER_TOKEN (never a
 * CLI flag: flags leak into process lists).
 *
 * Failure discipline: a proposal that cannot be paid (mandate refusal, price drift, store
 * error) is reported back with a machine-readable code so the web/WhatsApp user sees WHY,
 * and is not retried by this process (attempted ids are kept in memory; a watch restart may
 * retry once). A malformed queue item is skipped and reported, never a crash.
 */
import { z } from "zod";
import { AgentPOSError, isAgentPOSError } from "@agentpos/core";
import type { BuyerService } from "./buyer.js";

/** What the watcher requires of a queue entry before it will try to pay it. */
const queueItemSchema = z.object({
  proposalId: z.string().min(1),
  storeUrl: z.url(),
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
  /** Quoted total the human approved, in USDC minor units. The watcher refuses to pay more. */
  amountMinor: z.string().regex(/^\d+$/).optional(),
  amount: z.string().optional(),
  title: z.string().optional(),
});

export type SignerQueueItem = z.output<typeof queueItemSchema>;

export interface WatchOutcome {
  proposalId: string;
  status: "paid" | "failed" | "skipped";
  txHash?: string;
  orderId?: string;
  code?: string;
}

export interface SignerWatcherDeps {
  /** buyer-web origin, e.g. https://buyer.example (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token for /api/signer/*. The CLI reads it from AGENTPOS_SIGNER_TOKEN. */
  token: string;
  /** Pays with the profile's local wallet; the mandate inside it applies unchanged. */
  buyerService: BuyerService;
  /** Used ONLY to talk to buyer-web; the BuyerService talks to stores on its own. */
  fetchImpl?: typeof globalThis.fetch;
  /** One human-readable line per proposal outcome. Never receives secrets. */
  onLine?: (line: string) => void;
}

export class SignerWatcher {
  private readonly base: string;
  private readonly token: string;
  private readonly buyer: BuyerService;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly line: (line: string) => void;
  /** Proposal ids this process already tried, pass or fail: never retried in a loop. */
  private readonly attempted = new Set<string>();

  constructor(deps: SignerWatcherDeps) {
    this.base = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.buyer = deps.buyerService;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.line = deps.onLine ?? (() => {});
  }

  /**
   * One poll cycle: fetch the queue, try every proposal not yet attempted, report each
   * outcome back. Throws only when the queue itself is unusable (unreachable or the token
   * is rejected); a bad queue ITEM is reported and skipped, never thrown.
   */
  async runOnce(): Promise<WatchOutcome[]> {
    const queue = await this.fetchQueue();
    const outcomes: WatchOutcome[] = [];
    for (const raw of queue) {
      const outcome = await this.processItem(raw);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  private async processItem(raw: unknown): Promise<WatchOutcome | undefined> {
    const proposalId = this.extractProposalId(raw);
    const parsed = queueItemSchema.safeParse(raw);
    if (!parsed.success) {
      if (proposalId === undefined) {
        // Nothing to report against; say so once per cycle and move on.
        this.line("skipped a queue item with no proposalId");
        return { proposalId: "", status: "skipped", code: "CONFIG_INVALID" };
      }
      if (this.attempted.has(proposalId)) return undefined;
      this.attempted.add(proposalId);
      const message = `Malformed queue item: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`.slice(0, 500);
      await this.reportFailed(proposalId, "CONFIG_INVALID", message);
      this.line(`failed ${proposalId} CONFIG_INVALID (malformed queue item)`);
      return { proposalId, status: "failed", code: "CONFIG_INVALID" };
    }
    const item = parsed.data;
    if (this.attempted.has(item.proposalId)) return undefined;
    this.attempted.add(item.proposalId);
    try {
      const result = await this.pay(item);
      await this.reportPaid(item.proposalId, result.txHash, result.orderId);
      this.line(`paid ${item.proposalId} tx ${result.txHash}`);
      return {
        proposalId: item.proposalId,
        status: "paid",
        txHash: result.txHash,
        orderId: result.orderId,
      };
    } catch (err) {
      const code = isAgentPOSError(err) ? err.code : "INTERNAL";
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.reportFailed(item.proposalId, code, message);
      this.line(`failed ${item.proposalId} ${code}: ${message}`);
      return { proposalId: item.proposalId, status: "failed", code };
    }
  }

  /**
   * The purchase itself, with the EXISTING machinery: quote a fresh cart (the approved
   * cart's quote may have expired) and pay it through BuyerService.buy(), where the profile
   * mandate (maxPerTx, allowedSellers, period ceiling...) is enforced exactly as for a
   * direct purchase. One extra guard on top: the human approved a specific total, so a
   * store that now quotes MORE gets REQUOTE_REQUIRED instead of money.
   */
  private async pay(item: SignerQueueItem): Promise<{ txHash: string; orderId: string }> {
    const cart = await this.buyer.createCart(item.storeUrl, [
      { itemId: item.itemId, quantity: item.quantity },
    ]);
    if (item.amountMinor !== undefined && BigInt(cart.quote.totalMinor) > BigInt(item.amountMinor)) {
      throw new AgentPOSError("REQUOTE_REQUIRED", "The store now quotes more than was approved", {
        hint: "Prices changed since the human approved. Propose the purchase again at the new price.",
        details: { approvedMinor: item.amountMinor, quotedMinor: cart.quote.totalMinor },
      });
    }
    const result = await this.buyer.buy(item.storeUrl, cart.cartId);
    return { txHash: result.receipt.txHash, orderId: result.orderId };
  }

  private extractProposalId(raw: unknown): string | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const id = (raw as { proposalId?: unknown }).proposalId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  // --- talking to buyer-web --------------------------------------------------

  private async fetchQueue(): Promise<unknown[]> {
    const res = await this.request("GET", "/api/signer/queue");
    const body = (await res.json().catch(() => ({}))) as { proposals?: unknown[] };
    return Array.isArray(body.proposals) ? body.proposals : [];
  }

  /**
   * The paid report matters most: buyer-web must learn the txHash or the human keeps seeing
   * "awaiting signature" for money that moved. Retry a few times before giving up loudly.
   */
  private async reportPaid(proposalId: string, txHash: string, orderId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.request("POST", "/api/signer/paid", { proposalId, txHash, orderId });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    this.line(
      `WARNING: paid ${proposalId} (tx ${txHash}) but could not report it to ${this.base}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }. Mark it paid there before restarting the watcher, or it may pay again.`,
    );
  }

  private async reportFailed(proposalId: string, code: string, message: string): Promise<void> {
    try {
      await this.request("POST", "/api/signer/failed", { proposalId, code, message });
    } catch (err) {
      this.line(
        `could not report failure for ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new AgentPOSError("SITE_UNREACHABLE", `Cannot reach buyer-web at ${this.base}`, {
        hint: "Check the URL and that buyer-web is running with SIGNER_TOKEN set.",
        retryable: true,
        cause,
      });
    }
    if (res.status === 401) {
      throw new AgentPOSError("APPROVAL_UNAUTHORIZED", "buyer-web rejected the signer token", {
        hint: "AGENTPOS_SIGNER_TOKEN here must equal SIGNER_TOKEN on the buyer-web instance.",
      });
    }
    if (!res.ok) {
      const parsed = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; hint?: string };
      };
      throw new AgentPOSError(
        "SITE_UNREACHABLE",
        parsed.error?.message ?? `buyer-web answered ${res.status} on ${path}`,
        {
          hint: parsed.error?.hint ?? "See the buyer-web logs.",
          retryable: res.status >= 500,
          details: { status: res.status, code: parsed.error?.code },
        },
      );
    }
    return res;
  }
}

export interface RunSignerWatchOptions extends SignerWatcherDeps {
  /** Poll interval in milliseconds; minimum 1000. Default 15000. */
  intervalMs?: number;
  /** Process the queue once and return (for tests and cron users). */
  once?: boolean;
  /** Stops the loop cleanly when aborted. */
  signal?: AbortSignal;
}

/**
 * Runs the watcher: once, or forever every `intervalMs`. A rejected token stops the loop
 * (it will never fix itself); an unreachable buyer-web is reported and retried next tick.
 */
export async function runSignerWatch(options: RunSignerWatchOptions): Promise<WatchOutcome[]> {
  const watcher = new SignerWatcher(options);
  const line = options.onLine ?? (() => {});
  if (options.once) return watcher.runOnce();
  const intervalMs = Math.max(1000, options.intervalMs ?? 15_000);
  const all: WatchOutcome[] = [];
  for (;;) {
    try {
      all.push(...(await watcher.runOnce()));
    } catch (err) {
      if (isAgentPOSError(err) && err.code === "APPROVAL_UNAUTHORIZED") throw err;
      line(`queue poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (options.signal?.aborted) return all;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (options.signal?.aborted) return all;
  }
}
