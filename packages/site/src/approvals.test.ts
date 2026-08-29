/**
 * M2 acceptance criteria, end to end over HTTP: TTL rejects and releases, an invalid signature
 * is 401, a repeated resolution is idempotent, settlement executes exactly the approved
 * snapshot, and an agent is never charged for an order that ended rejected or expired.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createMemoryLogger, resolveConfig, usdc } from "@agentgate/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentgate/core";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  hashSnapshot,
  signResolution,
} from "@agentgate/approvals";
import { createAgentGateApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent } from "./test-utils.js";

const SECRET = "merchant-shared-secret";

function stub(): FacilitatorClient & { settles: number } {
  let n = 0;
  const s = {
    settles: 0,
    async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
      return { isValid: true, payer: "GPAYER" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      s.settles += 1;
      n += 1;
      return {
        success: true,
        transaction: `tx_${n}`,
        network: r.network,
        payer: "GPAYER",
        amount: r.amount,
      };
    },
    async getSupported(): Promise<SupportedResponse> {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
        extensions: [],
        signers: {},
      };
    },
  };
  return s as FacilitatorClient & { settles: number };
}

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const mug: CatalogItem = {
  id: "mug",
  externalId: "12",
  type: "product",
  title: "Ceramic Mug",
  descriptionAgent: "350 ml",
  url: "https://shop.test/mug",
  attributes: {},
  priceUsdc: usdc("10"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [],
};

const healthFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    }),
    { status: 200 },
  );

function build(options: { secret?: string | undefined; ttlMinutes?: number } = {}) {
  const storage = new SiteStorage(":memory:");
  storage.upsertItem(mug);
  const created: PaidOrderInput[] = [];
  const connector: OrderConnector & { created: PaidOrderInput[] } = {
    platform: "generic",
    created,
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async (input) => {
      created.push(input);
      return { externalOrderId: `ext-${created.length}` };
    },
  };
  const facilitator = stub();
  const gate = createAgentGateApp({
    site: parseSiteConfig({
      siteUrl: "https://shop.test",
      displayName: "Approval Shop",
      payTo,
      platform: "generic",
      // Everything above 5 USDC needs a human; the mug costs 10.
      policy: { approvalThresholdUsdc: "5" },
      approvals: { enabled: true, ttlMinutes: options.ttlMinutes ?? 30 },
    }),
    core,
    connector,
    storage,
    facilitator,
    logger: createMemoryLogger(),
    approvalSecret: "secret" in options ? options.secret : SECRET,
    healthFetch,
  });
  const req = (path: string, init?: RequestInit) =>
    gate.fetch(new Request(`https://shop.test${path}`, init));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
  const read = (r: Response): Promise<any> => r.json() as Promise<any>;
  const newCart = async () =>
    read(
      await req("/agentgate/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ itemId: "mug", quantity: 1 }] }),
      }),
    );
  const checkout = (cartId: string) =>
    req(`/agentgate/checkout?cart=${cartId}`, { method: "POST" });
  const pay = (cartId: string) =>
    payLikeAnAgent(gate.fetch, `https://shop.test/agentgate/checkout?cart=${cartId}`, {
      method: "POST",
    });
  const resolve = (
    id: string,
    decision: "approve" | "reject",
    opts: { secret?: string; timestamp?: string; reason?: string } = {},
  ) => {
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
    return req(`/agentgate/approvals/${id}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signResolution(opts.secret ?? SECRET, timestamp, id, decision),
      },
      body: JSON.stringify({ decision, ...(opts.reason ? { reason: opts.reason } : {}) }),
    });
  };
  return { gate, storage, connector, facilitator, req, read, newCart, checkout, pay, resolve };
}

describe("M2 approval flow", () => {
  it("parks the payment, then settles exactly the approved snapshot once the merchant approves", async () => {
    const t = build();
    const cart = await t.newCart();

    const parked = await t.checkout(cart.cartId);
    expect(parked.status).toBe(202);
    const pending = await t.read(parked);
    expect(pending).toMatchObject({
      status: "pending_approval",
      summary: "1 x Ceramic Mug for 10 USDC",
    });
    expect(t.facilitator.settles).toBe(0);

    const polled = await t.read(await t.req(`/agentgate/approvals/${pending.approvalId}`));
    expect(polled.status).toBe("pending");
    expect(polled.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const resolved = await t.read(await t.resolve(pending.approvalId, "approve"));
    expect(resolved.status).toBe("approved");
    const afterApproval = await t.read(await t.req(`/agentgate/approvals/${pending.approvalId}`));
    expect(afterApproval.next).toContain(`cart=${cart.cartId}`);

    // Now, and only now, the agent gets 402 terms and pays.
    const { first, paid } = await t.pay(cart.cartId);
    expect(first.status).toBe(402);
    expect(paid?.status).toBe(200);

    // The order executed is exactly what was approved.
    const snapshot = t.gate.approvals!.get(pending.approvalId).snapshot;
    const order = t.storage.getOrderByCart(cart.cartId)!;
    expect(order.status).toBe("paid");
    expect(order.quote.totalUsdc.toString()).toBe(snapshot.totalMinor);
    expect(
      order.quote.lines.map((l) => [l.itemId, l.quantity, l.lineTotalUsdc.toString()]),
    ).toEqual(snapshot.lines.map((l) => [l.itemId, l.quantity, l.lineTotalMinor]));
    expect(t.connector.created).toHaveLength(1);
    expect(hashSnapshot(snapshot)).toBe(t.gate.approvals!.get(pending.approvalId).snapshotHash);
  });

  it("never charges an order the merchant rejected", async () => {
    const t = build();
    const cart = await t.newCart();
    const pending = await t.read(await t.checkout(cart.cartId));
    await t.resolve(pending.approvalId, "reject", { reason: "Out of stock in the warehouse" });

    const blocked = await t.checkout(cart.cartId);
    expect(blocked.status).toBe(403);
    const body = await t.read(blocked);
    expect(body.error.code).toBe("APPROVAL_REJECTED");
    expect(body.error.message).toContain("Out of stock");

    // even a full x402 attempt cannot get terms
    const { first } = await t.pay(cart.cartId);
    expect(first.status).toBe(403);
    expect(t.facilitator.settles).toBe(0);
    expect(t.connector.created).toHaveLength(0);
  });

  it("expires by TTL, releases the quote and charges nobody", async () => {
    const t = build({ ttlMinutes: 30 });
    const cart = await t.newCart();
    const pending = await t.read(await t.checkout(cart.cartId));

    // Age the request past its deadline: silence must reject, never approve.
    const stored = t.gate.approvals!.get(pending.approvalId);
    t.gate.approvals!.store.save({
      ...stored,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const polled = await t.read(await t.req(`/agentgate/approvals/${pending.approvalId}`));
    expect(polled.status).toBe("expired");
    expect(polled.reason).toMatch(/rejected automatically/i);

    const blocked = await t.checkout(cart.cartId);
    expect(blocked.status).toBe(410);
    expect((await t.read(blocked)).error.code).toBe("APPROVAL_EXPIRED");
    expect(t.facilitator.settles).toBe(0);
  });
});

describe("M2 resolution authentication", () => {
  it("answers 401 to a resolution that is not signed by the merchant", async () => {
    const t = build();
    const cart = await t.newCart();
    const pending = await t.read(await t.checkout(cart.cartId));
    const id = pending.approvalId;

    const wrongSecret = await t.resolve(id, "approve", { secret: "attacker" });
    expect(wrongSecret.status).toBe(401);
    expect((await t.read(wrongSecret)).error.code).toBe("APPROVAL_UNAUTHORIZED");

    const stale = await t.resolve(id, "approve", {
      timestamp: String(Math.floor(Date.now() / 1000) - 3600),
    });
    expect(stale.status).toBe(401);

    const unsigned = await t.req(`/agentgate/approvals/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(unsigned.status).toBe(401);

    // A signature for "reject" cannot be replayed to approve.
    const ts = String(Math.floor(Date.now() / 1000));
    const swapped = await t.req(`/agentgate/approvals/${id}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: ts,
        [SIGNATURE_HEADER]: signResolution(SECRET, ts, id, "reject"),
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(swapped.status).toBe(401);

    // None of that moved the approval.
    expect(t.gate.approvals!.get(id).status).toBe("pending");
  });

  it("refuses every resolution when the store has no signing secret configured", async () => {
    const t = build({ secret: undefined });
    const cart = await t.newCart();
    const pending = await t.read(await t.checkout(cart.cartId));
    const res = await t.resolve(pending.approvalId, "approve");
    expect(res.status).toBe(401);
    expect((await t.read(res)).error.hint).toMatch(/AGENTGATE_APPROVAL_SECRET/);
  });

  it("is idempotent: replaying a resolution never flips the decision", async () => {
    const t = build();
    const cart = await t.newCart();
    const pending = await t.read(await t.checkout(cart.cartId));
    const first = await t.read(await t.resolve(pending.approvalId, "reject", { reason: "no" }));
    expect(first.status).toBe("rejected");

    const replayed = await t.read(await t.resolve(pending.approvalId, "reject", { reason: "no" }));
    expect(replayed.resolvedAt).toBe(first.resolvedAt);

    const flipAttempt = await t.read(await t.resolve(pending.approvalId, "approve"));
    expect(flipAttempt.status).toBe("rejected");
    expect(t.facilitator.settles).toBe(0);
  });

  it("returns 404 for an unknown approval", async () => {
    const t = build();
    expect((await t.req("/agentgate/approvals/apr_nope")).status).toBe(404);
  });
});
