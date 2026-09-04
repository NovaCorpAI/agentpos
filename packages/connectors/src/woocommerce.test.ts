import { describe, expect, it, vi } from "vitest";
import { AgentPOSError, usdc } from "@agentpos/core";
import { WooCommerceConnector, stripHtml } from "./woocommerce.js";

const product = {
  id: 12,
  name: "Ceramic Mug 350ml",
  permalink: "https://shop.example/product/mug",
  sku: "AG-MUG-350",
  status: "publish",
  virtual: false,
  price: "9.90",
  short_description: "<p>White ceramic mug, <strong>350 ml</strong></p>",
  manage_stock: true,
  stock_quantity: 50,
  stock_status: "instock",
  images: [{ src: "https://shop.example/mug.jpg" }],
  attributes: [{ name: "Color", options: ["White"] }],
};

function mockFetch(
  routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("{}", { status: 404 });
    const { status = 200, body } = routes[key]!(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("WooCommerceConnector", () => {
  it("refuses plain http unless explicitly allowed", () => {
    expect(
      () =>
        new WooCommerceConnector({
          baseUrl: "http://shop.example",
          consumerKey: "a",
          consumerSecret: "b",
        }),
    ).toThrowError(AgentPOSError);
    expect(
      () =>
        new WooCommerceConnector({
          baseUrl: "http://localhost:8080",
          consumerKey: "a",
          consumerSecret: "b",
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });

  it("lists products with currency, stock, evidence-friendly fields", async () => {
    const fetchImpl = mockFetch({
      "/settings/general/woocommerce_currency": () => ({ body: { value: "USD" } }),
      "/products?": () => ({ body: [product] }),
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const items = await c.listProducts();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "12",
      title: "Ceramic Mug 350ml",
      description: "White ceramic mug, 350 ml",
      price: { amount: "9.90", currency: "USD" },
      stock: { managed: true, quantity: 50, inStock: true },
      physical: true,
      attributes: { Color: "White", sku: "AG-MUG-350" },
    });
    const authHeader = (fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)
      .authorization;
    expect(authHeader).toBe(`Basic ${Buffer.from("k:s").toString("base64")}`);
  });

  it("reports availability against live stock", async () => {
    const fetchImpl = mockFetch({
      "/settings/general/woocommerce_currency": () => ({ body: { value: "USD" } }),
      "/products/12": () => ({ body: { ...product, stock_quantity: 1 } }),
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const [ok, short, unknown] = await c.getAvailability([
      { itemId: "mug", externalId: "12", quantity: 1 },
      { itemId: "mug2", externalId: "12", quantity: 5 },
      { itemId: "noid", quantity: 1 },
    ]);
    expect(ok?.available).toBe(true);
    expect(short?.available).toBe(false);
    expect(unknown?.available).toBe(false);
  });

  it("creates a paid order with on-chain metadata and returns the admin url", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch({
      "/orders": (init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { id: 77, status: "processing" } };
      },
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const res = await c.createOrder({
      orderId: "ord_1",
      lines: [
        {
          itemId: "mug",
          externalId: "12",
          title: "Mug",
          quantity: 2,
          unitPriceUsdc: usdc("9.9"),
          lineTotalUsdc: usdc("19.8"),
          physical: true,
        },
      ],
      totalUsdc: usdc("19.8"),
      payment: {
        txHash: "abc",
        network: "stellar:testnet",
        asset: "USDC",
        amountMinor: usdc("19.8"),
        payer: "GPAYER",
        ts: "2026-08-25T00:00:00Z",
      },
      buyer: { email: "buyer@example.com", name: "Ada Lovelace" },
      shipping: {
        name: "Ada Lovelace",
        line1: "1 Main St",
        city: "Springfield",
        postalCode: "12345",
        country: "US",
      },
      createdAt: "2026-08-25T00:00:00Z",
    });
    expect(res).toEqual({
      externalOrderId: "77",
      adminUrl: "https://shop.example/wp-admin/post.php?post=77&action=edit",
    });
    expect(sent).toMatchObject({
      set_paid: true,
      payment_method: "agentpos",
      transaction_id: "abc",
      line_items: [{ product_id: 12, quantity: 2 }],
      shipping: { first_name: "Ada", last_name: "Lovelace", country: "US" },
      billing: { email: "buyer@example.com" },
    });
    const meta = sent!.meta_data as Array<{ key: string; value: string }>;
    expect(meta.find((m) => m.key === "_agentpos_amount_minor")?.value).toBe("198000000");
  });

  it("maps HTTP failures to typed, retryable-aware errors", async () => {
    const fetchImpl = mockFetch({ "/orders": () => ({ status: 503, body: { message: "down" } }) });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    try {
      await c.createOrder({
        orderId: "o",
        lines: [
          {
            itemId: "x",
            externalId: "1",
            title: "x",
            quantity: 1,
            unitPriceUsdc: usdc("1"),
            lineTotalUsdc: usdc("1"),
            physical: false,
          },
        ],
        totalUsdc: usdc("1"),
        payment: {
          txHash: "t",
          network: "stellar:testnet",
          asset: "USDC",
          amountMinor: usdc("1"),
          ts: "now",
        },
        createdAt: "now",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).retryable).toBe(true);
    }
  });

  it("expands a variable product into one item per purchasable variation", async () => {
    const parent = {
      id: 30,
      name: "Cuadro 30x40",
      permalink: "https://shop.example/product/cuadro",
      sku: "CU-3040",
      status: "publish",
      type: "variable",
      price: "15.00",
      short_description: "<p>Marco de madera 30x40</p>",
      manage_stock: true,
      stock_quantity: 12,
      stock_status: "instock",
      images: [{ src: "https://shop.example/cuadro.jpg" }],
      attributes: [
        { name: "Passepartout", options: ["con", "sin"] },
        { name: "Fondo", options: ["blanco", "negro"] },
      ],
    };
    const variations = [
      {
        id: 301,
        permalink: "https://shop.example/product/cuadro?attribute_fondo=blanco",
        sku: "CU-3040-CB",
        status: "publish",
        purchasable: true,
        price: "19.90",
        manage_stock: true,
        stock_quantity: 7,
        stock_status: "instock",
        image: { src: "https://shop.example/cuadro-blanco.jpg" },
        attributes: [
          { name: "Passepartout", option: "con" },
          { name: "Fondo", option: "blanco" },
        ],
      },
      {
        id: 302,
        status: "publish",
        purchasable: true,
        price: "",
        manage_stock: "parent",
        stock_quantity: null,
        stock_status: "instock",
        attributes: [
          { name: "Passepartout", option: "sin" },
          { name: "Fondo", option: "negro" },
        ],
      },
      // Not purchasable (e.g. no price set): must be skipped.
      { id: 303, status: "publish", purchasable: false, attributes: [] },
      // Disabled by the merchant: must be skipped.
      { id: 304, status: "private", purchasable: true, price: "9.00", attributes: [] },
    ];
    const fetchImpl = mockFetch({
      "/settings/general/woocommerce_currency": () => ({ body: { value: "USD" } }),
      "/products/30/variations": () => ({ body: variations }),
      "/products?": () => ({ body: [parent] }),
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const items = await c.listProducts();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "301",
      title: "Cuadro 30x40 — Passepartout: con — Fondo: blanco",
      url: "https://shop.example/product/cuadro?attribute_fondo=blanco",
      imageUrl: "https://shop.example/cuadro-blanco.jpg",
      sku: "CU-3040-CB",
      price: { amount: "19.90", currency: "USD" },
      stock: { managed: true, quantity: 7, inStock: true },
      attributes: {
        Passepartout: "con",
        Fondo: "blanco",
        parent_id: "30",
        parent_sku: "CU-3040",
        sku: "CU-3040-CB",
      },
    });
    // Variation 302: price falls back to the parent, stock is inherited (manage_stock "parent"),
    // sku falls back to the parent sku.
    expect(items[1]).toMatchObject({
      externalId: "302",
      title: "Cuadro 30x40 — Passepartout: sin — Fondo: negro",
      url: "https://shop.example/product/cuadro",
      imageUrl: "https://shop.example/cuadro.jpg",
      price: { amount: "15.00", currency: "USD" },
      stock: { managed: true, quantity: 12, inStock: true },
      attributes: { Passepartout: "sin", Fondo: "negro", parent_id: "30", parent_sku: "CU-3040" },
    });
  });

  it("reports availability for a variation id, following inherited stock to the parent", async () => {
    const variation = (id: number, extra: Record<string, unknown>) => ({
      id,
      name: "Cuadro 30x40 - con, blanco",
      permalink: "https://shop.example/product/cuadro",
      status: "publish",
      type: "variation",
      parent_id: 30,
      price: "19.90",
      stock_status: "instock",
      attributes: [{ name: "Fondo", option: "blanco" }],
      ...extra,
    });
    const fetchImpl = mockFetch({
      "/settings/general/woocommerce_currency": () => ({ body: { value: "USD" } }),
      "/products/301": () => ({ body: variation(301, { manage_stock: true, stock_quantity: 3 }) }),
      "/products/302": () => ({
        body: variation(302, { manage_stock: "parent", stock_quantity: null }),
      }),
      "/products/30": () => ({
        body: {
          id: 30,
          name: "Cuadro 30x40",
          permalink: "https://shop.example/product/cuadro",
          type: "variable",
          manage_stock: true,
          stock_quantity: 12,
          stock_status: "instock",
          status: "publish",
        },
      }),
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const [own, ownShort, inherited, inheritedShort] = await c.getAvailability([
      { itemId: "a", externalId: "301", quantity: 2 },
      { itemId: "b", externalId: "301", quantity: 5 },
      { itemId: "c", externalId: "302", quantity: 12 },
      { itemId: "d", externalId: "302", quantity: 13 },
    ]);
    expect(own).toMatchObject({
      available: true,
      quantity: 3,
      price: { amount: "19.90", currency: "USD" },
    });
    expect(ownShort?.available).toBe(false);
    expect(inherited).toMatchObject({ available: true, quantity: 12 });
    expect(inheritedShort?.available).toBe(false);
  });

  it("creates order lines with product_id + variation_id for variations", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch({
      "/products/301": () => ({ body: { id: 301, type: "variation", parent_id: 30 } }),
      "/products/12": () => ({ body: { id: 12, type: "simple", parent_id: 0 } }),
      "/orders": (init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { id: 88, status: "processing" } };
      },
    });
    const c = new WooCommerceConnector({
      baseUrl: "https://shop.example",
      consumerKey: "k",
      consumerSecret: "s",
      fetchImpl,
    });
    const line = (itemId: string, externalId: string, quantity: number) => ({
      itemId,
      externalId,
      title: itemId,
      quantity,
      unitPriceUsdc: usdc("1"),
      lineTotalUsdc: usdc("1"),
      physical: false,
    });
    const res = await c.createOrder({
      orderId: "ord_2",
      lines: [line("cuadro", "301", 1), line("mug", "12", 2)],
      totalUsdc: usdc("2"),
      payment: {
        txHash: "def",
        network: "stellar:testnet",
        asset: "USDC",
        amountMinor: usdc("2"),
        ts: "2026-09-04T00:00:00Z",
      },
      createdAt: "2026-09-04T00:00:00Z",
    });
    expect(res.externalOrderId).toBe("88");
    expect(sent?.line_items).toEqual([
      { product_id: 30, variation_id: 301, quantity: 1 },
      { product_id: 12, quantity: 2 },
    ]);
  });

  it("strips html", () => {
    expect(stripHtml("<p>Hello&nbsp;<b>world</b> &amp; more</p>")).toBe("Hello world & more");
  });
});
