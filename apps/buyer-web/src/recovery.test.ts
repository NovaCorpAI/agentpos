/**
 * Getting back in, end to end over HTTP. This is the other file that has to be paranoid:
 * a recovery path is, by definition, a way past the password, so every one of them here
 * is tested for what it must NOT allow as much as for what it must.
 *
 * The three paths, in the order the pages offer them: printable recovery codes (always
 * available, no infrastructure), a six-digit code over the WhatsApp channel the owner
 * already configured, and a one-time URL printed on the server by whoever can already run
 * commands on it. Plus the normal one nobody should have to think about: changing the
 * password from inside a live session.
 *
 * There is no email reset, and its absence is deliberate: this is software people run on
 * their own box, and a self-hosted box has no mail server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLogger } from "@agentpos/core";
import { createBuyerWebApp } from "./app.js";
import { BuyerWebStorage } from "./storage.js";
import { generateWhatsAppCode, normalizeRecoveryCode } from "./auth/codes.js";
import { createOwnerNotifier } from "./whatsapp/notify.js";
import {
  OWNER_EMAIL,
  OWNER_PASSWORD,
  cookieFrom,
  csrfFrom,
  generateCodes,
  inProcessStore,
  logIn,
  setUpOwner,
  startRecovery,
} from "./test-utils.js";
import type { AppLike, BuyerWebClient } from "./test-utils.js";

const OWNER_NUMBER = "+56911111111";
const NEW_PASSWORD = "contrasena-nueva-2026";

const META_CONFIG = {
  verifyToken: "verify-token-123",
  appSecret: "meta-app-secret",
  accessToken: "meta-access-token",
  phoneNumberId: "111222333",
};

interface BuildOptions {
  now?: () => Date;
  logs?: string[];
  /** Mounts the WhatsApp channel, so the recovery code can be sent over it. */
  whatsapp?: boolean;
}

/** A buyer-web app plus, when the channel is on, everything the fake transport received. */
function build(options: BuildOptions = {}) {
  const storage = new BuyerWebStorage(":memory:");
  const sent: Array<{ to: string; text: string }> = [];
  const built = createBuyerWebApp({
    storage,
    fetchImpl: inProcessStore().fetchImpl,
    ...(options.now ? { now: options.now } : {}),
    ...(options.logs
      ? {
          logger: createLogger({
            level: "debug",
            sink: (line: string) => options.logs?.push(line),
          }),
        }
      : {}),
    ...(options.whatsapp
      ? {
          whatsapp: { allowedNumbers: [OWNER_NUMBER], meta: META_CONFIG },
          whatsappTransports: {
            meta: {
              send: async (msg: { to: string; text: string }) => {
                sent.push(msg);
              },
            },
          },
        }
      : {}),
  });
  return { ...built, storage, sent };
}

/** The six digits out of the message the owner's phone got. */
function codeFrom(text: string): string {
  return /\b(\d{6})\b/.exec(text)?.[1] ?? "";
}

/** Walks the set-a-new-password step with a recovery cookie, the way a browser does. */
async function setNewPassword(
  app: AppLike,
  cookie: string,
  password = NEW_PASSWORD,
  confirm = password,
): Promise<Response> {
  const form = await app.request("/recuperar/nueva-clave", { headers: { cookie } });
  expect(form.status).toBe(200);
  const csrf = csrfFrom(await form.text());
  expect(csrf).not.toBe("");
  return app.request("/recuperar/nueva-clave", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ _csrf: csrf, password, confirm }),
  });
}

/** Everything from "I have a code" to "I have a new password", in one call. */
async function recoverWith(app: AppLike, code: string, password = NEW_PASSWORD) {
  const started = await startRecovery(app, { code });
  expect(started.status).toBe(303);
  const done = await setNewPassword(app, started.cookie, password);
  return { cookie: started.cookie, done };
}

// --- the codes themselves -----------------------------------------------------

