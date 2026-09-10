/**
 * Facilitator failover (operational continuity, the multi-acquirer POS pattern): a merchant
 * configures an ordered list of facilitators (primary + fallbacks) and the store keeps selling
 * when the primary is down, without ever risking a double settlement (guardrail 6).
 *
 * The pool implements the SDK's `FacilitatorClient` interface, so it plugs into the existing
 * injection point (`createResourceServer(core, facilitator)`) and the resource server keeps
 * driving verify/settle exactly as before. Verify/settle themselves are NEVER reimplemented:
 * each endpoint is served by the official `HTTPFacilitatorClient` from @x402/core, the same
 * class `packages/core` instantiates for the single-facilitator path. This module only decides
 * WHICH of those official clients handles a given payment; it never touches x402 wire formats,
 * headers or schemas, which stay behind `packages/core/src/adapter/` (guardrail 3).
 */
import { createHash } from "node:crypto";
// The one direct SDK import in this package's runtime: the official facilitator HTTP client,
// constructed per endpoint. Core's adapter builds the identical client for the single-endpoint
// path but does not export a factory, and adapter changes belong to wt-core; revisit when core
// exposes one.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { silentLogger } from "@agentpos/core";
import type { CoreConfig, FacilitatorClient, Logger } from "@agentpos/core";
import type { SiteConfig } from "./config.js";

/** One facilitator the store may verify and settle against. Keys never leave the process. */
export interface FacilitatorEndpoint {
  url: string;
  /** Bearer keys for this endpoint (rotated per request, like the core client does). */
  apiKeys: string[];
}

/** Tests inject stub clients per endpoint through this factory. */
export type FacilitatorClientFactory = (
  endpoint: FacilitatorEndpoint,
  index: number,
) => FacilitatorClient;

/** What /health reports per facilitator: host only, never URLs with credentials, never keys. */
export interface FacilitatorPoolEntryHealth {
  host: string;
  status: "ok" | "degraded";
  /** True for the endpoint the next payment would use. */
  active: boolean;
  checkedAt?: string;
  error?: string;
}

export interface FacilitatorPoolHealth {
  /** Index of the endpoint the next payment would use. */
  active: number;
  endpoints: FacilitatorPoolEntryHealth[];
}

/**
 * Resolves the ordered facilitator list. The config file's `facilitators` array wins; otherwise
 * the primary comes from core config (AGENTPOS_FACILITATOR_URL / AGENTPOS_FACILITATOR_API_KEY,
 * already resolved there) and an optional fallback from AGENTPOS_FACILITATOR_FALLBACK_URL /
 * AGENTPOS_FACILITATOR_FALLBACK_API_KEY.
 */
export function resolveFacilitatorEndpoints(
  site: SiteConfig,
  core: CoreConfig,
  env: Record<string, string | undefined> = process.env,
): FacilitatorEndpoint[] {
  if (site.facilitators && site.facilitators.length > 0) {
    return site.facilitators.map((f) => ({ url: f.url, apiKeys: f.apiKey ? [f.apiKey] : [] }));
  }
  const endpoints: FacilitatorEndpoint[] = [
    { url: core.facilitatorUrl, apiKeys: core.facilitatorApiKeys },
  ];
  const fallbackUrl = env.AGENTPOS_FACILITATOR_FALLBACK_URL;
  if (fallbackUrl) {
    const key = env.AGENTPOS_FACILITATOR_FALLBACK_API_KEY;
    endpoints.push({ url: fallbackUrl, apiKeys: key ? [key] : [] });
  }
  return endpoints;
}

/** Health probes are considered current for this long (matches the /health cache today). */
const HEALTH_TTL_MS = 60_000;
/** Verify->settle pins older than this are swept; a cart's 402 never lives longer than that. */
const PIN_TTL_MS = 10 * 60_000;

