/**
 * Read-only merchant API (Cloud foundation): mounting, auth, pagination, parity with the
 * dashboard views, and the guarantee that neither the owner token nor facilitator keys ever
 * appear in a response or a log line.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createMemoryLogger, resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, Order, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import { parseSiteConfig, secretsFromEnv } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";

const TOKEN = "owner-token-0123456789abcdef"; // 28 chars: what the store owner would generate
const FACILITATOR_KEY = "fac-secret-key-abcdef-123456";

const payTo = Keypair.random().publicKey();
const receiptSecret = Keypair.random().secret();
const siteInput: SiteConfigInput = {
  siteUrl: "https://shop.test",
  displayName: "Test Shop",
  payTo,
  platform: "generic",
};
const site = parseSiteConfig(siteInput);
const core = resolveConfig({ network: "testnet", facilitatorApiKeys: [FACILITATOR_KEY] });

const mug: CatalogItem = {
  id: "mug",
  externalId: "12",
  type: "product",
  title: "Ceramic Mug 350ml",
  descriptionAgent: "White ceramic mug, 350 ml.",
  url: "https://shop.test/product/mug/",
  attributes: {},
  priceUsdc: usdc("9.9"),
  stockMode: "tracked",
  physical: true,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};
const ebook: CatalogItem = {
  ...mug,
  id: "ebook",
  externalId: "13",
  title: "E-book",
  physical: false,
  priceUsdc: usdc("2"),
  stockMode: "untracked",
};
const draftItem: CatalogItem = { ...mug, id: "draft-only", status: "draft" };

const connector: OrderConnector = {
  platform: "generic",
  getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
  createOrder: async () => ({ externalOrderId: "woo-1" }),
};

/** Facilitator health check never leaves the process in tests. */
const healthFetch = (async () =>
  new Response(JSON.stringify({ kinds: [{ scheme: "exact", network: "stellar:testnet" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function order(i: number, over: Partial<Order> = {}): Order {
  const total = usdc("2");
  const at = `2026-09-0${i}T00:00:00.000Z`;
  return {
    id: `ord_${i}`,
    cartId: `cart_${i}`,
    status: "paid",
    quote: {
      lines: [
        {
          itemId: "ebook",
          title: "E-book",
          quantity: 1,
          unitPriceUsdc: total,
          lineTotalUsdc: total,
          physical: false,
        },
      ],
      totalUsdc: total,
      payTo,
      requiresShipping: false,
    },
    buyer: { email: "ada@example.com" },
    payment: {
      txHash: `tx_${i}`,
      network: "stellar:testnet",
      asset: "USDC",
      amountMinor: total,
      ts: at,
    },
    externalOrderId: `woo-${i}`,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function buildApp(
  options: { token?: string; site?: ReturnType<typeof parseSiteConfig> } = {},
): { gate: ReturnType<typeof createAgentPOSApp>; logger: ReturnType<typeof createMemoryLogger> } {
  const storage = new SiteStorage(":memory:");
  for (const item of [mug, ebook, draftItem]) storage.upsertItem(item);
  const logger = createMemoryLogger();
  const gate = createAgentPOSApp({
    site: options.site ?? site,
    core,
    connector,
    storage,
    facilitator: stubFacilitator(),
    receiptSecret,
    healthFetch,
    logger,
    ...(options.token !== undefined ? { merchantApiToken: options.token } : {}),
  });
  return { gate, logger };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
type Loose = any;
const read = (r: Response): Promise<Loose> => r.json() as Promise<Loose>;

describe("merchant API", () => {
  let gate: ReturnType<typeof createAgentPOSApp>;
  let logger: ReturnType<typeof createMemoryLogger>;

  beforeEach(() => {
    ({ gate, logger } = buildApp({ token: TOKEN }));
  });

  // `null` means "send no Authorization header at all".
  const req = (path: string, token: string | null = TOKEN) =>
    gate.fetch(
      new Request(`https://shop.test${path}`, {
        headers: token !== null ? { authorization: `Bearer ${token}` } : {},
      }),
    );

  it("is not mounted at all when the token is absent", async () => {
    const { gate: bare } = buildApp({});
    for (const path of ["/agentpos/api/merchant/summary", "/agentpos/api/merchant/orders"]) {
      const res = await bare.fetch(
        new Request(`https://shop.test${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(res.status).toBe(404);
    }
  });

  it("refuses a short token at construction and at the config boundary", () => {
    expect(() => buildApp({ token: "short" })).toThrowError(/too short/);
    expect(() => secretsFromEnv({ MERCHANT_API_TOKEN: "short" })).toThrowError(/too short/);
    expect(secretsFromEnv({ MERCHANT_API_TOKEN: TOKEN }).merchantApiToken).toBe(TOKEN);
    expect(secretsFromEnv({}).merchantApiToken).toBeUndefined();
  });

  it("answers 401 MERCHANT_UNAUTHORIZED for a missing or wrong token", async () => {
    for (const bad of [null, "wrong", `${TOKEN}x`, TOKEN.slice(0, -1) + "X"]) {
      const res = await req("/agentpos/api/merchant/summary", bad);
      expect(res.status).toBe(401);
      expect((await read(res)).error.code).toBe("MERCHANT_UNAUTHORIZED");
    }
    // The right token unlocks the same route.
    expect((await req("/agentpos/api/merchant/summary")).status).toBe(200);
  });

  it("paginates orders with an opaque cursor across pages, oldest first", async () => {
    for (const i of [1, 2, 3, 4]) gate.storage.saveOrder(order(i));
    gate.storage.saveOrder(order(5, { status: "pending_payment" }));

    const page1 = await read(await req("/agentpos/api/merchant/orders?limit=2"));
    expect(page1.orders.map((o: Loose) => o.orderId)).toEqual(["ord_1", "ord_2"]);
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.orders[0].rail).toBe("x402-stellar");
    expect(page1.orders[0].txHash).toBe("tx_1");
    expect(page1.orders[0].total).toBe("2");
    expect(page1.orders[0].payment.amountMinor).toBe("20000000");

    const page2 = await read(
      await req(`/agentpos/api/merchant/orders?limit=2&cursor=${page1.nextCursor}`),
    );
    expect(page2.orders.map((o: Loose) => o.orderId)).toEqual(["ord_3", "ord_4"]);
    expect(typeof page2.nextCursor).toBe("string");

    const page3 = await read(
      await req(`/agentpos/api/merchant/orders?limit=2&cursor=${page2.nextCursor}`),
    );
    expect(page3.orders.map((o: Loose) => o.orderId)).toEqual(["ord_5"]);
    expect(page3.nextCursor).toBeNull();

    // Filters: status and date window.
    const paid = await read(await req("/agentpos/api/merchant/orders?status=paid"));
    expect(paid.orders).toHaveLength(4);
    const windowed = await read(
      await req("/agentpos/api/merchant/orders?from=2026-09-02&to=2026-09-03"),
    );
    expect(windowed.orders.map((o: Loose) => o.orderId)).toEqual(["ord_2", "ord_3"]);

    // Typed refusals for bad input.
    expect((await req("/agentpos/api/merchant/orders?status=bogus")).status).toBe(400);
    expect((await req("/agentpos/api/merchant/orders?cursor=!!!")).status).toBe(400);
    expect((await req("/agentpos/api/merchant/orders?limit=0")).status).toBe(400);
  });

  it("returns full order detail including hold and connectorError", async () => {
    const held = order(6, {
      hold: {
        reason: "PAYMENT_MISMATCH",
        details: { mismatch: [{ field: "amount" }] },
        at: "2026-09-06T00:00:00.000Z",
      },
      connectorError: {
        code: "ORDER_NOT_CREATED",
        message: "woo down",
        hint: "Retry from the dashboard.",
        retryable: true,
        attempts: 3,
      },
    });
    delete (held as { externalOrderId?: string }).externalOrderId; // a held order was never pushed
    gate.storage.saveOrder(held);
    const detail = await read(await req("/agentpos/api/merchant/orders/ord_6"));
    expect(detail.order.orderId).toBe("ord_6");
    expect(detail.order.cartId).toBe("cart_6");
    expect(detail.order.hold.reason).toBe("PAYMENT_MISMATCH");
    expect(detail.order.connectorError.code).toBe("ORDER_NOT_CREATED");
    expect(detail.order.buyer.email).toBe("ada@example.com");

    const missing = await req("/agentpos/api/merchant/orders/nope");
    expect(missing.status).toBe(404);
    expect((await read(missing)).error.code).toBe("ORDER_NOT_FOUND");
  });

  it("lists the receipt chain and serves full receipts by seq, matching the chain", async () => {
    const chain = gate.receipts;
    expect(chain).toBeDefined();
    for (const i of [1, 2, 3]) {
      chain?.append({
        event: "order.settled",
        at: new Date().toISOString(),
        order: { id: `ord_${i}`, cartId: `cart_${i}`, status: "paid" },
        adapterVersion: "test",
      });
    }
    const stored = chain?.list() ?? [];
    expect(stored).toHaveLength(3);

    const page1 = await read(await req("/agentpos/api/merchant/receipts?limit=2"));
    expect(page1.receipts.map((r: Loose) => r.seq)).toEqual([1, 2]);
    expect(page1.receipts.map((r: Loose) => r.hash)).toEqual(stored.slice(0, 2).map((r) => r.hash));
    expect(page1.receipts[0]).toMatchObject({ event: "order.settled", orderId: "ord_1" });
    expect(page1.signer).toBe(chain?.signer);
    const page2 = await read(
      await req(`/agentpos/api/merchant/receipts?limit=2&cursor=${page1.nextCursor}`),
    );
    expect(page2.receipts.map((r: Loose) => r.seq)).toEqual([3]);
    expect(page2.nextCursor).toBeNull();

    const detail = await read(await req("/agentpos/api/merchant/receipts/2"));
    expect(detail.receipt.hash).toBe(stored[1]?.hash);
    expect(detail.receipt.signature).toBe(stored[1]?.signature);
    expect(detail.receipt.body.seq).toBe(2);

    const missing = await req("/agentpos/api/merchant/receipts/99");
    expect(missing.status).toBe(404);
    expect((await read(missing)).error.code).toBe("RECEIPT_NOT_FOUND");
    expect((await req("/agentpos/api/merchant/receipts/abc")).status).toBe(400);
  });

  it("serves rules with exactly the /dashboard/rules shape (shared builder)", async () => {
    const dashboard = await read(
      await gate.fetch(new Request("https://shop.test/agentpos/dashboard/rules")),
    );
    const api = await read(await req("/agentpos/api/merchant/rules"));
    expect(api).toEqual(dashboard);
    expect(api.payTo).toBe(payTo);
    expect(api.approvals.channels).toEqual({ webhook: false, whatsapp: false });
  });

  it("summarizes the store in one call: counts, health hosts, adapter version", async () => {
    for (const i of [1, 2]) gate.storage.saveOrder(order(i));
    gate.storage.saveOrder(order(3, { status: "pending_payment" }));
    gate.receipts?.append({
      event: "order.settled",
      at: new Date().toISOString(),
      order: { id: "ord_1", cartId: "cart_1", status: "paid" },
      adapterVersion: "test",
    });

    const summary = await read(await req("/agentpos/api/merchant/summary"));
    expect(summary.store).toEqual({ name: "Test Shop", url: "https://shop.test" });
    expect(summary.network).toBe("stellar:testnet");
    expect(summary.asset).toBe("USDC");
    expect(typeof summary.adapterVersion).toBe("string");
    expect(summary.counts.orders).toEqual({
      total: 3,
      byStatus: { paid: 2, pending_payment: 1 },
    });
    expect(summary.counts.receipts).toBe(1);
    expect(summary.counts.publishedItems).toBe(2);
    expect(summary.facilitator.ok).toBe(true);
    expect(summary.facilitators[0].host).toBe(new URL(core.facilitatorUrl).host);
    expect(summary.receipts.signer).toBe(gate.receipts?.signer);
    expect(summary.receipts.chainHeight).toBe(1);
  });

  it("never leaks the token or facilitator keys, and logs only a token hash", async () => {
    gate.storage.saveOrder(order(1));
    gate.receipts?.append({
      event: "order.settled",
      at: new Date().toISOString(),
      order: { id: "ord_1", cartId: "cart_1", status: "paid" },
      adapterVersion: "test",
    });
    const paths = [
      "/agentpos/api/merchant/summary",
      "/agentpos/api/merchant/orders",
      "/agentpos/api/merchant/orders/ord_1",
      "/agentpos/api/merchant/receipts",
      "/agentpos/api/merchant/receipts/1",
      "/agentpos/api/merchant/rules",
    ];
    for (const path of paths) {
      const res = await req(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(FACILITATOR_KEY);
    }

    const requests = logger.records.filter((r) => r.event === "merchant_api.request");
    expect(requests.length).toBe(paths.length);
    const expectedHash = createHash("sha256").update(TOKEN, "utf8").digest("hex").slice(0, 8);
    for (const record of requests) {
      expect(record.token).toBe(expectedHash);
      expect(typeof record.route).toBe("string");
      expect(record.traceId).toBeTruthy();
    }
    // Nothing anywhere in the structured log carries the token or a facilitator key.
    const allLogs = JSON.stringify(logger.records);
    expect(allLogs).not.toContain(TOKEN);
    expect(allLogs).not.toContain(FACILITATOR_KEY);
  });

  it("rate limits the route group with 429 + Retry-After", async () => {
    const tight = parseSiteConfig({
      ...siteInput,
      rateLimit: { merchantApiPerMinute: 3, burst: 0 },
    });
    const { gate: limited } = buildApp({ token: TOKEN, site: tight });
    const call = () =>
      limited.fetch(
        new Request("https://shop.test/agentpos/api/merchant/rules", {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      );
    for (let i = 0; i < 3; i += 1) expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await read(blocked)).error.code).toBe("RATE_LIMITED");
  });
});