describe("recovery codes", () => {
  it("shows ten codes exactly once and keeps only their hashes", async () => {
    const { app, storage } = build();
    const client = await setUpOwner(app);
    const res = await client.request("/cuenta/codigos", { method: "POST" });
    const html = await res.text();
    expect(html).toContain("Guardalas ahora: no se vuelven a mostrar");
    const codes = [...html.matchAll(/<li>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/li>/g)].map(
      (m) => m[1] as string,
    );
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    // No I, O, 0 or 1 anywhere: a code has to survive being read off paper.
    for (const code of codes) expect(/[IO01]/.test(code)).toBe(false);

    // Storage has ten scrypt hashes and not one code.
    const rows = storage.listUnusedRecoveryCodes();
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row.codeHash.startsWith("scrypt$")).toBe(true);
    const dump = JSON.stringify(rows);
    for (const code of codes) expect(dump).not.toContain(code);

    // And the account page never shows them again, only how many are left.
    const account = await (await client.request("/cuenta")).text();
    for (const code of codes) expect(account).not.toContain(code);
    expect(account).toContain("10</strong> de 10");
  });

  it("accepts a code however it was typed back, and spends it exactly once", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const code = codes[0] as string;

    // Lower case, spaces instead of dashes: the same code.
    const messy = code.toLowerCase().replace(/-/g, " ");
    expect(normalizeRecoveryCode(messy)).toBe(code);
    const { done } = await recoverWith(app, messy);
    expect(done.status).toBe(303);

    // Replayed, the very same code is refused: single use, enforced in the database.
    const replay = await startRecovery(app, { code });
    expect(replay.status).toBe(401);
    expect(replay.html).toContain("RECOVERY_INVALID");
    expect(replay.cookie).toBe("");
  });

  it("keeps the other nine codes usable and counts them down", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    await recoverWith(app, codes[0] as string);
    const back = await logIn(app, { password: NEW_PASSWORD });
    expect(await (await back.request("/cuenta")).text()).toContain("9</strong> de 10");
    // A second, different code still works.
    const second = await startRecovery(app, { code: codes[1] as string });
    expect(second.status).toBe(303);
  });

  it("retires the whole old set when new codes are generated", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const first = await generateCodes(client);
    const second = await generateCodes(client);
    expect(new Set([...first, ...second]).size).toBe(20);
    const stale = await startRecovery(app, { code: first[0] as string });
    expect(stale.status).toBe(401);
    const fresh = await startRecovery(app, { code: second[0] as string });
    expect(fresh.status).toBe(303);
  });

  it("does not burn a good code presented with the wrong email", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const code = codes[0] as string;
    const wrong = await startRecovery(app, { email: "otra@ejemplo.com", code });
    expect(wrong.status).toBe(401);
    // The owner's own code survived someone else's attempt with it.
    expect((await startRecovery(app, { code })).status).toBe(303);
  });
});

// --- the reminder for an account that predates the codes ----------------------

describe("the reminder for an account with no codes", () => {
  it("offers to generate them on every page until they exist", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    for (const path of ["/", "/proposals", "/activity"]) {
      const html = await (await client.request(path)).text();
      expect([path, html.includes("Todavia no tienes codigos de recuperacion")]).toEqual([
        path,
        true,
      ]);
    }
    await generateCodes(client);
    for (const path of ["/", "/proposals", "/activity"]) {
      const html = await (await client.request(path)).text();
      expect([path, html.includes("Todavia no tienes codigos de recuperacion")]).toEqual([
        path,
        false,
      ]);
    }
  });

  it("can be put away for this session, and comes back on the next one", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const away = await client.request("/cuenta/recordatorio", {
      method: "POST",
      body: new URLSearchParams({ next: "/proposals" }),
    });
    expect(away.status).toBe(303);
    expect(away.headers.get("location")).toBe("/proposals");
    expect(await (await client.request("/")).text()).not.toContain(
      "Todavia no tienes codigos de recuperacion",
    );
    // A new session has not dismissed anything: the nudge is back.
    const second = await logIn(app);
    expect(await (await second.request("/")).text()).toContain(
      "Todavia no tienes codigos de recuperacion",
    );
  });

  it("never sends the owner off site when the banner is dismissed", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const away = await client.request("/cuenta/recordatorio", {
      method: "POST",
      body: new URLSearchParams({ next: "//evil.example/steal" }),
    });
    expect(away.headers.get("location")).toBe("/");
  });
});

// --- what a recovery session may do --------------------------------------------

