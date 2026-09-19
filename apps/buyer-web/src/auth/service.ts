/**
 * The access layer of the buyer space: one owner account, server-side sessions, a per
 * session CSRF token, a login throttle, three ways back in after a lost password, and an
 * access log the owner can read.
 *
 * Why it exists: this surface can raise a spending limit and approve a payment that the
 * owner's own machine will then sign. It is exactly as valuable as the money behind it, so
 * it gets a real login instead of a proxy-level gate.
 *
 * Why there is no "email me a reset link": this is software people run on their own box,
 * and a self-hosted install has no mail server. A reset path that silently needs SMTP is a
 * reset path that does not work the day it is needed. The three that do work, in the order
 * the pages offer them: a printable recovery code, a code over the WhatsApp channel the
 * owner already configured, and a one-time URL printed by someone with a shell on the box.
 *
 * Five rules this module never bends:
 *  1. The password exists here only as a scrypt hash. Nothing logs it, nothing stores it.
 *  2. Neither does a recovery code, a WhatsApp code or an operator token: scrypt hashes,
 *     shown once, never written to a log line.
 *  3. A log line may carry a hash of the email, never the email, never the session id.
 *  4. A wrong email and a wrong password are the same answer, and cost the same time. So
 *     are an unknown email and a known one on the recovery form.
 *  5. Finishing a recovery kills every session, including whatever an intruder was holding.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "@agentpos/core";
import type { BuyerWebStorage } from "../storage.js";
import type {
  AccessEntry,
  OwnerAccount,
  RecoveryChallengeKind,
  SessionRecord,
  SessionScope,
} from "../types.js";
import {
  generateOperatorToken,
  generateRecoveryCodes,
  generateWhatsAppCode,
  isOperatorToken,
  isWhatsAppCode,
  normalizeRecoveryCode,
  normalizeWhatsAppCode,
} from "./codes.js";
import { AuthError } from "./errors.js";
import { emailHash } from "./fingerprint.js";
import type { RequestOrigin } from "./fingerprint.js";
import { LoginThrottle } from "./ratelimit.js";
import { dummyHash, hashPassword, verifyPassword } from "./scrypt.js";

/** How long a session lives without use. It slides forward on every authenticated request. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A recovery session exists to set one password. Fifteen minutes is longer than that takes
 * and shorter than a coffee break on a shared screen. It does not slide.
 */
export const RECOVERY_SESSION_TTL_MS = 15 * 60 * 1000;

/** How long a WhatsApp code is worth typing. */
export const WHATSAPP_CODE_TTL_MS = 10 * 60 * 1000;

/** How long the operator's one-time URL lives. */
export const OPERATOR_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Wrong guesses a live challenge survives. The fourth kills it and a new one is needed. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** One WhatsApp code per minute, so the form cannot be used to spam the owner's phone. */
export const WHATSAPP_CODE_RESEND_MS = 60 * 1000;

/** Short enough to be typed, long enough that a throttled guess is hopeless. */
export const MIN_PASSWORD_LENGTH = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one refusal a caller gets for a wrong email and for a wrong password alike. */
function wrongCredentials(): AuthError {
  return new AuthError("INVALID_CREDENTIALS", "Correo o contrasena incorrectos", {
    hint: "Revisa los dos campos. Este espacio tiene una sola cuenta, la del dueno.",
  });
}

export interface OwnerBootstrap {
  email: string;
  /** A scrypt hash (`scrypt$...`). A plaintext password is refused in config.ts. */
  passwordHash: string;
}

export interface AuthServiceDeps {
  storage: BuyerWebStorage;
  now?: () => Date;
  sessionTtlMs?: number;
  /** Structured log. Only event codes and hashes ever reach it. */
  logger?: Logger;
  /**
   * How a six-digit recovery code reaches the owner, when the WhatsApp channel is
   * configured. It is the same transport the bot replies through, and it refuses any
   * number that is not on WHATSAPP_ALLOWED_NUMBERS. Absent means the page does not offer
   * the WhatsApp route at all.
   */
  notifier?: OwnerNotifier;
}

