/**
 * The market call against a fan-out of stores: a real in-process AgentPOS store, a store that
 * pages, one that is too slow, one that is broken, one written before structured search and one
 * the mandate forbids. Nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";
import { BuyerService } from "./buyer.js";
import { formatMarketTable } from "./market.js";
import { mandateSchema } from "./mandate.js";
import type { Profile } from "./profile.js";
import { buildBuyerServer } from "./server.js";
import { SpendingLog } from "./spending.js";
import type { MarketCallResult, MarketStoreReport } from "./market.js";

const core = resolveConfig({ network: "testnet" });

/** A published item as a store puts it on the wire. */
interface WireItem {
  id: string;
  title: string;
  description: string;
  url: string;
  price: { amount: string; asset: string; minor: string };
  physical: boolean;
  attributes: Record<string, string>;
  stockMode?: "tracked" | "untracked";
}

function wire(
  id: string,
  title: string,
  amount: string,
  attributes: Record<string, string>,
  extra: Partial<WireItem> = {},
): WireItem {
  return {
    id,
    title,
    description: title,
    url: `https://example.test/${id}`,
    price: { amount, asset: "USDC", minor: usdc(amount).toString() },
    physical: false,
    attributes,
    stockMode: "untracked",
    ...extra,
  };
}

interface FakeStore {
  name: string;
  items: WireItem[];
  /** Items per answer. The client follows the pages. */
  pageSize?: number;
  /** What the store claims `page.total` is, when it lies about having more. */
  totalOverride?: number;
  /** A store written before structured search: 4xx for anything but `q`. */
  rejectFilters?: boolean;
  /** No `page` block at all, like the oldest stores. */
  omitPage?: boolean;
  failStatus?: number;
  delayMs?: number;
}

