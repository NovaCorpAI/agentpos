/**
 * The same cart, paid two ways. x402 is covered in app.test.ts; this file proves the card rail
 * end to end against a fake Transbank: the cart advertises both rails, a card checkout hands the
 * payment page to the human, the return settles exactly once and the order lands in the
 * merchant's platform with a CLP payment record, receipts included. Oneclick charges an enrolled
 * card with no human step. Nothing here touches a real acquirer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createTransbankRail,
  resolveConfig,
  usdc,
  validateUcpBusinessProfile,
} from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { buildReconciliationCsv } from "./export.js";

const payTo = Keypair.random().publicKey();
const site = parseSiteConfig({
  siteUrl: "https://tienda.test",
  displayName: "Tienda de prueba",
  payTo,
  platform: "generic",
  cartTtlMinutes: 1,
  fiatCurrency: "CLP",
  transbank: {
    environment: "integration",
    oneclick: { mallCode: "597055555541", childCommerceCode: "597055555542" },
  },
});
const core = resolveConfig({ network: "testnet" });

/** A mug the scanner priced from the store: 14.990 pesos, confirmed at 9.9 USDC. */
const mug: CatalogItem = {
  id: "mug",
  externalId: "12",
  type: "product",
  title: "Taza de cerámica 350 ml",
  descriptionAgent: "Taza blanca de cerámica, 350 ml.",
  url: "https://tienda.test/product/mug/",
  attributes: { sku: "AG-MUG-350" },
  priceUsdc: usdc("9.9"),
  priceSrc: { amount: "14990", currency: "CLP" },
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};
/** An item with no source price: a cart holding it has no fiat quote and cannot go by card. */
const { priceSrc: _priceSrc, ...mugWithoutSource } = mug;
const noFiat: CatalogItem = { ...mugWithoutSource, id: "sin-precio-origen", externalId: "13" };

function connectorMock(): OrderConnector & { created: PaidOrderInput[] } {
  const created: PaidOrderInput[] = [];
  return {
    platform: "generic",
    created,
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async (input) => {
      created.push(input);
      return {
        externalOrderId: `woo-${created.length}`,
        adminUrl: "https://tienda.test/wp-admin/post.php?post=1",
      };
    },
  };
}

type Reply = { status: number; body: unknown } | Error;