/** What sending a recovery code to the owner's own phone needs. See whatsapp/notify.ts. */
export interface OwnerNotifier {
  /** The allowlisted number the code goes to, for the log line (already a hash upstream). */
  send(text: string): Promise<void>;
}

/** What the WhatsApp step answers. Deliberately the same shape whatever happened. */
export interface WhatsAppCodeRequest {
  /** True only when a message actually went out. Never surfaced to the caller's page. */
  sent: boolean;
  /** Why not, for the log. Never rendered: the page always says the same sentence. */
  reason?: "no-account" | "throttled" | "no-channel" | "send-failed";
}

/**
 * A code that was looked up but not yet spent. Splitting the two is what lets the email
 * be checked before anything is consumed: presenting a good code with the wrong address
 * must not burn it. `commit` spends it and answers false if someone else got there first.
 */
interface Attempt {
  ok: boolean;
  commit: () => boolean;
}

const REFUSED: Attempt = { ok: false, commit: () => false };

export interface AuthenticatedSession {
  session: SessionRecord;
  account: OwnerAccount;
}

export class AuthService {
  private readonly storage: BuyerWebStorage;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly logger: Logger | undefined;
  private readonly throttle: LoginThrottle;
  private readonly notifier: OwnerNotifier | undefined;
  /**
   * Sessions that dismissed the "you have no recovery codes" banner. In memory on purpose:
   * it is a nudge, not a setting, and the worst a restart can do is show it again.
   */
  private readonly dismissedCodeReminder = new Set<string>();

  constructor(deps: AuthServiceDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.sessionTtlMs ?? SESSION_TTL_MS;
    this.logger = deps.logger;
    this.notifier = deps.notifier;
    this.throttle = new LoginThrottle(this.now);
    this.storage.deleteExpiredSessions(this.now().toISOString());
  }

  // --- the owner account -----------------------------------------------------

  hasOwner(): boolean {
    return this.storage.getOwner() !== undefined;
  }

  owner(): OwnerAccount | undefined {
    return this.storage.getOwner();
  }