/** Error codes that prove the request never left this machine for the facilitator. */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function walkCauses(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** HTTP status carried by SDK errors (VerifyError/SettleError expose `statusCode`). */
function statusCodeOf(err: unknown): number | undefined {
  for (const e of walkCauses(err)) {
    const status = (e as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function isTimeoutError(err: unknown): boolean {
  return walkCauses(err).some(
    (e) =>
      (e as { name?: unknown }).name === "FacilitatorTimeoutError" ||
      (e as { name?: unknown }).name === "TimeoutError" ||
      (e as { name?: unknown }).name === "AbortError",
  );
}

/**
 * An infrastructure failure of the facilitator (network error, timeout, 5xx, malformed
 * response), as opposed to a deterministic 4xx rejection of the payload. Only the former marks
 * an endpoint unhealthy and may trigger failover.
 */
export function isInfrastructureFailure(err: unknown): boolean {
  const status = statusCodeOf(err);
  if (status !== undefined) return status >= 500;
  // Thrown without an HTTP status: the client never got a well-formed answer.
  return true;
}

/**
 * True only when the failed request provably never reached the facilitator: DNS failure,
 * connection refused/unreachable, or a connect-phase timeout. A response of any status, a
 * request timeout, or anything ambiguous returns false. This is the ONLY condition under which
 * a settle may be retried elsewhere: an ambiguous settle failure may already be on chain, and
 * submitting the same payment to a second facilitator could settle it twice (guardrail 6).
 */
export function isPreSubmissionFailure(err: unknown): boolean {
  if (statusCodeOf(err) !== undefined) return false; // a response arrived, so the request did too
  if (isTimeoutError(err)) return false; // the request may be in flight or already applied
  for (const e of walkCauses(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    if ((e as { name?: unknown }).name === "ConnectTimeoutError") return true;
  }
  return false; // unknown failure: assume it may have been submitted (conservative)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Replicates the auth-header rotation the core client uses for its single endpoint. */
function defaultClientFactory(endpoint: FacilitatorEndpoint): FacilitatorClient {
  const keys = endpoint.apiKeys;
  let index = 0;
  return new HTTPFacilitatorClient({
    url: endpoint.url,
    ...(keys.length > 0
      ? {
          createAuthHeaders: async () => {
            const key = keys[index % keys.length] as string;
            index += 1;
            const headers = { Authorization: `Bearer ${key}` };
            return { verify: headers, settle: headers, supported: headers };
          },
        }
      : {}),
  });
}

export interface FailoverFacilitatorOptions {
  /** Ordered: first entry is the primary, the rest are fallbacks in preference order. */
  endpoints: FacilitatorEndpoint[];
  /** CAIP-2 network a healthy facilitator must support (probe checks it). */
  network: string;
  createClient?: FacilitatorClientFactory;
  logger?: Logger;
  now?: () => number;
}

interface EndpointState {
  endpoint: FacilitatorEndpoint;
  client: FacilitatorClient;
  /** 0 = never probed. A failed operation also counts as a probe. */
  probedAt: number;
  probeOk: boolean;
  lastError: string | undefined;
}

type VerifyArgs = Parameters<FacilitatorClient["verify"]>;
type VerifyResult = ReturnType<FacilitatorClient["verify"]>;
type SettleArgs = Parameters<FacilitatorClient["settle"]>;
type SettleResult = ReturnType<FacilitatorClient["settle"]>;
type SupportedResult = ReturnType<FacilitatorClient["getSupported"]>;

/**
 * A `FacilitatorClient` that routes each payment to the first healthy endpoint of an ordered
 * pool. With a single endpoint it is a plain passthrough: no probes, no retries, exactly
 * today's behavior.
 *
 * Routing rules, in order of importance:
 *  1. Verify and settle of one payment use the SAME facilitator. Verify establishes that
 *     facilitator's view of the payment (nonces, channel state, replay tracking); settling
 *     through a different one would submit a payment its facilitator never verified and could
 *     race the first into a double settlement (guardrail 6). The chosen endpoint is pinned per
 *     payment payload at verify time and read back at settle time.
 *  2. Verify is read-only and side-effect free, so an infrastructure failure retries once on
 *     the next healthy endpoint (the pin moves with it: nothing was submitted yet).
 *  3. Settle is retried on the next endpoint ONLY when the first attempt provably never
 *     reached its facilitator (connection-level failure). Any ambiguous failure (timeout, 5xx,
 *     malformed response) is rethrown untouched so the existing stuck-order path runs
 *     (onSettleFailure -> markSettlementFailed): the payment may already be on chain, and a
 *     second submission is the catastrophic case this class must never create.
 */
export class FailoverFacilitator implements FacilitatorClient {
  private readonly states: EndpointState[];
  private readonly network: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** payment fingerprint -> endpoint chosen at verify time. */
  private readonly pins = new Map<string, { index: number; at: number }>();

  constructor(options: FailoverFacilitatorOptions) {
    const createClient = options.createClient ?? defaultClientFactory;
    this.states = options.endpoints.map((endpoint, i) => ({
      endpoint,
      client: createClient(endpoint, i),
      probedAt: 0,
      probeOk: false,
      lastError: undefined,
    }));
    if (this.states.length === 0) throw new Error("FailoverFacilitator needs >= 1 endpoint");
    this.network = options.network;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  async verify(...args: VerifyArgs): VerifyResult {
    this.sweepPins();
    const [payload] = args;
    const first = await this.pick();
    try {
      const result = await this.state(first).client.verify(...args);
      this.noteSuccess(first);
      this.pin(payload, first);
      return result;
    } catch (err) {
      // Verify is read-only: safe to retry anywhere. Retry once, on the next healthy endpoint.
      if (this.states.length === 1 || !isInfrastructureFailure(err)) throw err;
      this.markUnhealthy(first, err);
      const next = await this.pick(first);
      if (next === -1) throw err;
      this.logFailover("verify", first, next, err);
      const result = await this.state(next).client.verify(...args);
      this.noteSuccess(next);
      this.pin(payload, next);
      return result;
    }
  }

  async settle(...args: SettleArgs): SettleResult {
    const [payload] = args;
    const key = fingerprint(payload);
    // Same facilitator as verify (rule 1 above). A missing pin (e.g. process restart between
    // verify and settle) falls back to normal selection; with one endpoint it is identical.
    const pinned = this.pins.get(key);
    const first = pinned ? pinned.index : await this.pick();
    try {
      const result = await this.state(first).client.settle(...args);
      this.noteSuccess(first);
      this.pins.delete(key);
      return result;
    } catch (err) {
      if (isInfrastructureFailure(err)) this.markUnhealthy(first, err);
      // Cross-facilitator settle retry ONLY for provable pre-submission failures (rule 3):
      // anything ambiguous rethrows into the existing stuck-order path, never a second submit.
      if (this.states.length === 1 || !isPreSubmissionFailure(err)) throw err;
      const next = await this.pick(first);
      if (next === -1) throw err;
      this.logFailover("settle", first, next, err);
      const result = await this.state(next).client.settle(...args);
      this.noteSuccess(next);
      this.pins.delete(key);
      return result;
    }
  }

  async getSupported(): SupportedResult {
    let lastError: unknown;
    for (let i = 0; i < this.states.length; i += 1) {
      try {
        const result = await this.state(i).client.getSupported();
        this.noteSuccess(i);
        return result;
      } catch (err) {
        lastError = err;
        this.markUnhealthy(i, err);
        if (i + 1 < this.states.length) this.logFailover("supported", i, i + 1, err);
      }
    }
    throw lastError;
  }

  /** Probes every stale endpoint and reports the pool for /health. Hosts only, never keys. */
  async health(): Promise<FacilitatorPoolHealth> {
    await Promise.all(
      this.states.map(async (s, i) => {
        if (!this.fresh(s)) await this.probe(i);
      }),
    );
    const active = Math.max(
      0,
      this.states.findIndex((s) => s.probeOk),
    );
    return {
      active,
      endpoints: this.states.map((s, i) => ({
        host: hostOf(s.endpoint.url),
        status: s.probeOk ? "ok" : "degraded",
        active: i === active,
        ...(s.probedAt > 0 ? { checkedAt: new Date(s.probedAt).toISOString() } : {}),
        ...(s.lastError !== undefined ? { error: s.lastError } : {}),
      })),
    };
  }

  private state(index: number): EndpointState {
    return this.states[index] as EndpointState;
  }

  private fresh(s: EndpointState): boolean {
    return s.probedAt > 0 && this.now() - s.probedAt <= HEALTH_TTL_MS;
  }

  /**
   * First healthy endpoint, probing stale ones on the way. With every endpoint unhealthy the
   * primary is returned anyway (its real error is more useful than a synthetic one), except
   * when we are already failing over (`exclude` set): then -1 means "do not retry".
   */
  private async pick(exclude = -1): Promise<number> {
    if (this.states.length === 1) return 0;
    for (let i = 0; i < this.states.length; i += 1) {
      if (i === exclude) continue;
      const s = this.state(i);
      if (this.fresh(s)) {
        if (s.probeOk) return i;
        continue;
      }
      if (await this.probe(i)) return i;
    }
    return exclude === -1 ? 0 : -1;
  }

  private async probe(index: number): Promise<boolean> {
    const s = this.state(index);
    try {
      const supported = (await s.client.getSupported()) as {
        kinds?: Array<{ scheme: string; network: string }>;
      };
      const supportsNetwork = Boolean(
        supported.kinds?.some((k) => k.scheme === "exact" && k.network === this.network),
      );
      s.probedAt = this.now();
      s.probeOk = supportsNetwork;
      s.lastError = supportsNetwork ? undefined : `network ${this.network} not supported`;
    } catch (err) {
      this.markUnhealthy(index, err);
    }
    if (!s.probeOk) {
      this.logger.warn("facilitator.failover", {
        operation: "probe",
        facilitator: hostOf(s.endpoint.url),
        error: s.lastError,
      });
    }
    return s.probeOk;
  }

  private noteSuccess(index: number): void {
    const s = this.state(index);
    s.probedAt = this.now();
    s.probeOk = true;
    s.lastError = undefined;
  }

  private markUnhealthy(index: number, err: unknown): void {
    const s = this.state(index);
    s.probedAt = this.now();
    s.probeOk = false;
    s.lastError = err instanceof Error ? err.message : String(err);
  }

  private logFailover(operation: string, from: number, to: number, err: unknown): void {
    this.logger.warn("facilitator.failover", {
      operation,
      from: hostOf(this.state(from).endpoint.url),
      to: hostOf(this.state(to).endpoint.url),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private pin(payload: unknown, index: number): void {
    this.pins.set(fingerprint(payload), { index, at: this.now() });
  }

  private sweepPins(): void {
    const cutoff = this.now() - PIN_TTL_MS;
    for (const [key, value] of this.pins) if (value.at < cutoff) this.pins.delete(key);
  }
}

/** Stable in-process fingerprint of a payment payload (verify and settle see the same one). */
function fingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
