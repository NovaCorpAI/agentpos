/**
 * The wizard's HTTP surface, end to end and stateless: wallet refusal, the one-shot WooCommerce
 * probe against a stubbed fetch, config generation, and the verification checklist against a
 * real AgentPOS site running in-process (same pattern as packages/mcp-buyer/src/demo.test.ts).
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createLogger, resolveConfig, silentLogger, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, siteConfigSchema, SiteStorage } from "@agentpos/site";
import { createMerchantWebApp } from "./app.js";
import type { MerchantWebDeps } from "./app.js";
import type { HostResolver } from "./ssrf.js";

const payTo = Keypair.random().publicKey();

/**
 * Every outbound fetch goes through the SSRF guard, which resolves the hostname first. Tests
 * never touch DNS: this resolver says the fixture hosts (shop.test, wp.test, shop.example) are
 * ordinary public addresses. The tests that exercise the guard inject their own.
 */
const publicResolver: HostResolver = async () => ["93.184.216.34"];

/** The wizard as every test builds it: silent logger, stubbed resolver, no real network. */
function wizard(deps: MerchantWebDeps = {}): ReturnType<typeof createMerchantWebApp> {
  return createMerchantWebApp({ logger: silentLogger, resolveHost: publicResolver, ...deps });
}

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
    const app = wizard();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("jamás tu llave secreta");
    // Self-contained: no external scripts, stylesheets or CDNs.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("https://cdn");
  });

  it("explains the panel key in merchant language and names the next step", async () => {
    const app = wizard();
    const html = await (await app.request("/")).text();
    expect(html).toContain("la llave que deja al panel de AgentPOS leer tus órdenes");
    expect(html).toContain("Es de solo lectura");
    expect(html).toContain(
      "Siguiente paso: conecta tu tienda al panel en app.agentposhq.com con la dirección de tu tienda y esta llave.",
    );
    // Losing it is recoverable, and the page says how.
    expect(html).toContain("Si la pierdes no pasa nada");
    // No internal vocabulary anywhere the merchant can see it.
    expect(html.toLowerCase()).not.toContain("sidecar");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/validate-wallet", () => {
  it("accepts a public address", async () => {
    const app = wizard();
    const res = await postJson(app, "/api/validate-wallet", { address: payTo });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: payTo });
  });

  it("refuses a secret key with SECRET_IN_CONFIG and never echoes it", async () => {
    const app = wizard();
    const secret = Keypair.random().secret();
    const res = await postJson(app, "/api/validate-wallet", { address: secret });
    expect(res.status).toBe(400);
    const text = await res.clone().text();
    expect(text).not.toContain(secret);
    expect((await errorOf(res)).code).toBe("SECRET_IN_CONFIG");
  });

  it("refuses garbage with CONFIG_INVALID", async () => {
    const app = wizard();
    const res = await postJson(app, "/api/validate-wallet", { address: "garbage" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });

  it("answers a non-JSON body in our error vocabulary", async () => {
    const app = wizard();
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
    const app = wizard({ fetchImpl });

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
    const app = wizard({ fetchImpl });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.hint).toContain("Lectura/escritura");
  });

  it("maps a 404 to a permalinks/URL hint", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
    const app = wizard({ fetchImpl });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    const error = await errorOf(res);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.hint).toContain("ermalinks");
  });

  it("reports an unreachable store as SITE_UNREACHABLE", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const app = wizard({ fetchImpl });
    const res = await postJson(app, "/api/validate-woo", wooPayload);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe("SITE_UNREACHABLE");
  });

  it("refuses a request with missing fields, listing the issues", async () => {
    const app = wizard();
    const res = await postJson(app, "/api/validate-woo", { baseUrl: "https://wp.test" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/generate", () => {
  it("returns both files, and the config round-trips through siteConfigSchema", async () => {
    const app = wizard();
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
    const app = wizard();
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
    const app = wizard({ fetchImpl: inProcessStore() });
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
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as typeof globalThis.fetch;
    const app = wizard({ fetchImpl });
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
    const app = wizard({ fetchImpl });
    const res = await app.request("/api/verify?domain=no-such.example");
    expect(res.status).toBe(200);
    const result = (await res.json()) as { ok: boolean; checks: Array<{ ok: boolean }> };
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
  });

  it("refuses a missing or invalid domain with CONFIG_INVALID", async () => {
    const app = wizard();
    expect((await errorOf(await app.request("/api/verify"))).code).toBe("CONFIG_INVALID");
    const bad = await app.request("/api/verify?domain=%20");
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("CONFIG_INVALID");
  });
});

// ---------------------------------------------------------------------------
// The merchant panel check: the store must answer 200 WITH the owner key and 401 WITHOUT it.
const PANEL_TOKEN = "Zm9vYmFyYmF6cXV1eHF1dXhmb29iYXJiYXo";

/**
 * A store that serves the four discovery surfaces, and answers the merchant summary according
 * to `summary`: "guarded" (200 for the right key, 401 otherwise), a fixed status for every
 * caller (404 for an older AgentPOS, 200 for a store that leaks it to anyone).
 */
function storeWithPanel(summary: "guarded" | number): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agentpos/api/merchant/summary")) {
      if (summary !== "guarded") return new Response("{}", { status: summary });
      const auth = new Headers(init?.headers).get("authorization");
      return auth === `Bearer ${PANEL_TOKEN}`
        ? new Response(JSON.stringify({ store: { name: "Faro Demo Store" } }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "MERCHANT_UNAUTHORIZED" } }), {
            status: 401,
          });
    }
    if (url.endsWith("/agentpos/health")) {
      return new Response(JSON.stringify({ ok: true, name: "Faro Demo Store" }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
}

interface VerifyBody {
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; status?: number; hint?: string; url: string }>;
}

async function verifyPost(
  fetchImpl: typeof globalThis.fetch,
  payload: unknown,
): Promise<VerifyBody> {
  const app = wizard({ fetchImpl });
  const res = await postJson(app, "/api/verify", payload);
  expect(res.status).toBe(200);
  return (await res.json()) as VerifyBody;
}

describe("POST /api/verify, with the merchant panel key", () => {
  it("passes when the store answers 200 with the key and 401 without it", async () => {
    const body = await verifyPost(storeWithPanel("guarded"), {
      domain: "shop.test",
      merchantApiToken: PANEL_TOKEN,
    });
    const check = body.checks.find((c) => c.id === "merchantApi");
    expect(check?.url).toBe("https://shop.test/agentpos/api/merchant/summary");
    expect(check?.ok).toBe(true);
    expect(check?.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("fails on a wrong key, pointing at MERCHANT_API_TOKEN in the .env", async () => {
    const body = await verifyPost(storeWithPanel("guarded"), {
      domain: "shop.test",
      merchantApiToken: "not-the-one-in-the-env-file",
    });
    const check = body.checks.find((c) => c.id === "merchantApi");
    expect(check?.ok).toBe(false);
    expect(check?.status).toBe(401);
    expect(check?.hint).toContain("MERCHANT_API_TOKEN");
    expect(body.ok).toBe(false);
  });

  it("reads a 404 as an older AgentPOS and says how to update it", async () => {
    const body = await verifyPost(storeWithPanel(404), {
      domain: "shop.test",
      merchantApiToken: PANEL_TOKEN,
    });
    const check = body.checks.find((c) => c.id === "merchantApi");
    expect(check?.ok).toBe(false);
    expect(check?.status).toBe(404);
    expect(check?.hint).toContain("una versión antigua de AgentPOS");
    expect(check?.hint).toContain("@agentpos/site@latest");
  });

  it("fails loudly when the orders answer without any key at all", async () => {
    const body = await verifyPost(storeWithPanel(200), {
      domain: "shop.test",
      merchantApiToken: PANEL_TOKEN,
    });
    const check = body.checks.find((c) => c.id === "merchantApi");
    expect(check?.ok).toBe(false);
    expect(check?.hint).toContain("SIN la llave");
  });

  it("leaves the panel check out when no key is sent", async () => {
    const body = await verifyPost(storeWithPanel("guarded"), { domain: "shop.test" });
    expect(body.checks.map((c) => c.id)).toEqual(["health", "openapi", "ucp", "llms"]);
    expect(body.ok).toBe(true);
  });

  it("never writes the key to a log line, on the happy path or on an error", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const app = wizard({ fetchImpl: storeWithPanel("guarded"), logger });

    const generated = (await (
      await postJson(app, "/api/generate", {
        siteUrl: "https://shop.test",
        displayName: "Faro Store",
        payTo,
        platform: "generic",
      })
    ).json()) as { merchantApiToken: string };
    expect(generated.merchantApiToken.length).toBeGreaterThanOrEqual(24);

    await postJson(app, "/api/verify", {
      domain: "shop.test",
      merchantApiToken: generated.merchantApiToken,
    });
    // ...and the error path, which is the one that actually logs.
    await postJson(app, "/api/verify", {
      domain: "   ",
      merchantApiToken: generated.merchantApiToken,
    });

    expect(lines.join("\n")).not.toContain(generated.merchantApiToken);
  });
});

// ---------------------------------------------------------------------------
// Published on the open internet, the three endpoints that fetch are the risk. These exercise
// them through the HTTP surface, with the guard's resolver stubbed.
describe("the endpoints that fetch, published", () => {
  /** Reality, stubbed: localhost is loopback, two names point inside, everything else is public. */
  const realisticResolver: HostResolver = async (hostname) => {
    if (hostname === "localhost") return ["127.0.0.1"];
    if (hostname === "intranet.example") return ["10.1.2.3"];
    if (hostname === "metadata.example") return ["169.254.169.254"];
    return ["93.184.216.34"];
  };
  const neverCalled = (() => {
    throw new Error("the guard let a request through");
  }) as unknown as typeof globalThis.fetch;

  const refusedByGuard = [
    "localhost",
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "169.254.169.254",
    "[::1]",
    "[fc00::1]",
    "[::ffff:127.0.0.1]",
    "intranet.example",
    "metadata.example",
    "shop.example:22",
  ];

  it("refuses every non-public domain on GET /api/verify, without opening a connection", async () => {
    const app = wizard({ fetchImpl: neverCalled, resolveHost: realisticResolver });
    for (const domain of refusedByGuard) {
      const res = await app.request(`/api/verify?domain=${encodeURIComponent(domain)}`);
      expect(res.status, domain).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("CONFIG_INVALID");
      expect(`${error.message} ${error.hint}`).toContain("público");
    }
  });

  it("refuses a non-public store on POST /api/validate-woo", async () => {
    const app = wizard({ fetchImpl: neverCalled, resolveHost: realisticResolver });
    const res = await postJson(app, "/api/validate-woo", {
      baseUrl: "http://192.168.1.10",
      consumerKey: "ck_key",
      consumerSecret: "cs_secret",
    });
    // Not SITE_UNREACHABLE: the merchant gets the reason, not "your store did not answer".
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });

  it("refuses a non-public store on the merchant-API probe too", async () => {
    const app = wizard({ fetchImpl: neverCalled, resolveHost: realisticResolver });
    const res = await postJson(app, "/api/verify", {
      domain: "intranet.example",
      merchantApiToken: PANEL_TOKEN,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });

  it("refuses a store that redirects the checklist somewhere else", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })) as typeof globalThis.fetch;
    const app = wizard({ fetchImpl, resolveHost: realisticResolver });
    const res = await app.request("/api/verify?domain=shop.test");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });

  it("answers 429 with Retry-After once one address asks too often", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof globalThis.fetch;
    const app = wizard({ fetchImpl });
    let limited: Response | undefined;
    for (let i = 0; i < 20 && limited === undefined; i++) {
      const res = await app.request("/api/verify?domain=shop.test");
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await errorOf(limited as Response)).code).toBe("RATE_LIMITED");

    // Per endpoint, not global: the WooCommerce probe has its own bucket and still answers.
    const woo = await postJson(app, "/api/validate-woo", {
      baseUrl: "https://wp.test",
      consumerKey: "ck_key",
      consumerSecret: "cs_secret",
    });
    expect(woo.status).not.toBe(429);
  });

  it("refuses an oversized body with 413", async () => {
    const app = wizard();
    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x".repeat(200 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("refuses an oversized field even inside a small body", async () => {
    const app = wizard();
    const res = await postJson(app, "/api/validate-woo", {
      baseUrl: "https://wp.test",
      consumerKey: "ck_".padEnd(500, "x"),
      consumerSecret: "cs_secret",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("CONFIG_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("nothing the merchant types reaches a log line", () => {
  it("keeps WooCommerce keys, the wallet address and the panel key out of every level", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const consumerKey = "ck_0123456789abcdef0123456789abcdef01234567";
    const consumerSecret = "cs_fedcba9876543210fedcba9876543210fedcba98";
    const secret = Keypair.random().secret();
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("/wp-json/")
        ? new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
        : new Response("ok", { status: 200 })) as typeof globalThis.fetch;
    const app = wizard({ logger, fetchImpl });

    // The happy path...
    await postJson(app, "/api/validate-woo", {
      baseUrl: "https://wp.test",
      consumerKey,
      consumerSecret,
    });
    await postJson(app, "/api/validate-wallet", { address: payTo });
    const generated = (await (
      await postJson(app, "/api/generate", {
        siteUrl: "https://shop.test",
        displayName: "Faro Store",
        payTo,
        platform: "woocommerce",
        wooConsumerKey: consumerKey,
        wooConsumerSecret: consumerSecret,
      })
    ).json()) as { merchantApiToken: string };

    // ...and every error path, which is the one that actually writes a line.
    await postJson(app, "/api/validate-wallet", { address: secret });
    await postJson(app, "/api/validate-woo", {
      baseUrl: "http://10.0.0.5",
      consumerKey,
      consumerSecret,
    });
    await postJson(app, "/api/verify", {
      domain: "   ",
      merchantApiToken: generated.merchantApiToken,
    });
    await postJson(app, "/api/generate", { siteUrl: "not-a-url", payTo, displayName: "x" });

    const log = lines.join("\n");
    // The lines were written (this is a debug-level logger): they just say nothing useful.
    expect(lines.length).toBeGreaterThan(0);
    for (const value of [consumerKey, consumerSecret, secret, payTo, generated.merchantApiToken]) {
      expect(log).not.toContain(value);
    }
  });
});
