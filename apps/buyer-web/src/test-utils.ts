/**
 * Test-only helper: a real AgentPOS store running in-process, reached through an injected
 * fetch, so the whole propose/approve flow is exercised against genuine site behavior
 * (pattern copied from packages/mcp-buyer/src/demo.test.ts). Excluded from the build.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";

export const STORE_URL = "https://shop.test";

const core = resolveConfig({ network: "testnet" });

export const mug: CatalogItem = {
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

export const sticker: CatalogItem = {
  ...mug,
  id: "sticker",
  title: "Sticker",
  descriptionAgent: "Vinyl laptop sticker.",
  priceUsdc: usdc("1.5"),
};

/** Something the store must actually ship: a cart with it needs an address and an email. */
export const poster: CatalogItem = {
  ...mug,
  id: "poster",
  title: "Printed Poster",
  descriptionAgent: "A2 printed poster, shipped rolled.",
  priceUsdc: usdc("12"),
  physical: true,
};

/** A store plus a fetch that reaches it without a network. */
export function inProcessStore(
  options: { items?: CatalogItem[]; siteUrl?: string; displayName?: string } = {},
): {
  fetchImpl: typeof globalThis.fetch;
} {
  const site = parseSiteConfig({
    siteUrl: options.siteUrl ?? STORE_URL,
    displayName: options.displayName ?? "Faro Demo Store",
    payTo: Keypair.random().publicKey(),
    platform: "generic",
  });
  const storage = new SiteStorage(":memory:");
  for (const item of options.items ?? [mug, sticker, poster]) storage.upsertItem(item);
  const connector: OrderConnector = {
    platform: "generic",
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "ext-1" }),
  };
  const gate = createAgentPOSApp({
    site,
    core,
    storage,
    connector,
    receiptSecret: Keypair.random().secret(),
  });
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    gate.fetch(new Request(input as string, init))) as typeof globalThis.fetch;
  return { fetchImpl };
}

// --- market call fixture -----------------------------------------------------
// Four stores: two current ones, one written before structured search (4xx on the new
// parameters, fine with plain `q`) and one that is simply down.

export const MARKET_A = "https://uno.test";
export const MARKET_B = "https://dos.test";
export const MARKET_LEGACY = "https://vieja.test";
export const MARKET_DOWN = "https://rota.test";

function lamina(
  id: string,
  title: string,
  price: string,
  attributes: Record<string, string>,
  siteUrl: string,
): CatalogItem {
  return {
    id,
    type: "product",
    title,
    descriptionAgent: title,
    url: `${siteUrl}/${id}`,
    attributes,
    priceUsdc: usdc(price),
    stockMode: "untracked",
    physical: false,
    status: "published",
    sourceEvidence: [{ source: "test", locator: "fixture" }],
  };
}

const LEGACY_ITEMS = [
  {
    id: "vieja-blanco",
    title: "Lamina 30x40 blanco",
    description: "Lamina 30x40 blanco",
    url: `${MARKET_LEGACY}/vieja-blanco`,
    price: { amount: "12", asset: "USDC", minor: usdc("12").toString() },
    physical: false,
    attributes: { Fondo: "blanco", Passepartout: "con" },
    stockMode: "untracked",
  },
  {
    id: "vieja-negro",
    title: "Lamina 30x40 negro",
    description: "Lamina 30x40 negro",
    url: `${MARKET_LEGACY}/vieja-negro`,
    price: { amount: "8", asset: "USDC", minor: usdc("8").toString() },
    physical: false,
    attributes: { Fondo: "negro", Passepartout: "con" },
    stockMode: "untracked",
  },
];

const STRUCTURED_PARAMS = [
  "minPriceUsdc",
  "maxPriceUsdc",
  "physical",
  "inStock",
  "limit",
  "offset",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A market of four stores behind one fetch: everything a market call has to survive, without
 * a network. Store A and B are real AgentPOS apps, so the wire format is the real one.
 */
export function inProcessMarket(): { fetchImpl: typeof globalThis.fetch } {
  const a = inProcessStore({
    siteUrl: MARKET_A,
    displayName: "Galeria Uno",
    items: [
      lamina(
        "uno-blanco",
        "Lamina 30x40 blanco",
        "20",
        { Fondo: "blanco", Passepartout: "con" },
        MARKET_A,
      ),
      lamina(
        "uno-negro",
        "Lamina 30x40 negro",
        "14",
        { Fondo: "negro", Passepartout: "sin" },
        MARKET_A,
      ),
    ],
  });
  const b = inProcessStore({
    siteUrl: MARKET_B,
    displayName: "Galeria Dos",
    items: [
      lamina(
        "dos-blanco",
        "Lamina 30x40 blanco",
        "18",
        { Fondo: "blanco", Passepartout: "con" },
        MARKET_B,
      ),
    ],
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    if (url.host === "uno.test") return a.fetchImpl(raw, init);
    if (url.host === "dos.test") return b.fetchImpl(raw, init);
    if (url.host === "rota.test") {
      return jsonResponse(
        { error: { code: "INTERNAL", message: "la tienda esta caida", hint: "Intenta luego." } },
        500,
      );
    }
    if (url.host === "vieja.test") {
      if (!url.pathname.endsWith("/catalog")) {
        return jsonResponse({ error: { code: "INTERNAL", message: "no", hint: "-" } }, 404);
      }
      const structured = [...url.searchParams.keys()].some(
        (k) => k.startsWith("attr.") || STRUCTURED_PARAMS.includes(k),
      );
      if (structured) {
        return jsonResponse(
          {
            error: {
              code: "CONFIG_INVALID",
              message: "parametro desconocido",
              hint: "Esta tienda solo entiende ?q=<texto>.",
            },
          },
          400,
        );
      }
      return jsonResponse({
        site: { name: "Galeria Vieja", url: MARKET_LEGACY },
        items: LEGACY_ITEMS,
      });
    }
    return jsonResponse({ error: { code: "INTERNAL", message: "sin ruta", hint: "-" } }, 404);
  }) as typeof globalThis.fetch;
  return { fetchImpl };
}
