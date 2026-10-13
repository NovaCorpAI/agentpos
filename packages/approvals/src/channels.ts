/**
 * Notification channels (M2). All of them are best effort: a channel that fails must never
 * block the queue, because an approval the merchant did not see is still a valid pending
 * approval that expires on its own. Failures are surfaced through `onError`, not thrown.
 */
import { createHmac } from "node:crypto";
import { formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { ApprovalLinks, ApprovalRequest, NotificationChannel } from "./types.js";

type FetchLike = typeof globalThis.fetch;

/** Human-readable summary reused by every channel. */
export function describeApproval(request: ApprovalRequest): string {
  const items = request.snapshot.lines.map((l) => `${l.quantity} x ${l.title}`).join(", ");
  const total = formatUsdc(usdcFromMinor(request.snapshot.totalMinor));
  return `${items} for ${total} ${request.snapshot.asset}`;
}

export interface WebhookChannelOptions {
  url: string;
  /** Shared secret; the POST carries an HMAC so the receiver can trust it came from this store. */
  secret?: string | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Signed JSON POST. The signature covers the exact body bytes. */
export class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";
  constructor(private readonly options: WebhookChannelOptions) {}

  async notify(request: ApprovalRequest, links: ApprovalLinks): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const body = JSON.stringify({
      type: "agentpos.approval.requested",
      approvalId: request.id,
      cartId: request.cartId,
      summary: describeApproval(request),
      snapshotHash: request.snapshotHash,
      snapshot: request.snapshot,
      expiresAt: request.expiresAt,
      links,
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.secret) {
      headers["x-agentpos-signature"] =
        `sha256=${createHmac("sha256", this.options.secret).update(body).digest("hex")}`;
    }
    await fetchImpl(this.options.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
  }
}

export interface EmailChannelOptions {
  to: string;
  /**
   * The merchant supplies the transport. AgentPOS does not bundle an SMTP client: sites already
   * have one, and shipping credentials for a mail provider is not our business.
   */
  send: (message: { to: string; subject: string; text: string }) => Promise<void>;
}

export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  constructor(private readonly options: EmailChannelOptions) {}

  async notify(request: ApprovalRequest, links: ApprovalLinks): Promise<void> {
    await this.options.send({
      to: this.options.to,
      subject: `Approval needed: ${describeApproval(request)}`,
      text: [
        `An AI agent wants to buy: ${describeApproval(request)}.`,
        request.snapshot.shipping
          ? `Ship to: ${request.snapshot.shipping.city}, ${request.snapshot.shipping.country}.`
          : "No shipping (digital).",
        `Reason: ${request.snapshot.policy.message}`,
        `Expires: ${request.expiresAt} (it is rejected automatically if you do nothing).`,
        `Approve or reject: ${links.resolve}`,
        `Approval id: ${request.id}`,
      ].join("\n"),
    });
  }
}

export interface TwilioWhatsAppOptions {
  accountSid: string;
  authToken: string;
  /** E.164 with the whatsapp: prefix, e.g. "whatsapp:+14155238886". */
  from: string;
  to: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

/** Thin HTTP client, no vendor SDK (no lock-in dependencies). */
export class TwilioWhatsAppChannel implements NotificationChannel {
  readonly name = "whatsapp";
  constructor(private readonly options: TwilioWhatsAppOptions) {}

  async notify(request: ApprovalRequest, links: ApprovalLinks): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const base = this.options.baseUrl ?? "https://api.twilio.com";
    const body = new URLSearchParams({
      From: this.options.from,
      To: this.options.to,
      Body: [
        `AgentPOS: an agent wants to buy ${describeApproval(request)}.`,
        `Reason: ${request.snapshot.policy.message}`,
        `Expires ${request.expiresAt}.`,
        links.resolve,
      ].join("\n"),
    });
    await fetchImpl(`${base}/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  }
}