describe("the recovery session", () => {
  it("cannot reach anything except the set-a-new-password page", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const started = await startRecovery(app, { code: codes[0] as string });
    const cookie = started.cookie;
    expect(cookie).not.toBe("");

    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/proposals"],
      ["GET", "/activity"],
      ["GET", "/cuenta"],
      ["GET", "/setup"],
      ["POST", "/profile"],
      ["POST", "/proposals"],
      ["POST", "/proposals/abc/approve"],
      ["POST", "/cuenta/clave"],
      ["POST", "/cuenta/codigos"],
    ] as Array<[string, string]>) {
      const res = await app.request(path, { method, headers: { cookie } });
      expect([method, path, res.status]).toEqual([method, path, 403]);
      const html = await res.text();
      expect(html).toContain("RECOVERY_SCOPE_LIMITED");
      // Nothing of the guarded pages leaks through the refusal.
      expect(html).not.toContain("Maximo por compra");
      expect(html).not.toContain(OWNER_EMAIL);
    }
    // The JSON API says the same thing in its own shape.
    const api = await app.request("/api/status", { headers: { cookie } });
    expect(api.status).toBe(403);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
      "RECOVERY_SCOPE_LIMITED",
    );
    // And the one page it exists for does answer.
    expect((await app.request("/recuperar/nueva-clave", { headers: { cookie } })).status).toBe(200);
  });

  it("is refused without a csrf token, like every other form", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const started = await startRecovery(app, { code: codes[0] as string });
    const naked = await app.request("/recuperar/nueva-clave", {
      method: "POST",
      headers: { cookie: started.cookie },
      body: new URLSearchParams({ password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
    });
    expect(naked.status).toBe(403);
    expect(await naked.text()).toContain("CSRF_INVALID");
  });

  it("sends a visitor with no recovery in flight back to the start", async () => {
    const { app } = build();
    await setUpOwner(app);
    const res = await app.request("/recuperar/nueva-clave");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/recuperar");
  });

  it("dies fifteen minutes after it was opened, and does not slide", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app } = build({ now: () => clock });
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const started = await startRecovery(app, { code: codes[0] as string });
    // Used all the way through, but never extended.
    for (const minutes of [5, 10, 14]) {
      clock = new Date(Date.parse("2026-09-19T10:00:00.000Z") + minutes * 60_000);
      const res = await app.request("/recuperar/nueva-clave", {
        headers: { cookie: started.cookie },
      });
      expect([minutes, res.status]).toEqual([minutes, 200]);
    }
    clock = new Date("2026-09-19T10:16:00.000Z");
    const dead = await app.request("/recuperar/nueva-clave", {
      headers: { cookie: started.cookie },
    });
    expect(dead.status).toBe(302);
    expect(dead.headers.get("location")).toBe("/recuperar");
  });

  it("can be abandoned by logging in with the password after all", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const started = await startRecovery(app, { code: codes[0] as string });
    // The login form answers a recovery cookie instead of bouncing it into a 403 loop.
    const form = await app.request("/login", { headers: { cookie: started.cookie } });
    expect(form.status).toBe(200);
    const back = await app.request("/login", {
      method: "POST",
      headers: { cookie: started.cookie },
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(back.status).toBe(303);
    const cookie = cookieFrom(back);
    expect((await app.request("/", { headers: { cookie } })).status).toBe(200);
    // The abandoned recovery is gone, not waiting out its fifteen minutes.
    const stale = await app.request("/recuperar/nueva-clave", {
      headers: { cookie: started.cookie },
    });
    expect(stale.status).toBe(302);
  });

  it("rejects a weak or mistyped new password and stays open", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    const started = await startRecovery(app, { code: codes[0] as string });
    const short = await setNewPassword(app, started.cookie, "corta", "corta");
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("muy corta");
    const mismatch = await setNewPassword(app, started.cookie, NEW_PASSWORD, "otra-cosa-larga");
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("no coinciden");
    // The old password still works: nothing changed on a refused attempt.
    expect((await logIn(app)).cookie).not.toBe("");
    // And the recovery is still usable.
    expect((await setNewPassword(app, started.cookie)).status).toBe(303);
  });
});

// --- finishing a recovery -------------------------------------------------------