  /**
   * Creates the one owner account and logs them in. Answers SETUP_DONE forever after: a
   * second account on this surface would be a second person who can spend the first one's
   * money, so there is no path to one.
   */
  async setup(
    input: { email: string; password: string; confirm: string },
    origin: RequestOrigin,
  ): Promise<SessionRecord> {
    if (this.hasOwner()) throw setupDone();
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new AuthError("ACCOUNT_INVALID", "Ese correo no parece un correo", {
        hint: "Escribe una direccion completa, por ejemplo tu@ejemplo.com.",
      });
    }
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError("ACCOUNT_INVALID", "La contrasena es muy corta", {
        hint: `Usa al menos ${String(MIN_PASSWORD_LENGTH)} caracteres. Esta clave protege tus limites de gasto.`,
      });
    }
    if (input.password !== input.confirm) {
      throw new AuthError("ACCOUNT_INVALID", "Las dos contrasenas no coinciden", {
        hint: "Escribe la misma contrasena en los dos campos.",
      });
    }
    const at = this.now().toISOString();
    this.storage.saveOwner({
      id: "owner",
      email,
      passwordHash: await hashPassword(input.password),
      createdAt: at,
      updatedAt: at,
    });
    this.logger?.info("auth.setup", { emailHash: emailHash(email), ...origin });
    this.record("setup", origin, emailHash(email), "cuenta del dueno creada");
    return this.openSession(origin);
  }

  /**
   * Creates (or updates) the owner from the environment, for a deploy that cannot stop at a
   * setup form. The pair is authoritative: changing it in the env and restarting is how an
   * owner who lost the password gets back in, and every live session dies with the change.
   */
  bootstrapOwner(bootstrap: OwnerBootstrap): void {
    const email = bootstrap.email.trim().toLowerCase();
    const current = this.storage.getOwner();
    if (current && current.email === email && current.passwordHash === bootstrap.passwordHash) {
      return;
    }
    const at = this.now().toISOString();
    this.storage.saveOwner({
      id: "owner",
      email,
      passwordHash: bootstrap.passwordHash,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    });
    if (current) this.storage.deleteAllSessions();
    const event = current ? "auth.owner_replaced_from_env" : "auth.owner_created_from_env";
    this.logger?.info(event, { emailHash: emailHash(email) });
    this.record(
      "setup",
      { ipHash: "entorno", uaFamily: "servidor" },
      emailHash(email),
      current
        ? "cuenta del dueno reemplazada desde el entorno; sesiones cerradas"
        : "cuenta del dueno creada desde el entorno",
    );
  }

  // --- login / logout --------------------------------------------------------

  /**
   * Verifies the credentials and opens a session. An unknown email pays the same scrypt
   * cost as a known one, so nothing in the timing says whether an account exists.
   */
  async login(
    input: { email: string; password: string },
    origin: RequestOrigin,
  ): Promise<SessionRecord> {
    const email = input.email.trim().toLowerCase();
    const hashed = emailHash(email);
    const keys = [`ip:${origin.ipHash}`, `account:${hashed}`];
    const wait = this.throttle.retryAfter(keys);
    if (wait > 0) {
      this.logger?.warn("auth.login_rate_limited", {
        emailHash: hashed,
        retryAfter: wait,
        ...origin,
      });
      this.record("login_rate_limited", origin, hashed, `espera ${String(wait)} s`);
      throw rateLimited(wait);
    }
    const account = this.storage.getOwner();
    const ok = await verifyPassword(input.password, account?.passwordHash ?? (await dummyHash()));
    if (!account || !ok || account.email !== email) {
      const next = this.throttle.fail(keys);
      this.logger?.warn("auth.login_failed", { emailHash: hashed, ...origin });
      this.record("login_failed", origin, hashed, "correo o contrasena incorrectos");
      if (next > 0) throw rateLimited(next);
      throw wrongCredentials();
    }
    this.throttle.succeed(keys);
    this.logger?.info("auth.login_ok", { emailHash: hashed, ...origin });
    this.record("login_ok", origin, hashed, "sesion iniciada");
    return this.openSession(origin);
  }

  /**
   * Drops a half-finished recovery session. Called when the owner logs in normally after
   * starting one: knowing the password makes the recovery moot, and a live recovery row
   * next to a real session is a credential nobody needs any more. A full session is left
   * alone, so this can be called with whatever cookie happens to be on the request.
   */
  discardRecoverySession(sessionId: string): void {
    if (sessionId.length === 0) return;
    if (this.storage.getSession(sessionId)?.scope !== "recovery") return;
    this.storage.deleteSession(sessionId);
  }

  logout(sessionId: string, origin: RequestOrigin): void {
    if (sessionId.length === 0) return;
    const session = this.storage.getSession(sessionId);
    this.storage.deleteSession(sessionId);
    if (!session) return;
    const account = this.storage.getOwner();
    const hashed = account ? emailHash(account.email) : "";
    this.logger?.info("auth.logout", { emailHash: hashed, ...origin });
    this.record("logout", origin, hashed, "sesion cerrada");
  }

  // --- sessions --------------------------------------------------------------

  /**
   * The account behind a cookie, or undefined. Expired rows are deleted on sight, and a
   * live one slides its expiry forward: a session dies from inactivity, not from the clock.
   */
  validateSession(sessionId: string, origin: RequestOrigin): AuthenticatedSession | undefined {
    if (sessionId.length === 0) return undefined;
    const session = this.storage.getSession(sessionId);
    if (!session) return undefined;
    const now = this.now();
    if (session.expiresAt <= now.toISOString()) {
      this.storage.deleteSession(session.id);
      this.logger?.info("auth.session_expired", { ...origin });
      this.record("session_expired", origin, "", "sesion expirada por inactividad");
      return undefined;
    }
    const account = this.storage.getOwner();
    if (!account || account.id !== session.accountId) {
      this.storage.deleteSession(session.id);
      return undefined;
    }
    const at = now.toISOString();
    // A recovery session does not slide: it has fifteen minutes to set one password, and
    // reloading the form is not a reason to extend the window it was opened for.
    if (session.scope === "recovery") {
      this.storage.touchSession(session.id, session.expiresAt, at);
      return { session: { ...session, lastSeenAt: at }, account };
    }
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    this.storage.touchSession(session.id, expiresAt, at);
    return { session: { ...session, expiresAt, lastSeenAt: at }, account };
  }

  /** Seconds a session cookie should live, matching the row's sliding expiry. */
  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  // --- csrf ------------------------------------------------------------------

  /** Constant-time check of the per-session token. Throws CSRF_INVALID, never returns false. */
  requireCsrf(session: SessionRecord, token: string, origin: RequestOrigin): void {
    const expected = Buffer.from(session.csrfToken, "utf8");
    const actual = Buffer.from(token, "utf8");
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (ok) return;
    this.logger?.warn("auth.csrf_invalid", { ...origin });
    this.record("csrf_invalid", origin, "", "formulario sin token valido");
    throw new AuthError("CSRF_INVALID", "El formulario no traia un token valido", {
      hint: "Vuelve a cargar la pagina y repite la accion; no se cambio nada.",
    });
  }

  // --- re-authentication -----------------------------------------------------

  /** Checks the password again (approving a payment), without touching the session. */
  async verifyOwnerPassword(password: string): Promise<boolean> {
    const account = this.storage.getOwner();
    const ok = await verifyPassword(password, account?.passwordHash ?? (await dummyHash()));
    return account !== undefined && ok;
  }

  /** Records the refusal of a re-authentication, so a wrong password is never silent. */
  noteReauthFailed(origin: RequestOrigin, detail: string): void {
    const account = this.storage.getOwner();
    this.logger?.warn("auth.reauth_failed", {
      emailHash: account ? emailHash(account.email) : "",
      ...origin,
    });
    this.record("reauth_failed", origin, account ? emailHash(account.email) : "", detail);
  }

  /** Records an approval, so the money decisions sit in the same list as the logins. */
  noteApproval(origin: RequestOrigin, detail: string): void {
    const account = this.storage.getOwner();
    this.record("approval", origin, account ? emailHash(account.email) : "", detail);
  }

  // --- changing the password from inside -------------------------------------

  /**
   * The normal path: the owner knows the password and wants a different one. The current
   * password is asked again (a live session is not proof that the person at the keyboard
   * is the owner), every OTHER session dies, and this one survives so nobody is thrown out
   * of the page they are standing on.
   */
  async changePassword(
    input: { current: string; password: string; confirm: string },
    session: SessionRecord,
    origin: RequestOrigin,
  ): Promise<void> {
    const account = this.storage.getOwner();
    const ok = await verifyPassword(input.current, account?.passwordHash ?? (await dummyHash()));
    if (!account || !ok) {
      this.logger?.warn("auth.password_change_refused", {
        emailHash: account ? emailHash(account.email) : "",
        ...origin,
      });
      this.record(
        "reauth_failed",
        origin,
        account ? emailHash(account.email) : "",
        "contrasena actual incorrecta al cambiarla",
      );
      throw new AuthError("REAUTH_FAILED", "Tu contrasena actual no es esa", {
        hint: "Escribe la contrasena con la que entraste. Nada cambio.",
      });
    }
    this.assertNewPassword(input.password, input.confirm);
    const at = this.now().toISOString();
    this.storage.saveOwner({
      ...account,
      passwordHash: await hashPassword(input.password),
      updatedAt: at,
    });
    this.storage.deleteOtherSessions(session.id);
    this.logger?.info("auth.password_changed", { emailHash: emailHash(account.email), ...origin });
    this.record(
      "password_changed",
      origin,
      emailHash(account.email),
      "contrasena cambiada desde la sesion; las demas sesiones se cerraron",
    );
  }

  // --- recovery codes ---------------------------------------------------------

  /** How many printable codes are still good. Zero is what the reminder banner reacts to. */
  recoveryCodes(): { total: number; unused: number } {
    return this.storage.countRecoveryCodes();
  }

  /**
   * A fresh set of ten. The plaintext codes are returned once, to be shown once; only
   * their scrypt hashes are kept. Every previous code stops working the moment this runs,
   * which is the point: a set the owner is unsure about is a set to replace.
   */
  async generateRecoveryCodes(origin: RequestOrigin): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((code) => hashPassword(code)));
    const at = this.now().toISOString();
    this.storage.replaceRecoveryCodes(hashes, at);
    const account = this.storage.getOwner();
    const hashed = account ? emailHash(account.email) : "";
    this.logger?.info("auth.recovery_codes_generated", {
      emailHash: hashed,
      count: codes.length,
      ...origin,
    });
    this.record(
      "recovery_codes_generated",
      origin,
      hashed,
      `${String(codes.length)} codigos nuevos; los anteriores dejaron de servir`,
    );
    return codes;
  }

  /** True while the owner has never generated a set: what puts the banner on the page. */
  needsRecoveryCodes(): boolean {
    return this.storage.countRecoveryCodes().total === 0;
  }

  /** The banner is a nudge, so a session may put it away without answering it. */
  dismissCodeReminder(sessionId: string): void {
    if (sessionId.length > 0) this.dismissedCodeReminder.add(sessionId);
  }

  reminderDismissed(sessionId: string): boolean {
    return this.dismissedCodeReminder.has(sessionId);
  }

  // --- getting back in --------------------------------------------------------

  /** True when the pages may offer "send me a code on WhatsApp". */
  get whatsappRecoveryAvailable(): boolean {
    return this.notifier !== undefined;
  }

  /**
   * Sends a six-digit code to the owner's allowlisted WhatsApp number. The answer is the
   * same page whatever happened here, so the form cannot be used to find out whether an
   * email has an account: `sent` and `reason` exist for the log, never for the response.
   */
  async requestWhatsAppCode(email: string, origin: RequestOrigin): Promise<WhatsAppCodeRequest> {
    const wanted = email.trim().toLowerCase();
    const hashed = emailHash(wanted);
    const account = this.storage.getOwner();
    if (!this.notifier) return { sent: false, reason: "no-channel" };
    if (!account || account.email !== wanted) {
      this.logger?.warn("auth.recovery_code_not_sent", { emailHash: hashed, ...origin });
      return { sent: false, reason: "no-account" };
    }
    const live = this.storage.getRecoveryChallenge("whatsapp");
    const nowMs = this.now().getTime();
    if (live && nowMs - Date.parse(live.createdAt) < WHATSAPP_CODE_RESEND_MS) {
      this.logger?.warn("auth.recovery_code_throttled", { emailHash: hashed, ...origin });
      return { sent: false, reason: "throttled" };
    }
    const code = generateWhatsAppCode();
    const now = this.now();
    this.storage.putRecoveryChallenge({
      kind: "whatsapp",
      codeHash: await hashPassword(code),
      createdAt: now.toISOString(),
      expiresAt: new Date(nowMs + WHATSAPP_CODE_TTL_MS).toISOString(),
      attempts: 0,
    });
    try {
      await this.notifier.send(
        [
          `Codigo para recuperar tu espacio AgentPOS: ${code}`,
          "Vale 10 minutos y se usa una sola vez.",
          "Si no lo pediste tu, ignora este mensaje y revisa el panel Accesos: alguien intento entrar.",
        ].join("\n"),
      );
    } catch {
      // The code stays stored: the owner can ask again in a minute. Nothing about the
      // failure (or the number) reaches the page or the log beyond this event code.
      this.storage.deleteRecoveryChallenge("whatsapp");
      this.logger?.warn("auth.recovery_code_send_failed", { emailHash: hashed, ...origin });
      return { sent: false, reason: "send-failed" };
    }
    this.logger?.info("auth.recovery_code_sent", { emailHash: hashed, ...origin });
    this.record("recovery_code_sent", origin, hashed, "codigo enviado al WhatsApp del dueno");
    return { sent: true };
  }

  /**
   * The recovery form: an email plus either a printable code or a six-digit WhatsApp code.
   * On success it opens a session that can do exactly one thing, set a new password.
   *
   * Every failure is the same refusal, and every failure costs a scrypt derivation, so
   * neither the words nor the clock says whether that email has an account here.
   */
  async startRecovery(
    input: { email: string; code: string },
    origin: RequestOrigin,
  ): Promise<SessionRecord> {
    const email = input.email.trim().toLowerCase();
    const hashed = emailHash(email);
    const keys = [`recover:ip:${origin.ipHash}`, `recover:account:${hashed}`];
    const wait = this.throttle.retryAfter(keys);
    if (wait > 0) {
      this.logger?.warn("auth.recovery_rate_limited", {
        emailHash: hashed,
        retryAfter: wait,
        ...origin,
      });
      this.record("recovery_rate_limited", origin, hashed, `espera ${String(wait)} s`);
      throw rateLimited(wait);
    }
    const account = this.storage.getOwner();
    const emailMatches = account !== undefined && account.email === email;
    const raw = input.code.trim();
    const attempt = isWhatsAppCode(raw)
      ? await this.matchChallenge("whatsapp", normalizeWhatsAppCode(raw))
      : await this.matchPrintedCode(normalizeRecoveryCode(raw));
    // The code is only spent once the email has also checked out, and `commit` is the
    // atomic step: whoever loses a race with a replay reads false here.
    const matched = emailMatches && attempt.ok && attempt.commit();
    if (!emailMatches || !matched) {
      const next = this.throttle.fail(keys);
      this.logger?.warn("auth.recovery_failed", { emailHash: hashed, ...origin });
      this.record("recovery_failed", origin, hashed, "codigo de recuperacion rechazado");
      if (next > 0) throw rateLimited(next);
      throw recoveryRefused();
    }
    this.throttle.succeed(keys);
    this.logger?.info("auth.recovery_started", { emailHash: hashed, ...origin });
    this.record(
      "recovery_started",
      origin,
      hashed,
      "codigo correcto: solo puede fijar una contrasena nueva",
    );
    return this.openSession(origin, "recovery");
  }

  /**
   * The operator's one-time URL, printed on the server by someone who can already run
   * commands there. It bypasses the password on purpose, which is why it is single use,
   * expires in fifteen minutes, is stored hashed, and lands in the access log either way.
   */
  async startRecoveryWithOperatorToken(
    token: string,
    origin: RequestOrigin,
  ): Promise<SessionRecord> {
    const keys = [`recover:ip:${origin.ipHash}`, "recover:operator"];
    const wait = this.throttle.retryAfter(keys);
    if (wait > 0) {
      this.record("recovery_rate_limited", origin, "", `espera ${String(wait)} s`);
      throw rateLimited(wait);
    }
    const attempt = isOperatorToken(token)
      ? await this.matchChallenge("operator", token.trim())
      : REFUSED;
    const ok = attempt.ok && attempt.commit();
    if (!ok) {
      const next = this.throttle.fail(keys);
      this.logger?.warn("auth.recovery_operator_failed", { ...origin });
      this.record("recovery_failed", origin, "", "enlace de operador invalido o vencido");
      if (next > 0) throw rateLimited(next);
      throw recoveryRefused();
    }
    this.throttle.succeed(keys);
    const account = this.storage.getOwner();
    const hashed = account ? emailHash(account.email) : "";
    this.logger?.warn("auth.recovery_operator_used", { ...origin });
    this.record(
      "recovery_started",
      origin,
      hashed,
      "enlace de operador usado desde el servidor: salta la contrasena",
    );
    return this.openSession(origin, "recovery");
  }

  /**
   * Issues the operator's one-time URL token. Called only by the CLI on the box, never by
   * a route: nothing over HTTP can ask for one.
   */
  async issueOperatorToken(): Promise<{ token: string; expiresAt: string }> {
    const token = generateOperatorToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + OPERATOR_TOKEN_TTL_MS).toISOString();
    this.storage.putRecoveryChallenge({
      kind: "operator",
      codeHash: await hashPassword(token),
      createdAt: now.toISOString(),
      expiresAt,
      attempts: 0,
    });
    const account = this.storage.getOwner();
    this.record(
      "operator_token_issued",
      { ipHash: "servidor", uaFamily: "cli" },
      account ? emailHash(account.email) : "",
      "enlace de recuperacion de un solo uso emitido en el servidor",
    );
    return { token, expiresAt };
  }

  /**
   * The end of a recovery: a new password, and then nothing survives. Every session dies,
   * this one included and whatever an intruder was holding included, so the owner logs in
   * fresh and alone. Any leftover challenge is retired at the same time.
   */
  async completeRecovery(
    input: { password: string; confirm: string },
    session: SessionRecord,
    origin: RequestOrigin,
  ): Promise<void> {
    if (session.scope !== "recovery") {
      throw new AuthError("RECOVERY_REQUIRED", "Esta pagina necesita una recuperacion en curso", {
        hint: "Empieza en /recuperar con tu correo y un codigo.",
      });
    }
    const account = this.storage.getOwner();
    if (!account) {
      throw new AuthError("SETUP_REQUIRED", "Esta instalacion todavia no tiene dueno", {
        hint: "Crea la cuenta en /setup.",
      });
    }
    this.assertNewPassword(input.password, input.confirm);
    const at = this.now().toISOString();
    this.storage.saveOwner({
      ...account,
      passwordHash: await hashPassword(input.password),
      updatedAt: at,
    });
    this.storage.deleteRecoveryChallenge("whatsapp");
    this.storage.deleteRecoveryChallenge("operator");
    this.storage.deleteAllSessions();
    this.logger?.info("auth.recovery_completed", {
      emailHash: emailHash(account.email),
      ...origin,
    });
    this.record(
      "recovery_completed",
      origin,
      emailHash(account.email),
      "contrasena nueva por recuperacion; todas las sesiones se cerraron",
    );
  }

  // --- access log ------------------------------------------------------------

  access(limit = 40): AccessEntry[] {
    return this.storage.listAccess(limit);
  }

  // --- internals -------------------------------------------------------------

  /** The rules a new password meets, wherever it comes from. */
  private assertNewPassword(password: string, confirm: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError("ACCOUNT_INVALID", "La contrasena es muy corta", {
        hint: `Usa al menos ${String(MIN_PASSWORD_LENGTH)} caracteres. Esta clave protege tus limites de gasto.`,
      });
    }
    if (password !== confirm) {
      throw new AuthError("ACCOUNT_INVALID", "Las dos contrasenas no coinciden", {
        hint: "Escribe la misma contrasena en los dos campos.",
      });
    }
  }

  /**
   * Walks the unspent printable codes looking for this one. It does NOT spend it: `commit`
   * does, and the caller only calls it once the email has also checked out, so a code
   * presented with the wrong address is not burned on the real owner's behalf.
   *
   * Every comparison costs a scrypt derivation. That is the price of keeping nothing a
   * thief could type back, and a wrong code pays it too so the clock says nothing.
   */
  private async matchPrintedCode(canonical: string): Promise<Attempt> {
    const rows = this.storage.listUnusedRecoveryCodes();
    if (canonical.length === 0) {
      // Still pay for one derivation, so a malformed code is not the fast answer.
      await verifyPassword("", rows[0]?.codeHash ?? (await dummyHash()));
      return REFUSED;
    }
    for (const row of rows) {
      if (!(await verifyPassword(canonical, row.codeHash))) continue;
      /**
       * The spend is an UPDATE guarded by `used_at is null`, so two requests replaying the
       * same code cannot both win: the loser gets false out of `commit` and is refused
       * exactly like a wrong code.
       */
      return { ok: true, commit: () => this.storage.consumeRecoveryCode(row.id, this.now().toISOString()) };
    }
    if (rows.length === 0) await verifyPassword(canonical, await dummyHash());
    return REFUSED;
  }

  /**
   * One live challenge per kind: an expired one is dropped on sight, a wrong guess counts
   * against the three this one gets, and the right answer is spent by deleting the row.
   */
  private async matchChallenge(kind: RecoveryChallengeKind, value: string): Promise<Attempt> {
    const challenge = this.storage.getRecoveryChallenge(kind);
    if (!challenge) {
      await verifyPassword(value, await dummyHash());
      return REFUSED;
    }
    if (challenge.expiresAt <= this.now().toISOString()) {
      this.storage.deleteRecoveryChallenge(kind);
      await verifyPassword(value, await dummyHash());
      return REFUSED;
    }
    if (await verifyPassword(value, challenge.codeHash)) {
      return { ok: true, commit: () => this.storage.consumeRecoveryChallenge(kind) };
    }
    if (this.storage.bumpRecoveryChallengeAttempts(kind) >= MAX_RECOVERY_ATTEMPTS) {
      this.storage.deleteRecoveryChallenge(kind);
    }
    return REFUSED;
  }

  private openSession(origin: RequestOrigin, scope: SessionScope = "full"): SessionRecord {
    const now = this.now();
    const ttl = scope === "recovery" ? RECOVERY_SESSION_TTL_MS : this.ttlMs;
    const session: SessionRecord = {
      id: randomBytes(32).toString("hex"),
      accountId: "owner",
      csrfToken: randomBytes(32).toString("hex"),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      lastSeenAt: now.toISOString(),
      ipHash: origin.ipHash,
      uaFamily: origin.uaFamily,
      scope,
    };
    this.storage.createSession(session);
    return session;
  }

  private record(
    event: AccessEntry["event"],
    origin: RequestOrigin,
    hashedEmail: string,
    detail: string,
  ): void {
    this.storage.appendAccess({
      at: this.now().toISOString(),
      event,
      ipHash: origin.ipHash,
      uaFamily: origin.uaFamily,
      emailHash: hashedEmail,
      detail,
    });
  }
}

export function setupDone(): AuthError {
  return new AuthError("SETUP_DONE", "Esta instalacion ya tiene dueno", {
    hint: "La cuenta se crea una sola vez. Entra en /login con ella.",
  });
}

/**
 * The one refusal every failed recovery gets: a wrong code, a spent code, an expired code
 * and an email with no account here all read exactly the same.
 */
export function recoveryRefused(): AuthError {
  return new AuthError("RECOVERY_INVALID", "Ese codigo no sirve", {
    hint: "Revisa el correo y el codigo. Cada codigo impreso se usa una sola vez, y el codigo de WhatsApp vence a los 10 minutos.",
  });
}

function rateLimited(seconds: number): AuthError {
  return new AuthError(
    "LOGIN_RATE_LIMITED",
    `Demasiados intentos. Espera ${String(seconds)} segundos y vuelve a probar.`,
    {
      hint: "El limite cuenta por direccion y por cuenta, y sube con cada intento fallido.",
      retryAfter: seconds,
    },
  );
}
