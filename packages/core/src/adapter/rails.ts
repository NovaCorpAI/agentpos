/**
 * Payment rails: the neutral-acquirer pattern (plan/RIELES.md) applied to the charge itself.
 *
 * Today a store has exactly one way to be paid: x402 / USDC over Stellar. Tomorrow it may route
 * to the merchant's own fiat acquirer, or to a network agentic credential. A `PaymentRail` is the
 * seam where that choice lives, so that adding a rail is ADDITIVE: it never changes the catalog,
 * the cart, the quote or the order surfaces, and it never changes what an agent reads from
 * discovery except by adding one more handler.
 *
 * What lives here (guardrail 3: every protocol contact is in adapter/):
 *  - the interface a rail implements, and its result and failure types;
 *  - a validated, reverse-DNS rail id;
 *  - an ordered registry with lookup and "first rail that supports this charge".
 *
 * What does NOT live here: routing POLICY. Which rail a given cart should use, in which order,
 * with which fallbacks and thresholds, is the merchant's decision and belongs to
 * `packages/policy` (M1). The registry only answers "which rails can, in the order declared".
 *
 * Money crossing this interface is always an integer in a minor unit (guardrail 4): `UsdcMinor`,
 * or a {@link MinorAmount} carrying its own currency and decimals. There is no float anywhere in
 * the public surface, and no rail may accept one.
 */
import { AgentPOSError } from "../errors.js";
import type { ErrorCode } from "../errors.js";
import type { UsdcMinor } from "../money.js";
import { USDC_DECIMALS, usdcFromMinor } from "../money.js";

// ---------------------------------------------------------------------------
// Money that crosses a rail boundary
// ---------------------------------------------------------------------------

declare const railBrand: unique symbol;
type Brand<T, B extends string> = T & { readonly [railBrand]: B };

/** Largest number of decimals any rail may declare. Guards against nonsense configuration. */
const MAX_DECIMALS = 18;

/**
 * An amount of money as an integer in the smallest unit of its currency, plus the information a
 * reader needs to interpret that integer. Fiat rails price in ISO 4217 minor units (CLP has 0
 * decimals, USD 2); the x402 rail prices in USDC minor units (7). Never a float.
 */
export interface MinorAmount {
  /** Integer amount in the smallest unit of `currency`. Non-negative. */
  readonly minor: bigint;
  /** Asset or ISO 4217 code, e.g. "USDC", "XLM", "CLP". */
  readonly currency: string;
  /** Decimals the minor unit represents: USDC 7, USD 2, CLP 0. */
  readonly decimals: number;
}

/** Builds a {@link MinorAmount}, rejecting negatives and impossible decimal counts. */
export function minorAmount(minor: bigint, currency: string, decimals: number): MinorAmount {
  if (minor < 0n) {
    throw new AgentPOSError("INVALID_AMOUNT", "A rail amount cannot be negative", {
      hint: "Amounts are unsigned integers in the currency's smallest unit.",
      details: { minor: minor.toString(), currency },
    });
  }
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(currency)) {
    throw new AgentPOSError("INVALID_AMOUNT", `Invalid currency code: '${currency}'`, {
      hint: "Use an asset symbol or ISO 4217 code, e.g. 'USDC' or 'CLP'.",
      details: { currency },
    });
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AgentPOSError("INVALID_AMOUNT", `Invalid minor-unit exponent: ${decimals}`, {
      hint: `Decimals must be an integer between 0 and ${MAX_DECIMALS} (USDC is 7, CLP is 0).`,
      details: { currency, decimals },
    });
  }
  return { minor, currency: currency.toUpperCase(), decimals };
}

/** USDC minor units as a rail amount. */
export function usdcAmount(value: UsdcMinor): MinorAmount {
  return { minor: value, currency: "USDC", decimals: USDC_DECIMALS };
}

