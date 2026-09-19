/**
 * The access layer, end to end over HTTP. This is the file that has to be paranoid: the
 * surface it guards can raise a spending limit and approve a payment that the owner's own
 * machine then signs.
 *
 * It checks the whole route matrix (who redirects, who answers 401, who is exempt and
 * why), the session lifecycle, the CSRF token on every mutating route, the login throttle,
 * the password asked again before an approval, and the rule that no log line ever carries
 * the email, the password or the session id.
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "@agentpos/core";
import { createBuyerWebApp } from "./app.js";
import { configFromEnv } from "./config.js";
import { hashPassword } from "./auth/scrypt.js";
import { BuyerWebStorage } from "./storage.js";
import {
  OWNER_EMAIL,
  OWNER_PASSWORD,
  STORE_URL,
  cookieFrom,
  csrfFrom,
  inProcessStore,
  logIn,
  setUpOwner,
} from "./test-utils.js";
import type { BuyerWebClient } from "./test-utils.js";
import { buyerWebProfileSchema } from "./types.js";
import type { Proposal } from "./types.js";

const META_CONFIG = {
  verifyToken: "verify-token-123",
  appSecret: "meta-app-secret",
  accessToken: "meta-access-token",
  phoneNumberId: "111222333",
};
const TWILIO_CONFIG = {
  accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authToken: "twilio-auth-token",
  fromNumber: "whatsapp:+14155238886",
  webhookUrl: "https://buyer.example/whatsapp/twilio",
};
const SIGNER_TOKEN = "signer-token-0123456789abcdef";

interface BuildOptions {
  now?: () => Date;
  sessionTtlMs?: number;
  logs?: string[];
  owner?: { email: string; passwordHash: string };
  channels?: boolean;
}

function build(options: BuildOptions = {}) {
  const storage = new BuyerWebStorage(":memory:");
  const built = createBuyerWebApp({
    storage,
    fetchImpl: inProcessStore().fetchImpl,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.logs
      ? {
          logger: createLogger({
            level: "debug",
            sink: (line: string) => options.logs?.push(line),
          }),
        }
      : {}),
    ...(options.channels
      ? {
          whatsapp: {
            allowedNumbers: ["+56911111111"],
            meta: META_CONFIG,
            twilio: TWILIO_CONFIG,
          },
          whatsappTransports: {
            meta: { send: async () => undefined },
            twilio: { send: async () => undefined },
          },
          signerToken: SIGNER_TOKEN,
        }
      : {}),
  });
  return { ...built, storage };
}

/** A mandate, saved through the form, so proposals can be created. */
async function withMandate(client: BuyerWebClient): Promise<void> {
  const res = await client.request("/profile", {
    method: "POST",
    body: new URLSearchParams({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: STORE_URL,
      email: "buyer@example.com",
    }),
  });
  expect(res.status).toBe(303);
}

