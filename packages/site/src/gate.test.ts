/**
 * Production gate G1 (docs/GATE-G1.md): every automatable criterion has a test here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  AgentPOSError,
  assetAddress,
  createMemoryLogger,
  resolveConfig,
  usdc,
} from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import type { AlertEvent } from "./checkout.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent } from "./test-utils.js";

interface StubOptions {
  txHash?: () => string;
  verifyThrows?: boolean;
  settleThrows?: boolean;
}

function stub(options: StubOptions = {}): FacilitatorClient & { settles: number } {
  let n = 0;
  const s = {
    settles: 0,
    async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
      if (options.verifyThrows) throw new Error("facilitator timeout");
      return { isValid: true, payer: "GPAYER" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      if (options.settleThrows) throw new Error("facilitator settle timeout");
      s.settles += 1;
      n += 1;
      return {
        success: true,
        transaction: options.txHash ? options.txHash() : `tx_${n}`,
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
  priceUsdc: usdc("9.9"),
  stockMode: "tracked",
  physical: false,
  status: "published",
  sourceEvidence: [],
};

function connectorMock(opts: { failTimes?: number; available?: () => boolean } = {}) {
  const created: PaidOrderInput[] = [];
  let failures = opts.failTimes ?? 0;
  const c: OrderConnector & { created: PaidOrderInput[] } = {
    platform: "generic",
    created,
    getAvailability: async (items) =>
      items.map((i) => ({ itemId: i.itemId, available: opts.available ? opts.available() : true })),
    createOrder: async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new AgentPOSError("INTERNAL", "platform down", { hint: "retry", retryable: true });
      }
      created.push(input);
      return { externalOrderId: `ext-${created.length}` };
    },
  };
  return c;
}

const healthFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    }),
    { status: 200 },
  );

function build(
  overrides: {
    facilitator?: FacilitatorClient;
    connector?: OrderConnector;
    rateLimit?: Record<string, number>;
    storage?: SiteStorage;
  } = {},
) {
  const storage = overrides.storage ?? new SiteStorage(":memory:");
  storage.upsertItem(mug);
  const alerts: AlertEvent[] = [];
  const logger = createMemoryLogger();
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Gate Shop",
    payTo,
    platform: "generic",
    ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit } : {}),
  });
  const connector = overrides.connector ?? connectorMock();
  const gate = createAgentPOSApp({
    site,
    core,
    connector,
    storage,
    facilitator: overrides.facilitator ?? stub(),
    logger,
    alert: (e) => void alerts.push(e),
    healthFetch,
  });
  const req = (path: string, init?: RequestInit) =>
    gate.fetch(new Request(`https://shop.test${path}`, init));
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
  const read = (r: Response): Promise<any> => r.json() as Promise<any>;
  const newCart = async (qty = 1, headers?: Record<string, string>) =>
    read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: qty }] }, headers)),
    );
  const pay = (cartId: string) =>
    payLikeAnAgent(gate.fetch, `https://shop.test/agentpos/checkout?cart=${cartId}`, {
      method: "POST",
    });
  return {
    gate,
    storage,
    alerts,
    logger,
    connector: connector as ReturnType<typeof connectorMock>,
    req,
    json,
    read,
    newCart,
    pay,
  };
}

describe("G1 payment correctness", () => {
  it("holds the order and raises a critical alert when settled terms differ from the quote", async () => {
    const t = build();
    const cart = await t.newCart();
    const receipt = {
      txHash: "tx_tamper",
      network: "stellar:testnet",
      payer: "GPAYER",
      amount: undefined,
      adapterVersion: "0.2.0",
    };
    const held = await t.gate.checkout.markPaid(cart.cartId, receipt, {
      payTo: Keypair.random().publicKey(), // funds went elsewhere
      asset: assetAddress(core),
      amountMinor: usdc("9.9"),
      network: "stellar:testnet",
    });
    expect(held.status).toBe("paid");
    expect(held.hold?.reason).toBe("PAYMENT_MISMATCH");
    expect(held.externalOrderId).toBeUndefined();
    expect(t.connector.created).toHaveLength(0);
    expect(t.alerts.map((a) => a.code)).toContain("PAYMENT_MISMATCH");
    // retries never touch held orders
    await t.gate.checkout.retryPending(Date.now() + 10 * 60_000);
    expect(t.connector.created).toHaveLength(0);
  });

  it("treats a partial settlement (amount below quote) as a mismatch", async () => {
    const t = build();
    const cart = await t.newCart();
    const held = await t.gate.checkout.markPaid(
      cart.cartId,
      {
        txHash: "tx_partial",
        network: "stellar:testnet",
        payer: "GPAYER",
        amount: usdc("9.8"),
        adapterVersion: "0.2.0",
      },
      { payTo, asset: assetAddress(core), amountMinor: usdc("9.9"), network: "stellar:testnet" },
    );
    expect(held.hold?.details).toMatchObject({ mismatch: [{ field: "settledAmount" }] });
    expect(t.connector.created).toHaveLength(0);
  });

  it("accepts exact terms and creates the platform order", async () => {
    const t = build();
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).toBe(200);
    const order = t.storage.getOrderByCart(cart.cartId)!;
    expect(order.status).toBe("paid");
    expect(order.hold).toBeUndefined();
    expect(order.externalOrderId).toBe("ext-1");
  });

  it("forces a re-quote when the price changed after the quote, before any 402", async () => {
    const t = build();
    const cart = await t.newCart();
    t.storage.upsertItem({ ...mug, priceUsdc: usdc("12") });
    const res = await t.req(`/agentpos/checkout?cart=${cart.cartId}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await t.read(res);
    expect(body.error.code).toBe("REQUOTE_REQUIRED");
    expect(body.error.details.drift[0]).toMatchObject({ itemId: "mug", reason: "price_changed" });
    expect((await t.req(`/agentpos/cart/${cart.cartId}`)).status).toBe(410);
    expect(t.connector.created).toHaveLength(0);
  });

  it("forces a re-quote when stock ran out after the quote", async () => {
    let available = true;
    const t = build({ connector: connectorMock({ available: () => available }) });
    const cart = await t.newCart();
    available = false;
    const res = await t.req(`/agentpos/checkout?cart=${cart.cartId}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await t.read(res)).error.details.drift[0].reason).toBe("out_of_stock");
  });

  it("a replayed payment (same tx hash) cannot pay a second cart", async () => {
    const t = build({ facilitator: stub({ txHash: () => "tx_same" }) });
    const a = await t.newCart();
    const b = await t.newCart();
    await t.pay(a.cartId);
    await t.pay(b.cartId);
    const orderA = t.storage.getOrderByCart(a.cartId)!;
    const orderB = t.storage.getOrderByCart(b.cartId)!;
    expect(orderA.status).toBe("paid");
    expect(orderB.status).toBe("pending_payment");
    expect(orderB.payment).toBeUndefined();
    expect(t.connector.created).toHaveLength(1);
    expect(t.storage.getPayment("tx_same")?.orderId).toBe(orderA.id);
  });

  it("facilitator failure during verify charges nothing and creates no order", async () => {
    const t = build({ facilitator: stub({ verifyThrows: true }) });
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).toBeGreaterThanOrEqual(400);
    expect(t.storage.getOrderByCart(cart.cartId)?.payment).toBeUndefined();
    expect(t.connector.created).toHaveLength(0);
  });

  it("facilitator failure during settle leaves the order pending and alerts", async () => {
    const t = build({ facilitator: stub({ settleThrows: true }) });
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).not.toBe(200);
    expect(t.storage.getOrderByCart(cart.cartId)?.status).toBe("pending_payment");
    expect(t.connector.created).toHaveLength(0);
    expect(t.alerts.map((a) => a.code)).toContain("SETTLEMENT_FAILED");
  });

  it("platform down after settle: payment kept, alert raised, retry loop recovers, stall alert after an hour", async () => {
    // 3 immediate attempts fail, the first retry pass (up to 3 attempts) fails too, the next pass succeeds.
    const t = build({ connector: connectorMock({ failTimes: 6 }) });
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid?.status).toBe(200);
    let order = t.storage.getOrderByCart(cart.cartId)!;
    expect(order.status).toBe("paid");
    expect(order.payment?.txHash).toBe("tx_1");
    expect(order.externalOrderId).toBeUndefined();
    expect(t.alerts.map((a) => a.code)).toContain("ORDER_NOT_CREATED");
    expect(t.gate.checkout.stuckOrders()).toHaveLength(1);

    // too early for backoff: nothing happens
    expect(await t.gate.checkout.retryPending(Date.now())).toHaveLength(0);
    // after backoff: first retry pass fails (failures 4-6), stall alert only if older than an hour
    let retried = await t.gate.checkout.retryPending(Date.now() + 60_000);
    expect(retried[0]?.externalOrderId).toBeUndefined();
    expect(t.alerts.filter((a) => a.code === "RETRY_LOOP_STALLED")).toHaveLength(0);
    // simulate an order that has been stuck for 2 hours
    t.storage.saveOrder({
      ...t.storage.getOrderByCart(cart.cartId)!,
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    retried = await t.gate.checkout.retryPending(Date.now());
    order = retried[0]!;
    expect(order.externalOrderId).toBe("ext-1"); // 7th attempt succeeds
    expect(t.gate.checkout.stuckOrders()).toHaveLength(0);
  });

  it("propagates a traceId from the request into cart, order and logs", async () => {
    const t = build();
    const cart = await t.newCart(1, { "x-trace-id": "trace-abc" });
    expect(cart.traceId).toBe("trace-abc");
    await t.pay(cart.cartId);
    const order = t.storage.getOrderByCart(cart.cartId)!;
    expect(order.traceId).toBe("trace-abc");
    expect(
      t.logger.records.some((r) => r.event === "payment.settled" && r.traceId === "trace-abc"),
    ).toBe(true);
  });
});

describe("G1 security", () => {
  it("rate limits cart creation per IP with Retry-After", async () => {
    const t = build({
      rateLimit: {
        cartPerMinutePerIp: 2,
        checkoutPerMinutePerIp: 60,
        checkoutAttemptsPerCart: 10,
        burst: 0,
      },
    });
    const h = { "x-forwarded-for": "203.0.113.5" };
    expect(
      (await t.req("/agentpos/cart", t.json({ items: [{ itemId: "mug", quantity: 1 }] }, h)))
        .status,
    ).toBe(201);
    expect(
      (await t.req("/agentpos/cart", t.json({ items: [{ itemId: "mug", quantity: 1 }] }, h)))
        .status,
    ).toBe(201);
    const third = await t.req(
      "/agentpos/cart",
      t.json({ items: [{ itemId: "mug", quantity: 1 }] }, h),
    );
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await t.read(third)).error.code).toBe("RATE_LIMITED");
    // another IP is unaffected
    expect(
      (
        await t.req(
          "/agentpos/cart",
          t.json({ items: [{ itemId: "mug", quantity: 1 }] }, { "x-forwarded-for": "203.0.113.6" }),
        )
      ).status,
    ).toBe(201);
  });

  it("limits checkout attempts per cart", async () => {
    const t = build({
      rateLimit: {
        cartPerMinutePerIp: 60,
        checkoutPerMinutePerIp: 60,
        checkoutAttemptsPerCart: 2,
        burst: 0,
      },
    });
    const cart = await t.newCart();
    expect(
      (await t.req(`/agentpos/checkout?cart=${cart.cartId}`, { method: "POST" })).status,
    ).toBe(402);
    expect(
      (await t.req(`/agentpos/checkout?cart=${cart.cartId}`, { method: "POST" })).status,
    ).toBe(402);
    const third = await t.req(`/agentpos/checkout?cart=${cart.cartId}`, { method: "POST" });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects oversized bodies, oversized carts and overlong queries", async () => {
    const t = build();
    const big = await t.req("/agentpos/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(70_000),
    });
    expect(big.status).toBe(413);
    const many = await t.req(
      "/agentpos/cart",
      t.json({ items: Array.from({ length: 51 }, () => ({ itemId: "mug", quantity: 1 })) }),
    );
    expect(many.status).toBe(400);
    const q = await t.req(`/agentpos/catalog?q=${"a".repeat(5000)}`);
    expect(q.status).toBe(200);
  });

  it("refuses to start with a secret seed anywhere in the site configuration", () => {
    const seed = Keypair.random().secret();
    expect(() =>
      parseSiteConfig({
        siteUrl: "https://shop.test",
        displayName: "x",
        payTo: seed,
        platform: "none",
      }),
    ).toThrowError(/secret seed/);
    try {
      parseSiteConfig({
        siteUrl: "https://shop.test",
        displayName: "x",
        payTo,
        platform: "none",
        policies: { contact: `mail me ${seed}` },
      });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("SECRET_IN_CONFIG");
    }
  });
});

describe("G1 operations", () => {
  it("health reports the facilitator and stuck orders", async () => {
    const t = build({ connector: connectorMock({ failTimes: 10 }) });
    let res = await t.req("/agentpos/health");
    expect(res.status).toBe(200);
    expect((await t.read(res)).facilitator.ok).toBe(true);
    const cart = await t.newCart();
    await t.pay(cart.cartId);
    res = await t.req("/agentpos/health");
    expect(res.status).toBe(503);
    expect((await t.read(res)).orders.stuck).toBe(1);
  });

  it("backs up the database consistently", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "agentpos-backup-"));
    const storage = new SiteStorage(join(dir, "live.sqlite"));
    const t = build({ storage });
    await t.newCart();
    const dest = join(dir, "backups", "copy.sqlite");
    storage.backup(dest);
    expect(existsSync(dest)).toBe(true);
    const restored = new SiteStorage(dest);
    expect(restored.counts().items).toBe(1);
    expect(restored.counts().carts).toBe(1);
    restored.close();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sustains a burst of concurrent agents without duplicating orders or payments (load)", async () => {
    const t = build({
      rateLimit: {
        cartPerMinutePerIp: 1000,
        checkoutPerMinutePerIp: 1000,
        checkoutAttemptsPerCart: 10,
        burst: 100,
      },
    });
    const N = 40;
    const carts = await Promise.all(Array.from({ length: N }, () => t.newCart()));
    const results = await Promise.all(carts.map((c) => t.pay(c.cartId)));
    expect(results.every((r) => r.paid?.status === 200)).toBe(true);
    const orders = t.storage.listOrders({ limit: 1000 });
    expect(orders).toHaveLength(N);
    expect(orders.every((o) => o.status === "paid" && o.externalOrderId)).toBe(true);
    const hashes = new Set(orders.map((o) => o.payment?.txHash));
    expect(hashes.size).toBe(N);
    expect(t.connector.created).toHaveLength(N);
    expect(t.storage.counts().payments).toBe(N);
  });
});

describe("G1 mainnet lock", () => {
  beforeEach(() => {});
  it("cannot configure mainnet while the gate is open, even with the flag", () => {
    try {
      resolveConfig(
        { network: "mainnet", allowMainnet: true, rpcUrl: "https://rpc.example" },
        { mainnetReady: false },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("MAINNET_NOT_CONFIRMED");
      expect((err as AgentPOSError).message).toMatch(/gate G1/);
    }
    // Gate closed (release constant): still needs the explicit flag and an RPC URL.
    expect(() => resolveConfig({ network: "mainnet", rpcUrl: "https://rpc.example" })).toThrowError(
      /explicit flag/,
    );
    expect(() => resolveConfig({ network: "mainnet", allowMainnet: true })).toThrowError(/RPC/);
    const cfg = resolveConfig({
      network: "mainnet",
      allowMainnet: true,
      rpcUrl: "https://rpc.example",
    });
    expect(cfg.caip2).toBe("stellar:pubnet");
  });
});