describe("completing a recovery", () => {
  it("closes every session, including one an intruder was holding", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    // Somebody else is inside with the old password: exactly what a recovery is for.
    const intruder = await logIn(app);
    expect((await intruder.request("/")).status).toBe(200);

    const { cookie, done } = await recoverWith(app, codes[0] as string);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/login?recuperada=1");

    for (const stale of [client.cookie, intruder.cookie, cookie]) {
      const res = await app.request("/", { headers: { cookie: stale } });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    }
    // The new password is the only way in now.
    const old = await app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(old.status).toBe(401);
    const back = await logIn(app, { password: NEW_PASSWORD });
    expect((await back.request("/")).status).toBe(200);
  });

  it("says so on the login page it lands on", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    await recoverWith(app, codes[0] as string);
    const login = await (await app.request("/login?recuperada=1")).text();
    expect(login).toContain("Contrasena cambiada");
  });
});

// --- what the recovery form gives away (nothing) ---------------------------------

describe("the recovery form says nothing about who exists", () => {
  it("answers a known and an unknown email with the very same page", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await generateCodes(client);
    const known = await startRecovery(app, { code: "ABCD-EFGH-JKLM" });
    const unknown = await startRecovery(app, {
      email: "nadie@ejemplo.com",
      code: "ABCD-EFGH-JKLM",
    });
    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(401);
    expect(known.html).toBe(unknown.html);
    expect(known.html).not.toContain("no existe");
  });

  it("answers the same for a wrong code, a used code and a malformed one", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    await recoverWith(app, codes[0] as string);
    const used = await startRecovery(app, { code: codes[0] as string });
    const wrong = await startRecovery(app, { code: "ZZZZ-ZZZZ-ZZZZ" });
    const junk = await startRecovery(app, { code: "no-es-un-codigo" });
    expect([used.status, wrong.status, junk.status]).toEqual([401, 401, 401]);
    expect(used.html).toBe(wrong.html);
    expect(wrong.html).toBe(junk.html);
  });

  it("locks out after repeated attempts, per address and per account", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await generateCodes(client);
    for (let i = 0; i < 4; i++) {
      expect((await startRecovery(app, { code: "ZZZZ-ZZZZ-ZZZZ" })).status).toBe(401);
    }
    const locked = await startRecovery(app, { code: "ZZZZ-ZZZZ-ZZZZ" });
    expect(locked.status).toBe(429);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
    expect(locked.html).toContain("LOGIN_RATE_LIMITED");
    // A real code does not get through while the lockout stands.
    const codes = await generateCodes(client);
    const real = await startRecovery(app, { code: codes[0] as string });
    expect(real.status).toBe(429);
    expect(real.cookie).toBe("");
    // And the lockout is the recovery form's own: the login still answers normally.
    expect((await logIn(app)).cookie).not.toBe("");
  });
});

// --- the WhatsApp code -----------------------------------------------------------