async function propose(client: BuyerWebClient, itemId = "sticker"): Promise<Proposal> {
  const res = await client.request("/api/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeUrl: STORE_URL, itemId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

// --- setup -------------------------------------------------------------------

describe("first run: the one owner account", () => {
  it("sends every page to /setup while there is no account", async () => {
    const { app } = build();
    for (const path of ["/", "/proposals", "/activity"]) {
      const res = await app.request(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/setup");
    }
    const login = await app.request("/login");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/setup");
    const setup = await app.request("/setup");
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain("Crea tu cuenta de dueno");
  });

  it("creates the account once and then answers 404 to /setup forever", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    expect((await client.request("/")).status).toBe(200);

    const again = await app.request("/setup", {
      method: "POST",
      body: new URLSearchParams({
        email: "otra@ejemplo.com",
        password: "otra-contrasena-larga",
        confirm: "otra-contrasena-larga",
      }),
    });
    expect(again.status).toBe(404);
    expect(await again.text()).toContain("SETUP_DONE");
    expect((await app.request("/setup")).status).toBe(404);
    // And the second account was never created: the first one still logs in.
    const back = await logIn(app);
    expect((await back.request("/")).status).toBe(200);
  });

  it("refuses a short password, a mismatch and a malformed email, and creates nothing", async () => {
    const { app } = build();
    const cases: Array<[Record<string, string>, string]> = [
      [{ email: "no-es-un-correo", password: "x".repeat(12), confirm: "x".repeat(12) }, "correo"],
      [{ email: OWNER_EMAIL, password: "corta", confirm: "corta" }, "muy corta"],
      [{ email: OWNER_EMAIL, password: "x".repeat(12), confirm: "y".repeat(12) }, "no coinciden"],
    ];
    for (const [body, expected] of cases) {
      const res = await app.request("/setup", { method: "POST", body: new URLSearchParams(body) });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("ACCOUNT_INVALID");
      expect(html).toContain(expected);
    }
    // Still no owner: /setup is open and the pages still send you there.
    expect((await app.request("/setup")).status).toBe(200);
  });

  it("logs the owner in right away when the account is created", async () => {
    const { app } = build();
    const res = await app.request("/setup", {
      method: "POST",
      body: new URLSearchParams({
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        confirm: OWNER_PASSWORD,
      }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = cookieFrom(res);
    const home = await app.request("/", { headers: { cookie } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(OWNER_EMAIL);
  });
});

// --- bootstrap from the environment ------------------------------------------

describe("owner bootstrap from the environment", () => {
  it("creates the account from an email and a scrypt hash, with no setup form", async () => {
    const passwordHash = await hashPassword(OWNER_PASSWORD);
    const { app } = build({ owner: { email: OWNER_EMAIL, passwordHash } });
    expect((await app.request("/setup")).status).toBe(404);
    const client = await logIn(app);
    expect((await client.request("/")).status).toBe(200);
  });

  it("replaces the account when the environment changes, and closes open sessions", async () => {
    const storage = new BuyerWebStorage(":memory:");
    const first = createBuyerWebApp({ storage, fetchImpl: inProcessStore().fetchImpl });
    const client = await setUpOwner(first.app);
    expect((await client.request("/")).status).toBe(200);

    // Same database, new process, new owner pair in the environment.
    const second = createBuyerWebApp({
      storage,
      fetchImpl: inProcessStore().fetchImpl,
      owner: { email: "nueva@ejemplo.com", passwordHash: await hashPassword("otra-clave-larga") },
    });
    const stale = await second.app.request("/", { headers: { cookie: client.cookie } });
    expect(stale.status).toBe(302);
    expect(stale.headers.get("location")).toContain("/login");
    const back = await logIn(second.app, {
      email: "nueva@ejemplo.com",
      password: "otra-clave-larga",
    });
    expect((await back.request("/")).status).toBe(200);
  });

  it("refuses a plaintext password or a half-configured pair in the environment", () => {
    const base = { BUYER_WEB_PORT: "8788" } as NodeJS.ProcessEnv;
    expect(() =>
      configFromEnv({ ...base, BUYER_WEB_OWNER_PASSWORD: "plaintext-secret" }),
    ).toThrowError(/plaintext password/);
    expect(() => configFromEnv({ ...base, BUYER_WEB_OWNER_EMAIL: OWNER_EMAIL })).toThrowError(
      /Incomplete owner bootstrap/,
    );
    expect(() =>
      configFromEnv({
        ...base,
        BUYER_WEB_OWNER_EMAIL: OWNER_EMAIL,
        BUYER_WEB_OWNER_PASSWORD_HASH: "not-a-hash",
      }),
    ).toThrowError(/not a scrypt hash/);
    expect(configFromEnv(base).owner).toBeUndefined();
  });

  it("accepts a real hash through configFromEnv", async () => {
    const passwordHash = await hashPassword(OWNER_PASSWORD);
    const config = configFromEnv({
      BUYER_WEB_PORT: "8788",
      BUYER_WEB_OWNER_EMAIL: OWNER_EMAIL,
      BUYER_WEB_OWNER_PASSWORD_HASH: passwordHash,
    } as NodeJS.ProcessEnv);
    expect(config.owner).toEqual({ email: OWNER_EMAIL, passwordHash });
  });
});

// --- login --------------------------------------------------------------------

describe("login", () => {
  it("accepts the right credentials and opens a session cookie that is not readable by script", async () => {
    const { app } = build();
    await setUpOwner(app);
    const res = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(res.status).toBe(303);
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/");
  });

  it("marks the cookie Secure behind https and not over plain http", async () => {
    const { app } = build();
    await setUpOwner(app);
    const insecure = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(insecure.headers.get("set-cookie")).not.toContain("Secure");
    const secure = await app.request("/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(secure.headers.get("set-cookie")).toContain("Secure");
  });

  it("answers the same refusal for an unknown email and for a wrong password", async () => {
    const { app } = build();
    await setUpOwner(app);
    const unknown = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: "nadie@ejemplo.com", password: OWNER_PASSWORD }),
    });
    const wrong = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: "contrasena-equivocada" }),
    });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.status).toBe(401);
    const a = await unknown.text();
    const b = await wrong.text();
    expect(a).toContain("Correo o contrasena incorrectos");
    expect(b).toContain("Correo o contrasena incorrectos");
    // Neither answer carries a hint about which of the two fields was wrong.
    expect(a).not.toContain("no existe");
    expect(b).not.toContain("no existe");
    expect(cookieFrom(unknown)).toBe("");
    expect(cookieFrom(wrong)).toBe("");
  });

  it("sends the owner back to where they were going", async () => {
    const { app } = build();
    await setUpOwner(app);
    const anonymous = await app.request("/proposals");
    expect(anonymous.headers.get("location")).toBe("/login?next=%2Fproposals");
    const res = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        next: "/proposals",
      }),
    });
    expect(res.headers.get("location")).toBe("/proposals");
  });

  it("never redirects off-site after login", async () => {
    const { app } = build();
    await setUpOwner(app);
    const res = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        next: "//evil.example/steal",
      }),
    });
    expect(res.headers.get("location")).toBe("/");
  });
});

