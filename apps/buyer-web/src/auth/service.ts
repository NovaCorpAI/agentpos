/**
 * The access layer of the buyer space: one owner account, server-side sessions, a per
 * session CSRF token, a login throttle and an access log the owner can read.
 *
 * Why it exists: this surface can raise a spending limit and approve a payment that the
 * owner's own machine will then sign. It is exactly as valuable as the money behind it, so
 * it gets a real login instead of a proxy-level gate.
 *
 * Three rules this module never bends:
 *  1. The password exists here only as a scrypt hash. Nothing logs it, nothing stores it.
 *  2. A log line may carry a hash of the email, never the email, never the session id.
 *  3. A wrong email and a wrong password are the same answer, and cost the same time.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "@agentpos/core";
import type { BuyerWebStorage } from "../storage.js";
import type { AccessEntry, OwnerAccount, SessionRecord } from "../types.js";
import { AuthError } from "./errors.js";
import { emailHash } from "./fingerprint.js";
import type { RequestOrigin } from "./fingerprint.js";
import { LoginThrottle } from "./ratelimit.js";
import { dummyHash, hashPassword, verifyPassword } from "./scrypt.js";

/** How long a session lives without use. It slides forward on every authenticated request. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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
}

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

  constructor(deps: AuthServiceDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.sessionTtlMs ?? SESSION_TTL_MS;
    this.logger = deps.logger;
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

  // --- access log ------------------------------------------------------------

  access(limit = 40): AccessEntry[] {
    return this.storage.listAccess(limit);
  }

  // --- internals -------------------------------------------------------------

  private openSession(origin: RequestOrigin): SessionRecord {
    const now = this.now();
    const session: SessionRecord = {
      id: randomBytes(32).toString("hex"),
      accountId: "owner",
      csrfToken: randomBytes(32).toString("hex"),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
      ipHash: origin.ipHash,
      uaFamily: origin.uaFamily,
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
