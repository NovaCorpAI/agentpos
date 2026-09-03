/**
 * The reference agent (G2) run against a real AgentPOS app in-process: it must discover the store
 * the way a stranger would, quote, pay, and check the receipt rather than trust it. And it must
 * degrade honestly: an empty store, a store that parks the order for a human, and a store with no
 * wallet configured are all answers, not crashes.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";
import { runDemoPurchase } from "./demo.js";

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
const sticker: CatalogItem = { ...mug, id: "sticker", title: "Sticker", priceUsdc: usdc("1.5") };

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

/** A store, plus a fetch that reaches it without a network. */
function store(options: { items?: CatalogItem[]; policy?: Record<string, unknown> } = {}) {
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Faro Demo Store",
    payTo,
    platform: "generic",
    ...(options.policy ? { policy: options.policy } : {}),
  });
  const storage = new SiteStorage(":memory:");
  for (const item of options.items ?? [mug, sticker]) storage.upsertItem(item);
  const gate = createAgentPOSApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    receiptSecret: Keypair.random().secret(),
  });
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    gate.fetch(new Request(input as string, init))) as typeof globalThis.fetch;
  return { gate, fetchImpl };
}

describe("the reference buying agent", () => {
  it("discovers the store the way a stranger would, and says how it did it", async () => {
    const { fetchImpl } = store();
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      dryRun: true,
      fetchImpl,
    });

    expect(result.discovery).toEqual({
      openapi: true,
      llmsTxt: true,
      ucpManifest: true,
      mcp: true,
      via: "openapi",
    });
    expect(result.store.name).toBe("Faro Demo Store");
    expect(result.store.network).toBe("stellar:testnet");
    const labels = result.steps.map((s) => s.step);
    expect(labels).toContain("discover");
    expect(labels).toContain("catalog");
    expect(labels).toContain("quote");
  });

  it("picks the cheapest item by default, and quotes it without paying", async () => {
    const { fetchImpl } = store();
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      dryRun: true,
      fetchImpl,
    });
    expect(result.item?.id).toBe("sticker");
    expect(result.cart?.quote.total).toBe("1.5");
    expect(result.paid).toBe(false);
    // A dry run must not have created an order anywhere.
    expect(result.order).toBeUndefined();
    expect(result.steps.at(-1)?.message).toContain("no wallet and no funds");
  });

  it("buys the item it was asked for", async () => {
    const { fetchImpl } = store();
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      itemId: "mug",
      quantity: 2,
      dryRun: true,
      fetchImpl,
    });
    expect(result.item?.id).toBe("mug");
    expect(result.cart?.quote.total).toBe("19.8");
  });

  it("says so plainly when the item does not exist", async () => {
    const { fetchImpl } = store();
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      itemId: "nope",
      dryRun: true,
      fetchImpl,
    });
    expect(result.cart).toBeUndefined();
    expect(result.steps.at(-1)?.message).toContain("No item 'nope'");
    expect(result.steps.at(-1)?.detail?.available).toEqual(["mug", "sticker"]);
  });

  it("reports an empty store instead of failing", async () => {
    const { fetchImpl } = store({ items: [] });
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      dryRun: true,
      fetchImpl,
    });
    expect(result.item).toBeUndefined();
    expect(result.steps.at(-1)?.message).toContain("nothing published");
  });

  it("surfaces that a human has to approve, and that nothing is charged meanwhile", async () => {
    const { fetchImpl } = store({ policy: { approvalThresholdUsdc: "1" } });
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      dryRun: true,
      fetchImpl,
    });
    const policyStep = result.steps.find((s) => s.step === "policy");
    expect(policyStep).toBeDefined();
    expect(policyStep?.message).toContain("Nothing is charged");
    expect(result.cart?.policy?.decision).toBe("requires_approval");
  });

  it("stops with an actionable message when there is no wallet and it was not a dry run", async () => {
    const { fetchImpl } = store();
    const result = await runDemoPurchase({
      storeUrl: "https://shop.test",
      fetchImpl,
    });
    expect(result.paid).toBe(false);
    expect(result.steps.at(-1)?.message).toContain("agentpos-buyer init");
  });
});