// --- the login throttle --------------------------------------------------------

describe("login rate limit", () => {
  it("locks out after repeated failures and says how long to wait", async () => {
    const { app } = build();
    await setUpOwner(app);
    const attempt = () =>
      app.request("/login", {
        method: "POST",
        body: new URLSearchParams({ email: OWNER_EMAIL, password: "no-es-la-clave" }),
      });
    for (let i = 0; i < 4; i++) expect((await attempt()).status).toBe(401);
    const locked = await attempt();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await locked.text()).toContain("LOGIN_RATE_LIMITED");
    // And the right password does not get through while the lockout stands.
    const right = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(right.status).toBe(429);
    expect(cookieFrom(right)).toBe("");
  });

  it("forgets the failures once the lockout has passed", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app } = build({ now: () => clock });
    await setUpOwner(app);
    for (let i = 0; i < 5; i++) {
      await app.request("/login", {
        method: "POST",
        body: new URLSearchParams({ email: OWNER_EMAIL, password: "no-es-la-clave" }),
      });
    }
    clock = new Date("2026-09-19T10:31:00.000Z");
    const right = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(right.status).toBe(303);
  });
});

// --- sessions -------------------------------------------------------------------

describe("sessions", () => {
  it("expires after the idle window and asks for the password again", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app } = build({ now: () => clock, sessionTtlMs: 60_000 });
    const client = await setUpOwner(app);
    expect((await client.request("/")).status).toBe(200);
    clock = new Date("2026-09-19T10:02:00.000Z");
    const dead = await client.request("/");
    expect(dead.status).toBe(302);
    expect(dead.headers.get("location")).toContain("/login");
    const api = await client.request("/api/status");
    expect(api.status).toBe(401);
  });

  it("slides the expiry forward while the owner keeps working", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app } = build({ now: () => clock, sessionTtlMs: 60_000 });
    const client = await setUpOwner(app);
    // Every 40 s, for four minutes: past the raw TTL, but never idle for a whole minute.
    for (let i = 1; i <= 6; i++) {
      clock = new Date(Date.parse("2026-09-19T10:00:00.000Z") + i * 40_000);
      expect((await client.request("/")).status).toBe(200);
    }
    clock = new Date(Date.parse("2026-09-19T10:00:00.000Z") + 6 * 40_000 + 61_000);
    expect((await client.request("/")).status).toBe(302);
  });

  it("logout deletes the row, so the same cookie is worth nothing afterwards", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const out = await client.request("/logout", { method: "POST" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/login");
    const after = await client.request("/");
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toContain("/login");
  });

  it("ignores an invented session id", async () => {
    const { app } = build();
    await setUpOwner(app);
    const res = await app.request("/", {
      headers: { cookie: `agentpos_buyer_session=${"a".repeat(64)}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });
});

// --- the route matrix -------------------------------------------------------------

/** Every guarded page: an anonymous visitor is sent to /login, never served the page. */
const GUARDED_PAGES: Array<[string, string]> = [
  ["GET", "/"],
  ["GET", "/proposals"],
  ["GET", "/activity"],
  ["POST", "/profile"],
  ["POST", "/proposals"],
  ["POST", "/proposals/abc/approve"],
  ["POST", "/proposals/abc/reject"],
  ["POST", "/logout"],
];

/** Every guarded JSON route: a program gets a typed 401, not an HTML login page. */
const GUARDED_JSON: Array<[string, string]> = [
  ["GET", "/api/status"],
  ["GET", "/api/offers?q=mug"],
  ["GET", "/api/market?q=mug"],
  ["GET", "/api/proposals"],
  ["POST", "/api/proposals"],
  ["POST", "/api/proposals/abc/approve"],
  ["POST", "/api/proposals/abc/reject"],
];

describe("route protection matrix", () => {
  it("redirects every page to /login for an anonymous visitor", async () => {
    const { app } = build();
    await setUpOwner(app);
    for (const [method, path] of GUARDED_PAGES) {
      const res = await app.request(path, { method });
      expect([method, path, res.status]).toEqual([method, path, 302]);
      expect(res.headers.get("location")).toContain("/login");
      // Not a single byte of the guarded page leaks into the redirect body.
      expect(await res.text()).not.toContain("Mandato");
    }
  });

  it("answers a typed 401 on every JSON route for an anonymous caller", async () => {
    const { app } = build();
    await setUpOwner(app);
    for (const [method, path] of GUARDED_JSON) {
      const res = await app.request(path, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
      expect([method, path, res.status]).toEqual([method, path, 401]);
      const body = (await res.json()) as { error: { code: string; hint: string } };
      expect(body.error.code).toBe("AUTH_REQUIRED");
      expect(body.error.hint).toContain("/login");
    }
  });

  it("leaves /health and the way in open", async () => {
    const { app } = build();
    expect((await app.request("/health")).status).toBe(200);
    await setUpOwner(app);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/login")).status).toBe(200);
  });

  it("keeps the self-authenticating routes exactly as they were", async () => {
    const { app } = build({ channels: true });
    await setUpOwner(app);

    // Meta's GET handshake: no cookie, no redirect, the challenge echoed back.
    const handshake = await app.request(
      `/whatsapp/meta?hub.mode=subscribe&hub.verify_token=${META_CONFIG.verifyToken}&hub.challenge=12345`,
    );
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe("12345");

    // An unsigned webhook POST is refused by the signature check, not by the login.
    const unsigned = await app.request("/whatsapp/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
    const twilio = await app.request("/whatsapp/twilio", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "From=whatsapp%3A%2B56911111111&Body=hola",
    });
    expect(twilio.status).toBe(401);

    // The signer bridge: its bearer token, no cookie, no CSRF token, still 200.
    const queue = await app.request("/api/signer/queue", {
      headers: { authorization: `Bearer ${SIGNER_TOKEN}` },
    });
    expect(queue.status).toBe(200);
    const wrong = await app.request("/api/signer/queue", {
      headers: { authorization: "Bearer nope-nope-nope-nope-nope-nope" },
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      "APPROVAL_UNAUTHORIZED",
    );
  });
});

// --- csrf --------------------------------------------------------------------------

describe("csrf on every mutating route", () => {
  it("refuses a form without the token and one with a wrong token, and accepts the real one", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await withMandate(client);
    const proposal = await propose(client);

    const routes: Array<[string, RequestInit]> = [
      ["/profile", { method: "POST", body: new URLSearchParams({ maxPerTx: "1", maxTotal: "2" }) }],
      [
        "/proposals",
        {
          method: "POST",
          body: new URLSearchParams({ storeUrl: STORE_URL, itemId: "mug", quantity: "1" }),
        },
      ],
      [`/proposals/${proposal.id}/approve`, { method: "POST", body: new URLSearchParams({}) }],
      [`/proposals/${proposal.id}/reject`, { method: "POST", body: new URLSearchParams({}) }],
      ["/logout", { method: "POST", body: new URLSearchParams({}) }],
      [
        "/api/proposals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storeUrl: STORE_URL, itemId: "mug" }),
        },
      ],
      [
        `/api/proposals/${proposal.id}/approve`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ],
      [
        `/api/proposals/${proposal.id}/reject`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ],
    ];
    for (const [path, init] of routes) {
      const missing = await client.withoutCsrf(path, { ...init });
      expect([path, missing.status]).toEqual([path, 403]);
      const wrong = await client.withBadCsrf(path, { ...init });
      expect([path, wrong.status]).toEqual([path, 403]);
      const body = await wrong.text();
      expect(body).toContain("CSRF_INVALID");
    }
    // The real token still goes through: rejecting the proposal works.
    const ok = await client.request(`/api/proposals/${proposal.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(ok.status).toBe(200);
  });

  it("renders the token in every form the pages show", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await withMandate(client);
    await propose(client);
    const home = await (await client.request("/")).text();
    const proposals = await (await client.request("/proposals")).text();
    // The mandate form, the logout form, the approve and reject forms.
    expect((home.match(/name="_csrf"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((proposals.match(/name="_csrf"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(csrfFrom(home)).toBe(client.csrf);
  });

  it("gives each session its own token", async () => {
    const { app } = build();
    const first = await setUpOwner(app);
    const second = await logIn(app);
    expect(second.csrf).not.toBe(first.csrf);
    // And one session's token is worthless in the other's hands.
    const crossed = await app.request("/logout", {
      method: "POST",
      headers: { cookie: second.cookie },
      body: new URLSearchParams({ _csrf: first.csrf }),
    });
    expect(crossed.status).toBe(403);
  });
});

// --- re-authentication before an approval ------------------------------------------

describe("approving asks for the password again", () => {
  /** A mandate with a confirmation threshold, saved straight into storage. */
  function saveMandateWithThreshold(storage: BuyerWebStorage, threshold: string): void {
    storage.saveProfile(
      buyerWebProfileSchema.parse({
        id: "default",
        network: "testnet",
        stores: [STORE_URL],
        email: "buyer@example.com",
        mandate: {
          maxPerTx: "25",
          maxTotal: "100",
          period: "week",
          allowedSellers: ["shop.test"],
          allowPhysicalGoods: false,
          shippingAddressLocked: true,
          requireConfirmAboveUsdc: threshold,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  it("asks for it on every amount when the mandate sets no threshold", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await withMandate(client);
    const proposal = await propose(client);
    const html = await (await client.request("/proposals")).text();
    expect(html).toContain("Confirma con tu contrasena");
    expect(html).toContain("1.5 USDC");
    expect(html).toContain("Faro Demo Store");
    expect(html).toContain('type="password"');

    const naked = await client.request(`/proposals/${proposal.id}/approve`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
    expect(naked.status).toBe(403);
    expect(await naked.text()).toContain("Escribe tu contrasena para aprobar");
    // Nothing moved: the proposal is still waiting.
    const still = (await (await client.request("/api/proposals")).json()) as {
      proposals: Proposal[];
    };
    expect(still.proposals[0]?.status).toBe("pending");
  });

  it("refuses a wrong password and keeps the proposal pending", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await withMandate(client);
    const proposal = await propose(client);
    const res = await client.approve(proposal.id, { password: "no-es-la-clave" });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Contrasena incorrecta");
    const still = (await (await client.request("/api/proposals")).json()) as {
      proposals: Proposal[];
    };
    expect(still.proposals[0]?.status).toBe("pending");

    // The right password goes through.
    const ok = await client.approve(proposal.id);
    expect(ok.status).toBe(303);
  });

  it("asks only above the mandate threshold", async () => {
    const { app, storage } = build();
    const client = await setUpOwner(app);
    saveMandateWithThreshold(storage, "5");

    // 1.5 USDC, under the threshold: approved with the session alone.
    const small = await propose(client, "sticker");
    const cheapHtml = await (await client.request("/proposals")).text();
    expect(cheapHtml).not.toContain("Confirma con tu contrasena");
    const approvedSmall = await client.request(`/proposals/${small.id}/approve`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
    expect(approvedSmall.status).toBe(303);

    // 9.9 USDC, over it: the password is asked again.
    const big = await propose(client, "mug");
    const refused = await client.request(`/proposals/${big.id}/approve`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("9.9 USDC");
    expect((await client.approve(big.id)).status).toBe(303);
  });

  it("applies the same rule to the JSON route", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await withMandate(client);
    const proposal = await propose(client);
    const naked = await client.request(`/api/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(naked.status).toBe(403);
    expect(((await naked.json()) as { error: { code: string } }).error.code).toBe(
      "REAUTH_REQUIRED",
    );
    const wrong = await client.approve(proposal.id, { api: true, password: "otra" });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("REAUTH_FAILED");
    expect((await client.approve(proposal.id, { api: true })).status).toBe(200);
  });
});

// --- the access log ------------------------------------------------------------------

describe("the Accesos panel", () => {
  it("shows entries, refusals and approvals, by hash", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: "no-es-la-clave" }),
    });
    await withMandate(client);
    const proposal = await propose(client);
    await client.approve(proposal.id);

    const html = await (await client.request("/activity")).text();
    expect(html).toContain("Accesos");
    expect(html).toContain("cuenta creada");
    expect(html).toContain("intento fallido");
    expect(html).toContain("propuesta aprobada");
    expect(html).toContain("1.5 USDC en Faro Demo Store");
    // The panel says where from without saying from where: a hash and a browser family.
    expect(html).toContain("desconocido");
  });
});

// --- logs ------------------------------------------------------------------------------

describe("what the logs may say", () => {
  it("never writes the email, the password, the session id or the csrf token", async () => {
    const logs: string[] = [];
    const { app } = build({ logs });
    const client = await setUpOwner(app);
    await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: "no-es-la-clave" }),
    });
    await logIn(app);
    await withMandate(client);
    const proposal = await propose(client);
    await client.approve(proposal.id, { password: "no-es-la-clave" });
    await client.approve(proposal.id);
    await client.withBadCsrf("/profile", {
      method: "POST",
      body: new URLSearchParams({ maxPerTx: "1", maxTotal: "2" }),
    });
    await client.request("/logout", { method: "POST" });

    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    for (const secret of [
      OWNER_EMAIL,
      OWNER_PASSWORD,
      "no-es-la-clave",
      client.cookie.split("=").at(1) ?? "",
      client.csrf,
    ]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(all).not.toContain(secret);
    }
    // What it does say: the event, and an 8-character hash of the email.
    expect(all).toContain("auth.login_ok");
    expect(all).toContain("auth.login_failed");
    expect(all).toContain("auth.csrf_invalid");
    expect(all).toContain("auth.reauth_failed");
    expect(all).toContain("emailHash");
    expect(/"emailHash":"[0-9a-f]{8}"/.test(all)).toBe(true);
  });
});
