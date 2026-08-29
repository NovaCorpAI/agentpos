/**
 * RFC 9421 HTTP Message Signatures, the form the x402 `http-message-signatures` extension
 * specifies for authenticating a paying agent.
 *
 * We verify RFC 9421 rather than only our own pre-standard header set, because a merchant should
 * not require agents to learn a private dialect to prove who they are. The two coexist: this
 * module is tried first, and `request.ts` remains for clients already signing that way.
 *
 * Scope, stated so nobody assumes more: Ed25519 only (the algorithm the surrounding ecosystem
 * uses, and the one Stellar keys are), derived components `@method`, `@path`, `@query`,
 * `@authority` and `@target-uri`, plain header components, and `Content-Digest` (RFC 9530) with
 * SHA-256. Anything outside that is refused with a reason rather than silently accepted.
 */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export const SIGNATURE_INPUT_HEADER = "signature-input";
export const SIGNATURE_HEADER = "signature";
export const CONTENT_DIGEST_HEADER = "content-digest";

/** How far the agent's clock may be from the merchant's, matching the legacy header set. */
export const RFC9421_WINDOW_SECONDS = 60;

export type HeaderReader = (name: string) => string | undefined | null;

export interface SignedMessage {
  method: string;
  /** Absolute URL of the request as received. */
  url: string;
  /** Raw body exactly as received; empty string when there is none. */
  body: string;
  headers: HeaderReader;
}

export interface Rfc9421Result {
  ok: boolean;
  /** Machine-readable reason when `ok` is false; safe to show an agent. */
  reason?: string;
  keyid?: string;
  label?: string;
  created?: number;
  nonce?: string;
  /** Key under which this signature must be spent once, to refuse replays. */
  replayKey?: string;
}

// ---------------------------------------------------------------------------
// Structured field parsing (RFC 8941), only the shapes RFC 9421 actually uses.
// ---------------------------------------------------------------------------

export type SfParams = Record<string, string | number | boolean>;

interface DictMember {
  /** Inner-list items, unquoted, for Signature-Input. */
  items: string[];
  params: SfParams;
  /** Byte-sequence payload, for Signature. */
  bytes?: Buffer;
  /**
   * The member's value exactly as written in the header. The `@signature-params` line must
   * reproduce it byte for byte, and re-serializing our own parse would be a guess about the
   * sender's spacing.
   */
  raw: string;
}

class Scanner {
  pos = 0;
  constructor(readonly src: string) {}
  ws(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === " " || this.src[this.pos] === "\t"))
      this.pos += 1;
  }
  peek(): string | undefined {
    return this.src[this.pos];
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }
}

function parseKey(s: Scanner): string {
  const start = s.pos;
  while (!s.eof() && /[a-zA-Z0-9_.*-]/.test(s.src[s.pos] as string)) s.pos += 1;
  if (s.pos === start) throw new Error("expected a key");
  return s.src.slice(start, s.pos);
}

function parseString(s: Scanner): string {
  if (s.peek() !== '"') throw new Error("expected a quoted string");
  s.pos += 1;
  let out = "";
  while (!s.eof()) {
    const ch = s.src[s.pos] as string;
    s.pos += 1;
    if (ch === "\\") {
      const next = s.src[s.pos];
      if (next !== '"' && next !== "\\") throw new Error("bad escape in string");
      out += next;
      s.pos += 1;
    } else if (ch === '"') {
      return out;
    } else {
      out += ch;
    }
  }
  throw new Error("unterminated string");
}

function parseBareItem(s: Scanner): string | number | boolean {
  const ch = s.peek();
  if (ch === '"') return parseString(s);
  if (ch === "?") {
    s.pos += 1;
    const v = s.src[s.pos];
    s.pos += 1;
    return v === "1";
  }
  if (ch === ":") {
    // byte sequence
    s.pos += 1;
    const end = s.src.indexOf(":", s.pos);
    if (end === -1) throw new Error("unterminated byte sequence");
    const b64 = s.src.slice(s.pos, end);
    s.pos = end + 1;
    return b64;
  }
  const start = s.pos;
  while (!s.eof() && /[^,;)\s]/.test(s.src[s.pos] as string)) s.pos += 1;
  const token = s.src.slice(start, s.pos);
  if (token === "") throw new Error("expected an item");
  return /^-?\d+$/.test(token) ? Number(token) : token;
}

function parseParams(s: Scanner): SfParams {
  const params: SfParams = {};
  while (!s.eof() && s.peek() === ";") {
    s.pos += 1;
    s.ws();
    const key = parseKey(s);
    if (s.peek() === "=") {
      s.pos += 1;
      params[key] = parseBareItem(s) as string | number | boolean;
    } else {
      params[key] = true;
    }
  }
  return params;
}

