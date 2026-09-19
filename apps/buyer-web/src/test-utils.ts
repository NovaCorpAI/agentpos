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
export function inProcessStore(options: { items?: CatalogItem[] } = {}): {
  fetchImpl: typeof globalThis.fetch;
} {
  const site = parseSiteConfig({
    siteUrl: STORE_URL,
    displayName: "Faro Demo Store",
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
