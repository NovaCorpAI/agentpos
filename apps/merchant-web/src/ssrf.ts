/**
 * Outbound request guard (SSRF). The wizard fetches URLs the merchant typed: the WooCommerce key
 * probe, the verification checklist and the merchant-API probe. Running on the founder's laptop
 * that is harmless; published at conecta.agentposhq.com it would turn this server into a probe
 * for whoever asks, one that sits inside our network and can see what the internet cannot.
 *
 * So EVERY outbound fetch in this app goes through `createGuardedFetch`, which:
 *
 *  1. accepts only `http:` and `https:`, and no credentials in the URL,
 *  2. accepts only ports 80, 443, 8080 and 8443 (or the scheme default),
 *  3. resolves the hostname and refuses loopback, link-local, private, carrier-NAT,
 *     unique-local, multicast, documentation and reserved addresses, IPv4 and IPv6, including
 *     the IPv4-mapped and NAT64 forms of an IPv4 address,
 *  4. follows redirects itself (`redirect: "manual"`) and refuses any that leaves the original
 *     host, re-checking the address of every hop,
 *  5. caps the response body and the time each hop may take, and
 *  6. caps how many outbound requests one inbound request may trigger.
 *
 * A refusal is an `AgentPOSError` the merchant can act on ("Esa dirección no es pública"); the
 * machine-readable reason travels in `details.reason`. A DNS failure is deliberately NOT one of
 * those: it throws a plain `Error`, so the caller reports it as "the store did not answer"
 * rather than accusing the merchant of pointing us at an internal address.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AgentPOSError } from "@agentpos/core";

/** Resolves a hostname to its IP addresses. Tests inject a stub; nothing here touches DNS. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** Ports a public store can reasonably answer on. Anything else is an internal service. */
export const ALLOWED_PORTS: ReadonlySet<string> = new Set(["80", "443", "8080", "8443"]);

/** Per hop. The callers already pass their own 10s budget; this is the ceiling. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** A manifest, an OpenAPI document or a one-product page. Anything larger is not for us. */
export const MAX_RESPONSE_BYTES = 512 * 1024;
/** Redirect hops, same host only. */
export const DEFAULT_MAX_REDIRECTS = 3;
/** Outbound requests one inbound request may trigger (verify does 4, or 6 with the panel key). */
export const DEFAULT_MAX_REQUESTS = 8;

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

const NOT_PUBLIC = "Esa dirección no es pública";
const NOT_PUBLIC_HINT =
  "Escribe el dominio público de tu tienda, por ejemplo https://mitienda.cl. No consultamos localhost, ni direcciones de redes internas, ni puertos distintos de 80, 443, 8080 y 8443.";

function refuse(
  reason: string,
  message = NOT_PUBLIC,
  details: Record<string, unknown> = {},
): never {
  throw new AgentPOSError("CONFIG_INVALID", message, {
    hint: NOT_PUBLIC_HINT,
    details: { reason, ...details },
  });
}

// ---------------------------------------------------------------------------
// Address parsing. `isIP` says whether a string is an address; these turn it into bytes.

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

function parseIPv6(raw: string): number[] | undefined {
  // Drop a zone id ("fe80::1%eth0"): it says nothing about which network the address is on.
  const zone = raw.indexOf("%");
  let text = zone === -1 ? raw : raw.slice(0, zone);

  // Trailing dotted-quad form ("::ffff:127.0.0.1", "64:ff9b::1.2.3.4").
  let embedded: number[] | undefined;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    embedded = parseIPv4(text.slice(lastColon + 1));
    if (!embedded) return undefined;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] === "" ? [] : (halves[0] as string).split(":");
    const right = halves[1] === "" ? [] : (halves[1] as string).split(":");
    const fill = 8 - left.length - right.length;
    if (fill < 0) return undefined;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  } else {
    groups = text.split(":");
  }
  if (groups.length !== 8) return undefined;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  if (embedded) bytes.splice(12, 4, ...embedded);
  return bytes;
}

function ipv4Reason(b: number[]): string | undefined {
  const [o1 = 0, o2 = 0, o3 = 0] = b;
  if (o1 === 0) return "this-network"; // 0.0.0.0/8, and 0.0.0.0 itself means "every interface"
  if (o1 === 10) return "private"; // 10.0.0.0/8
  if (o1 === 127) return "loopback"; // 127.0.0.0/8
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return "carrier-nat"; // 100.64.0.0/10
  if (o1 === 169 && o2 === 254) return "link-local"; // 169.254.0.0/16, cloud metadata lives here
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return "private"; // 172.16.0.0/12
  if (o1 === 192 && o2 === 0 && o3 === 0) return "reserved"; // 192.0.0.0/24
  if (o1 === 192 && o2 === 0 && o3 === 2) return "documentation"; // 192.0.2.0/24
  if (o1 === 192 && o2 === 168) return "private"; // 192.168.0.0/16
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return "benchmark"; // 198.18.0.0/15
  if (o1 === 198 && o2 === 51 && o3 === 100) return "documentation"; // 198.51.100.0/24
  if (o1 === 203 && o2 === 0 && o3 === 113) return "documentation"; // 203.0.113.0/24
  if (o1 >= 224) return "multicast-or-reserved"; // 224/4, 240/4 and 255.255.255.255
  return undefined;
}