const STRUCTURED = ["minPriceUsdc", "maxPriceUsdc", "physical", "inStock", "limit", "offset"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function norm(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

function facetsOf(items: WireItem[]): Record<string, Array<{ value: string; count: number }>> {
  const out: Record<string, Array<{ value: string; count: number }>> = {};
  for (const item of items) {
    for (const [name, value] of Object.entries(item.attributes)) {
      const list = (out[name] ??= []);
      const found = list.find((v) => norm(v.value) === norm(value));
      if (found) found.count += 1;
      else list.push({ value, count: 1 });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.count - a.count);
  return out;
}

async function answerCatalog(store: FakeStore, url: URL): Promise<Response> {
  if (store.delayMs !== undefined) await new Promise((r) => setTimeout(r, store.delayMs));
  if (store.failStatus !== undefined) {
    return json(
      { error: { code: "INTERNAL", message: "the store is on fire", hint: "Try again later." } },
      store.failStatus,
    );
  }
  const params = url.searchParams;
  const keys = [...params.keys()];
  const structured = keys.some((k) => k.startsWith("attr.") || STRUCTURED.includes(k));
  if (store.rejectFilters && structured) {
    return json(
      {
        error: {
          code: "CONFIG_INVALID",
          message: "unknown query parameter",
          hint: "This store only understands ?q=<text>.",
        },
      },
      400,
    );
  }
  const q = params.get("q");
  let scoped = store.items;
  if (q) scoped = scoped.filter((i) => norm(`${i.title} ${i.description}`).includes(norm(q)));
  if (!store.rejectFilters) {
    const physical = params.get("physical");
    if (physical !== null) scoped = scoped.filter((i) => String(i.physical) === physical);
    const max = params.get("maxPriceUsdc");
    if (max !== null) scoped = scoped.filter((i) => BigInt(i.price.minor) <= usdc(max));
    const min = params.get("minPriceUsdc");
    if (min !== null) scoped = scoped.filter((i) => BigInt(i.price.minor) >= usdc(min));
  }
  const facets = facetsOf(scoped);
  let matched = scoped;
  for (const [key, value] of params) {
    if (!key.startsWith("attr.")) continue;
    const name = norm(key.slice("attr.".length));
    matched = matched.filter((i) =>
      Object.entries(i.attributes).some(([n, v]) => norm(n) === name && norm(v) === norm(value)),
    );
  }
  const limit = Number(params.get("limit") ?? "200");
  const offset = Number(params.get("offset") ?? "0");
  const size = Math.min(store.pageSize ?? limit, limit);
  const items = matched.slice(offset, offset + size);
  return json({
    site: { name: store.name, url: url.origin },
    items,
    facets,
    ...(store.omitPage
      ? {}
      : {
          page: {
            limit,
            offset,
            returned: items.length,
            total: store.totalOverride ?? matched.length,
          },
        }),
  });
}

/** A real AgentPOS store, so the market call is proven against the actual wire format. */
function realStore(items: CatalogItem[]): ReturnType<typeof createAgentPOSApp> {
  const storage = new SiteStorage(":memory:");
  for (const item of items) storage.upsertItem(item);
  const connector: OrderConnector = {
    platform: "generic",
    getAvailability: async (lines) => lines.map((l) => ({ itemId: l.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "ext-1" }),
  };
  return createAgentPOSApp({
    site: parseSiteConfig({
      siteUrl: "https://uno.test",
      displayName: "Galeria Uno",
      payTo: Keypair.random().publicKey(),
      platform: "generic",
    }),
    core,
    storage,
    connector,
  });
}

function catalogItem(
  id: string,
  title: string,
  amount: string,
  attributes: Record<string, string>,
  physical = true,
): CatalogItem {
  return {
    id,
    type: "product",
    title,
    descriptionAgent: title,
    url: `https://uno.test/${id}`,
    attributes,
    priceUsdc: usdc(amount),
    stockMode: "untracked",
    physical,
    status: "published",
    sourceEvidence: [{ source: "test", locator: "fixture" }],
  };
}

const UNO_ITEMS = [
  catalogItem("uno-blanco-con", "Lamina 30x40 blanco", "20", {
    Fondo: "blanco",
    Passepartout: "con",
  }),
  catalogItem("uno-blanco-sin", "Lamina 30x40 blanco sin", "15", {
    Fondo: "blanco",
    Passepartout: "sin",
  }),
  catalogItem("uno-negro-con", "Lamina 30x40 negro", "25", {
    Fondo: "negro",
    Passepartout: "con",
  }),
];

const DOS: FakeStore = {
  name: "Galeria Dos",
  items: [
    wire("dos-blanco", "Lamina 30x40 blanco", "18", { Fondo: "blanco", Passepartout: "con" }),
    wire("dos-cafe", "Lamina 30x40 cafe", "30", { Fondo: "Café", Passepartout: "con" }),
  ],
};

/** Written before structured search: 400 on the new parameters, fine with plain `q`. */
const VIEJA: FakeStore = {
  name: "Galeria Vieja",
  rejectFilters: true,
  omitPage: true,
  items: [
    wire("vieja-blanco", "Lamina 30x40 blanco", "12", { Fondo: "blanco", Passepartout: "con" }),
    wire("vieja-negro", "Lamina 30x40 negro", "9", { Fondo: "negro", Passepartout: "con" }),
    wire("vieja-cara", "Lamina 30x40 blanco grande", "90", {
      Fondo: "blanco",
      Passepartout: "con",
    }),
  ],
};

const LENTA: FakeStore = { name: "Galeria Lenta", items: [], delayMs: 200 };
const ROTA: FakeStore = { name: "Galeria Rota", items: [], failStatus: 500 };

describe("market call", () => {
  let home: string;
  let site: ReturnType<typeof createAgentPOSApp>;
  let profile: Profile;
  let spending: SpendingLog;
  let calls: Map<string, number>;
  const fakes = new Map<string, FakeStore>([
    ["dos.test", DOS],
    ["vieja.test", VIEJA],
    ["lenta.test", LENTA],
    ["rota.test", ROTA],
  ]);

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    calls.set(url.host, (calls.get(url.host) ?? 0) + 1);
    if (url.host === "uno.test") return site.fetch(new Request(raw, init));
    const store = fakes.get(url.host);
    if (!store) return json({ error: { code: "INTERNAL", message: "no route", hint: "-" } }, 404);
    if (!url.pathname.endsWith("/catalog")) {
      return json({ error: { code: "INTERNAL", message: "not here", hint: "-" } }, 404);
    }
    return answerCatalog(store, url);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-market-"));
    process.env.AGENTPOS_HOME = home;
    calls = new Map();
    site = realStore(UNO_ITEMS);
    spending = new SpendingLog(join(home, "spending.jsonl"));
    profile = {
      name: "test",
      network: "testnet",
      keyFile: "unused",
      address: Keypair.random().publicKey(),
      mandate: mandateSchema.parse({
        maxPerTx: "30",
        maxTotal: "100",
        allowPhysicalGoods: true,
      }),
      sites: ["https://uno.test", "https://dos.test"],
      createdAt: new Date().toISOString(),
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTPOS_HOME;
  });

  const buyer = () => new BuyerService({ profile, fetchImpl, spendingLog: spending, core });

  it("fans out, normalizes the offers and sorts by total for the requested quantity", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco", Passepartout: "con" },
      quantity: 2,
    });
    expect(result.offers.map((o) => o.itemId)).toEqual(["dos-blanco", "uno-blanco-con"]);
    const [cheapest, next] = result.offers;
    expect(cheapest?.store.name).toBe("Galeria Dos");
    expect(cheapest?.unitPrice).toBe("18");
    expect(cheapest?.unitPriceMinor).toBe("180000000");
    // 18 USDC x 2, computed in minor units and formatted once.
    expect(cheapest?.totalUsdc).toBe("36");
    expect(cheapest?.totalMinor).toBe("360000000");
    expect(cheapest?.quantity).toBe(2);
    expect(cheapest?.matchedAttributes).toEqual({ Fondo: "blanco", Passepartout: "con" });
    expect(cheapest?.stock).toBe("in_stock");
    expect(next?.store.name).toBe("Galeria Uno");
    expect(next?.totalUsdc).toBe("40");
    expect(next?.physical).toBe(true);
  });

  it("breaks ties on the total by store name", async () => {
    const twin: FakeStore = {
      name: "Aaa Galeria",
      items: [wire("twin", "Lamina 30x40 blanco", "20", { Fondo: "blanco", Passepartout: "con" })],
    };
    fakes.set("twin.test", twin);
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco", Passepartout: "con" },
      sites: ["https://twin.test"],
    });
    const twenty = result.offers.filter((o) => o.totalUsdc === "20");
    expect(twenty.map((o) => o.store.name)).toEqual(["Aaa Galeria", "Galeria Uno"]);
    fakes.delete("twin.test");
  });

  it("says who did not answer instead of quietly returning fewer options", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco", Passepartout: "con" },
      sites: ["https://lenta.test", "https://rota.test", "https://vieja.test"],
      timeoutMs: 30,
    });
    const byHost = new Map(result.stores.map((s) => [s.host, s]));
    expect(byHost.get("uno.test")?.state).toBe("ok");
    expect(byHost.get("dos.test")?.state).toBe("ok");
    expect(byHost.get("lenta.test")?.state).toBe("timeout");
    expect(byHost.get("lenta.test")?.error?.code).toBe("SITE_UNREACHABLE");
    expect(byHost.get("rota.test")?.state).toBe("error");
    expect(byHost.get("rota.test")?.offers).toBe(0);
    expect(byHost.get("vieja.test")?.state).toBe("unsupported-filters");
    // The slow and broken stores cost nothing: the rest of the market still answered.
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.stores.reduce((acc, s) => acc + s.offers, 0)).toBe(result.offers.length);
  });

  it("retries a store that refuses the new parameters with the plain call and filters here", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco", Passepartout: "con" },
      maxPriceUsdc: "40",
      sites: ["https://vieja.test"],
    });
    const vieja = result.stores.find((s) => s.host === "vieja.test") as MarketStoreReport;
    expect(vieja.state).toBe("unsupported-filters");
    expect(vieja.name).toBe("Galeria Vieja");
    expect(vieja.error?.code).toBe("SPEC_MISMATCH");
    // Structured call refused, plain call answered: two requests, and the store is still here.
    expect(calls.get("vieja.test")).toBe(2);
    const ids = result.offers.filter((o) => o.store.host === "vieja.test").map((o) => o.itemId);
    // Attribute filter and the price ceiling applied by the buyer: the 90 USDC one is out.
    expect(ids).toEqual(["vieja-blanco"]);
    expect(vieja.offers).toBe(1);
    expect(result.offers[0]?.itemId).toBe("vieja-blanco");
  });

  it("never calls a store the mandate forbids, and says why", async () => {
    profile = {
      ...profile,
      mandate: mandateSchema.parse({ ...profile.mandate, allowedSellers: ["uno.test"] }),
    };
    const result = await buyer().marketCall({
      what: "lamina",
      sites: ["https://rota.test"],
    });
    const byHost = new Map(result.stores.map((s) => [s.host, s]));
    expect(byHost.get("dos.test")?.state).toBe("not-allowed");
    expect(byHost.get("rota.test")?.state).toBe("not-allowed");
    expect(byHost.get("rota.test")?.error?.code).toBe("SELLER_UNVERIFIED");
    expect(calls.get("dos.test")).toBeUndefined();
    expect(calls.get("rota.test")).toBeUndefined();
    expect(result.offers.every((o) => o.store.host === "uno.test")).toBe(true);
  });

  it("marks the offers the mandate cannot pay, and never hides them", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Passepartout: "con" },
      quantity: 2,
    });
    // 30 x 2 = 60, over the 30 USDC per-payment cap. Still listed, cheapest first.
    const cafe = result.offers.find((o) => o.itemId === "dos-cafe");
    expect(cafe?.totalUsdc).toBe("60");
    expect(cafe?.mandate.payable).toBe(false);
    expect(cafe?.mandate.blocks.map((b) => b.reason)).toEqual(["per_payment_cap"]);
    expect(cafe?.mandate.blocks[0]?.code).toBe("MANDATE_EXCEEDED");
    expect(cafe?.mandate.blocks[0]?.message).toContain("30 USDC per-payment limit");
    // Nothing was dropped: the over-the-cap offers are in the list, next to the payable ones.
    expect(result.offers.map((o) => o.itemId)).toContain("dos-blanco");
    const one = await buyer().marketCall({ what: "lamina", attributes: { Passepartout: "con" } });
    const payable = one.offers.find((o) => o.itemId === "dos-blanco");
    expect(payable?.totalUsdc).toBe("18");
    expect(payable?.mandate.payable).toBe(true);
    expect(payable?.mandate.blocks).toEqual([]);
  });

  it("marks physical goods when the mandate does not allow them", async () => {
    profile = {
      ...profile,
      mandate: mandateSchema.parse({ ...profile.mandate, allowPhysicalGoods: false }),
    };
    const result = await buyer().marketCall({ what: "lamina" });
    const physical = result.offers.find((o) => o.store.host === "uno.test");
    expect(physical?.physical).toBe(true);
    expect(physical?.mandate.payable).toBe(false);
    expect(physical?.mandate.blocks.map((b) => b.reason)).toContain("physical_not_allowed");
    // The digital store next door is still payable: the label is per offer, not per call.
    const digital = result.offers.find((o) => o.itemId === "dos-blanco");
    expect(digital?.mandate.payable).toBe(true);
  });

  it("counts what is already spent in the period against every offer", async () => {
    spending.append({
      ts: new Date().toISOString(),
      profile: "test",
      site: "https://uno.test",
      cartId: "c1",
      orderId: "o1",
      txHash: "tx1",
      network: "stellar:testnet",
      asset: "USDC",
      amountMinor: usdc("95").toString(),
      summary: "earlier today",
    });
    const result = await buyer().marketCall({ what: "lamina" });
    const cheapest = result.offers[0];
    expect(cheapest?.mandate.payable).toBe(false);
    const reasons = cheapest?.mandate.blocks.map((b) => b.reason);
    expect(reasons).toEqual(["period_budget"]);
    expect(cheapest?.mandate.blocks[0]?.message).toContain("95 USDC already committed");
  });

  it("reports both reasons when both apply", async () => {
    profile = {
      ...profile,
      mandate: mandateSchema.parse({
        maxPerTx: "5",
        maxTotal: "6",
        allowPhysicalGoods: false,
      }),
    };
    const result = await buyer().marketCall({ what: "lamina" });
    const offer = result.offers.find((o) => o.store.host === "uno.test");
    expect(offer?.mandate.blocks.map((b) => b.reason)).toEqual([
      "per_payment_cap",
      "period_budget",
      "physical_not_allowed",
    ]);
  });

  it("flags the offers that would need a human approval", async () => {
    profile = {
      ...profile,
      mandate: mandateSchema.parse({ ...profile.mandate, requireConfirmAboveUsdc: "16" }),
    };
    const result = await buyer().marketCall({ what: "lamina" });
    const big = result.offers.find((o) => o.itemId === "uno-blanco-con");
    expect(big?.mandate.payable).toBe(true);
    expect(big?.mandate.needsApproval).toBe(true);
    const small = result.offers.find((o) => o.itemId === "uno-blanco-sin");
    expect(small?.mandate.needsApproval).toBe(false);
  });

  it("merges the facets of every store so the buyer can refine", async () => {
    const result = await buyer().marketCall({ what: "lamina" });
    // uno: blanco 2, negro 1. dos: blanco 1, Café 1. Counts add up per value.
    expect(result.facets.Fondo).toEqual([
      { value: "blanco", count: 3 },
      { value: "Café", count: 1 },
      { value: "negro", count: 1 },
    ]);
    expect(result.facets.Passepartout).toEqual([
      { value: "con", count: 4 },
      { value: "sin", count: 1 },
    ]);
  });

  it("keeps the sibling options visible while filtering on one of them", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco" },
    });
    expect(result.offers.every((o) => o.matchedAttributes.Fondo !== undefined)).toBe(true);
    expect(result.facets.Fondo?.map((v) => v.value)).toContain("negro");
  });

  it("follows the pages of a store that answers in slices", async () => {
    fakes.set("paged.test", {
      name: "Galeria Paginada",
      pageSize: 2,
      items: Array.from({ length: 5 }, (_, i) =>
        wire(`p${String(i)}`, `Lamina 30x40 numero ${String(i)}`, "1", { Fondo: "blanco" }),
      ),
    });
    const result = await buyer().marketCall({ what: "lamina", sites: ["https://paged.test"] });
    const paged = result.stores.find((s) => s.host === "paged.test") as MarketStoreReport;
    expect(paged.state).toBe("ok");
    expect(paged.offers).toBe(5);
    expect(paged.truncated).toBeUndefined();
    expect(calls.get("paged.test")).toBe(3);
    fakes.delete("paged.test");
  });

  it("stops after the page cap so one store cannot stall the call", async () => {
    fakes.set("infinita.test", {
      name: "Galeria Infinita",
      pageSize: 2,
      totalOverride: 1000,
      items: Array.from({ length: 40 }, (_, i) =>
        wire(`i${String(i)}`, `Lamina 30x40 numero ${String(i)}`, "1", { Fondo: "blanco" }),
      ),
    });
    const result = await buyer().marketCall({ what: "lamina", sites: ["https://infinita.test"] });
    const store = result.stores.find((s) => s.host === "infinita.test") as MarketStoreReport;
    expect(calls.get("infinita.test")).toBe(5);
    expect(store.offers).toBe(10);
    expect(store.truncated).toBe(true);
    expect(store.total).toBe(1000);
    fakes.delete("infinita.test");
  });

  it("refuses an impossible request before calling anyone", async () => {
    await expect(buyer().marketCall({ what: "lamina", quantity: 0 })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(
      buyer().marketCall({ what: "lamina", minPriceUsdc: "10", maxPriceUsdc: "5" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(buyer().marketCall({ what: "lamina", maxPriceUsdc: "ten" })).rejects.toMatchObject(
      { code: "INVALID_AMOUNT" },
    );
    expect(calls.size).toBe(0);
  });

  it("exposes the market call as an MCP tool", async () => {
    const shared = buyer();
    const { WebStandardStreamableHTTPServerTransport } =
      await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    const call = async (method: string, params: unknown, id = 1) => {
      const server = buildBuyerServer({ defaultProfile: "test", buyerFactory: () => shared });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const res = await transport.handleRequest(
        new Request("http://buyer/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
      const body = (await res.json()) as {
        result: { structuredContent: Record<string, unknown>; isError?: boolean };
      };
      await server.close();
      return body;
    };
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const listed = (await call("tools/list", {}, 2)) as unknown as {
      result: { tools: Array<{ name: string; description?: string }> };
    };
    const tool = listed.result.tools.find((t) => t.name === "market_call");
    expect(tool?.description).toContain("across my stores");
    const answer = await call(
      "tools/call",
      {
        name: "market_call",
        arguments: {
          what: "lamina",
          attributes: { Fondo: "blanco", Passepartout: "con" },
          quantity: 2,
        },
      },
      3,
    );
    const result = answer.result.structuredContent as unknown as MarketCallResult;
    expect(answer.result.isError).toBeUndefined();
    expect(result.offers.map((o) => o.itemId)).toEqual(["dos-blanco", "uno-blanco-con"]);
    expect(result.stores).toHaveLength(2);
    expect(result.facets.Fondo?.[0]?.value).toBe("blanco");
    const rejected = await call(
      "tools/call",
      { name: "market_call", arguments: { what: "lamina", quantity: 0 } },
      4,
    );
    expect(rejected.result.isError).toBe(true);
  });

  it("renders a comparison table a human can read in a terminal", async () => {
    const result = await buyer().marketCall({
      what: "lamina",
      attributes: { Passepartout: "con" },
      quantity: 2,
      sites: ["https://rota.test", "https://vieja.test"],
    });
    const table = formatMarketTable(result);
    expect(table).toContain("STORE");
    expect(table).toContain("TOTAL");
    expect(table).toContain("PAYABLE");
    expect(table).toContain("Galeria Dos");
    // The attributes column shows what was asked for and matched.
    expect(table).toContain("Passepartout=con");
    // The cheapest line is the first row after the header.
    const rows = table.split("\n");
    expect(rows[1]).toContain("Galeria Vieja");
    expect(table).toContain("no (per_payment_cap)");
    expect(table).toContain("yes");
    expect(table).toContain("unsupported-filters");
    expect(table).toContain("error");
    expect(table).toContain("Refine with");
    expect(table).toContain("Fondo: blanco");
  });

  it("renders an empty market call without pretending there were offers", () => {
    const empty: MarketCallResult = {
      query: { what: "nada", attributes: {}, quantity: 1 },
      offers: [],
      stores: [
        {
          url: "https://rota.test",
          name: "rota.test",
          host: "rota.test",
          state: "error",
          offers: 0,
          error: { code: "SITE_UNREACHABLE", message: "down", hint: "later" },
        },
      ],
      facets: {},
    };
    const table = formatMarketTable(empty);
    expect(table).toContain('No offers for "nada"');
    expect(table).toContain("SITE_UNREACHABLE: down");
  });
});
