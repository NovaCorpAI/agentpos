/**
 * M4 at the HTTP surface: a settled order produces a signed receipt that names the terms, the
 * policy, the approval and the agent; the chain grows across orders; refusals are recorded too;
 * and a third party can verify the whole thing with nothing but the JSON we handed them.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { exportAuditTrail, formatAuditTrail, verifyChain, verifyReceipt } from "@agentpos/receipts";
import type { Receipt } from "@agentpos/receipts";
import { signRequest } from "@agentpos/identity";
import { createAgentPOSApp } from "./app.js";
import type { AgentPOSSite } from "./app.js";
import { parseSiteConfig } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent, stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const storeKey = Keypair.random();

const ebook: CatalogItem = {
  id: "ebook",
  externalId: "13",
  type: "product",
  title: "E-book",
  descriptionAgent: "PDF guide, 120 pages.",
  url: "https://shop.test/product/ebook/",
  attributes: {},
  priceUsdc: usdc("2"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};

function connectorMock(): OrderConnector & { created: PaidOrderInput[] } {
  const created: PaidOrderInput[] = [];
  return {
    platform: "generic",
    created,
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async (input) => {
      created.push(input);
      return { externalOrderId: `woo-${created.length}` };
    },
  };
}

function makeSite(overrides: Partial<SiteConfigInput> = {}): AgentPOSSite {
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Test Shop",
    payTo,
    platform: "generic",
    ...overrides,
  });
  const storage = new SiteStorage(":memory:");
  storage.upsertItem(ebook);
  return createAgentPOSApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    facilitator: stubFacilitator(),
    // Explicit key: tests must not touch the merchant key file on disk.
    receiptSecret: storeKey.secret(),
  });
}

async function cart(gate: AgentPOSSite, quantity = 1): Promise<string> {
  const res = await gate.fetch(
    new Request("https://shop.test/agentpos/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ itemId: "ebook", quantity }] }),
    }),
  );
  const body = (await res.json()) as { cartId?: string; error?: { code: string } };
  if (!body.cartId) throw new Error(`cart refused: ${body.error?.code}`);
  return body.cartId;
}

async function pay(gate: AgentPOSSite, cartId: string): Promise<Response> {
  const { first, paid } = await payLikeAnAgent(
    gate.fetch,
    `https://shop.test/agentpos/checkout?cart=${cartId}`,
    { method: "POST" },
  );
  return paid ?? first;
}

describe("receipts for settled orders (M4)", () => {
  it("records the terms, the payment and the platform order, signed by the store", async () => {
    const gate = makeSite();
    const cartId = await cart(gate);
    await pay(gate, cartId);

    const order = gate.storage.getOrderByCart(cartId);
    const receipts = gate.receipts?.forOrder(order?.id ?? "") ?? [];
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0] as Receipt;

    expect(receipt.body.event).toBe("order.settled");
    expect(receipt.body.seq).toBe(1);
    expect(receipt.body.prev).toBe("genesis");
    expect(receipt.body.store.signer).toBe(storeKey.publicKey());
    expect(receipt.body.terms?.totalMinor).toBe("20000000");
    expect(receipt.body.terms?.payTo).toBe(payTo);
    expect(receipt.body.payment?.amountMinor).toBe("20000000");
    expect(receipt.body.order?.externalOrderId).toBe("woo-1");
    expect(receipt.body.policy?.decision).toBe("allowed");
    expect(verifyReceipt(receipt).valid).toBe(true);
  });

  it("serves the buyer their receipt, verifiable without the database", async () => {
    const gate = makeSite();
    const cartId = await cart(gate);
    await pay(gate, cartId);
    const orderId = gate.storage.getOrderByCart(cartId)?.id as string;

    const res = await gate.fetch(
      new Request(`https://shop.test/agentpos/orders/${orderId}/receipt`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      receipts: unknown[];
      verification: { valid: boolean };
      howToVerify: string;
    };
    expect(body.verification.valid).toBe(true);
    expect(body.howToVerify).toContain("sha256");
    // A third party, holding only what the endpoint returned:
    expect(verifyReceipt(body.receipts[0]).valid).toBe(true);

    const hash = (body.receipts[0] as Receipt).hash;
    const byHash = await gate.fetch(new Request(`https://shop.test/agentpos/receipts/${hash}`));
    expect(byHash.status).toBe(200);

    const missing = await gate.fetch(
      new Request(`https://shop.test/agentpos/receipts/${"0".repeat(64)}`),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "RECEIPT_NOT_FOUND",
    );
  });

  it("chains receipts across orders and publishes the signing key on health", async () => {
    const gate = makeSite();
    await pay(gate, await cart(gate));
    await pay(gate, await cart(gate));
    await pay(gate, await cart(gate));

    const all = gate.receipts?.list() ?? [];
    expect(all.map((r) => r.body.seq)).toEqual([1, 2, 3]);
    expect(all[1]?.body.prev).toBe(all[0]?.hash);
    expect(all[2]?.body.prev).toBe(all[1]?.hash);
    expect(verifyChain(all).valid).toBe(true);

    const health = await gate.fetch(new Request("https://shop.test/agentpos/health"));
    const body = (await health.json()) as { receipts?: { signer: string; chainHeight: number } };
    expect(body.receipts?.signer).toBe(storeKey.publicKey());
    expect(body.receipts?.chainHeight).toBe(3);
  });

  it("records the agent that bought, when the store asks who is buying", async () => {
    const gate = makeSite({ identity: { mode: "identified" } });
    const agent = Keypair.random();
    const body = JSON.stringify({ items: [{ itemId: "ebook", quantity: 1 }] });
    const res = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signRequest(agent.secret(), { method: "POST", path: "/agentpos/cart", body }),
        },
        body,
      }),
    );
    const { cartId } = (await res.json()) as { cartId: string };
    await pay(gate, cartId);

    const receipt = (gate.receipts?.list() ?? [])[0] as Receipt;
    expect(receipt.body.agent?.agentKey).toBe(agent.publicKey());
    expect(receipt.body.agent?.authenticated).toBe(true);
  });
});

describe("receipts for what did not happen", () => {
  it("records a sale the policy refused", async () => {
    const gate = makeSite({ policy: { maxOrderUsdc: "3" } });
    await expect(cart(gate, 5)).rejects.toThrow(/POLICY_ORDER_LIMIT/);

    const all = gate.receipts?.list() ?? [];
    expect(all).toHaveLength(1);
    expect(all[0]?.body.event).toBe("policy.denied");
    expect(all[0]?.body.policy?.code).toBe("POLICY_ORDER_LIMIT");
    expect(all[0]?.body.terms?.totalMinor).toBe("100000000");
    expect(verifyReceipt(all[0]).valid).toBe(true);
  });

  it("records an order parked for a human, and the decision that followed", async () => {
    const gate = makeSite({ policy: { approvalThresholdUsdc: "1" } });
    const cartId = await cart(gate);
    const parked = await gate.fetch(
      new Request(`https://shop.test/agentpos/checkout?cart=${cartId}`, { method: "POST" }),
    );
    expect(parked.status).toBe(202);
    const { approvalId } = (await parked.json()) as { approvalId: string };

    gate.approvals?.resolve(approvalId, "reject", "not selling this today");

    const events = (gate.receipts?.list() ?? []).map((r) => r.body.event);
    expect(events).toEqual(["approval.requested", "approval.resolved"]);
    const resolved = (gate.receipts?.list() ?? [])[1] as Receipt;
    expect(resolved.body.approval?.status).toBe("rejected");
    expect(resolved.body.approval?.reason).toBe("not selling this today");
    expect(resolved.body.cart?.id).toBe(cartId);
    expect(verifyChain(gate.receipts?.list() ?? []).valid).toBe(true);
  });
});

describe("audit trail export", () => {
  it("exports the period with its own verification, and reads as text", async () => {
    const gate = makeSite();
    await pay(gate, await cart(gate));
    await pay(gate, await cart(gate));

    const trail = exportAuditTrail(gate.receipts!);
    expect(trail.summary.receipts).toBe(2);
    expect(trail.summary.settled.orders).toBe(2);
    expect(trail.summary.settled.total).toBe("4");
    expect(trail.verification.valid).toBe(true);
    expect(trail.store?.signer).toBe(storeKey.publicKey());

    const text = formatAuditTrail(trail);
    expect(text).toContain("Test Shop");
    expect(text).toContain("Verification: PASS");
    expect(text).toContain("Settled orders: 2 for 4 USDC");
  });
});

describe("a store that keeps no receipts", () => {
  it("still sells, and simply has nothing to show", async () => {
    const gate = makeSite({ receipts: { enabled: false } });
    const cartId = await cart(gate);
    const paid = await pay(gate, cartId);
    expect(paid.status).toBe(200);
    expect(gate.receipts).toBeUndefined();

    const orderId = gate.storage.getOrderByCart(cartId)?.id as string;
    const res = await gate.fetch(
      new Request(`https://shop.test/agentpos/orders/${orderId}/receipt`),
    );
    expect(res.status).toBe(404);
  });
});
