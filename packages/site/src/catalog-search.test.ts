/**
 * Structured catalog search: a buying agent must be able to ask for ONE variant ("frame 30x40,
 * with passepartout, white background, under 40 USDC") instead of guessing from a text match.
 * The fixture is shaped like what the WooCommerce connector publishes for a variable product:
 * one catalog item per variation, the options in `attributes`, plus sku / parent_id / parent_sku.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import type { AgentPOSSite } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const site = parseSiteConfig({
  siteUrl: "https://marcos.test",
  displayName: "Marcos Test",
  payTo,
  platform: "generic",
});

/** One WooCommerce variation as it lands in the catalog. */
function variation(
  id: string,
  size: string,
  passepartout: string,
  background: string,
  price: string,
  extra: Record<string, string> = {},
): CatalogItem {
  return {
    id,
    externalId: id.replace(/\D/g, "").slice(0, 4),
    type: "product",
    title: `Marco de madera - Tamaño: ${size} - Passepartout: ${passepartout} - Fondo: ${background}`,
    descriptionAgent: "Marco de madera maciza, listo para colgar.",
    url: `https://marcos.test/producto/marco/?id=${id}`,
    attributes: {
      Tamaño: size,
      Passepartout: passepartout,
      Fondo: background,
      sku: `MM-${id}`,
      parent_id: "42",
      parent_sku: "MM",
      ...extra,
    },
    priceUsdc: usdc(price),
    stockMode: "tracked",
    physical: true,
    status: "published",
    sourceEvidence: [{ source: "connector:woocommerce", locator: "product/42" }],
  };
}

const items: CatalogItem[] = [
  variation("marco-3040-con-blanco", "30x40", "con", "blanco", "35"),
  variation("marco-3040-sin-blanco", "30x40", "sin", "blanco", "29.5"),
  variation("marco-3040-con-cafe", "30x40", "con", "Café", "39.9999999"),
  variation("marco-5070-con-blanco", "50x70", "con", "blanco", "40.0000001"),
  variation("marco-5070-sin-negro", "50x70", "sin", "negro", "52"),
  variation("marco-3040-con-negro-agotado", "30x40", "con", "negro", "12", {
    stock_status: "outofstock",
  }),
  {
    id: "lamina-digital",
    type: "product",
    title: "Lámina digital",
    descriptionAgent: "Archivo para imprimir en casa.",
    url: "https://marcos.test/producto/lamina/",
    attributes: { Formato: "PDF" },
    priceUsdc: usdc("5"),
    stockMode: "untracked",
    physical: false,
    status: "published",
    sourceEvidence: [{ source: "test", locator: "fixture" }],
  },
  // Never published: it must not appear in any answer, nor in any facet count.
  { ...variation("marco-borrador", "30x40", "con", "dorado", "99"), status: "draft" },
];

const ALL_PUBLISHED = 7;

function connectorMock(): OrderConnector {
  return {
    platform: "generic",
    getAvailability: async (lines) => lines.map((l) => ({ itemId: l.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "woo-1" }),
  };
}

function makeSite(catalog: CatalogItem[] = items): AgentPOSSite {
  const storage = new SiteStorage(":memory:");
  for (const item of catalog) storage.upsertItem(item);
  return createAgentPOSApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    facilitator: stubFacilitator(),
    receiptSecret: Keypair.random().secret(),
  });
}

interface CatalogBody {
  items: Array<{ id: string; price: { minor: string }; attributes: Record<string, string> }>;
  facets: Record<string, Array<{ value: string; count: number }>>;
  page: { limit: number; offset: number; returned: number; total: number };
}

interface ErrorBody {
  error: { code: string; message: string; hint: string; retryable: boolean };
}

const gate = makeSite();