function ipv6Reason(b: number[]): string | undefined {
  const zeroPrefix = (n: number): boolean => b.slice(0, n).every((byte) => byte === 0);
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;

  if (zeroPrefix(16)) return "unspecified"; // ::
  if (zeroPrefix(15) && b[15] === 1) return "loopback"; // ::1
  // IPv4-mapped (::ffff:a.b.c.d): judge the address it actually carries.
  if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4Reason(b.slice(12));
  }
  // NAT64 well-known prefix 64:ff9b::/96: same, it is an IPv4 destination in disguise.
  if (
    first === 0x00 &&
    second === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return ipv4Reason(b.slice(12));
  }
  if (zeroPrefix(12)) return "ipv4-compatible"; // ::a.b.c.d, deprecated and never legitimate here
  if ((first & 0xfe) === 0xfc) return "unique-local"; // fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (first === 0xff) return "multicast"; // ff00::/8
  if (first === 0x20 && second === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  return undefined;
}

/**
 * Why this address may not be fetched, or `undefined` when it is an ordinary public address.
 * An address we cannot parse is refused: unknown is not the same as safe.
 */
export function ipRefusalReason(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIPv4(address);
    return bytes ? ipv4Reason(bytes) : "unparseable";
  }
  if (family === 6) {
    const bytes = parseIPv6(address);
    return bytes ? ipv6Reason(bytes) : "unparseable";
  }
  return "unparseable";
}

/** The real resolver. Uses the OS resolution path, which is the one `fetch` will use too. */
export const systemResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

async function resolveOrFail(hostname: string, resolve: HostResolver): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    // Not a refusal: the caller turns this into "the store did not answer".
    throw new Error(`DNS lookup failed for ${hostname}: ${String(err)}`);
  }
  if (addresses.length === 0) throw new Error(`DNS lookup returned nothing for ${hostname}`);
  return addresses;
}

/**
 * Throws unless `raw` is a URL this server may fetch. Returns the parsed URL on success.
 * Every address the hostname resolves to must pass: one private answer is enough to refuse,
 * which is what makes a hostname that points at 10.x as unusable as the literal address.
 */
export async function assertPublicUrl(raw: string | URL, resolve: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    refuse("unparseable-url", "Esa dirección no se entiende como una URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    refuse("scheme", "Solo podemos consultar direcciones http o https", { scheme: url.protocol });
  }
  if (url.username !== "" || url.password !== "") {
    refuse("credentials", "No consultamos direcciones que llevan usuario y contraseña dentro");
  }
  if (url.port !== "" && !ALLOWED_PORTS.has(url.port)) {
    refuse("port", "Ese puerto no está permitido", { port: url.port });
  }

  // `hostname` keeps the brackets around an IPv6 literal.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const addresses = isIP(host) !== 0 ? [host] : await resolveOrFail(host, resolve);
  for (const address of addresses) {
    const reason = ipRefusalReason(address);
    if (reason !== undefined) refuse(reason, NOT_PUBLIC, { host });
  }
  return url;
}

export interface GuardedFetchOptions {
  /** The fetch that actually runs. Tests inject a stub; production uses the global one. */
  fetchImpl?: typeof globalThis.fetch;
  resolve?: HostResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Requests this instance may make in total. Create one instance per inbound request. */
  maxRequests?: number;
}

function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, own]) : own;
}

async function capBody(res: Response, maxBytes: number): Promise<Response> {
  if (res.body === null || NULL_BODY_STATUS.has(res.status)) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      refuse("response-too-large", "Esa dirección devolvió una respuesta demasiado grande", {
        maxBytes,
      });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * A `fetch` that only reaches public addresses. Create one per inbound request, so
 * `maxRequests` bounds how many probes that request can trigger.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof globalThis.fetch {
  const inner = options.fetchImpl ?? globalThis.fetch;
  const resolve = options.resolve ?? systemResolver;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let budget = options.maxRequests ?? DEFAULT_MAX_REQUESTS;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const first = await assertPublicUrl(href, resolve);
    let target = first;

    for (let hop = 0; ; hop++) {
      if (budget <= 0) {
        refuse("too-many-requests", "Esta revisión pidió demasiadas direcciones");
      }
      budget -= 1;
      // Every hop after the first is a new address: re-check it.
      if (hop > 0) await assertPublicUrl(target, resolve);

      const res = await inner(target.href, {
        ...init,
        redirect: "manual",
        signal: withTimeout(init?.signal, timeoutMs),
      });

      const location = res.headers.get("location");
      if (!REDIRECT_STATUS.has(res.status) || location === null)
        return await capBody(res, maxBytes);

      if (hop >= maxRedirects)
        refuse("too-many-redirects", "Esa dirección redirige demasiadas veces");
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        refuse("bad-location", "Esa dirección respondió con un redirect que no se entiende");
      }
      if (next.host !== first.host) {
        // The whole point of the guard: a public host must not hand us an internal one.
        refuse("redirect-off-host", "Esa dirección redirige a otro servidor", { to: next.host });
      }
      target = next;
    }
  }) as typeof globalThis.fetch;
}
