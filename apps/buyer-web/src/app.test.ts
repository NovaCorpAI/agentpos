/**
 * The HTTP surface end to end: pages render, forms post, and the JSON API (what a future
 * messaging channel will call) works against a real in-process store.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { MarketCallResult } from "@agentpos/mcp-buyer";
import { createBuyerWebApp } from "./app.js";
import { BuyerWebStorage } from "./storage.js";
import {
  MARKET_A,
  MARKET_B,
  MARKET_DOWN,
  MARKET_LEGACY,
  STORE_URL,
  inProcessMarket,
  inProcessStore,
} from "./test-utils.js";
import { buyerWebProfileSchema } from "./types.js";
import type { ApprovalResult, Proposal, ServiceStatus } from "./types.js";

function makeApp() {
  const storage = new BuyerWebStorage(":memory:");
  return { ...createBuyerWebApp({ storage, fetchImpl: inProcessStore().fetchImpl }), storage };
}

function profileForm(overrides: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: STORE_URL,
      email: "buyer@example.com",
      ...overrides,
    }),
  };
}

/** The shipping section as the browser posts it: every field, filled. */
const SHIPPING_FIELDS: Record<string, string> = {
  shipName: "Ana Perez",
  shipLine1: "Avenida Siempre Viva 742",
  shipLine2: "Depto 31",
  shipCity: "Santiago",
  shipRegion: "Region Metropolitana",
  shipPostalCode: "8320000",
  shipCountry: "cl",
  shipPhone: "+56911111111",
};