/** Parses a dictionary of inner lists and/or byte sequences, keeping each member's raw text. */
export function parseSfDictionary(header: string): Map<string, DictMember> {
  const s = new Scanner(header);
  const out = new Map<string, DictMember>();
  s.ws();
  while (!s.eof()) {
    const key = parseKey(s);
    let items: string[] = [];
    let bytes: Buffer | undefined;
    const valueStart = s.pos;
    if (s.peek() === "=") {
      s.pos += 1;
      if (s.peek() === "(") {
        s.pos += 1;
        s.ws();
        while (!s.eof() && s.peek() !== ")") {
          const item = parseBareItem(s);
          // Component identifiers may carry their own parameters; we do not support those and
          // must not pretend to, so record them and let the caller refuse.
          const itemParams = parseParams(s);
          items.push(Object.keys(itemParams).length > 0 ? `${String(item)};params` : String(item));
          s.ws();
        }
        if (s.peek() !== ")") throw new Error("unterminated inner list");
        s.pos += 1;
      } else {
        const value = parseBareItem(s);
        if (typeof value === "string" && header[valueStart + 1] === ":")
          bytes = Buffer.from(value, "base64");
        else items = [String(value)];
      }
    }
    const params = parseParams(s);
    out.set(key, {
      items,
      params,
      ...(bytes ? { bytes } : {}),
      raw: header.slice(valueStart + 1, s.pos),
    });
    s.ws();
    if (s.peek() === ",") {
      s.pos += 1;
      s.ws();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content-Digest (RFC 9530)
// ---------------------------------------------------------------------------

export function contentDigest(body: string): string {
  return `sha-256=:${createHash("sha256").update(body, "utf8").digest("base64")}:`;
}

function digestMatches(header: string, body: string): boolean {
  // A message may carry several digests; one correct sha-256 is what we require, and any
  // sha-256 entry that disagrees is fatal rather than ignorable.
  let sawSha256 = false;
  for (const member of parseSfDictionary(header)) {
    const [algorithm, value] = member;
    if (algorithm.toLowerCase() !== "sha-256") continue;
    sawSha256 = true;
    const expected = createHash("sha256").update(body, "utf8").digest();
    if (!value.bytes || !value.bytes.equals(expected)) return false;
  }
  return sawSha256;
}

// ---------------------------------------------------------------------------
// Signature base (RFC 9421 section 2.5)
// ---------------------------------------------------------------------------

function derivedComponent(name: string, message: SignedMessage): string | undefined {
  const url = new URL(message.url);
  switch (name) {
    case "@method":
      return message.method.toUpperCase();
    case "@target-uri":
      return url.href;
    case "@authority":
      return url.host.toLowerCase();
    case "@path":
      return url.pathname;
    case "@query":
      return url.search === "" ? "?" : url.search;
    default:
      return undefined;
  }
}

export interface BaseResult {
  base?: string;
  reason?: string;
}

export function signatureBase(
  components: string[],
  signatureParams: string,
  message: SignedMessage,
): BaseResult {
  const lines: string[] = [];
  for (const component of components) {
    if (component.endsWith(";params"))
      return { reason: `Component parameters are not supported: ${component.slice(0, -7)}` };
    const lower = component.toLowerCase();
    if (lower.startsWith("@")) {
      const value = derivedComponent(lower, message);
      if (value === undefined) return { reason: `Unsupported derived component: ${lower}` };
      lines.push(`"${lower}": ${value}`);
    } else {
      const value = message.headers(lower);
      if (value === undefined || value === null)
        return { reason: `Signed header is missing from the request: ${lower}` };
      lines.push(`"${lower}": ${value.trim()}`);
    }
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return { base: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

/**
 * Verifies the first signature in the message that names a key we can use. Returns a reason
 * instead of throwing, so the caller decides what an unverifiable signature means in its mode.
 */
export function verifyHttpMessageSignature(
  message: SignedMessage,
  options: { now?: Date; windowSeconds?: number } = {},
): Rfc9421Result {
  const inputHeader = message.headers(SIGNATURE_INPUT_HEADER);
  const signatureHeader = message.headers(SIGNATURE_HEADER);
  if (!inputHeader || !signatureHeader)
    return { ok: false, reason: "No RFC 9421 signature on this request" };

  let inputs: Map<string, DictMember>;
  let signatures: Map<string, DictMember>;
  try {
    inputs = parseSfDictionary(inputHeader);
    signatures = parseSfDictionary(signatureHeader);
  } catch (err) {
    return {
      ok: false,
      reason: `Malformed signature headers: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let lastReason = "No usable signature in Signature-Input";
  for (const [label, input] of inputs) {
    const result = verifyOne(label, input, signatures.get(label), message, options);
    if (result.ok) return result;
    lastReason = result.reason ?? lastReason;
  }
  return { ok: false, reason: lastReason };
}

function verifyOne(
  label: string,
  input: DictMember,
  signature: DictMember | undefined,
  message: SignedMessage,
  options: { now?: Date; windowSeconds?: number },
): Rfc9421Result {
  const where = { label };
  if (!signature?.bytes)
    return { ok: false, ...where, reason: `Signature '${label}' has no signature value` };

  const keyid = input.params.keyid;
  if (typeof keyid !== "string" || !STELLAR_PUBLIC_KEY.test(keyid))
    return {
      ok: false,
      ...where,
      reason: "keyid must be an Ed25519 public key in Stellar StrKey form (G...)",
    };

  const alg = input.params.alg;
  if (alg !== undefined && alg !== "ed25519")
    return { ok: false, ...where, keyid, reason: `Unsupported algorithm '${String(alg)}'; this store verifies ed25519` };

  const now = (options.now ?? new Date()).getTime() / 1000;
  const window = options.windowSeconds ?? RFC9421_WINDOW_SECONDS;
  const created = input.params.created;
  if (typeof created !== "number")
    return { ok: false, ...where, keyid, reason: "Signature-Input must carry a `created` parameter" };
  if (Math.abs(now - created) > window)
    return {
      ok: false,
      ...where,
      keyid,
      created,
      reason: `Signature created ${Math.round(Math.abs(now - created))}s away from server time; the window is ${window}s`,
    };
  const expires = input.params.expires;
  if (typeof expires === "number" && now > expires)
    return { ok: false, ...where, keyid, created, reason: "Signature has expired" };

  // Binding to the request: without at least method and path, a signature authorizes anything.
  const covered = input.items.map((c) => c.toLowerCase());
  const bindsPath = covered.includes("@path") || covered.includes("@target-uri");
  if (!covered.includes("@method") || !bindsPath)
    return {
      ok: false,
      ...where,
      keyid,
      created,
      reason: 'The signature must cover "@method" and "@path" (or "@target-uri")',
    };
  if (message.body.length > 0) {
    if (!covered.includes("content-digest"))
      return {
        ok: false,
        ...where,
        keyid,
        created,
        reason: 'A request with a body must sign "content-digest"',
      };
    const digestHeader = message.headers(CONTENT_DIGEST_HEADER);
    if (!digestHeader || !digestMatches(digestHeader, message.body))
      return {
        ok: false,
        ...where,
        keyid,
        created,
        reason: "Content-Digest does not match the body as received",
      };
  }

  const { base, reason } = signatureBase(input.items, input.raw, message);
  if (!base)
    return { ok: false, ...where, keyid, created, reason: reason ?? "Cannot build the signature base" };

  let valid = false;
  try {
    valid = Keypair.fromPublicKey(keyid).verify(Buffer.from(base, "utf8"), signature.bytes);
  } catch {
    valid = false;
  }
  if (!valid)
    return { ok: false, ...where, keyid, created, reason: "Signature does not verify against keyid" };

  const nonce = typeof input.params.nonce === "string" ? input.params.nonce : undefined;
  return {
    ok: true,
    ...where,
    keyid,
    created,
    ...(nonce ? { nonce } : {}),
    // With a nonce, replays are refused by nonce. Without one, the signature itself is the key:
    // that still refuses exact replays, and only collides for byte-identical requests inside the
    // window. Send a nonce.
    replayKey: `${keyid}:${nonce ?? signature.bytes.toString("base64")}`,
  };
}

// ---------------------------------------------------------------------------
// Signing (agent side; also the conformance vector for the verifier)
// ---------------------------------------------------------------------------

export interface Rfc9421SignOptions {
  label?: string;
  created?: number;
  nonce?: string;
  /** Defaults to @method, @path, @query and (with a body) content-digest. */
  components?: string[];
}

/** Builds the headers an agent sends. Runs on the AGENT's machine; the secret never leaves it. */
export function signHttpMessage(
  agentSecret: string,
  message: Omit<SignedMessage, "headers">,
  options: Rfc9421SignOptions = {},
): Record<string, string> {
  const keypair = Keypair.fromSecret(agentSecret);
  const label = options.label ?? "sig1";
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? Keypair.random().publicKey().slice(1, 17);
  const hasBody = message.body.length > 0;
  const components =
    options.components ??
    ["@method", "@path", "@query", ...(hasBody ? ["content-digest"] : [])];

  const digest = hasBody ? contentDigest(message.body) : undefined;
  const headers: Record<string, string> = {
    ...(digest ? { "content-digest": digest } : {}),
  };
  const params = `(${components.map((c) => `"${c}"`).join(" ")});created=${created};keyid="${keypair.publicKey()}";alg="ed25519";nonce="${nonce}"`;
  const { base, reason } = signatureBase(components, params, {
    ...message,
    headers: (name) => headers[name.toLowerCase()],
  });
  if (!base) throw new Error(reason ?? "cannot build the signature base");

  headers[SIGNATURE_INPUT_HEADER] = `${label}=${params}`;
  headers[SIGNATURE_HEADER] = `${label}=:${keypair.sign(Buffer.from(base, "utf8")).toString("base64")}:`;
  return headers;
}