/** Reads a rail amount back as `UsdcMinor`, refusing anything that is not USDC in minor units. */
export function toUsdcMinor(amount: MinorAmount): UsdcMinor {
  if (amount.currency !== "USDC" || amount.decimals !== USDC_DECIMALS) {
    throw new AgentPOSError(
      "INVALID_AMOUNT",
      `Expected USDC with ${USDC_DECIMALS} decimals, got ${amount.currency} with ${amount.decimals}`,
      {
        hint: "This rail charges USDC only; convert before quoting, never at settlement time.",
        details: { currency: amount.currency, decimals: amount.decimals },
      },
    );
  }
  return usdcFromMinor(amount.minor);
}

/** True when two amounts are in the same currency AND the same minor unit, so comparable. */
export function sameUnit(a: MinorAmount, b: MinorAmount): boolean {
  return a.currency === b.currency && a.decimals === b.decimals;
}

// ---------------------------------------------------------------------------
// Rail identity
// ---------------------------------------------------------------------------

/**
 * A rail identifier in reverse-DNS form, e.g. `org.x402.stellar`, `com.amazon.payments`.
 * Branded so an unvalidated string can never reach a registry or a discovery surface.
 */
export type PaymentRailId = Brand<string, "PaymentRailId">;

const RAIL_ID_MAX_LENGTH = 128;
/** Reverse-DNS: lowercase, at least two dot-separated segments, hyphens only inside a segment. */
const RAIL_ID_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Shape check without throwing. */
export function isPaymentRailId(value: unknown): value is PaymentRailId {
  return typeof value === "string" && value.length <= RAIL_ID_MAX_LENGTH && RAIL_ID_RE.test(value);
}

/**
 * Validates a rail id and brands it. Rail ids are permanent public identifiers (discovery,
 * reconciliation, merchant routing policy), so they are checked once, here.
 */
