/**
 * G3: what an agent that was never told this store exists can find on its own. The ecosystem's
 * crawlers read `{origin}/openapi.json` first and fall back to the runtime 402, so the two must
 * agree: the document must declare paid and free endpoints correctly, and the 402 it promises
 * must actually arrive.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import type { AgentPOSSite } from "./app.js";
import { parseSiteConfig } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent, stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });

const mug: CatalogItem = {
  id: "mug",
  type: "product",
  title: "Ceramic Mug",
  descriptionAgent: "White ceramic mug, 350 ml.",
  url: "https://shop.test/product/mug/",
  attributes: {},
  priceUsdc: usdc("9.9"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};
const ebook: CatalogItem = { ...mug, id: "ebook", title: "E-book", priceUsdc: usdc("2") };

function connectorMock(): OrderConnector {
  const created: PaidOrderInput[] = [];
  return {
    platform: "generic",
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
  storage.upsertItem(mug);
  storage.upsertItem(ebook);
  return createAgentPOSApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    facilitator: stubFacilitator(),
    receiptSecret: Keypair.random().secret(),
  });
}

type Doc = {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  "x-agentpos": Record<string, unknown>;
};

async function openapi(gate: AgentPOSSite, path = "/openapi.json"): Promise<Doc> {
  const res = await gate.fetch(new Request(`https://shop.test${path}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Doc;
}

describe("OpenAPI discovery document", () => {
  it("is served at the origin root, where the crawlers look", async () => {
    const doc = await openapi(makeSite());
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("https://shop.test");
    expect(doc.info["x-guidance"]).toContain("/agentpos/cart");
    expect(doc["x-agentpos"].publishedItems).toBe(2);
  });

  it("is also served under the base path, for sites that proxy only /agentpos", async () => {
    const root = await openapi(makeSite());
    const scoped = await openapi(makeSite(), "/agentpos/openapi.json");
    expect(scoped.paths).toEqual(root.paths);
  });

  it("declares checkout as paid, with dynamic pricing in decimal USD", async () => {
    const doc = await openapi(makeSite());
    const checkout = doc.paths["/agentpos/checkout"]?.post as Record<string, unknown>;
    const payment = checkout["x-payment-info"] as {
      price: { mode: string; currency: string; min: string; max: string };
      protocols: Array<Record<string, unknown>>;
    };
    expect(payment.price.mode).toBe("dynamic");
    expect(payment.price.currency).toBe("USD");
    // The catalog spans 2 to 9.9 USDC, and x-payment-info is decimal dollars, NOT atomic units.
    expect(payment.price.min).toBe("2");
    expect(payment.price.max).toBe("9.9");
    expect(payment.protocols[0]).toHaveProperty("x402");
    expect(checkout).toHaveProperty("responses.402");
    // A paid operation must NOT be marked free.
    expect(checkout.security).toBeUndefined();
  });

  it("marks every free endpoint with an empty security array so crawlers skip it", async () => {
    const doc = await openapi(makeSite());
    const free = [
      "/agentpos/catalog",
      "/agentpos/cart",
      "/agentpos/feed",
      "/agentpos/health",
      "/agentpos/orders/{orderId}",
    ];
    for (const path of free) {
      const op = Object.values(doc.paths[path] ?? {})[0] as Record<string, unknown> | undefined;
      expect(op, `${path} must be declared`).toBeDefined();
      expect(op?.security, `${path} must declare security: []`).toEqual([]);
    }
  });

  it("describes only what this store actually serves", async () => {
    const withReceipts = await openapi(makeSite());
    expect(withReceipts.paths).toHaveProperty("/agentpos/orders/{orderId}/receipt");
    expect((withReceipts.info["x-guidance"] as string).includes("signed receipt")).toBe(true);

    const bare = await openapi(
      makeSite({ receipts: { enabled: false }, approvals: { enabled: false } }),
    );
    expect(bare.paths).not.toHaveProperty("/agentpos/orders/{orderId}/receipt");
    const checkout = bare.paths["/agentpos/checkout"]?.post as Record<string, unknown>;
    expect(checkout.responses).not.toHaveProperty("202");
  });

  it("agrees with the runtime: the endpoint it calls paid really answers 402", async () => {
    const gate = makeSite();
    const cartRes = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ itemId: "mug", quantity: 1 }] }),
      }),
    );
    const { cartId } = (await cartRes.json()) as { cartId: string };
    const paid = await gate.fetch(
      new Request(`https://shop.test/agentpos/checkout?cart=${cartId}`, { method: "POST" }),
    );
    expect(paid.status).toBe(402);

    // And the free ones really are free: they answer, and never with a payment demand.
    for (const path of ["/agentpos/catalog", "/agentpos/feed"]) {
      expect((await gate.fetch(new Request(`https://shop.test${path}`))).status).toBe(200);
    }
    // Health reports its own verdict (200 healthy / 503 degraded) and is never paywalled; with no
    // facilitator reachable from a test process it is legitimately 503.
    expect([200, 503]).toContain(
      (await gate.fetch(new Request("https://shop.test/agentpos/health"))).status,
    );
  });
});

describe("llms.txt", () => {
  it("tells an agent how to buy, in the order it has to do it", async () => {
    const res = await makeSite().fetch(new Request("https://shop.test/llms.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("# Test Shop");
    expect(text.indexOf("/agentpos/catalog")).toBeLessThan(text.indexOf("/agentpos/cart"));
    expect(text.indexOf("/agentpos/cart")).toBeLessThan(text.indexOf("/agentpos/checkout"));
    expect(text).toContain("https://shop.test/openapi.json");
    expect(text).toContain("https://shop.test/.well-known/ucp");
    expect(text).toContain("Items published: 2");
  });

  it("does not advertise a receipt endpoint a store has turned off", async () => {
    const res = await makeSite({ receipts: { enabled: false } }).fetch(
      new Request("https://shop.test/llms.txt"),
    );
    expect(await res.text()).not.toContain("/receipt");
  });
});

describe("public metrics (G2)", () => {
  it("publishes aggregates and nothing that identifies a buyer", async () => {
    const gate = makeSite();
    // Two settled orders.
    for (const itemId of ["mug", "ebook"]) {
      const cartRes = await gate.fetch(
        new Request("https://shop.test/agentpos/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [{ itemId, quantity: 1 }],
            buyer: { email: "ada@example.com" },
          }),
        }),
      );
      const { cartId } = (await cartRes.json()) as { cartId: string };
      await payLikeAnAgent(
        gate.fetch,
        `https://shop.test/agentpos/checkout?cart=${cartId}`,
        { method: "POST" },
      );
    }

    const res = await gate.fetch(new Request("https://shop.test/agentpos/metrics"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paidOrders: number;
      total: string;
      uniquePayers: number;
      latencyMs: { samples: number; p50?: number; p95?: number };
      byDay: Array<{ day: string; orders: number; total: string }>;
      heldOrders: number;
      pendingPlatformOrders: number;
    };
    expect(body.paidOrders).toBe(2);
    expect(body.total).toBe("11.9");
    expect(body.uniquePayers).toBe(1); // the stub facilitator always reports the same payer
    expect(body.byDay[0]?.orders).toBe(2);
    expect(body.latencyMs.samples).toBe(2);
    expect(body.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(body.heldOrders).toBe(0);
    expect(body.pendingPlatformOrders).toBe(0);

    // Nothing that identifies a buyer may appear anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ada@example.com");
    expect(raw).not.toContain("GPAYER");
    expect(raw).not.toContain("cart_");
    expect(raw).not.toContain("ord_");
  });

  it("answers with zeroes for a store that has sold nothing", async () => {
    const res = await makeSite().fetch(new Request("https://shop.test/agentpos/metrics?days=7"));
    const body = (await res.json()) as {
      paidOrders: number;
      total: string;
      windowDays: number;
      latencyMs: { samples: number; p50?: number };
    };
    expect(body.paidOrders).toBe(0);
    expect(body.total).toBe("0");
    expect(body.windowDays).toBe(7);
    // No samples means no percentile, not a fake zero.
    expect(body.latencyMs.samples).toBe(0);
    expect(body.latencyMs.p50).toBeUndefined();
  });
});

describe("the store's own dashboard (G2)", () => {
  it("serves a self-contained page from the store's domain", async () => {
    const res = await makeSite().fetch(new Request("https://shop.test/agentpos/dashboard"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Test Shop");
    expect(html).toContain("/agentpos/metrics");
    // Self-contained: no external scripts, styles or fonts. It must work behind any CSP and
    // leak nothing about who views it.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
  });

  it("escapes the store name so a merchant cannot inject markup into their own page", async () => {
    const gate = makeSite({ displayName: 'Shop <script>alert(1)</script>' });
    const html = await (await gate.fetch(new Request("https://shop.test/agentpos/dashboard"))).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("metrics answers with open CORS so browser pages can read the aggregates", async () => {
    const res = await makeSite().fetch(new Request("https://shop.test/agentpos/metrics"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