describe("the WhatsApp code", () => {
  it("is offered only when the channel is configured", async () => {
    const off = build();
    await setUpOwner(off.app);
    const plain = await (await off.app.request("/recuperar")).text();
    expect(plain).not.toContain("Enviar codigo a mi WhatsApp");

    const on = build({ whatsapp: true });
    await setUpOwner(on.app);
    const withChannel = await (await on.app.request("/recuperar")).text();
    expect(withChannel).toContain("Enviar codigo a mi WhatsApp");
  });

  it("sends six digits to the owner's number and lets them set a new password", async () => {
    const { app, sent } = build({ whatsapp: true });
    await setUpOwner(app);
    const asked = await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL }),
    });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Si la cuenta existe, enviamos el codigo");
    expect(sent).toHaveLength(1);
    // Meta wants bare digits, and the number is the allowlisted one.
    expect(sent[0]?.to).toBe("56911111111");
    const code = codeFrom(sent[0]?.text ?? "");
    expect(code).toMatch(/^\d{6}$/);

    const { done } = await recoverWith(app, code);
    expect(done.status).toBe(303);
    expect((await logIn(app, { password: NEW_PASSWORD })).cookie).not.toBe("");
  });

  it("never says whether the email matched, and sends nothing when it did not", async () => {
    const { app, sent } = build({ whatsapp: true });
    await setUpOwner(app);
    const stranger = await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: "nadie@ejemplo.com" }),
    });
    expect(stranger.status).toBe(200);
    expect(await stranger.text()).toContain("Si la cuenta existe, enviamos el codigo");
    expect(sent).toHaveLength(0);
  });

  it("sends at most one code per minute", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app, sent } = build({ whatsapp: true, now: () => clock });
    await setUpOwner(app);
    const ask = () =>
      app.request("/recuperar/whatsapp", {
        method: "POST",
        body: new URLSearchParams({ email: OWNER_EMAIL }),
      });
    expect((await ask()).status).toBe(200);
    clock = new Date("2026-09-19T10:00:30.000Z");
    const throttled = await ask();
    // Same page, same words: the throttle is invisible from outside.
    expect(throttled.status).toBe(200);
    expect(await throttled.text()).toContain("Si la cuenta existe, enviamos el codigo");
    expect(sent).toHaveLength(1);
    clock = new Date("2026-09-19T10:01:30.000Z");
    expect((await ask()).status).toBe(200);
    expect(sent).toHaveLength(2);
    // The first code died with the second: one live challenge at a time.
    const first = codeFrom(sent[0]?.text ?? "");
    expect((await startRecovery(app, { code: first })).status).toBe(401);
    expect((await startRecovery(app, { code: codeFrom(sent[1]?.text ?? "") })).status).toBe(303);
  });

  it("dies after three wrong guesses", async () => {
    const { app, sent } = build({ whatsapp: true });
    await setUpOwner(app);
    await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL }),
    });
    const code = codeFrom(sent[0]?.text ?? "");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      expect((await startRecovery(app, { code: wrong })).status).toBe(401);
    }
    // The real code is worth nothing now: the challenge is gone, not just this guess.
    expect((await startRecovery(app, { code })).status).toBe(401);
  });

  it("expires ten minutes after it was sent", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app, sent } = build({ whatsapp: true, now: () => clock });
    await setUpOwner(app);
    await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL }),
    });
    const code = codeFrom(sent[0]?.text ?? "");
    clock = new Date("2026-09-19T10:11:00.000Z");
    expect((await startRecovery(app, { code })).status).toBe(401);
  });

  it("refuses to message a number that is not on the allowlist", async () => {
    const log: Array<{ event: string }> = [];
    const sent: Array<{ to: string; text: string }> = [];
    const notifier = createOwnerNotifier({
      config: { allowedNumbers: [OWNER_NUMBER], meta: META_CONFIG },
      transports: {
        meta: {
          send: async (msg: { to: string; text: string }) => {
            sent.push(msg);
          },
        },
      },
      log: (event) => log.push({ event }),
    });
    expect(notifier).toBeDefined();
    // The owner's own number, written any of the ways a provider might: fine.
    await notifier?.sendTo("whatsapp:+56911111111", "hola");
    await notifier?.sendTo("56911111111", "hola");
    expect(sent).toHaveLength(2);
    // Anything else: refused here, before the transport is ever reached, whatever the
    // caller (or a provider echoing a number back) claims.
    await expect(notifier?.sendTo("+56999999999", generateWhatsAppCode())).rejects.toThrow(
      /WHATSAPP_ALLOWED_NUMBERS/,
    );
    expect(sent).toHaveLength(2);
    expect(log.some((l) => l.event === "whatsapp.notify_refused")).toBe(true);
  });

  it("does not exist as a channel when no provider is configured", () => {
    const notifier = createOwnerNotifier({
      config: { allowedNumbers: [OWNER_NUMBER] },
      transports: {},
      log: () => undefined,
    });
    expect(notifier).toBeUndefined();
  });
});

// --- the operator's one-time URL ---------------------------------------------------