/** Fake Transbank: replies in order, remembers every request. */
function fakeTransbank(replies: Reply[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies.shift();
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("fake Transbank: no reply queued");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const created = {
  status: 200,
  body: { token: "tok_1", url: "https://webpay3gint.transbank.cl/webpayserver/initTransaction" },
};
const authorized = (amount = 14990) => ({
  status: 200,
  body: {
    status: "AUTHORIZED",
    response_code: 0,
    authorization_code: "1213",
    amount,
    buy_order: "will-be-overridden",
    vci: "TSY",
  },
});

describe("card checkout: the same cart, paid by card", () => {
  let connector: ReturnType<typeof connectorMock>;
  let storage: SiteStorage;

  function build(replies: Reply[]) {
    const fake = fakeTransbank(replies);
    const rail = createTransbankRail({
      environment: "integration",
      commerceCode: "597055555532",
      apiKey: "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C",
      oneclick: { mallCode: "597055555541", childCommerceCode: "597055555542" },
      fetchImpl: fake.fetchImpl,
      // Deterministic buy orders so the fake's AUTHORIZED replies can name them.
      buyOrderFor: (input) => `bo-${input.reference}`,
    });
    const gate = createAgentPOSApp({ site, core, connector, storage, rails: [rail] });
    const req = (path: string, init?: RequestInit) =>
      gate.fetch(new Request(`https://tienda.test${path}`, init));
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON access
    type Loose = any;
    const read = (r: Response): Promise<Loose> => r.json() as Promise<Loose>;
    return { gate, req, json, read, calls: fake.calls, replies };
  }

  beforeEach(() => {
    storage = new SiteStorage(":memory:");
    for (const item of [mug, noFiat]) storage.upsertItem(item);
    connector = connectorMock();
  });

  it("advertises both ways to pay on the cart, with the fiat total summed from source prices", async () => {
    const { req, json, read } = build([]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 2 }] })),
    );
    expect(cart.quote.totalFiat).toEqual({ currency: "CLP", minor: "29980", amount: "29980" });
    expect(cart.payments.map((p: { rail: string }) => p.rail)).toEqual([
      "org.x402.stellar",
      "cl.transbank.webpay",
    ]);
    const card = cart.payments[1];
    expect(card).toMatchObject({
      currency: "CLP",
      totalMinor: "29980",
      total: "29980",
      settlesOnLedger: false,
      method: "POST",
    });
    expect(card.url).toBe(`https://tienda.test/agentpos/checkout/card?cart=${cart.cartId}`);
    // Never a float, never a conversion: 2 x 14990 pesos, straight from the source price.
    expect(JSON.stringify(cart)).not.toContain("14990.");
  });

  it("publishes the card rail in discovery as a second payment handler, with no secrets", async () => {
    const { req, read } = build([]);
    const profile = await read(await req("/.well-known/ucp"));
    expect(validateUcpBusinessProfile(profile).errors).toEqual([]);
    const handlers = profile.ucp.payment_handlers;
    expect(Object.keys(handlers)).toContain("cl.transbank.webpay");
    const [card] = handlers["cl.transbank.webpay"];
    expect(card.available_instruments).toEqual([{ type: "card" }]);
    expect(card.config).toMatchObject({
      currencies: ["CLP"],
      settlesOnLedger: false,
      checkout: "https://tienda.test/agentpos/checkout/card",
    });
    expect(JSON.stringify(profile)).not.toContain("597055555532");
    expect(JSON.stringify(profile)).not.toContain("579B532A");
  });

  it("hands the payment page to the human, then settles once on return and creates the order", async () => {
    const { req, json, read, calls, replies } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );

    const started = await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    expect(started.status).toBe(202);
    const body = await read(started);
    expect(body).toMatchObject({
      status: "pending_payment",
      rail: "cl.transbank.webpay",
      currency: "CLP",
      totalMinor: "14990",
    });
    expect(body.pay).toMatchObject({
      url: created.body.url,
      method: "POST",
      form: { token_ws: "tok_1" },
      expiresInSeconds: 300,
    });
    // The rail was asked for exactly the fiat total, as an integer, with our return URL.
    expect(calls[0]?.body).toMatchObject({
      amount: 14990,
      return_url: `https://tienda.test/agentpos/checkout/card/return?cart=${cart.cartId}`,
    });
    const pending = await read(await req(`/agentpos/orders/${body.orderId}`));
    expect(pending.status).toBe("pending_payment");
    expect(connector.created).toHaveLength(0);

    // The human paid; Transbank sends them back with the token. Status, then commit.
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    const back = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&token_ws=tok_1`, {
      headers: { accept: "application/json" },
    });
    expect(back.status).toBe(200);
    const paid = await read(back);
    expect(paid.status).toBe("paid");
    expect(paid.externalOrderId).toBe("woo-1");
    expect(paid.payment).toMatchObject({
      rail: "cl.transbank.webpay",
      asset: "CLP",
      amountMinor: "14990",
      decimals: 0,
      network: "transbank:integration",
      txHash: `bo-${cart.cartId}`,
    });

    // The platform got a CLP payment record, not a USDC one.
    const input = connector.created[0] as PaidOrderInput;
    expect(input.payment.rail).toBe("cl.transbank.webpay");
    expect(input.payment.asset).toBe("CLP");
    expect(input.payment.amountMinor).toBe(14990n);
    expect(input.payment.decimals).toBe(0);

    // A second return with the same token must not commit twice (guardrail 6).
    const again = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&token_ws=tok_1`, {
      headers: { accept: "application/json" },
    });
    expect(again.status).toBe(200);
    expect((await read(again)).status).toBe("paid");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(connector.created).toHaveLength(1);
  });

  it("shows the person a page when they come back in a browser", async () => {
    const { req, json, read, replies } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    const form = new URLSearchParams({ token_ws: "tok_1" });
    const back = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toContain("text/html");
    const html = await back.text();
    expect(html).toContain("Pago recibido");
    expect(html).toContain("woo-1");
    expect(html).not.toContain("<script");
  });

  it("records a refused card as a failed order and creates nothing", async () => {
    const { req, json, read, replies } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    const started = await read(
      await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" }),
    );
    replies.push({
      status: 200,
      body: { status: "FAILED", response_code: -1, amount: 14990, buy_order: `bo-${cart.cartId}` },
    });
    const back = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&token_ws=tok_1`, {
      headers: { accept: "application/json" },
    });
    expect(back.status).toBeGreaterThanOrEqual(400);
    const err = await read(back);
    expect(err.error.code).toBe("PAYMENT_REJECTED");
    expect(connector.created).toHaveLength(0);
    const order = await read(await req(`/agentpos/orders/${started.orderId}`));
    expect(order.status).not.toBe("paid");
  });

  it("holds an order whose authorized amount differs from the fiat quote", async () => {
    const { req, json, read, replies } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    // Status says 14990 (verify passes), the commit reports 14000: the rail refuses to settle it.
    replies.push({
      status: 200,
      body: { ...authorized(14990).body, buy_order: `bo-${cart.cartId}` },
    });
    replies.push({
      status: 200,
      body: { ...authorized(14000).body, buy_order: `bo-${cart.cartId}` },
    });
    const back = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&token_ws=tok_1`, {
      headers: { accept: "application/json" },
    });
    const err = await read(back);
    expect(err.error.code).toBe("PAYMENT_MISMATCH");
    expect(connector.created).toHaveLength(0);
  });

  it("aborted by the buyer: nothing charged, order failed", async () => {
    const { req, json, read } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    const back = await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&TBK_TOKEN=tok_1`, {
      headers: { accept: "application/json" },
    });
    expect((await read(back)).error.code).toBe("SETTLEMENT_FAILED");
    expect(connector.created).toHaveLength(0);
  });

  it("charges an enrolled card with no human step (Oneclick), same order shape", async () => {
    const approved = {
      status: 200,
      body: {
        details: [
          {
            status: "AUTHORIZED",
            response_code: 0,
            authorization_code: "1213",
            amount: 14990,
            commerce_code: "597055555542",
          },
        ],
      },
    };
    const { req, json, read, calls } = build([approved]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    const res = await req(
      `/agentpos/checkout/card?cart=${cart.cartId}`,
      json({ enrolment: { username: "cliente-42", tbkUser: "tbk_user_abc" } }),
    );
    expect(res.status).toBe(200);
    const paid = await read(res);
    expect(paid.status).toBe("paid");
    expect(paid.payment).toMatchObject({
      rail: "cl.transbank.webpay",
      asset: "CLP",
      amountMinor: "14990",
      payer: "cliente-42",
    });
    expect(calls[0]?.url).toContain("/oneclick/v1.2/transactions");
    expect(calls[0]?.body).toMatchObject({
      username: "cliente-42",
      tbk_user: "tbk_user_abc",
      details: [{ amount: 14990, commerce_code: "597055555542" }],
    });
    expect(connector.created).toHaveLength(1);
  });

  it("refuses a card checkout for a cart with no fiat quote, before touching the rail", async () => {
    const { req, json, read, calls } = build([]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "sin-precio-origen", quantity: 1 }] })),
    );
    expect(cart.quote.totalFiat).toBeUndefined();
    expect(cart.payments.map((p: { rail: string }) => p.rail)).toEqual(["org.x402.stellar"]);
    const res = await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await read(res)).error.code).toBe("RAIL_UNSUPPORTED");
    expect(calls).toHaveLength(0);
  });

  it("reconciles a card order as its own rail, in whole pesos", async () => {
    const { req, json, read, replies } = build([created]);
    const cart = await read(
      await req("/agentpos/cart", json({ items: [{ itemId: "mug", quantity: 1 }] })),
    );
    await req(`/agentpos/checkout/card?cart=${cart.cartId}`, { method: "POST" });
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    replies.push({ status: 200, body: { ...authorized().body, buy_order: `bo-${cart.cartId}` } });
    await req(`/agentpos/checkout/card/return?cart=${cart.cartId}&token_ws=tok_1`, {
      headers: { accept: "application/json" },
    });
    const csv = buildReconciliationCsv(storage.listOrders(), "es");
    const row = csv.split("\n").find((l) => l.includes(`bo-${cart.cartId}`)) ?? "";
    expect(row).toContain("transbank-webpay");
    expect(row).toContain(",14990,");
    expect(row).toContain(",CLP,");
  });

  it("keeps the wallet rail exactly as before when no card rail is configured", async () => {
    const gate = createAgentPOSApp({
      site: { ...site, transbank: undefined },
      core,
      connector,
      storage,
    });
    const res = await gate.fetch(
      new Request("https://tienda.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ itemId: "mug", quantity: 1 }] }),
      }),
    );
    const cart = (await res.json()) as { payments: Array<{ rail: string }>; cartId: string };
    expect(cart.payments.map((p) => p.rail)).toEqual(["org.x402.stellar"]);
    const card = await gate.fetch(
      new Request(`https://tienda.test/agentpos/checkout/card?cart=${cart.cartId}`, {
        method: "POST",
      }),
    );
    expect(card.status).toBe(404);
  });
});
