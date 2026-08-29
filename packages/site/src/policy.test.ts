/**
 * M1 acceptance criteria: the merchant policy is enforced when quoting AND again at checkout,
 * an order over the approval threshold never settles, and the period accumulator counts
 * pending-approval carts alongside settled orders.
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
import type { MerchantPolicyInput } from "@agentgate/policy";
import { createAgentGateApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent } from "./test-utils.js";

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
  physical: true,
  status: "published",
  sourceEvidence: [],
};
const ebook: CatalogItem = {
  ...mug,
  id: "ebook",
  externalId: "13",
  title: "E-book",
  physical: false,
  priceUsdc: usdc("4"),
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

const shipping = {
  name: "Ada",
  line1: "1 Main St",
  city: "Santiago",
  postalCode: "1234",
  country: "CL",
};
const buyer = { email: "ada@example.com" };

function build(policy: MerchantPolicyInput, storage = new SiteStorage(":memory:")) {
  for (const item of [mug, ebook]) storage.upsertItem(item);
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
      displayName: "Policy Shop",
      payTo,
      platform: "generic",
      policy,
    }),
    core,
    connector,
    storage,
    facilitator,
    logger: createMemoryLogger(),
    healthFetch,
  });
  const req = (path: string, init?: RequestInit) =>
    gate.fetch(new Request(`https://shop.test${path}`, init));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
  const read = (r: Response): Promise<any> => r.json() as Promise<any>;
  const cart = (itemId: string, quantity = 1) =>
    req("/agentgate/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ itemId, quantity }], buyer, shipping }),
    });
  const pay = (cartId: string) =>
    payLikeAnAgent(gate.fetch, `https://shop.test/agentgate/checkout?cart=${cartId}`, {
      method: "POST",
    });
  return { gate, storage, connector, facilitator, req, read, cart, pay };
}

describe("M1 policy at quote time", () => {
  it("denies a cart over the per-order limit with a machine-readable code", async () => {
    const t = build({ maxOrderUsdc: "15" });
    const res = await t.cart("mug", 2); // 20 > 15
    expect(res.status).toBe(403);
    const body = await t.read(res);
    expect(body.error.code).toBe("POLICY_ORDER_LIMIT");
    expect(body.error.hint).toBeTruthy();
    expect(t.storage.counts().carts).toBe(0);
  });

  it("denies excluded items and allows the rest of the catalog", async () => {
    const t = build({ excludedItems: ["mug"] });
    expect((await t.cart("mug")).status).toBe(403);
    expect((await t.cart("ebook")).status).toBe(201);
  });

  it("denies shipping outside the allowed countries but still sells digital goods", async () => {
    const t = build({ allowedShippingCountries: ["AR"] });
    expect((await t.cart("mug")).status).toBe(403); // physical, ships to CL
    expect((await t.cart("ebook")).status).toBe(201); // digital, no shipping
  });

  it("denies every sale while the policy is suspended", async () => {
    const t = build({ status: "suspended" });
    const body = await t.read(await t.cart("ebook"));
    expect(body.error.code).toBe("POLICY_SUSPENDED");
  });
});

describe("M1 approval threshold", () => {
  it("quotes the cart but never settles it: the agent is not charged", async () => {
    const t = build({ approvalThresholdUsdc: "5" });
    const cart = await t.read(await t.cart("mug")); // 10 > 5
    expect(cart.cartId).toBeTruthy();
    expect(cart.policy).toMatchObject({
      decision: "requires_approval",
      code: "POLICY_APPROVAL_REQUIRED",
    });

    const res = await t.req(`/agentgate/checkout?cart=${cart.cartId}`, { method: "POST" });
    expect(res.status).toBe(403);
    const body = await t.read(res);
    expect(body.error.code).toBe("POLICY_APPROVAL_REQUIRED");
    expect(body.error.hint).toMatch(/Nothing was charged/);

    // no 402 was ever issued, no settlement, no order in the merchant platform
    expect(t.facilitator.settles).toBe(0);
    expect(t.connector.created).toHaveLength(0);
    expect(t.storage.listOrders()).toHaveLength(0);
  });

  it("lets an order at or below the threshold settle normally", async () => {
    const t = build({ approvalThresholdUsdc: "5" });
    const cart = await t.read(await t.cart("ebook")); // 4 <= 5
    expect(cart.policy.decision).toBe("allowed");
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).toBe(200);
    expect(t.connector.created).toHaveLength(1);
  });
});

describe("M1 policy re-evaluated at checkout", () => {
  it("blocks a quoted cart when the merchant suspends the policy before payment", async () => {
    const storage = new SiteStorage(":memory:");
    const open = build({}, storage);
    const cart = await open.read(await open.cart("ebook"));
    expect(cart.policy.decision).toBe("allowed");

    // Same storage, merchant now suspended: the cart exists but must not settle.
    const suspended = build({ status: "suspended" }, storage);
    const res = await suspended.req(`/agentgate/checkout?cart=${cart.cartId}`, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await suspended.read(res)).error.code).toBe("POLICY_SUSPENDED");
    expect(suspended.facilitator.settles).toBe(0);
  });
});

describe("M1 period accumulator", () => {
  it("counts settled orders toward the period limit", async () => {
    const t = build({ maxPeriodUsdc: "9", period: "daily" });
    const first = await t.read(await t.cart("ebook")); // 4, committed 0
    await t.pay(first.cartId);
    expect(t.connector.created).toHaveLength(1);

    const second = await t.read(await t.cart("ebook")); // 4, committed 4 -> 8 <= 9
    await t.pay(second.cartId);
    expect(t.connector.created).toHaveLength(2);

    const third = await t.cart("ebook"); // would be 12 > 9
    expect(third.status).toBe(403);
    expect((await t.read(third)).error.code).toBe("POLICY_PERIOD_LIMIT");
  });

  it("counts carts awaiting approval, not just settled orders", async () => {
    // Threshold 3 means the 4 USDC e-book always needs approval; limit 9 for the day.
    const t = build({ maxPeriodUsdc: "9", approvalThresholdUsdc: "3", period: "daily" });
    const a = await t.read(await t.cart("ebook"));
    const b = await t.read(await t.cart("ebook"));
    expect(a.policy.decision).toBe("requires_approval");
    expect(b.policy.decision).toBe("requires_approval");
    expect(t.storage.listOrders()).toHaveLength(0); // nothing settled at all

    // Two pending carts already commit 8 of the 9 allowed: a third one breaks the period limit.
    const third = await t.cart("ebook");
    expect(third.status).toBe(403);
    expect((await t.read(third)).error.code).toBe("POLICY_PERIOD_LIMIT");
  });

  it("does not count a cart against itself when re-evaluated at checkout", async () => {
    // Limit 9, single cart of 4: on re-evaluation the cart must not be added to its own total.
    const t = build({ maxPeriodUsdc: "9", approvalThresholdUsdc: "100", period: "daily" });
    const cart = await t.read(await t.cart("ebook"));
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).toBe(200);
    expect(t.connector.created).toHaveLength(1);
  });
});
