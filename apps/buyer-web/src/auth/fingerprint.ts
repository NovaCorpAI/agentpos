/**
 * What the access log is allowed to remember about a request: a hash of the address and a
 * coarse browser family. Never the address itself, never the full user-agent, never the
 * email. Enough for the owner to recognize "that was me, from home, on Firefox", and not
 * enough to be a tracking record if the database is ever shared.
 */
import { createHash } from "node:crypto";

/** sha256, first 8 hex chars: enough to correlate lines, short enough to be unremarkable. */
export function sha8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Hash of the email, lowercased and trimmed first, so the same address always matches. */
export function emailHash(email: string): string {
  return sha8(email.trim().toLowerCase());
}

export function ipHash(ip: string): string {
  return ip.length > 0 ? sha8(ip) : "unknown";
}

const FAMILIES: Array<[RegExp, string]> = [
  [/edg\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/chrome\/|crios\//i, "Chrome"],
  [/firefox\/|fxios\//i, "Firefox"],
  [/safari\//i, "Safari"],
  [/curl\//i, "curl"],
  [/wget\//i, "wget"],
  [/postman/i, "Postman"],
  [/python-requests|httpx|aiohttp/i, "script"],
  [/node|undici/i, "Node"],
  [/bot|crawler|spider/i, "bot"],
];

/** A user-agent reduced to one word. Anything unrecognized is just "otro". */
export function uaFamily(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) return "desconocido";
  for (const [re, name] of FAMILIES) if (re.test(ua)) return name;
  return "otro";
}

/** Everything the access layer knows about where a request came from. */
export interface RequestOrigin {
  ipHash: string;
  uaFamily: string;
}