async function search(query: string): Promise<CatalogBody> {
  const res = await gate.fetch(new Request(`https://marcos.test/agentpos/catalog?${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as CatalogBody;
}

async function ids(query: string): Promise<string[]> {
  return (await search(query)).items.map((i) => i.id).sort();
}

async function refused(query: string): Promise<ErrorBody["error"]> {
  const res = await gate.fetch(new Request(`https://marcos.test/agentpos/catalog?${query}`));
  expect(res.status, `expected 400 for ?${query}`).toBe(400);
  return ((await res.json()) as ErrorBody).error;
}

describe("catalog attribute filters", () => {
  it("matches one attribute exactly and finds the variation by its option", async () => {
    expect(await ids("attr.Passepartout=sin")).toEqual([
      "marco-3040-sin-blanco",
      "marco-5070-sin-negro",
    ]);
  });

  it("ignores case and Spanish accents on both the name and the value", async () => {
    // Attribute written "Fondo": "Café"; the agent sends an unaccented, lowercase query.
    expect(await ids("attr.fondo=cafe")).toEqual(["marco-3040-con-cafe"]);
    expect(await ids("attr.FONDO=CAFÉ")).toEqual(["marco-3040-con-cafe"]);
    // Attribute name written with a tilde ("Tamaño") is reachable without it.
    expect(await ids("attr.tamano=50X70")).toEqual([
      "marco-5070-con-blanco",
      "marco-5070-sin-negro",
    ]);
  });

  it("ANDs two attributes together", async () => {
    expect(await ids("attr.Passepartout=con&attr.Fondo=blanco")).toEqual([
      "marco-3040-con-blanco",
      "marco-5070-con-blanco",
    ]);
  });

  it("answers the full agent question: variant, price ceiling and shippable", async () => {
    const body = await search(
      "attr.Tamaño=30x40&attr.Passepartout=con&attr.Fondo=blanco&maxPriceUsdc=40&physical=true",
    );
    expect(body.items.map((i) => i.id)).toEqual(["marco-3040-con-blanco"]);
    expect(body.items[0]?.attributes.parent_sku).toBe("MM");
  });

  it("matches nothing, without an error, for an attribute the store does not have", async () => {
    const body = await search("attr.Marco=dorado");
    expect(body.items).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  it("never reaches a draft item through its attributes (guardrail 5)", async () => {
    expect(await ids("attr.Fondo=dorado")).toEqual([]);
  });

  it("combines with the free-text query", async () => {
    expect(await ids("q=madera&attr.Fondo=negro")).toEqual([
      "marco-3040-con-negro-agotado",
      "marco-5070-sin-negro",
    ]);
    expect(await ids("q=digital&attr.Fondo=negro")).toEqual([]);
  });
});

describe("catalog price, physical and stock filters", () => {
  it("compares price bounds in minor units, both ends inclusive", async () => {
    // 39.9999999 USDC = 399999999 minor units: a float comparison would round it to 40.
    expect(await ids("maxPriceUsdc=39.9999999")).toContain("marco-3040-con-cafe");
    expect(await ids("maxPriceUsdc=39.9999998")).not.toContain("marco-3040-con-cafe");
    expect(await ids("minPriceUsdc=40.0000001")).toEqual([
      "marco-5070-con-blanco",
      "marco-5070-sin-negro",
    ]);
    expect(await ids("minPriceUsdc=40.0000002")).toEqual(["marco-5070-sin-negro"]);
    const band = await search("minPriceUsdc=29.5&maxPriceUsdc=35");
    expect(band.items.map((i) => i.id).sort()).toEqual([
      "marco-3040-con-blanco",
      "marco-3040-sin-blanco",
    ]);
    expect(band.items.every((i) => /^\d+$/.test(i.price.minor))).toBe(true);
  });

  it("filters physical goods from digital ones", async () => {
    expect(await ids("physical=false")).toEqual(["lamina-digital"]);
    expect((await search("physical=true")).page.total).toBe(ALL_PUBLISHED - 1);
  });

  it("treats untracked stock as in stock and hides only what the catalog knows is gone", async () => {
    expect(await ids("inStock=false")).toEqual(["marco-3040-con-negro-agotado"]);
    const inStock = await ids("inStock=true");
    expect(inStock).toContain("lamina-digital"); // untracked: always sellable
    expect(inStock).not.toContain("marco-3040-con-negro-agotado");
    expect(inStock).toHaveLength(ALL_PUBLISHED - 1);
  });
});

describe("catalog paging", () => {
  it("defaults to the full-catalog page size and reports the page it served", async () => {
    const body = await search("");
    expect(body.page).toEqual({
      limit: 200,
      offset: 0,
      returned: ALL_PUBLISHED,
      total: ALL_PUBLISHED,
    });
  });

  it("walks the catalog with limit and offset without skipping or repeating", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < ALL_PUBLISHED; offset += 2) {
      const page = await search(`limit=2&offset=${offset}`);
      expect(page.page.total).toBe(ALL_PUBLISHED);
      expect(page.page.limit).toBe(2);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
    }
    expect(new Set(seen).size).toBe(ALL_PUBLISHED);
    expect(seen).toHaveLength(ALL_PUBLISHED);
    // Past the end is an empty page, not an error.
    expect((await search("limit=2&offset=99")).items).toEqual([]);
  });
});

describe("catalog facets", () => {
  it("reports every value of every attribute with its count", async () => {
    const { facets } = await search("");
    expect(facets.Passepartout).toEqual([
      { value: "con", count: 4 },
      { value: "sin", count: 2 },
    ]);
    // Sorted by count desc, then value asc.
    expect(facets.Fondo).toEqual([
      { value: "blanco", count: 3 },
      { value: "negro", count: 2 },
      { value: "Café", count: 1 },
    ]);
    expect(facets["Tamaño"]).toEqual([
      { value: "30x40", count: 4 },
      { value: "50x70", count: 2 },
    ]);
    // The draft item is not counted anywhere.
    expect(facets.Fondo.map((v) => v.value)).not.toContain("dorado");
  });

  it("counts facets BEFORE the attribute filters, so the sibling options stay visible", async () => {
    const body = await search("attr.Passepartout=con");
    expect(body.page.total).toBe(4);
    // The agent can still see that "sin" exists, and how many items it would get.
    expect(body.facets.Passepartout).toEqual([
      { value: "con", count: 4 },
      { value: "sin", count: 2 },
    ]);
  });

  it("does apply the non-attribute filters to the facet counts", async () => {
    const body = await search("attr.Passepartout=con&maxPriceUsdc=40");
    expect(body.items.map((i) => i.id).sort()).toEqual([
      "marco-3040-con-blanco",
      "marco-3040-con-cafe",
      "marco-3040-con-negro-agotado",
    ]);
    // Facets over the 5 items priced <= 40 USDC, attribute filter not applied.
    expect(body.facets.Passepartout).toEqual([
      { value: "con", count: 3 },
      { value: "sin", count: 1 },
    ]);
  });

  it("caps a facet at 25 values, keeping the most common ones", async () => {
    const many: CatalogItem[] = [];
    for (let i = 0; i < 30; i += 1) {
      const copies = i === 0 ? 9 : i < 3 ? 5 : 1;
      for (let c = 0; c < copies; c += 1) {
        many.push({
          ...variation(`color-${String(i).padStart(2, "0")}-${c}`, "30x40", "con", "blanco", "10"),
          attributes: { Color: i === 0 ? "mmm" : i === 1 ? "aaa" : i === 2 ? "zzz" : `c${i}` },
        });
      }
    }
    const res = await makeSite(many).fetch(new Request("https://marcos.test/agentpos/catalog"));
    const body = (await res.json()) as CatalogBody;
    expect(body.facets.Color).toHaveLength(25);
    expect(body.facets.Color.slice(0, 3)).toEqual([
      { value: "mmm", count: 9 },
      { value: "aaa", count: 5 },
      { value: "zzz", count: 5 },
    ]);
  });
});

describe("catalog filter validation", () => {
  it("refuses malformed values with a typed CONFIG_INVALID naming the accepted form", async () => {
    const price = await refused("maxPriceUsdc=cheap");
    expect(price.code).toBe("CONFIG_INVALID");
    expect(price.retryable).toBe(false);
    expect(price.hint).toContain("maxPriceUsdc");
    expect(price.hint).toContain("decimal");

    // USDC has 7 decimals: an 8th is not a rounding matter, it is a wrong amount.
    expect((await refused("minPriceUsdc=1.12345678")).code).toBe("CONFIG_INVALID");
    expect((await refused("minPriceUsdc=-1")).code).toBe("CONFIG_INVALID");

    const range = await refused("minPriceUsdc=50&maxPriceUsdc=10");
    expect(range.hint).toContain("minPriceUsdc <= maxPriceUsdc");

    expect((await refused("physical=yes")).hint).toContain("physical=true");
    expect((await refused("inStock=1")).hint).toContain("inStock=true");

    for (const bad of ["limit=0", "limit=501", "limit=abc", "limit=1.5", "offset=-1"]) {
      expect((await refused(bad)).code).toBe("CONFIG_INVALID");
    }

    expect((await refused("attr.=con")).hint).toContain("attr.<name>=<value>");
    expect((await refused("attr.Fondo=")).hint).toContain("attr.<name>=<value>");
  });

  it("ignores parameters it does not know instead of refusing the call", async () => {
    expect((await search("colour=blanco&utm_source=agent")).page.total).toBe(ALL_PUBLISHED);
  });
});

describe("MCP search_items", () => {
  const call = (args: Record<string, unknown>, id: number) =>
    gate.fetch(
      new Request("https://marcos.test/agentpos/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "search_items", arguments: args },
        }),
      }),
    );

  interface ToolResponse {
    result: {
      isError?: boolean;
      structuredContent: {
        items: Array<{ id: string }>;
        facets: Record<string, Array<{ value: string; count: number }>>;
        page: { total: number };
      };
    };
  }

  it("takes the same structured arguments as HTTP and returns the same items", async () => {
    const res = await call(
      {
        attributes: { passepartout: "con", fondo: "blanco" },
        maxPriceUsdc: "40",
        physical: true,
        inStock: true,
      },
      1,
    );
    const body = (await res.json()) as ToolResponse;
    const tool = body.result.structuredContent;
    expect(tool.items.map((i) => i.id)).toEqual(["marco-3040-con-blanco"]);
    expect(tool.items.map((i) => i.id)).toEqual(
      await ids(
        "attr.passepartout=con&attr.fondo=blanco&maxPriceUsdc=40&physical=true&inStock=true",
      ),
    );
    // Same discovery surface: the agent can read the other options from the tool answer.
    expect(tool.facets.Passepartout.map((v) => v.value).sort()).toEqual(["con", "sin"]);
  });

  it("pages like HTTP and refuses a malformed price bound with the typed error", async () => {
    const paged = (await (await call({ limit: 2, offset: 0 }, 2)).json()) as ToolResponse;
    expect(paged.result.structuredContent.items).toHaveLength(2);
    expect(paged.result.structuredContent.page.total).toBe(ALL_PUBLISHED);

    const bad = (await (await call({ maxPriceUsdc: "cheap" }, 3)).json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toContain("CONFIG_INVALID");
  });
});
