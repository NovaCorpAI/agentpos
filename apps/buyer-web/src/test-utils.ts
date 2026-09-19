/**
 * Test-only helper: a real AgentPOS store running in-process, reached through an injected
 * fetch, so the whole propose/approve flow is exercised against genuine site behavior
 * (pattern copied from packages/mcp-buyer/src/demo.test.ts). Excluded from the build.
 *
 * It also carries the signed-in client used by every test that touches a guarded route.
 * That client goes through the real /setup and /login forms and carries the real cookie
 * and the real CSRF token: no test is allowed to reach past the access layer by a back
 * door, because then nothing would be testing the access layer.
 */
import { expect } from "vitest";
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

// --- the signed-in client ----------------------------------------------------

/** The owner these tests create. The password is 19 characters, over the 12 minimum. */
export const OWNER_EMAIL = "duena@ejemplo.com";
export const OWNER_PASSWORD = "contrasena-larga-12";

/** What this helper needs from a Hono app: its in-process request method. */
export interface AppLike {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

export interface BuyerWebClient {
  /** A request as the signed-in owner: session cookie, plus the CSRF token when it mutates. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** A request with nothing attached: what an anonymous visitor (or a crawler) gets. */
  anonymous(path: string, init?: RequestInit): Promise<Response>;
  /** A request with the cookie but a wrong CSRF token. */
  withBadCsrf(path: string, init?: RequestInit): Promise<Response>;
  /** A request with the cookie and no CSRF token at all. */
  withoutCsrf(path: string, init?: RequestInit): Promise<Response>;
  /** Approving asks for the password again: this passes it. `api` uses the JSON route. */
  approve(proposalId: string, options?: { password?: string; api?: boolean }): Promise<Response>;
  cookie: string;
  csrf: string;
}

/**
 * The session cookie as a browser would keep it: name=value, without the attributes. When a
 * response carries the cookie twice (the access layer slides the old session, the handler
 * then hands out a new one, as on a login made while holding a recovery cookie), the LAST
 * one wins, which is what a browser does too.
 */
export function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return (
    raw
      .split(",")
      .map((part) => part.trim().split(";").at(0) ?? "")
      .filter((c) => c.startsWith("agentpos_buyer_session="))
      .at(-1) ?? ""
  );
}

/** The per-session token, read out of a rendered form exactly as a browser would post it. */
export function csrfFrom(html: string): string {
  return /name="_csrf" value="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
}

function clientFor(app: AppLike, cookie: string, csrf: string): BuyerWebClient {
  const send = async (
    path: string,
    init: RequestInit | undefined,
    options: { cookie: boolean; csrf: string | undefined },
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (options.cookie) headers.set("cookie", cookie);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    if (method !== "GET" && method !== "HEAD" && options.csrf !== undefined) {
      if (body instanceof URLSearchParams) {
        if (!body.has("_csrf")) body.set("_csrf", options.csrf);
      } else {
        headers.set("x-csrf-token", options.csrf);
      }
    }
    return app.request(path, { ...init, headers });
  };
  return {
    cookie,
    csrf,
    request: (path, init) => send(path, init, { cookie: true, csrf }),
    anonymous: (path, init) => send(path, init, { cookie: false, csrf: undefined }),
    withBadCsrf: (path, init) => send(path, init, { cookie: true, csrf: "0".repeat(64) }),
    withoutCsrf: (path, init) => send(path, init, { cookie: true, csrf: undefined }),
    approve: (proposalId, options = {}) => {
      const password = options.password ?? OWNER_PASSWORD;
      if (options.api) {
        return send(
          `/api/proposals/${proposalId}/approve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
          },
          { cookie: true, csrf },
        );
      }
      return send(
        `/proposals/${proposalId}/approve`,
        { method: "POST", body: new URLSearchParams({ password }) },
        { cookie: true, csrf },
      );
    },
  };
}

/**
 * The ten recovery codes, read out of the page that shows them once, exactly as the owner
 * would copy them off the screen. Generating them goes through the real form.
 */
export async function generateCodes(client: BuyerWebClient): Promise<string[]> {
  const res = await client.request("/cuenta/codigos", { method: "POST" });
  expect(res.status).toBe(200);
  const html = await res.text();
  const codes = [...html.matchAll(/<li>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/li>/g)].map(
    (m) => m[1] as string,
  );
  expect(codes).toHaveLength(10);
  return codes;
}

/** Posts the recovery form the way the browser does, and keeps the cookie it hands back. */
export async function startRecovery(
  app: AppLike,
  fields: { email?: string; code: string },
): Promise<{ status: number; cookie: string; html: string; retryAfter: string | null }> {
  const res = await app.request("/recuperar", {
    method: "POST",
    body: new URLSearchParams({ email: fields.email ?? OWNER_EMAIL, code: fields.code }),
  });
  return {
    status: res.status,
    cookie: cookieFrom(res),
    retryAfter: res.headers.get("retry-after"),
    html: res.status === 303 ? "" : await res.text(),
  };
}

/** Creates the owner account through the real /setup form and returns a signed-in client. */
export async function setUpOwner(
  app: AppLike,
  options: { email?: string; password?: string } = {},
): Promise<BuyerWebClient> {
  const email = options.email ?? OWNER_EMAIL;
  const password = options.password ?? OWNER_PASSWORD;
  const res = await app.request("/setup", {
    method: "POST",
    body: new URLSearchParams({ email, password, confirm: password }),
  });
  expect(res.status).toBe(303);
  const cookie = cookieFrom(res);
  expect(cookie).not.toBe("");
  const home = await app.request("/", { headers: { cookie } });
  const csrf = csrfFrom(await home.text());
  expect(csrf).not.toBe("");
  return clientFor(app, cookie, csrf);
}

/** Signs in through the real /login form with an account that already exists. */
export async function logIn(
  app: AppLike,
  options: { email?: string; password?: string } = {},
): Promise<BuyerWebClient> {
  const res = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({
      email: options.email ?? OWNER_EMAIL,
      password: options.password ?? OWNER_PASSWORD,
    }),
  });
  expect(res.status).toBe(303);
  const cookie = cookieFrom(res);
  const home = await app.request("/", { headers: { cookie } });
  return clientFor(app, cookie, csrfFrom(await home.text()));
}