describe("the operator link printed on the server", () => {
  /** What `node dist/auth/recover-cli.js` prints, without spawning a process. */
  async function issue(auth: { issueOperatorToken: () => Promise<{ token: string }> }) {
    return (await auth.issueOperatorToken()).token;
  }

  it("opens a recovery, exactly once", async () => {
    const { app, auth, storage } = build();
    await setUpOwner(app);
    const token = await issue(auth);
    // Stored hashed: the database never holds the link itself.
    const challenge = storage.getRecoveryChallenge("operator");
    expect(challenge?.codeHash.startsWith("scrypt$")).toBe(true);
    expect(challenge?.codeHash).not.toContain(token);

    // The GET only confirms: a link preview cannot burn the token.
    const page = await app.request(`/recuperar/operador?t=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Salta la contrasena");
    expect(storage.getRecoveryChallenge("operator")).toBeDefined();

    const used = await app.request("/recuperar/operador", {
      method: "POST",
      body: new URLSearchParams({ token }),
    });
    expect(used.status).toBe(303);
    const done = await setNewPassword(app, cookieFrom(used));
    expect(done.status).toBe(303);

    // Replayed: nothing left to spend.
    const again = await app.request("/recuperar/operador", {
      method: "POST",
      body: new URLSearchParams({ token }),
    });
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("RECOVERY_INVALID");
  });

  it("expires after fifteen minutes", async () => {
    let clock = new Date("2026-09-19T10:00:00.000Z");
    const { app, auth } = build({ now: () => clock });
    await setUpOwner(app);
    const token = await issue(auth);
    clock = new Date("2026-09-19T10:16:00.000Z");
    const late = await app.request("/recuperar/operador", {
      method: "POST",
      body: new URLSearchParams({ token }),
    });
    expect(late.status).toBe(401);
  });

  it("refuses an invented token and cannot be asked for one over http", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const invented = await app.request("/recuperar/operador", {
      method: "POST",
      body: new URLSearchParams({ token: "f".repeat(64) }),
    });
    expect(invented.status).toBe(401);
    // There is no route that hands one out: only the CLI on the box can.
    for (const path of ["/recuperar/operador/nuevo", "/api/recovery/operator", "/cuenta/operador"]) {
      expect((await client.request(path, { method: "POST" })).status).toBe(404);
    }
  });

  it("writes the issue and the use into the access log the owner reads", async () => {
    const { app, auth } = build();
    const client = await setUpOwner(app);
    const token = await issue(auth);
    const used = await app.request("/recuperar/operador", {
      method: "POST",
      body: new URLSearchParams({ token }),
    });
    await setNewPassword(app, cookieFrom(used));
    const back = await logIn(app, { password: NEW_PASSWORD });
    const html = await (await back.request("/activity")).text();
    expect(html).toContain("enlace de recuperacion del servidor");
    expect(html).toContain("recuperacion iniciada");
    expect(html).toContain("contrasena recuperada");
    expect(html).toContain("enlace de operador usado desde el servidor");
    expect(client.cookie).not.toBe("");
  });
});

// --- changing the password from inside ----------------------------------------------

describe("changing the password while signed in", () => {
  async function change(
    client: BuyerWebClient,
    fields: { current?: string; password?: string; confirm?: string } = {},
  ): Promise<Response> {
    const password = fields.password ?? NEW_PASSWORD;
    return client.request("/cuenta/clave", {
      method: "POST",
      body: new URLSearchParams({
        current: fields.current ?? OWNER_PASSWORD,
        password,
        confirm: fields.confirm ?? password,
      }),
    });
  }

  it("asks for the current password and refuses a wrong one", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const res = await change(client, { current: "no-es-la-clave" });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("REAUTH_FAILED");
    expect(html).toContain("Tu contrasena actual no es esa");
    // Nothing changed: the old password still opens the door.
    expect((await logIn(app)).cookie).not.toBe("");
  });

  it("refuses a short or mistyped new password", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    expect((await change(client, { password: "corta" })).status).toBe(400);
    expect((await change(client, { confirm: "otra-cosa-larga" })).status).toBe(400);
    expect((await logIn(app)).cookie).not.toBe("");
  });

  it("changes it, keeps this session and closes the others", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    const other = await logIn(app);
    const res = await change(client);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cuenta?saved=1");

    // This session is untouched: nobody is thrown out of the page they are standing on.
    const still = await client.request("/cuenta?saved=1");
    expect(still.status).toBe(200);
    expect(await still.text()).toContain("Contrasena cambiada");
    // The other one is gone.
    const dead = await other.request("/");
    expect(dead.status).toBe(302);
    // And the new password is the one that works.
    expect(
      (
        await app.request("/login", {
          method: "POST",
          body: new URLSearchParams({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
        })
      ).status,
    ).toBe(401);
    expect((await logIn(app, { password: NEW_PASSWORD })).cookie).not.toBe("");
  });

  it("lands in the access log", async () => {
    const { app } = build();
    const client = await setUpOwner(app);
    await change(client);
    const html = await (await client.request("/activity")).text();
    expect(html).toContain("contrasena cambiada");
    expect(html).toContain("las demas sesiones se cerraron");
  });
});

// --- the upgrade itself ---------------------------------------------------------------

describe("an installation that predates recovery", () => {
  it("gains the new tables without logging the owner out", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentpos-buyer-")), "buyer-web.sqlite");
    // The schema exactly as it shipped before recovery existed: no `scope` on sessions,
    // no recovery tables. This is what is running in production today.
    const old = new DatabaseSync(file);
    old.exec(`
      create table sessions (id text primary key, account_id text not null, csrf_token text not null, created_at text not null, expires_at text not null, last_seen_at text not null, ip_hash text not null, ua_family text not null);
      insert into sessions values ('sesion-vieja', 'owner', 'token-viejo', '2026-09-19T10:00:00.000Z', '2999-01-01T00:00:00.000Z', '2026-09-19T10:00:00.000Z', 'abcd1234', 'Firefox');
    `);
    old.close();

    const storage = new BuyerWebStorage(file);
    const session = storage.getSession("sesion-vieja");
    expect(session?.csrfToken).toBe("token-viejo");
    // Every session that existed before the upgrade is a full one, which is the default.
    expect(session?.scope).toBe("full");
    // And the recovery tables are there, empty, so the banner offers to fill them.
    expect(storage.countRecoveryCodes()).toEqual({ total: 0, unused: 0 });
    expect(storage.getRecoveryChallenge("operator")).toBeUndefined();
    storage.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});

// --- the access log and the structured log -------------------------------------------

describe("what recovery writes down", () => {
  it("puts every step on the Accesos panel", async () => {
    const { app, sent } = build({ whatsapp: true });
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL }),
    });
    await startRecovery(app, { code: "ZZZZ-ZZZZ-ZZZZ" });
    await recoverWith(app, codes[0] as string);
    const back = await logIn(app, { password: NEW_PASSWORD });
    const html = await (await back.request("/activity")).text();
    for (const line of [
      "codigos de recuperacion nuevos",
      "codigo enviado por WhatsApp",
      "codigo de recuperacion rechazado",
      "recuperacion iniciada",
      "contrasena recuperada",
    ]) {
      expect([line, html.includes(line)]).toEqual([line, true]);
    }
    // Not one code, used or not, is written into the history the owner reads.
    for (const code of codes) expect(html).not.toContain(code);
    expect(html).not.toContain(codeFrom(sent[0]?.text ?? ""));
  });

  it("never writes a code, a token or a password into the structured log", async () => {
    const logs: string[] = [];
    const { app, auth, sent } = build({ whatsapp: true, logs });
    const client = await setUpOwner(app);
    const codes = await generateCodes(client);
    await app.request("/recuperar/whatsapp", {
      method: "POST",
      body: new URLSearchParams({ email: OWNER_EMAIL }),
    });
    const whatsappCode = codeFrom(sent[0]?.text ?? "");
    const token = (await auth.issueOperatorToken()).token;
    await startRecovery(app, { code: "ZZZZ-ZZZZ-ZZZZ" });
    await recoverWith(app, codes[0] as string);

    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [...codes, whatsappCode, token, OWNER_EMAIL, NEW_PASSWORD]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(all).not.toContain(secret);
    }
    // What it does say: the events, and an eight character hash of the email.
    for (const event of [
      "auth.recovery_codes_generated",
      "auth.recovery_code_sent",
      "auth.recovery_failed",
      "auth.recovery_started",
      "auth.recovery_completed",
    ]) {
      expect([event, all.includes(event)]).toEqual([event, true]);
    }
    expect(/"emailHash":"[0-9a-f]{8}"/.test(all)).toBe(true);
  });
});