export function paymentRailId(value: string): PaymentRailId {
  if (!isPaymentRailId(value)) {
    throw new AgentPOSError("RAIL_ID_INVALID", `Not a valid payment rail id: '${value}'`, {
      hint: "Use lowercase reverse-DNS with at least two segments, e.g. 'org.x402.stellar'. Hyphens are allowed inside a segment; no uppercase, spaces, empty segments or trailing dots.",
      details: { value, maxLength: RAIL_ID_MAX_LENGTH },
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Failures: "the rail says no" vs "the rail did not answer"
// ---------------------------------------------------------------------------

/**
 * Why a rail did not take the money.
 *
 * - `rejected`: the rail answered, and the answer is no. Deterministic: the same request will be
 *   refused again, by this rail and (for payload-level problems) by any rail. Never retry.
 * - `unavailable`: the rail did not produce an answer (network error, timeout, 5xx, malformed
 *   response). The same request may succeed later, or on another rail. This is the only kind a
 *   failover may act on.
 */
export type RailFailureKind = "rejected" | "unavailable";

/**
 * A rail failure in the project's error shape (`{ code, message, hint }`), plus the one bit a
 * failover needs. `code` is the code the underlying adapter produced: a wrapper NEVER invents a
 * new code for a failure the rail already named.
 */
export interface RailFailure {
  kind: RailFailureKind;
  code: ErrorCode;
  message: string;
  hint: string;
  /** Always false for `rejected`, true for `unavailable`. Mirrors `AgentPOSError.retryable`. */
  retryable: boolean;
  /**
   * Settlement only: true when the request provably never reached the rail (DNS failure,
   * connection refused, connect-phase timeout). Guardrail 6: an ambiguous settle failure may
   * already be on the ledger, so re-submitting the same payment to another rail or facilitator
   * is allowed ONLY when this is true. Absent means "unknown", which means "do not re-submit".
   */
  preSubmission?: boolean;
  details?: Record<string, unknown> | undefined;
}

/** The rail answered no. Deterministic; retrying changes nothing. */
export function railRejected(
  code: ErrorCode,
  message: string,
  options: { hint: string; details?: Record<string, unknown> },
): RailFailure {
  return {
    kind: "rejected",
    code,
    message,
    hint: options.hint,
    retryable: false,
    ...(options.details ? { details: options.details } : {}),
  };
}

/** The rail did not answer. Retryable, and the only case a failover may act on. */
export function railUnavailable(
  code: ErrorCode,
  message: string,
  options: { hint: string; preSubmission?: boolean; details?: Record<string, unknown> },
): RailFailure {
  return {
    kind: "unavailable",
    code,
    message,
    hint: options.hint,
    retryable: true,
    ...(options.preSubmission !== undefined ? { preSubmission: options.preSubmission } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

/** Re-raises a rail failure as the project's typed error, preserving code and retryability. */
export function railFailureToError(failure: RailFailure, railId: PaymentRailId): AgentPOSError {
  return new AgentPOSError(failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
    details: {
      railId,
      railFailureKind: failure.kind,
      ...(failure.preSubmission !== undefined ? { preSubmission: failure.preSubmission } : {}),
      ...failure.details,
    },
  });
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function statusCodeOf(err: unknown): number | undefined {
  for (const e of causeChain(err)) {
    const status = (e as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Error codes that prove the request never left this machine. */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * An infrastructure failure of the rail (network error, timeout, 5xx, malformed response) rather
 * than a deterministic 4xx refusal of the payload. Only this may become `unavailable`.
 */
export function isRailInfrastructureFailure(err: unknown): boolean {
  const status = statusCodeOf(err);
  if (status !== undefined) return status >= 500;
  // No HTTP status at all: the caller never got a well-formed answer.
  return true;
}

/**
 * True only when the failed request provably never reached the rail. A response of any status, a
 * request timeout, or anything ambiguous returns false, because the payment may already be in
 * flight or already applied (guardrail 6: never create a second settlement).
 */
export function isRailPreSubmissionFailure(err: unknown): boolean {
  if (statusCodeOf(err) !== undefined) return false;
  for (const e of causeChain(err)) {
    const name = (e as { name?: unknown }).name;
    if (name === "FacilitatorTimeoutError" || name === "TimeoutError" || name === "AbortError") {
      return false;
    }
  }
  for (const e of causeChain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    if ((e as { name?: unknown }).name === "ConnectTimeoutError") return true;
  }
  return false;
}

export interface ClassifyRailFailureOptions {
  /** Code used when the thrown value is not one of ours and the rail is unreachable. */
  unavailableCode: ErrorCode;
  /** Code used when the thrown value is not one of ours and the rail refused deterministically. */
  rejectedCode: ErrorCode;
  hint?: string;
}

/**
 * Turns anything a rail throws into a {@link RailFailure}.
 *
 * An `AgentPOSError` keeps its own code and its own `retryable` flag: a wrapper must never
 * relabel a failure the underlying adapter already named. Anything else is classified by shape.
 */
export function classifyRailFailure(
  err: unknown,
  options: ClassifyRailFailureOptions,
): RailFailure {
  const preSubmission = isRailPreSubmissionFailure(err);
  if (err instanceof AgentPOSError) {
    const base = {
      code: err.code,
      message: err.message,
      hint: err.hint,
      ...(err.details ? { details: err.details } : {}),
    };
    return err.retryable
      ? { kind: "unavailable", retryable: true, preSubmission, ...base }
      : { kind: "rejected", retryable: false, ...base };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isRailInfrastructureFailure(err)) {
    return railUnavailable(options.unavailableCode, message, {
      hint:
        options.hint ??
        "The rail did not answer. Retry, or try the next rail the merchant declared.",
      preSubmission,
    });
  }
  return railRejected(options.rejectedCode, message, {
    hint: options.hint ?? "The rail refused this payment. Nothing was charged; do not retry.",
  });
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/** What a caller wants to charge, as far as it needs to be known to pick a rail. */
export interface RailSupportContext {
  /** Network id in the rail's own vocabulary (CAIP-2 for x402). Unset means "any". */
  network?: string | undefined;
  /** Asset or ISO 4217 code the caller intends to charge. Unset means "any". */
  currency?: string | undefined;
  /** Amount to charge, checked against the rail's bounds. Unset means "any". */
  amount?: MinorAmount | undefined;
}

/** Whether a rail can take a given charge, with a machine-readable reason when it cannot. */
export type RailSupportDecision =
  | { supported: true }
  | {
      supported: false;
      code: ErrorCode;
      message: string;
      hint: string;
      details?: Record<string, unknown>;
    };

/** What a rail can charge, as published on discovery surfaces. */
export interface RailCapabilities {
  /** Networks the rail settles on, in its own vocabulary. */
  networks: string[];
  /** Currencies or assets the rail can charge. */
  currencies: string[];
  /** Smallest chargeable amount, if the rail has one. */
  minAmount?: MinorAmount;
  /** Largest chargeable amount, if the rail has one. */
  maxAmount?: MinorAmount;
  /** True when settlement produces a public ledger transaction hash. */
  settlesOnLedger: boolean;
}

/** A rail as a discovery surface sees it. Contains no secrets and no merchant addresses. */
export interface PaymentRailDescription {
  id: PaymentRailId;
  label: string;
  /** Wire protocol the rail speaks, e.g. "x402". */
  protocol: string;
  /** Pinned version of that protocol (adapter/versions.ts). */
  protocolVersion: string;
  capabilities: RailCapabilities;
  /** Where the rail's terms are specified. */
  spec?: string;
  /** Version of the PaymentRail interface this rail implements. */
  railInterfaceVersion: string;
  adapterVersion: string;
}

/** What a caller asks a rail to quote. */
export interface RailQuoteInput {
  /** Where the money goes on this rail: a Stellar address, a merchant account id, etc. */
  payTo: string;
  /** Amount to charge, in minor units. */
  amount: MinorAmount;
  /** Human description carried into the rail's own terms. */
  description?: string | undefined;
  /** Cart or order id echoed back by the rail for reconciliation. */
  reference?: string | undefined;
  /** How long the quoted terms stay valid. The rail may clamp it. */
  maxTimeoutSeconds?: number | undefined;
  /** Network override; defaults to the rail's configured network. */
  network?: string | undefined;
}

/**
 * The terms an agent must satisfy to pay. `terms` is the rail's own wire object, untouched: for
 * x402 it is the 402 payment requirements exactly as the SDK built them. Callers pass it back to
 * `verify` and `settle` unmodified.
 */
export interface RailQuote<TTerms = unknown> {
  railId: PaymentRailId;
  terms: TTerms;
  amount: MinorAmount;
  payTo: string;
  network: string;
  /** Seconds the terms stay valid, as the rail decided. */
  expiresInSeconds?: number;
  reference?: string;
}

/** A rail's decision about a payment the agent presented. */
export type RailVerification =
  | { railId: PaymentRailId; ok: true; payer?: string; raw?: unknown }
  | { railId: PaymentRailId; ok: false; failure: RailFailure; raw?: unknown };

/**
 * The outcome of asking the rail to move the money. `reference` is the tx hash on ledger rails
 * and the rail's own reference otherwise; it is the empty string only when `settled` is false.
 */
export interface RailSettlement {
  railId: PaymentRailId;
  settled: boolean;
  reference: string;
  /** Amount the rail reports as actually settled, when it reports one. */
  amount?: MinorAmount;
  payer?: string;
  /** Present exactly when `settled` is false. */
  failure?: RailFailure;
  raw?: unknown;
}

/**
 * One way a store can be paid.
 *
 * Implementations are thin: they translate between this interface and an existing adapter, and
 * they never reimplement a protocol. A rail must be side-effect free in `supports`, `quote` and
 * `describe`; only `settle` moves money.
 *
 * @typeParam TTerms - the rail's own terms object (x402: `PaymentRequirements`).
 * @typeParam TPayload - what the agent presents as payment (x402: `PaymentPayload`).
 */
export interface PaymentRail<TTerms = unknown, TPayload = unknown> {
  /** Permanent reverse-DNS identifier. */
  readonly id: PaymentRailId;
  /** Short human label for the merchant's dashboard. Never shown to agents as an identifier. */
  readonly label: string;
  /** Whether this rail can take the given charge. Pure; no network. */
  supports(ctx: RailSupportContext): RailSupportDecision;
  /** The terms an agent must satisfy to pay this amount on this rail. */
  quote(input: RailQuoteInput): Promise<RailQuote<TTerms>>;
  /** The rail's decision about a presented payment. Never moves money. */
  verify(payload: TPayload, terms: TTerms): Promise<RailVerification>;
  /** Moves the money. Guardrail 6: the merchant's order is created only after this succeeds. */
  settle(payload: TPayload, terms: TTerms): Promise<RailSettlement>;
  /** What discovery surfaces publish about this rail. */
  describe(): PaymentRailDescription;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The rails a store has, in the order the store declared them. Ordered and id-indexed; nothing
 * more. It answers "which rails do I have" and "which of them can take this charge, first one
 * wins in declaration order". It deliberately holds NO routing policy: thresholds, preferences,
 * fallbacks and per-agent rules are the merchant's, and live in `packages/policy`.
 */
export class PaymentRailRegistry {
  private readonly ordered: Array<PaymentRail> = [];
  private readonly byId = new Map<string, PaymentRail>();

  constructor(rails: ReadonlyArray<PaymentRail> = []) {
    for (const rail of rails) this.register(rail);
  }

  /** Appends a rail. Order is meaningful: it is the merchant's declared preference. */
  register(rail: PaymentRail): this {
    paymentRailId(rail.id);
    if (this.byId.has(rail.id)) {
      throw new AgentPOSError("RAIL_DUPLICATE", `Payment rail '${rail.id}' is already registered`, {
        hint: "Each rail id may appear once. Configure the same rail twice only under distinct ids.",
        details: { railId: rail.id },
      });
    }
    this.ordered.push(rail);
    this.byId.set(rail.id, rail);
    return this;
  }

  /** Number of registered rails. */
  get size(): number {
    return this.ordered.length;
  }

  /** Rails in declaration order. */
  list(): Array<PaymentRail> {
    return [...this.ordered];
  }

  /** Rail ids in declaration order. */
  ids(): PaymentRailId[] {
    return this.ordered.map((r) => r.id);
  }

  /** Lookup by id. Accepts a plain string so HTTP input needs no pre-validation. */
  get(id: string): PaymentRail | undefined {
    return this.byId.get(id);
  }

  /** Lookup by id, or a typed error naming the rails that do exist. */
  require(id: string): PaymentRail {
    const rail = this.byId.get(id);
    if (!rail) {
      throw new AgentPOSError("RAIL_NOT_FOUND", `Unknown payment rail '${id}'`, {
        hint: "Use one of the rail ids this store declares in its discovery surfaces.",
        details: { railId: id, available: this.ids() },
      });
    }
    return rail;
  }

  /** First rail, in declaration order, that can take this charge. */
  firstSupporting(ctx: RailSupportContext): PaymentRail | undefined {
    return this.ordered.find((rail) => rail.supports(ctx).supported);
  }

  /** As {@link firstSupporting}, but explains per rail why none of them could. */
  requireSupporting(ctx: RailSupportContext): PaymentRail {
    const rail = this.firstSupporting(ctx);
    if (rail) return rail;
    const reasons = this.ordered.map((r) => {
      const decision = r.supports(ctx);
      return {
        railId: r.id,
        ...(decision.supported
          ? { supported: true }
          : { code: decision.code, message: decision.message }),
      };
    });
    throw new AgentPOSError("RAIL_UNSUPPORTED", "No payment rail can take this charge", {
      hint: "Check the network, currency and amount against the rails this store declares.",
      details: {
        requested: {
          ...(ctx.network !== undefined ? { network: ctx.network } : {}),
          ...(ctx.currency !== undefined ? { currency: ctx.currency } : {}),
          ...(ctx.amount !== undefined
            ? { amountMinor: ctx.amount.minor.toString(), currency: ctx.amount.currency }
            : {}),
        },
        rails: reasons,
      },
    });
  }

  /** What discovery surfaces publish about every rail, in declaration order. */
  describe(): PaymentRailDescription[] {
    return this.ordered.map((rail) => rail.describe());
  }
}
