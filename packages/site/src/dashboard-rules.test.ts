/**
 * The dashboard's Rules tab and its JSON source: the merchant must see, on their own store,
 * exactly what the store shows to agents and the rules it enforces. Two invariants matter:
 * the endpoint reflects the configured SiteConfig faithfully, and it NEVER carries a secret,
 * even when every secret-bearing knob is configured.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import type { AgentPOSSite } from "./app.js";
import { parseSiteConfig } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const receiptSecret = Keypair.random().secret(); // S..., the classic seed shape

const mug: CatalogItem = {
  id: "mug",
  type: "product",
  title: "Ceramic Mug",
  descriptionAgent: "White ceramic mug, 350 ml.",
  url: "https://shop.test/product/mug/",
  attributes: { color: "white" },
  priceUsdc: usdc("9.9"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};

function connectorMock(): OrderConnector {
  return {
    platform: "generic",
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "woo-1" }),
  };
}

function makeSite(overrides: Partial<SiteConfigInput> = {}): AgentPOSSite {
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Test Shop",
    payTo,
    platform: "generic",
    ...overrides,
  });
  const storage = new SiteStorage(":memory:");
  storage.upsertItem(mug);
  return createAgentPOSApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    facilitator: stubFacilitator(),
    receiptSecret,
    // Deliberately woo-shaped and seed-shaped values: the leak assertions below must hold even
    // when every secret-bearing knob is configured.
    approvalSecret: "cs_super_secret_approval_key",
  });
}

const CONFIGURED: Partial<SiteConfigInput> = {
  cartTtlMinutes: 20,
  locale: "es",
  policy: {
    status: "active",
    maxOrderUsdc: "100.50",
    maxPeriodUsdc: "1000",
    period: "weekly",
    maxQuantityPerItem: 3,
    maxQuantityPerOrder: 8,
    excludedItems: ["knife", "voucher"],
    allowedShippingCountries: ["CL", "AR"],
    approvalThresholdUsdc: "50",
  },
  identity: { mode: "identified", autoRegister: false },
  approvals: {
    enabled: true,
    ttlMinutes: 45,
    webhookUrl: "https://hooks.example/agentpos?token=ck_webhook_token_123",
    whatsapp: { from: "+56911111111", to: "+56922222222" },
  },
  receipts: { enabled: true, publicOrderReceipts: false },
};

async function rules(gate: AgentPOSSite): Promise<{ body: Record<string, unknown>; raw: string }> {
  const res = await gate.fetch(new Request("https://shop.test/agentpos/dashboard/rules"));
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { body: JSON.parse(raw) as Record<string, unknown>, raw };
}

describe("GET /agentpos/dashboard/rules", () => {
  it("returns the configured rules, money formatted, unset limits as null", async () => {
    const { body } = await rules(makeSite(CONFIGURED));
    expect(body).toMatchObject({
      store: { name: "Test Shop", url: "https://shop.test" },
      network: core.caip2,
      asset: core.checkoutAsset,
      payTo,
      cartTtlMinutes: 20,
      policy: {
        status: "active",
        maxOrderUsdc: "100.5", // formatUsdc drops the trailing zero
        period: "weekly",
        maxPeriodUsdc: "1000",
        maxQuantityPerItem: 3,
        maxQuantityPerOrder: 8,
        excludedItemsCount: 2,
        allowedShippingCountries: ["CL", "AR"],
        approvalThresholdUsdc: "50",
      },
      approvals: { enabled: true, ttlMinutes: 45, channels: { webhook: true, whatsapp: true } },
      identity: { mode: "identified", autoRegister: false },
      receipts: { enabled: true, publicOrderReceipts: false },
    });
  });

  it("shows the open defaults when the merchant set no rules", async () => {
    const { body } = await rules(makeSite());
    const policy = body.policy as Record<string, unknown>;
    expect(policy.status).toBe("active");
    expect(policy.maxOrderUsdc).toBeNull();
    expect(policy.maxPeriodUsdc).toBeNull();
    expect(policy.maxQuantityPerItem).toBeNull();
    expect(policy.maxQuantityPerOrder).toBeNull();
    expect(policy.excludedItemsCount).toBe(0);
    expect(policy.allowedShippingCountries).toEqual([]);
    expect(policy.approvalThresholdUsdc).toBeNull();
    expect(body.approvals).toEqual({
      enabled: true,
      ttlMinutes: 30,
      channels: { webhook: false, whatsapp: false },
    });
    expect(body.identity).toEqual({ mode: "open", autoRegister: true });
  });

  it("never leaks a secret, a channel endpoint or a phone number", async () => {
    const { raw } = await rules(makeSite(CONFIGURED));
    // WooCommerce-style credentials and Stellar seeds must never appear, in any field.
    expect(raw).not.toMatch(/ck_/);
    expect(raw).not.toMatch(/cs_/);
    expect(raw).not.toMatch(/S[A-Z2-7]{55}/);
    expect(raw).not.toContain(receiptSecret);
    expect(raw).not.toContain("cs_super_secret_approval_key");
    // Channel configuration is booleans only: no webhook URL, no WhatsApp numbers.
    expect(raw).not.toContain("hooks.example");
    expect(raw).not.toContain("+5691");
    expect(raw).not.toContain("+5692");
  });
});

describe("GET /agentpos/dashboard (tabs)", () => {
  async function html(gate: AgentPOSSite): Promise<string> {
    const res = await gate.fetch(new Request("https://shop.test/agentpos/dashboard"));
    expect(res.status).toBe(200);
    return res.text();
  }

  it("carries the three tabs and points them at the same-origin endpoints", async () => {
    const page = await html(makeSite());
    expect(page).toContain('data-tab="metrics"');
    expect(page).toContain('data-tab="catalog"');
    expect(page).toContain('data-tab="rules"');
    expect(page).toContain('"/agentpos/catalog"');
    expect(page).toContain('"/agentpos/dashboard/rules"');
  });

  it("localizes the tab labels", async () => {
    const es = await html(makeSite({ locale: "es" }));
    expect(es).toContain("Catálogo");
    expect(es).toContain("Reglas");
    const en = await html(makeSite({ locale: "en" }));
    expect(en).toContain(">Catalog<");
    expect(en).toContain(">Rules<");
  });

  it("still escapes a hostile display name", async () => {
    const page = await html(makeSite({ displayName: '<script>alert("x")</script> Shop' }));
    expect(page).not.toContain('<script>alert("x")</script>');
    expect(page).toContain("&lt;script&gt;");
  });
});