async function proposeViaApi(
  app: ReturnType<typeof makeApp>["app"],
  itemId = "sticker",
): Promise<Proposal> {
  const res = await app.request("/api/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeUrl: STORE_URL, itemId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

describe("pages", () => {
  let app: ReturnType<typeof makeApp>["app"];
  beforeEach(() => {
    app = makeApp().app;
  });

  it("renders the mandate editor with the custody rule spelled out", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Maximo por compra");
    expect(html).toContain("nunca guarda ni pide una llave secreta");
  });

  it("saves the mandate through the form and shows it back", async () => {
    const post = await app.request("/profile", profileForm());
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/?saved=1");
    const html = await (await app.request("/?saved=1")).text();
    expect(html).toContain("Mandato guardado");
    expect(html).toContain('value="25"');
    expect(html).toContain("https://shop.test");
  });

  it("refuses a pasted secret key loudly and loses nothing the user typed", async () => {
    const res = await app.request(
      "/profile",
      profileForm({ walletAddress: "S".concat("B".repeat(55)) }),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("SECRET_IN_CONFIG");
    expect(html).toContain('value="25"');
  });

  it("renders proposals with Approve and Reject, then the awaiting-signature card", async () => {
    await app.request("/profile", profileForm());
    const proposal = await proposeViaApi(app);

    let html = await (await app.request("/proposals")).text();
    expect(html).toContain("1 x Sticker");
    expect(html).toContain("Aprobar");
    expect(html).toContain("Rechazar");

    const approve = await app.request(`/proposals/${proposal.id}/approve`, { method: "POST" });
    expect(approve.status).toBe(303);
    html = await (await app.request("/proposals")).text();
    expect(html).toContain("esperando firma");
    expect(html).toContain("agentpos-buyer demo");
    // The page never pretends the purchase happened: no paid tag, no paid section.
    expect(html).not.toContain("tag paid");
    expect(html).not.toContain("Pagadas");
  });

  it("asks for the shipping address, revealed by the physical goods checkbox alone", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain("Direccion de despacho");
    expect(html).toContain('name="shipName"');
    expect(html).toContain('name="shipLine1"');
    expect(html).toContain('name="shipCity"');
    expect(html).toContain('name="shipPostalCode"');
    expect(html).toContain('name="shipCountry"');
    // Revealed with CSS only: no script, no external resource, and hidden fields still post.
    expect(html).toContain("input.toggle:checked ~ .ship");
    expect(html).not.toContain("<script");
  });

  it("refuses physical goods without an address and says which field is missing", async () => {
    const res = await app.request("/profile", profileForm({ allowPhysicalGoods: "on" }));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("SHIPPING_REQUIRED");
    expect(html).toContain("Falta la direccion de despacho");
    // Nothing the human typed is lost on the way back.
    expect(html).toContain('value="25"');
    expect(html).toContain('value="buyer@example.com"');
  });

  it("saves the address and reports only the city and the country", async () => {
    const post = await app.request(
      "/profile",
      profileForm({ allowPhysicalGoods: "on", ...SHIPPING_FIELDS }),
    );
    expect(post.status).toBe(303);
    const html = await (await app.request("/")).text();
    expect(html).toContain("Despacho a Santiago, CL");
    expect(html).not.toContain("Sin direccion de despacho guardada");
    // The summary line says where, never the street.
    expect(html).not.toContain("Despacho a Santiago, CL · Avenida");
  });

  it("warns when a saved mandate allows physical goods with nowhere to ship", async () => {
    const { app: broken, storage } = makeApp();
    storage.saveProfile(
      buyerWebProfileSchema.parse({
        id: "default",
        network: "testnet",
        stores: [STORE_URL],
        email: "buyer@example.com",
        mandate: {
          maxPerTx: "25",
          maxTotal: "100",
          period: "week",
          allowedSellers: ["shop.test"],
          allowPhysicalGoods: true,
          shippingAddressLocked: true,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    const html = await (await broken.request("/")).text();
    expect(html).toContain("banner warn");
    expect(html).toContain("no hay a donde despachar");
    expect(html).toContain("Agrega tu direccion de despacho abajo o desactiva bienes fisicos");
    // And the physical purchase is refused early, with the same reason.
    const res = await broken.request("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeUrl: STORE_URL, itemId: "poster" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("SHIPPING_REQUIRED");
    expect(body.error.message).toContain("No hay direccion de despacho guardada");
  });

  it("tells the human where a physical proposal will ship", async () => {
    await app.request("/profile", profileForm({ allowPhysicalGoods: "on", ...SHIPPING_FIELDS }));
    await proposeViaApi(app, "poster");
    const html = await (await app.request("/proposals")).text();
    expect(html).toContain("1 x Printed Poster");
    expect(html).toContain("se despacha a Santiago, CL");
    expect(html).not.toContain("Avenida Siempre Viva");
  });

  it("renders the activity page with the history", async () => {
    await app.request("/profile", profileForm());
    const proposal = await proposeViaApi(app);
    await app.request(`/proposals/${proposal.id}/reject`, { method: "POST" });
    const html = await (await app.request("/activity")).text();
    expect(html).toContain("mandato guardado");
    expect(html).toContain("propuesta creada");
    expect(html).toContain("propuesta rechazada");
    expect(html).toContain("1 x Sticker");
  });
});

describe("market call from the home page", () => {
  function marketApp() {
    const storage = new BuyerWebStorage(":memory:");
    return {
      ...createBuyerWebApp({ storage, fetchImpl: inProcessMarket().fetchImpl }),
      storage,
    };
  }

  async function withMandate() {
    const app = marketApp().app;
    await app.request("/profile", {
      method: "POST",
      body: new URLSearchParams({
        maxPerTx: "25",
        maxTotal: "100",
        period: "week",
        stores: [MARKET_A, MARKET_B, MARKET_LEGACY, MARKET_DOWN].join("\n"),
        email: "buyer@example.com",
      }),
    });
    return app;
  }

  it("renders the market call form with attributes, price, quantity and type", async () => {
    const app = await withMandate();
    const html = await (await app.request("/")).text();
    expect(html).toContain("Llamado al mercado");
    expect(html).toContain('name="attr"');
    expect(html).toContain("Fondo=blanco");
    expect(html).toContain('name="max"');
    expect(html).toContain('name="qty"');
    expect(html).toContain("Solo digitales");
    expect(html).not.toContain("<script");
  });

  it("runs the call from the query string and shows the comparison", async () => {
    const app = await withMandate();
    const res = await app.request(
      "/?q=lamina&attr=Fondo%3Dblanco&attr=Passepartout%3Dcon&qty=2&max=40",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Cheapest first: 12 x 2 from the legacy store, then 18 x 2, then 20 x 2.
    const order = ["Galeria Vieja", "Galeria Dos", "Galeria Uno"].map((n) => html.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("24 USDC");
    expect(html).toContain("36 USDC");
    expect(html).toContain("Total x2");
    // What the human typed comes back in the form.
    expect(html).toContain('value="Fondo=blanco"');
    expect(html).toContain('value="2"');
    // And the action on each offer is still there.
    expect(html).toContain("Proponer compra");
  });

  it("says who answered and who did not, on the page", async () => {
    const app = await withMandate();
    const html = await (await app.request("/?q=lamina")).text();
    expect(html).toContain("Quien respondio");
    expect(html).toContain("no entiende los filtros");
    expect(html).toContain("error");
    expect(html).toContain("la tienda esta caida");
    expect(html).toContain("Galeria Vieja");
  });

  it("offers the merged facets as one-click refinements", async () => {
    const app = await withMandate();
    const html = await (await app.request("/?q=lamina")).text();
    expect(html).toContain("Afinar el pedido");
    expect(html).toContain("blanco (3)");
    expect(html).toContain("negro (2)");
    expect(html).toContain("attr=Fondo%3Dblanco");
  });

  it("shows an offer the mandate cannot pay instead of hiding it", async () => {
    const app = await withMandate();
    const html = await (await app.request("/?q=lamina&qty=2")).text();
    // 20 x 2 = 40, over the 25 USDC per-payment limit. Listed, and labelled.
    expect(html).toContain("40 USDC");
    expect(html).toContain("supera tu maximo por compra");
    expect(html).toContain("tag rejected");
  });

  it("keeps a malformed filter on the page instead of guessing", async () => {
    const app = await withMandate();
    const res = await app.request("/?q=lamina&attr=blanco");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("CONFIG_INVALID");
    expect(html).toContain("clave=valor");
    expect(html).toContain('value="blanco"');
  });

  it("proposes a purchase straight from an offer", async () => {
    const app = await withMandate();
    const post = await app.request("/proposals", {
      method: "POST",
      body: new URLSearchParams({ storeUrl: MARKET_B, itemId: "dos-blanco", quantity: "1" }),
    });
    expect(post.status).toBe(303);
    const html = await (await app.request("/proposals")).text();
    expect(html).toContain("1 x Lamina 30x40 blanco");
    expect(html).toContain("18 USDC");
  });

  it("answers the same call as JSON for a messaging channel", async () => {
    const app = await withMandate();
    const res = await app.request("/api/market?q=lamina&attr=Fondo%3Dblanco&qty=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MarketCallResult;
    expect(body.offers.map((o) => o.itemId)).toEqual(["vieja-blanco", "dos-blanco", "uno-blanco"]);
    expect(body.stores).toHaveLength(4);
    expect(body.facets.Fondo?.[0]).toEqual({ value: "blanco", count: 3 });
  });

  it("answers a typed error as JSON for a bad filter", async () => {
    const app = await withMandate();
    const res = await app.request("/api/market?q=lamina&attr=blanco");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("CONFIG_INVALID");
    expect(body.error.hint).toContain("clave=valor");
  });
});

describe("JSON API (the future messaging channel)", () => {
  let app: ReturnType<typeof makeApp>["app"];
  beforeEach(async () => {
    app = makeApp().app;
    await app.request("/profile", profileForm());
  });

  it("reports status", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const status = (await res.json()) as ServiceStatus;
    expect(status.profileConfigured).toBe(true);
    expect(status.stores).toEqual([STORE_URL]);
    expect(status.pendingProposals).toBe(0);
  });

  it("searches offers", async () => {
    const res = await app.request("/api/offers?q=mug");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offers: Array<{ id: string }> };
    expect(body.offers).toHaveLength(1);
    expect(body.offers.at(0)?.id).toBe("mug");
  });

  it("runs propose -> approve over HTTP and returns honest instructions", async () => {
    const proposal = await proposeViaApi(app);
    const res = await app.request(`/api/proposals/${proposal.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ApprovalResult;
    expect(result.proposal.status).toBe("approved");
    expect(result.instructions.signer).toBe("local");
    expect(result.instructions.note).toContain("cannot pay for you");
  });

  it("runs propose -> reject over HTTP", async () => {
    const proposal = await proposeViaApi(app);
    const res = await app.request(`/api/proposals/${proposal.id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: Proposal };
    expect(body.proposal.status).toBe("rejected");
  });

  it("answers a typed 404 for an unknown item", async () => {
    const res = await app.request("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeUrl: STORE_URL, itemId: "nope" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("ITEM_NOT_FOUND");
    expect(body.error.hint).toBeTruthy();
  });

  it("answers a typed 404 for an unknown proposal", async () => {
    const res = await app.request("/api/proposals/nope/approve", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("APPROVAL_NOT_FOUND");
  });
});
