import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc, usdcFromMinor } from "@agentpos/core";
import type { Order, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const BOM = String.fromCharCode(0xfeff);

const ES_HEADER =
  "fecha,orden,orden_externa,estado,items,monto_usdc,riel,activo,hash_transaccion,liquidado_el,correo_comprador";
const EN_HEADER =
  "date_iso,order_id,external_order_id,status,items,gross_usdc,rail,asset,tx_hash,settled_at,buyer_email";

const connector: OrderConnector = {
  platform: "generic",
  getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
  createOrder: async () => ({ externalOrderId: "ext-1" }),
};

function order(overrides: Partial<Order> & { id: string; createdAt: string }): Order {
  const lines = [
    {
      itemId: "mug",
      title: "Ceramic Mug",
      quantity: 2,
      unitPriceUsdc: usdc("9.9"),
      lineTotalUsdc: usdc("19.8"),
      physical: false,
    },
  ];
  return {
    cartId: `cart_${overrides.id}`,
    status: "paid",
    quote: { lines, totalUsdc: usdc("19.8"), payTo, requiresShipping: false },
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function build(locale: "en" | "es") {
  const storage = new SiteStorage(":memory:");
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Export Shop",
    payTo,
    platform: "generic",
    locale,
  });
  const gate = createAgentPOSApp({
    site,
    core,
    connector,
    storage,
    facilitator: stubFacilitator(),
  });
  const csv = async (query = "") => {
    const res = await gate.fetch(
      new Request(`https://shop.test/agentpos/dashboard/export.csv${query}`),
    );
    // Raw bytes: Response.text() silently strips a UTF-8 BOM, which is what we assert on.
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { res, bytes, text: new TextDecoder().decode(bytes) };
  };
  return { storage, gate, csv };
}

describe("reconciliation export", () => {
  it("renders one RFC 4180 row per order, with BOM, CRLF and exact money", async () => {
    const t = build("es");
    t.storage.saveOrder(
      order({
        id: "ord_1",
        createdAt: "2026-09-01T10:00:00.000Z",
        externalOrderId: "woo-77",
        buyer: { email: "ada@example.com" },
        quote: {
          lines: [
            {
              itemId: "mug",
              // Comma and quotes in the title must survive quoting untouched.
              title: 'Mug, "large" edition',
              quantity: 2,
              unitPriceUsdc: usdc("9.9"),
              lineTotalUsdc: usdc("19.8"),
              physical: false,
            },
            {
              itemId: "ebook",
              title: "E-book",
              quantity: 1,
              unitPriceUsdc: usdc("2"),
              lineTotalUsdc: usdc("2"),
              physical: false,
            },
          ],
          totalUsdc: usdc("21.8"),
          payTo,
          requiresShipping: false,
        },
        payment: {
          txHash: "txabc123",
          network: "stellar:testnet",
          asset: "USDC",
          amountMinor: usdc("21.8"),
          payer: "GPAYER",
          ts: "2026-09-01T10:00:05.000Z",
        },
      }),
    );
    const { res, bytes, text } = await t.csv("?from=2026-09-01&to=2026-09-01");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="agentpos-conciliacion-2026-09-01-2026-09-01.csv"',
    );
    // UTF-8 BOM on the wire (TextDecoder strips it from `text`).
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).startsWith(BOM)).toBe(true);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(ES_HEADER);
    expect(lines[1]).toBe(
      "2026-09-01T10:00:00.000Z,ord_1,woo-77,paid," +
        '"Mug, ""large"" edition x 2; E-book x 1",' +
        "21.8,x402-stellar,USDC,txabc123,2026-09-01T10:00:05.000Z,ada@example.com",
    );
    expect(lines[2]).toBe(""); // trailing CRLF closes the last record
  });

  it("localizes only the header row", async () => {
    const en = build("en");
    en.storage.saveOrder(order({ id: "ord_en", createdAt: "2026-09-01T10:00:00.000Z" }));
    const { text } = await en.csv("?from=2026-09-01&to=2026-09-01");
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(EN_HEADER);
    // Data rows are locale-independent; an unpaid column set stays empty, not translated.
    expect(lines[1]).toBe(
      "2026-09-01T10:00:00.000Z,ord_en,,paid,Ceramic Mug x 2,19.8,,,,,",
    );
  });

  it("filters by creation date and defaults to the last 30 days", async () => {
    const t = build("es");
    t.storage.saveOrder(order({ id: "ord_old", createdAt: "2020-01-15T00:00:00.000Z" }));
    t.storage.saveOrder(order({ id: "ord_in", createdAt: "2026-09-02T12:00:00.000Z" }));
    t.storage.saveOrder(order({ id: "ord_recent", createdAt: new Date().toISOString() }));

    const windowed = await t.csv("?from=2026-09-01&to=2026-09-03");
    expect(windowed.text).toContain("ord_in");
    expect(windowed.text).not.toContain("ord_old");
    expect(windowed.text).not.toContain("ord_recent");

    const defaulted = await t.csv();
    expect(defaulted.res.status).toBe(200);
    expect(defaulted.text).toContain("ord_recent");
    expect(defaulted.text).not.toContain("ord_old");
  });

  it("rejects malformed or inverted ranges with a typed error", async () => {
    const t = build("es");
    for (const query of ["?from=01-09-2026", "?from=2026-09-10&to=2026-09-01", "?to=notadate"]) {
      const { res, text } = await t.csv(query);
      expect(res.status).toBe(400);
      const body = JSON.parse(text) as { error: { code: string } };
      expect(body.error.code).toBe("CONFIG_INVALID");
    }
  });

  it("formats money from minor units without floats, down to 7 decimals", async () => {
    const t = build("en");
    t.storage.saveOrder(
      order({
        id: "ord_tiny",
        createdAt: "2026-09-01T10:00:00.000Z",
        payment: {
          txHash: "tx_tiny",
          network: "stellar:testnet",
          asset: "USDC",
          amountMinor: usdcFromMinor(1n), // 0.0000001 USDC
          ts: "2026-09-01T10:00:05.000Z",
        },
      }),
    );
    const { text } = await t.csv("?from=2026-09-01&to=2026-09-01");
    expect(text).toContain(",0.0000001,x402-stellar,");
  });
});
