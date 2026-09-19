/**
 * The HTTP side of the access layer: the session cookie, where a request seems to come
 * from, and which routes are allowed through without a session.
 *
 * The cookie carries a session id and nothing else. No signed payload, no encoded claim:
 * anything the server needs to trust lives in the sessions table, where deleting a row is
 * the whole of "log out everywhere".
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ipHash, uaFamily } from "./fingerprint.js";
import type { RequestOrigin } from "./fingerprint.js";

export const SESSION_COOKIE = "agentpos_buyer_session";

/** Form field and header a state-changing request carries its CSRF token in. */
export const CSRF_FIELD = "_csrf";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Routes that answer without a session, and why:
 *  - /health: a liveness probe says nothing about the owner.
 *  - /login, /setup: the way in.
 *  - /recuperar and its two siblings: the way back in when the password is gone. They
 *    carry their own proof (a code, or the operator's one-time token) and, like /login,
 *    they cannot carry a CSRF token because there is no session yet.
 *  - /whatsapp/*: Twilio and Meta authenticate every POST with their own signature.
 *  - /api/signer/*: the owner's signer daemon authenticates with its bearer token.
 * The last two are exempt from the CSRF check too: they are not browsers, they carry no
 * cookie, and they prove who they are on every single request.
 */
export const SELF_AUTHENTICATED_PREFIXES = ["/whatsapp/", "/api/signer/"] as const;
const PUBLIC_PATHS = [
  "/health",
  "/login",
  "/setup",
  "/recuperar",
  "/recuperar/whatsapp",
  "/recuperar/operador",
] as const;

/**
 * The only paths a recovery session reaches. Everything else on this site answers it with
 * RECOVERY_SCOPE_LIMITED: proving a code buys one new password, not the mandate, not the
 * proposals and certainly not an approval.
 */
export const RECOVERY_SESSION_PATHS = [
  "/recuperar/nueva-clave",
  "/recuperar",
  "/logout",
  // Abandoning a recovery must not lock out someone who knows the password after all:
  // logging in normally replaces the recovery session with a real one.
  "/login",
] as const;

export function isSelfAuthenticated(path: string): boolean {
  return SELF_AUTHENTICATED_PREFIXES.some((p) => path.startsWith(p));
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.includes(path as (typeof PUBLIC_PATHS)[number]);
}

export function isRecoverySessionPath(path: string): boolean {
  return RECOVERY_SESSION_PATHS.includes(path as (typeof RECOVERY_SESSION_PATHS)[number]);
}

/** True for the methods that change something and therefore need a CSRF token. */
export function isMutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Where the request came from, already reduced to what may be stored: behind Caddy the
 * socket address is the proxy, so the forwarded headers are what carry the client.
 */
export function originOf(c: Context): RequestOrigin {
  const forwarded = c.req.header("x-forwarded-for") ?? "";
  const first = forwarded.split(",").at(0)?.trim() ?? "";
  const ip = first.length > 0 ? first : (c.req.header("x-real-ip") ?? "").trim();
  return { ipHash: ipHash(ip), uaFamily: uaFamily(c.req.header("user-agent")) };
}

/** https end to end, either directly or as the proxy in front reports it. */
export function isSecureRequest(c: Context): boolean {
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",").at(0)?.trim();
  if (proto) return proto === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionIdFrom(c: Context): string {
  return getCookie(c, SESSION_COOKIE) ?? "";
}

export function writeSessionCookie(c: Context, sessionId: string, maxAgeSeconds: number): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: isSecureRequest(c),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecureRequest(c) });
}

/**
 * The CSRF token as it arrives: a form field for the pages, a header for the JSON API. A
 * JSON body may also carry `_csrf`, so a channel that cannot set headers is not locked out.
 */
export async function csrfTokenFrom(c: Context): Promise<string> {
  const header = c.req.header(CSRF_HEADER);
  if (header) return header;
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
      const value = body[CSRF_FIELD];
      return typeof value === "string" ? value : "";
    }
    if (
      type.includes("application/x-www-form-urlencoded") ||
      type.includes("multipart/form-data") ||
      type === ""
    ) {
      const form = await c.req.raw.clone().formData();
      const value = form.get(CSRF_FIELD);
      return typeof value === "string" ? value : "";
    }
  } catch {
    return "";
  }
  return "";
}

/** A post-login destination is only ever a path on this site. */
export function safeNext(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
