/**
 * The wizard's HTTP surface, end to end and stateless: wallet refusal, the one-shot WooCommerce
 * probe against a stubbed fetch, config generation, and the verification checklist against a
 * real AgentPOS site running in-process (same pattern as packages/mcp-buyer/src/demo.test.ts).
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, silentLogger, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, siteConfigSchema, SiteStorage } from "@agentpos/site";
import { createMerchantWebApp } from "./app.js";

const payTo = Keypair.random().publicKey();

async function errorOf(res: Response): Promise<{ code: string; message: string; hint: string }> {
  const body = (await res.json()) as { error: { code: string; message: string; hint: string } };
  return body.error;
}

function postJson(app: ReturnType<typeof createMerchantWebApp>, path: string, payload: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
describe("the wizard page", () => {
  it("serves one self-contained page that states the no-secret-key rule in Spanish", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("jamás tu llave secreta");
    // Self-contained: no external scripts, stylesheets or CDNs.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("https://cdn");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/validate-wallet", () => {
  it("accepts a public address", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await postJson(app, "/api/validate-wallet", { address: payTo });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: payTo });
  });

  it("refuses a secret key with SECRET_IN_CONFIG and never echoes it", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const secret = Keypair.random().secret();
    const res = await postJson(app, "/api/validate-wallet", { address: secret });
    expect(res.status).toBe(400);
    const text = await res.clone().text();
    expect(text).not.toContain(secret);
    expect((await errorOf(res)).code).toBe("SECRET_IN_CONFIG");
  });

  it("refuses garbage with CONFIG_INVALID", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await postJson(app, "/api/validate-wallet", { address: "garbage" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });

  it("answers a non-JSON body in our error vocabulary", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await app.request("/api/validate-wallet", { method: "POST", body: "nope" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/validate-woo", () => {
  const wooPayload = {
    baseUrl: "https://wp.test",
    consumerKey: "ck_key",
    consumerSecret: "cs_secret",
  };

  it("calls the store's REST API once, with Basic auth and per_page=1", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    }) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });

    const res = await postJson(app, "/api/validate-woo", wooPayload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sampleProducts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://wp.test/wp-json/wc/v3/products?per_page=1");
    const expected = `Basic ${Buffer.from("ck_key:cs_secret").toString("base64")}`;
    expect(seen[0]?.auth).toBe(expected);
  });

  it("maps a 401 to CONFIG_INVALID with an actionable hint", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.hint).toContain("Read/Write");
  });

  it("maps a 404 to a permalinks/URL hint", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    const error = await errorOf(res);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.hint).toContain("ermalinks");
  });

  it("reports an unreachable store as SITE_UNREACHABLE", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe("SITE_UNREACHABLE");
  });

  it("refuses a request with missing fields, listing the issues", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await postJson(app, "/api/validate-woo", { baseUrl: "https://wp.test" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/generate", () => {
  it("returns both files, and the config round-trips through siteConfigSchema", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await postJson(app, "/api/generate", {
      siteUrl: "https://shop.example",
      displayName: "Faro Store",
      payTo,
      platform: "woocommerce",
      wooConsumerKey: "ck_x",
      wooConsumerSecret: "cs_y",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: { config: { filename: string; content: string }; env: { content: string } };
      commands: string[];
    };
    const parsed = siteConfigSchema.parse(JSON.parse(body.files.config.content));
    expect(parsed.payTo).toBe(payTo);
    expect(body.files.env.content).toContain("AGENTPOS_WOO_CONSUMER_KEY=ck_x");
    expect(body.commands.at(-1)).toBe("npx agentpos serve");
  });

  it("refuses to generate anything for a secret key", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    const res = await postJson(app, "/api/generate", {
      siteUrl: "https://shop.example",
      displayName: "Faro Store",
      payTo: Keypair.random().secret(),
      platform: "generic",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("SECRET_IN_CONFIG");
  });
});

// ---------------------------------------------------------------------------
// A real AgentPOS site in-process, reached through an injected fetch: the same way the
// reference buying agent's tests exercise discovery without a network.
function inProcessStore(): typeof globalThis.fetch {
  const item: CatalogItem = {
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
  const connector: OrderConnector = {
    platform: "generic",
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "ext-1" }),
  };
  const storage = new SiteStorage(":memory:");
  storage.upsertItem(item);
  const gate = createAgentPOSApp({
    site: parseSiteConfig({
      siteUrl: "https://shop.test",
      displayName: "Faro Demo Store",
      payTo,
      platform: "generic",
    }),
    core: resolveConfig({ network: "testnet" }),
    storage,
    connector,
    receiptSecret: Keypair.random().secret(),
    // The facilitator liveness probe, stubbed: /health must not touch the network in tests.
    healthFetch: (async () =>
      new Response(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
          extensions: [],
          signers: {},
        }),
        { status: 200 },
      )) as typeof globalThis.fetch,
  });
  return ((input: string | URL | Request, init?: RequestInit) =>
    gate.fetch(new Request(input as string, init))) as typeof globalThis.fetch;
}

describe("GET /api/verify", () => {
  it("passes all checks against a live in-process AgentPOS site, scheme added for free", async () => {
    const app = createMerchantWebApp({ fetchImpl: inProcessStore(), logger: silentLogger });
    const res = await app.request("/api/verify?domain=shop.test");
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      ok: boolean;
      origin: string;
      store?: { name: string; network: string };
      checks: Array<{ id: string; ok: boolean }>;
    };
    expect(result.origin).toBe("https://shop.test");
    expect(result.ok).toBe(true);
    expect(result.store?.name).toBe("Faro Demo Store");
    expect(result.store?.network).toBe("stellar:testnet");
    expect(result.checks.map((c) => [c.id, c.ok])).toEqual([
      ["health", true],
      ["openapi", true],
      ["ucp", true],
      ["llms", true],
    ]);
  });

  it("fails with per-check hints when the proxy exposes nothing", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });
    const res = await app.request("/api/verify?domain=https://shop.test");
    const result = (await res.json()) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; hint?: string }>;
    };
    expect(result.ok).toBe(false);
    for (const check of result.checks) {
      expect(check.ok).toBe(false);
      expect(check.hint).toBeTruthy();
    }
  });

  it("treats an unreachable domain as failing checks, not as a crash", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    }) as typeof globalThis.fetch;
    const app = createMerchantWebApp({ fetchImpl, logger: silentLogger });
    const res = await app.request("/api/verify?domain=no-such.example");
    expect(res.status).toBe(200);
    const result = (await res.json()) as { ok: boolean; checks: Array<{ ok: boolean }> };
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
  });

  it("refuses a missing or invalid domain with CONFIG_INVALID", async () => {
    const app = createMerchantWebApp({ logger: silentLogger });
    expect((await errorOf(await app.request("/api/verify"))).code).toBe("CONFIG_INVALID");
    const bad = await app.request("/api/verify?domain=%20");
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("CONFIG_INVALID");
  });
});
