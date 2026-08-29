import { describe, expect, it, vi } from "vitest";
import { AgentGateError, createMemoryLogger } from "@agentgate/core";
import { ApprovalService, MemoryApprovalStore } from "./service.js";
import { canonicalize, hashSnapshot } from "./snapshot.js";
import {
  SIGNATURE_WINDOW_SECONDS,
  assertValidResolutionSignature,
  signResolution,
} from "./signature.js";
import {
  EmailChannel,
  TwilioWhatsAppChannel,
  WebhookChannel,
  describeApproval,
} from "./channels.js";
import type { ApprovalSnapshot, NotificationChannel } from "./types.js";

const snapshot = (over: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot => ({
  cartId: "cart_1",
  lines: [
    {
      itemId: "mug",
      title: "Ceramic Mug",
      quantity: 2,
      unitPriceMinor: "100000000",
      lineTotalMinor: "200000000",
    },
  ],
  totalMinor: "200000000",
  asset: "USDC",
  network: "stellar:testnet",
  payTo: "GSELLER",
  buyer: { email: "ada@example.com" },
  policy: {
    code: "POLICY_APPROVAL_REQUIRED",
    message: "Above the approval threshold",
    thresholdMinor: "50000000",
  },
  ...over,
});

function service(over: { ttlMinutes?: number; channels?: NotificationChannel[] } = {}) {
  const store = new MemoryApprovalStore();
  const logger = createMemoryLogger();
  const svc = new ApprovalService({
    store,
    ...(over.ttlMinutes !== undefined ? { ttlMinutes: over.ttlMinutes } : {}),
    ...(over.channels ? { channels: over.channels } : {}),
    links: (r) => ({
      poll: `https://shop.test/agentgate/approvals/${r.id}`,
      resolve: `https://shop.test/agentgate/approvals/${r.id}/resolve`,
    }),
    logger,
  });
  return { svc, store, logger };
}

describe("approval queue", () => {
  it("creates one pending request per cart and keeps returning it", async () => {
    const { svc } = service();
    const first = await svc.gate(snapshot());
    const second = await svc.gate(snapshot());
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    expect(second.request.id).toBe(first.request.id);
    expect(svc.list()).toHaveLength(1);
  });

  it("expires by TTL, rejecting rather than approving by silence", async () => {
    const { svc } = service({ ttlMinutes: 30 });
    const { request } = await svc.gate(snapshot());
    const later = new Date(Date.now() + 31 * 60_000);
    await expect(svc.gate(snapshot(), later)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    const expired = svc.get(request.id);
    expect(expired.status).toBe("expired");
    expect(expired.reason).toMatch(/rejected automatically/i);
  });

  it("sweeps expired requests without traffic", async () => {
    const { svc } = service({ ttlMinutes: 5 });
    await svc.gate(snapshot());
    expect(svc.expirePending(new Date(Date.now() + 60_000))).toHaveLength(0);
    expect(svc.expirePending(new Date(Date.now() + 6 * 60_000))).toHaveLength(1);
  });

  it("lets an approved cart through, and blocks a rejected one for good", async () => {
    const approved = service();
    const a = await approved.svc.gate(snapshot());
    approved.svc.resolve(a.request.id, "approve");
    expect((await approved.svc.gate(snapshot())).status).toBe("approved");

    const rejected = service();
    const r = await rejected.svc.gate(snapshot());
    rejected.svc.resolve(r.request.id, "reject", "Out of stock in the warehouse");
    await expect(rejected.svc.gate(snapshot())).rejects.toMatchObject({
      code: "APPROVAL_REJECTED",
    });
  });

  it("is idempotent: a second resolution never flips the first", async () => {
    const { svc } = service();
    const { request } = await svc.gate(snapshot());
    const rejected = svc.resolve(request.id, "reject", "no");
    expect(rejected.status).toBe("rejected");
    const retried = svc.resolve(request.id, "approve");
    expect(retried.status).toBe("rejected");
    expect(retried.resolvedAt).toBe(rejected.resolvedAt);
  });

  it("cannot resolve an unknown approval", () => {
    const { svc } = service();
    expect(() => svc.resolve("apr_nope", "approve")).toThrowError(AgentGateError);
  });

  it("voids the approval when the order changes underneath it", async () => {
    const { svc } = service();
    const { request } = await svc.gate(snapshot());
    svc.resolve(request.id, "approve");
    // same cart id, different price: the merchant approved something else
    const drifted = snapshot({
      totalMinor: "300000000",
      lines: [
        {
          itemId: "mug",
          title: "Ceramic Mug",
          quantity: 3,
          unitPriceMinor: "100000000",
          lineTotalMinor: "300000000",
        },
      ],
    });
    await expect(svc.gate(drifted)).rejects.toMatchObject({ code: "APPROVAL_SNAPSHOT_CHANGED" });
  });

  it("hashes snapshots canonically: key order does not change the hash, content does", () => {
    const a = snapshot();
    const reordered = { ...snapshot(), asset: "USDC" };
    expect(hashSnapshot(a)).toBe(hashSnapshot(reordered));
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(snapshot({ payTo: "GOTHER" })));
    expect(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});

describe("resolution signatures", () => {
  const secret = "merchant-secret";
  const id = "apr_123";
  const now = new Date("2026-08-29T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts a correctly signed resolution", () => {
    const signature = signResolution(secret, ts, id, "approve");
    expect(() =>
      assertValidResolutionSignature({
        secret,
        timestamp: ts,
        signature,
        approvalId: id,
        decision: "approve",
        now,
      }),
    ).not.toThrow();
  });

  it.each([
    ["missing signature", { signature: undefined }],
    ["missing timestamp", { timestamp: undefined }],
    ["wrong secret", { signature: signResolution("other-secret", ts, id, "approve") }],
    ["different decision", { signature: signResolution(secret, ts, id, "reject") }],
    ["different approval id", { signature: signResolution(secret, ts, "apr_other", "approve") }],
    ["stale timestamp", { timestamp: String(Number(ts) - SIGNATURE_WINDOW_SECONDS - 5) }],
  ] as const)("rejects %s", (_label, patch) => {
    const base = {
      secret,
      timestamp: ts,
      signature: signResolution(secret, ts, id, "approve"),
      approvalId: id,
      decision: "approve",
      now,
    };
    try {
      assertValidResolutionSignature({ ...base, ...patch });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("APPROVAL_UNAUTHORIZED");
    }
  });
});

describe("notification channels", () => {
  it("posts a signed webhook the receiver can verify", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { svc } = service({
      channels: [
        new WebhookChannel({
          url: "https://hooks.test/agentgate",
          secret: "hook-secret",
          fetchImpl,
        }),
      ],
    });
    const { request } = await svc.gate(snapshot());
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.test/agentgate");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-agentgate-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "agentgate.approval.requested",
      approvalId: request.id,
      snapshotHash: request.snapshotHash,
    });
    expect(svc.get(request.id).notified).toEqual(["webhook"]);
  });

  it("emails the merchant with what was asked and when it expires", async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const send = vi.fn(
      async (m: { to: string; subject: string; text: string }) => void sent.push(m),
    );
    const { svc } = service({ channels: [new EmailChannel({ to: "shop@example.com", send })] });
    await svc.gate(snapshot());
    const message = sent[0]!;
    expect(message.to).toBe("shop@example.com");
    expect(message.subject).toContain("2 x Ceramic Mug");
    expect(message.text).toMatch(/rejected automatically|Expires/);
  });

  it("sends WhatsApp through Twilio without an SDK", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const { svc } = service({
      channels: [
        new TwilioWhatsAppChannel({
          accountSid: "AC123",
          authToken: "tok",
          from: "whatsapp:+1",
          to: "whatsapp:+2",
          fetchImpl,
        }),
      ],
    });
    await svc.gate(snapshot());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("AC123:tok").toString("base64")}`,
    );
    expect(String(init.body)).toContain("Ceramic+Mug");
  });

  it("keeps the queue working when a channel fails", async () => {
    const broken: NotificationChannel = {
      name: "broken",
      notify: async () => {
        throw new Error("smtp down");
      },
    };
    const { svc, logger } = service({ channels: [broken] });
    const { request, status } = await svc.gate(snapshot());
    expect(status).toBe("pending");
    expect(svc.get(request.id).status).toBe("pending");
    expect(logger.records.some((r) => r.event === "approval.notify_failed")).toBe(true);
  });

  it("summarizes an approval for humans", async () => {
    const { svc } = service();
    const { request } = await svc.gate(snapshot());
    expect(describeApproval(request)).toBe("2 x Ceramic Mug for 20 USDC");
  });
});
