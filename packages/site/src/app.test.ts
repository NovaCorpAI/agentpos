import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentgate/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentgate/core";
import { createAgentGateApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent, stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const site = parseSiteConfig({
  siteUrl: "https://shop.test",
  displayName: "Test Shop",
  payTo,
  platform: "generic",
  cartTtlMinutes: 1,
});
const core = resolveConfig({ network: "testnet" });

const mug: CatalogItem = {
  id: "mug",
  externalId: "12",
  type: "product",
  title: "Ceramic Mug 350ml",
  descriptionAgent: "White ceramic mug, 350 ml.",
  url: "https://shop.test/product/mug/",
  attributes: { sku: "AG-MUG-350" },
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
  descriptionAgent: "PDF guide, 120 pages.",
  attributes: {},
  physical: false,
  priceUsdc: usdc("2"),
  stockMode: "untracked",
};
const draftItem: CatalogItem = { ...mug, id: "draft-only", status: "draft" };

function connectorMock(): OrderConnector & { created: PaidOrderInput[] } {
  const created: PaidOrderInput[] = [];
  return {
    platform: "generic",
    created,
    getAvailability: async (items) =>
      items.map((i) => ({ itemId: i.itemId, available: i.itemId !== "mug" || i.quantity <= 5 })),
    createOrder: async (input) => {
      created.push(input);
      return {
        externalOrderId: `woo-${created.length}`,
        adminUrl: "https://shop.test/wp-admin/post.php?post=1",
      };
    },
  };
}

const shipping = {
  name: "Ada Lovelace",
  line1: "1 Main St",
  city: "Springfield",
  postalCode: "12345",
  country: "US",
};
const buyer = { email: "ada@example.com" };

describe("site app", () => {
  let connector: ReturnType<typeof connectorMock>;
  let gate: ReturnType<typeof createAgentGateApp>;
  let facilitator: ReturnType<typeof stubFacilitator>;

  beforeEach(() => {
    const storage = new SiteStorage(":memory:");
    for (const item of [mug, ebook, draftItem]) storage.upsertItem(item);
    connector = connectorMock();
    facilitator = stubFacilitator({ txHash: "abc123" });
    gate = createAgentGateApp({ site, core, connector, storage, facilitator });
  });

  const req = (path: string, init?: RequestInit) =>
    gate.fetch(new Request(`https://shop.test${path}`, init));
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
  type Loose = any;
  const read = (r: Response): Promise<Loose> => r.json() as Promise<Loose>;

  it("serves discovery surfaces with only published items", async () => {
    const manifest = await read(await req("/.well-known/ucp"));
    expect(manifest.ucp.payment_handlers[0].id).toBe("x402-stellar");
    const catalog = await read(await req("/agentgate/catalog"));
    expect(catalog.items.map((i: { id: string }) => i.id).sort()).toEqual(["ebook", "mug"]);
    expect(catalog.items[0].price.minor).toMatch(/^\d+$/);
    const feed = await read(await req("/agentgate/feed"));
    expect(feed.products).toHaveLength(2);
    const search = await read(await req("/agentgate/catalog?q=ceramic"));
    expect(search.items).toHaveLength(1);
    expect((await req("/agentgate/items/draft-only")).status).toBe(409);
    expect((await req("/agentgate/items/nope")).status).toBe(404);
  });

  it("quotes carts with integer totals and enforces shipping for physical goods", async () => {
    const missing = await req("/agentgate/cart", json({ items: [{ itemId: "mug", quantity: 2 }] }));
    expect(missing.status).toBe(422);
    expect((await read(missing)).error.code).toBe("SHIPPING_REQUIRED");

    const res = await req(
      "/agentgate/cart",
      json({
        items: [
          { itemId: "mug", quantity: 2 },
          { itemId: "ebook", quantity: 1 },
        ],
        buyer,
        shipping,
      }),
    );
    expect(res.status).toBe(201);
    const cart = await read(res);
    expect(cart.quote.total).toBe("21.8");
    expect(cart.quote.totalMinor).toBe("218000000");
    expect(cart.quote.payTo).toBe(payTo);
    expect(cart.checkout).toBe(`https://shop.test/agentgate/checkout?cart=${cart.cartId}`);

    const digitalOnly = await req(
      "/agentgate/cart",
      json({ items: [{ itemId: "ebook", quantity: 1 }] }),
    );
    expect(digitalOnly.status).toBe(201);
  });

  it("rejects out of stock and unknown items", async () => {
    const oos = await req(
      "/agentgate/cart",
      json({ items: [{ itemId: "mug", quantity: 6 }], buyer, shipping }),
    );
    expect(oos.status).toBe(409);
    const unknown = await req(
      "/agentgate/cart",
      json({ items: [{ itemId: "ghost", quantity: 1 }] }),
    );
    expect(unknown.status).toBe(404);
  });

  it("answers 402 with x402 terms from the cart, then creates the order only after settle", async () => {
    const cart = await read(
      await req(
        "/agentgate/cart",
        json({ items: [{ itemId: "mug", quantity: 1 }], buyer, shipping }),
      ),
    );
    const url = `https://shop.test/agentgate/checkout?cart=${cart.cartId}`;
    // Guardrail 6: at the moment the facilitator settles, no platform order may exist yet.
    let createdAtSettle = -1;
    let pendingAtSettle: string | undefined;
    const originalSettle = facilitator.settle.bind(facilitator);
    facilitator.settle = async (p, r) => {
      createdAtSettle = connector.created.length;
      pendingAtSettle = gate.storage.getOrderByCart(cart.cartId)?.status;
      return originalSettle(p, r);
    };
    const { first, paid, required } = await payLikeAnAgent(gate.fetch, url, { method: "POST" });
    expect(first.status).toBe(402);
    const accept = required!.accepts[0]!;
    expect(accept.payTo).toBe(payTo);
    expect(accept.amount).toBe("99000000");
    expect(accept.network).toBe("stellar:testnet");
    expect(createdAtSettle).toBe(0);
    expect(pendingAtSettle).toBe("pending_payment");

    expect(paid!.status).toBe(200);
    const body = await read(paid!);
    expect(body.orderId).toMatch(/^ord_/);
    expect(paid!.headers.get("payment-response")).toBeTruthy();
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);

    const order = await read(await req(`/agentgate/orders/${body.orderId}`));
    expect(order.status).toBe("paid");
    expect(order.payment.txHash).toBe("abc123");
    expect(order.externalOrderId).toBe("woo-1");
    expect(connector.created).toHaveLength(1);
    expect(connector.created[0]!.payment.txHash).toBe("abc123");
    expect(connector.created[0]!.shipping?.country).toBe("US");
  });

  it("is idempotent per tx hash and never creates a platform order twice", async () => {
    const cart = await read(
      await req("/agentgate/cart", json({ items: [{ itemId: "ebook", quantity: 1 }] })),
    );
    const url = `https://shop.test/agentgate/checkout?cart=${cart.cartId}`;
    await payLikeAnAgent(gate.fetch, url, { method: "POST" });
    await payLikeAnAgent(gate.fetch, url, { method: "POST" });
    expect(connector.created).toHaveLength(1);
    expect(gate.storage.listOrders()).toHaveLength(1);
  });

  it("keeps the payment and marks the order for retry when the connector fails", async () => {
    connector.createOrder = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { retryable: true });
    });
    const cart = await read(
      await req("/agentgate/cart", json({ items: [{ itemId: "ebook", quantity: 1 }] })),
    );
    const { paid } = await payLikeAnAgent(
      gate.fetch,
      `https://shop.test/agentgate/checkout?cart=${cart.cartId}`,
      { method: "POST" },
    );
    const body = await read(paid!);
    const order = await read(await req(`/agentgate/orders/${body.orderId}`));
    expect(order.status).toBe("paid");
    expect(order.externalOrderId).toBeUndefined();
    expect(order.connectorError.code).toBe("ORDER_NOT_CREATED");
    expect(order.payment.txHash).toBe("abc123");

    connector.createOrder = async () => ({ externalOrderId: "late-1" });
    const retried = await gate.checkout.retryConnector(body.orderId);
    expect(retried.externalOrderId).toBe("late-1");
  });

  it("does not settle-create anything when the facilitator rejects settlement", async () => {
    facilitator = stubFacilitator({ failSettle: true });
    gate = createAgentGateApp({ site, core, connector, storage: gate.storage, facilitator });
    const cart = await read(
      await req("/agentgate/cart", json({ items: [{ itemId: "ebook", quantity: 1 }] })),
    );
    const { paid } = await payLikeAnAgent(
      gate.fetch,
      `https://shop.test/agentgate/checkout?cart=${cart.cartId}`,
      { method: "POST" },
    );
    expect(paid!.status).toBe(402);
    expect(connector.created).toHaveLength(0);
    const orders = gate.storage.listOrders();
    expect(orders[0]?.status).toBe("pending_payment");
  });

  it("returns precise errors for missing or expired carts before any 402", async () => {
    expect((await req("/agentgate/checkout", { method: "POST" })).status).toBe(400);
    expect((await req("/agentgate/checkout?cart=nope", { method: "POST" })).status).toBe(404);
    const cart = await read(
      await req("/agentgate/cart", json({ items: [{ itemId: "ebook", quantity: 1 }] })),
    );
    const stored = gate.storage.getCart(cart.cartId)!;
    gate.storage.saveCart({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await req(`/agentgate/checkout?cart=${cart.cartId}`, { method: "POST" })).status).toBe(
      410,
    );
  });

  it("exposes MCP tools for discovery and carts", async () => {
    const call = (method: string, params: unknown, id = 1) =>
      req("/agentgate/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    const init = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.status).toBe(200);
    const list = await read(await call("tools/list", {}, 2));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        "search_items",
        "get_item",
        "create_cart",
        "get_order",
        "get_payment_instructions",
      ]),
    );
    const search = await read(
      await call("tools/call", { name: "search_items", arguments: { query: "mug" } }, 3),
    );
    expect(search.result.structuredContent.items[0].id).toBe("mug");
    const cart = await read(
      await call(
        "tools/call",
        { name: "create_cart", arguments: { items: [{ itemId: "ebook", quantity: 2 }] } },
        4,
      ),
    );
    expect(cart.result.structuredContent.quote.total).toBe("4");
  });
});
