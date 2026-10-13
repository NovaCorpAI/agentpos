/**
 * The Transbank card rail (Chile): the first way an AgentPOS store gets paid in fiat.
 *
 * Two modes, one rail id, both over the MERCHANT'S OWN Transbank credentials (guardrail 7: the
 * money goes to the merchant's affiliation; we never touch it):
 *
 *  - `webpay-plus`: a first purchase. `quote` creates the transaction and returns the URL the
 *    human must visit; the agent cannot fill a card form, so this mode hands the payment step
 *    to the person. `verify` reads the status; `settle` commits the token exactly once.
 *  - `oneclick`: a repeat purchase. The human enrolled a card once (with their bank's
 *    authentication) and the store holds `tbk_user`. `settle` authorizes the charge with the
 *    cardholder absent. This is the mode in which the agent actually buys on its own.
 *
 * This file is a THIN WRAPPER over Transbank's REST API v1.2 (adapter/versions.ts pins it). It
 * translates between that API and the `PaymentRail` interface and nothing else: the checkout,
 * the catalog and discovery do not change because this rail exists.
 *
 * A card settlement produces no ledger transaction. The rail's settlement reference is our own
 * buy order, which is unique; Transbank's authorization code travels in the raw response.
 */
import { AgentPOSError } from "../../errors.js";
import type {
  MinorAmount,
  PaymentRail,
  PaymentRailDescription,
  PaymentRailId,
  RailFailure,
  RailQuote,
  RailQuoteInput,
  RailSettlement,
  RailSupportContext,
  RailSupportDecision,
  RailVerification,
} from "../rails.js";
import {
  classifyRailFailure,
  minorAmount,
  paymentRailId,
  railRejected,
  railUnavailable,
} from "../rails.js";
import {
  ADAPTER_VERSION,
  PAYMENT_RAIL_IDS,
  PAYMENT_RAIL_INTERFACE_VERSION,
  PROTOCOL_VERSIONS,
} from "../versions.js";

/** Rail id of Transbank Webpay/Oneclick, validated once. */
export const TRANSBANK_RAIL_ID: PaymentRailId = paymentRailId(PAYMENT_RAIL_IDS.transbankWebpay);

/** Transbank has two environments. Their hosts are pinned in adapter/versions.ts. */
export type TransbankEnvironment = "integration" | "production";

/** Chilean pesos have no minor unit: 1 CLP is the smallest amount. */
const CLP_DECIMALS = 0;
const CURRENCY = "CLP";
/** Transbank refuses amounts under 50 CLP in either mode. */
const MIN_AMOUNT_CLP = 50n;
/** A Webpay Plus token must be committed within this window. */
const WEBPAY_TOKEN_TTL_SECONDS = 300;
/** Approved, as Transbank spells it. */
const AUTHORIZED = "AUTHORIZED";
/** A `buy_order` is at most 26 characters at Transbank. */
const BUY_ORDER_MAX = 26;

export interface TransbankRailOptions {
  environment: TransbankEnvironment;
  /**
   * The merchant's Webpay Plus commerce code and API key. Never ours, never logged, never
   * published: `describe()` carries neither.
   */
  commerceCode: string;
  apiKey: string;
  /**
   * Oneclick Mall codes, when the store offers repeat purchases: the mall that holds the
   * enrolment and the child store that receives the charge. Without them the rail quotes
   * Webpay Plus only.
   */
  oneclick?: { mallCode: string; childCommerceCode: string } | undefined;
  /** Largest amount this rail will quote, in CLP. Default: none. */
  maxAmountClp?: bigint | undefined;
  /** Transport; tests inject a fake. */
  fetchImpl?: typeof globalThis.fetch | undefined;
  /** Builds the `buy_order` for a quote. Default: the reference, or a random one. */
  buyOrderFor?: ((input: RailQuoteInput) => string) | undefined;
}

/** What `quote` returns for a first purchase: the human pays on Transbank's page. */
export interface WebpayPlusTerms {
  mode: "webpay-plus";
  /** Transbank's transaction token. Also the key of `verify` and `settle`. */
  token: string;
  /** Where the human must go, with the token POSTed as `token_ws`. */
  url: string;
  buyOrder: string;
  /** Integer CLP. */
  amount: string;
  environment: TransbankEnvironment;
}

/** What `quote` returns for a repeat purchase: the store charges an enrolled card. */
export interface OneclickTerms {
  mode: "oneclick";
  buyOrder: string;
  amount: string;
  childCommerceCode: string;
  environment: TransbankEnvironment;
}

export type TransbankTerms = WebpayPlusTerms | OneclickTerms;

/**
 * What the caller presents at verify/settle time. For Webpay Plus the human came back with the
 * token; for Oneclick the store presents the enrolment it holds for this buyer.
 */
export type TransbankPayload =
  { mode: "webpay-plus"; token: string } | { mode: "oneclick"; username: string; tbkUser: string };

/** An HTTP failure with the status attached, so the shared classifier can sort it. */
class TransbankHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "TransbankHttpError";
  }
}

function assertCredentials(options: TransbankRailOptions): void {
  if (!options.commerceCode || !options.apiKey) {
    throw new AgentPOSError(
      "CONFIG_INVALID",
      "Transbank rail requires the merchant's credentials",
      {
        hint: "Set TRANSBANK_COMMERCE_CODE and TRANSBANK_API_KEY to the merchant's own values (integration values are public; see .env.example).",
      },
    );
  }
}

function randomBuyOrder(): string {
  // 26 characters max: a compact, unique-enough id for reconciliation.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `ap-${t}-${r}`.slice(0, BUY_ORDER_MAX);
}

function readErrorMessage(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error_message" in body) {
    const m = (body as { error_message?: unknown }).error_message;
    return typeof m === "string" ? m : undefined;
  }
  return undefined;
}

export class TransbankRail implements PaymentRail<TransbankTerms, TransbankPayload> {
  readonly id = TRANSBANK_RAIL_ID;
  readonly label = "Tarjeta (Transbank)";

  private readonly environment: TransbankEnvironment;
  private readonly host: string;
  private readonly commerceCode: string;
  private readonly apiKey: string;
  private readonly oneclick: { mallCode: string; childCommerceCode: string } | undefined;
  private readonly minAmount: MinorAmount;
  private readonly maxAmount: MinorAmount | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly buyOrderFor: (input: RailQuoteInput) => string;

  constructor(options: TransbankRailOptions) {
    assertCredentials(options);
    this.environment = options.environment;
    this.host = PROTOCOL_VERSIONS.transbank.hosts[options.environment];
    this.commerceCode = options.commerceCode;
    this.apiKey = options.apiKey;
    this.oneclick = options.oneclick;
    this.minAmount = minorAmount(MIN_AMOUNT_CLP, CURRENCY, CLP_DECIMALS);
    this.maxAmount =
      options.maxAmountClp === undefined
        ? undefined
        : minorAmount(options.maxAmountClp, CURRENCY, CLP_DECIMALS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.buyOrderFor =
      options.buyOrderFor ??
      ((input) => (input.reference ?? randomBuyOrder()).slice(0, BUY_ORDER_MAX));
  }

  /** Cards in Chilean pesos, whole pesos, within bounds. Pure: no network. */
  supports(ctx: RailSupportContext): RailSupportDecision {
    const network = `transbank:${this.environment}`;
    if (ctx.network !== undefined && ctx.network !== network) {
      return {
        supported: false,
        code: "RAIL_UNSUPPORTED",
        message: `This rail settles at ${network}, not '${ctx.network}'`,
        hint: "Quote against the Transbank environment this store is configured for.",
        details: { railId: this.id, network, requested: ctx.network },
      };
    }
    if (ctx.currency !== undefined && ctx.currency.toUpperCase() !== CURRENCY) {
      return {
        supported: false,
        code: "RAIL_UNSUPPORTED",
        message: `This rail charges ${CURRENCY}, not '${ctx.currency}'`,
        hint: "Transbank settles Chilean pesos only. Route other currencies to another rail.",
        details: { railId: this.id, currency: CURRENCY, requested: ctx.currency },
      };
    }
    const amount = ctx.amount;
    if (amount !== undefined) {
      if (amount.currency !== CURRENCY || amount.decimals !== CLP_DECIMALS) {
        return {
          supported: false,
          code: "RAIL_UNSUPPORTED",
          message: `This rail charges ${CURRENCY} in whole pesos`,
          hint: "Quote the cart in CLP with 0 decimals; this rail never converts at settlement time.",
          details: {
            railId: this.id,
            currency: CURRENCY,
            requested: { currency: amount.currency, decimals: amount.decimals },
          },
        };
      }
      if (amount.minor < this.minAmount.minor) {
        return {
          supported: false,
          code: "RAIL_UNSUPPORTED",
          message: "Amount is below Transbank's minimum",
          hint: "Transbank refuses charges under 50 CLP.",
          details: {
            railId: this.id,
            minMinor: this.minAmount.minor.toString(),
            requestedMinor: amount.minor.toString(),
          },
        };
      }
      if (this.maxAmount !== undefined && amount.minor > this.maxAmount.minor) {
        return {
          supported: false,
          code: "RAIL_UNSUPPORTED",
          message: "Amount is above this rail's maximum",
          hint: "Split the order or route this cart to another rail.",
          details: {
            railId: this.id,
            maxMinor: this.maxAmount.minor.toString(),
            requestedMinor: amount.minor.toString(),
          },
        };
      }
    }
    return { supported: true };
  }

  /**
   * Webpay Plus: creates the transaction at Transbank and returns the page the human must visit.
   * Oneclick (when `input.network` ends in `#oneclick` or the store passes `oneclick` terms via
   * {@link quoteOneclick}): no network call, the terms are the amount and the child store.
   */
  async quote(input: RailQuoteInput): Promise<RailQuote<TransbankTerms>> {
    this.assertSupported(input);
    const buyOrder = this.buyOrderFor(input);
    const body = {
      buy_order: buyOrder,
      session_id: (input.reference ?? buyOrder).slice(0, 61),
      // Integers only, all the way to the wire (guardrail 4). CLP has no decimals.
      amount: Number(input.amount.minor),
      return_url: input.payTo,
    };
    const data = await this.call<{ token: string; url: string }>(
      "POST",
      `/rswebpaytransaction/api/webpay/v${PROTOCOL_VERSIONS.transbank.version}/transactions`,
      body,
      this.commerceCode,
    );
    if (typeof data.token !== "string" || typeof data.url !== "string") {
      throw new AgentPOSError("RAIL_UNAVAILABLE", "Transbank answered without a token", {
        hint: "The create-transaction response is malformed; retry or check the environment.",
        retryable: true,
        details: { railId: this.id },
      });
    }
    const terms: WebpayPlusTerms = {
      mode: "webpay-plus",
      token: data.token,
      url: data.url,
      buyOrder,
      amount: input.amount.minor.toString(),
      environment: this.environment,
    };
    return {
      railId: this.id,
      terms,
      amount: input.amount,
      payTo: input.payTo,
      network: `transbank:${this.environment}`,
      expiresInSeconds: WEBPAY_TOKEN_TTL_SECONDS,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    };
  }

  /**
   * Oneclick terms for a repeat purchase. Pure: nothing is sent to Transbank until `settle`.
   * `payTo` is the merchant's identifier for reconciliation; the money goes to the child store.
   */
  quoteOneclick(input: RailQuoteInput): RailQuote<OneclickTerms> {
    this.assertSupported(input);
    if (!this.oneclick) {
      throw new AgentPOSError("RAIL_UNSUPPORTED", "This store has no Oneclick Mall configured", {
        hint: "Set TRANSBANK_ONECLICK_MALL_CODE and TRANSBANK_ONECLICK_CHILD_CODE, or quote Webpay Plus.",
        details: { railId: this.id },
      });
    }
    const buyOrder = this.buyOrderFor(input);
    const terms: OneclickTerms = {
      mode: "oneclick",
      buyOrder,
      amount: input.amount.minor.toString(),
      childCommerceCode: this.oneclick.childCommerceCode,
      environment: this.environment,
    };
    return {
      railId: this.id,
      terms,
      amount: input.amount,
      payTo: input.payTo,
      network: `transbank:${this.environment}`,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    };
  }

  /**
   * Webpay Plus: reads the transaction status. Approved is `AUTHORIZED` with `response_code` 0;
   * `INITIALIZED` means the human has not paid yet, which is not a refusal: it is reported as
   * `PAYMENT_PENDING`, retryable, and never `preSubmission` (nothing may be re-sent elsewhere).
   * Oneclick: there is nothing to verify before charging; the enrolment is the store's fact.
   */
  async verify(payload: TransbankPayload, terms: TransbankTerms): Promise<RailVerification> {
    if (terms.mode === "oneclick") {
      if (payload.mode !== "oneclick" || !payload.tbkUser || !payload.username) {
        return this.refused("PAYMENT_REJECTED", "Oneclick payment needs the buyer's enrolment", {
          hint: "Present { mode: 'oneclick', username, tbkUser } as the store recorded it at enrolment.",
        });
      }
      return { railId: this.id, ok: true, payer: payload.username };
    }
    if (payload.mode !== "webpay-plus" || payload.token !== terms.token) {
      return this.refused("PAYMENT_REJECTED", "Presented token does not match the quoted one", {
        hint: "Verify with the token Transbank returned for this quote.",
      });
    }
    try {
      const status = await this.call<WebpayStatus>(
        "GET",
        `/rswebpaytransaction/api/webpay/v${PROTOCOL_VERSIONS.transbank.version}/transactions/${terms.token}`,
        undefined,
        this.commerceCode,
      );
      return this.decide(status, terms);
    } catch (err) {
      return { railId: this.id, ok: false, failure: this.classify(err, "PAYMENT_REJECTED") };
    }
  }

  /**
   * Webpay Plus: commits the token, exactly once. Oneclick: authorizes the charge on the
   * enrolled card. Either way the order is created by the caller only when `settled` is true
   * (guardrail 6). A failure with an HTTP status is never `preSubmission`: the charge may have
   * been applied.
   */
  async settle(payload: TransbankPayload, terms: TransbankTerms): Promise<RailSettlement> {
    try {
      if (terms.mode === "webpay-plus") {
        if (payload.mode !== "webpay-plus" || payload.token !== terms.token) {
          return this.notSettled(
            railRejected("SETTLEMENT_FAILED", "Presented token does not match the quoted one", {
              hint: "Commit with the token Transbank returned for this quote.",
              details: { railId: this.id },
            }),
          );
        }
        const result = await this.call<WebpayStatus>(
          "PUT",
          `/rswebpaytransaction/api/webpay/v${PROTOCOL_VERSIONS.transbank.version}/transactions/${terms.token}`,
          undefined,
          this.commerceCode,
        );
        return this.settlementOf(result, terms.buyOrder, terms.amount, result);
      }
      if (payload.mode !== "oneclick") {
        return this.notSettled(
          railRejected("SETTLEMENT_FAILED", "Oneclick settlement needs the buyer's enrolment", {
            hint: "Present { mode: 'oneclick', username, tbkUser }.",
            details: { railId: this.id },
          }),
        );
      }
      const mall = this.oneclick;
      if (!mall) {
        return this.notSettled(
          railRejected("RAIL_UNSUPPORTED", "This store has no Oneclick Mall configured", {
            hint: "Set the Oneclick mall and child codes.",
            details: { railId: this.id },
          }),
        );
      }
      const result = await this.call<OneclickAuthorization>(
        "POST",
        `/rswebpaytransaction/api/oneclick/v${PROTOCOL_VERSIONS.transbank.version}/transactions`,
        {
          username: payload.username,
          tbk_user: payload.tbkUser,
          buy_order: terms.buyOrder,
          details: [
            {
              commerce_code: terms.childCommerceCode,
              buy_order: terms.buyOrder,
              amount: Number(terms.amount),
              installments_number: 1,
            },
          ],
        },
        mall.mallCode,
      );
      const detail = result.details?.[0];
      if (!detail) {
        return this.notSettled(
          railUnavailable("RAIL_UNAVAILABLE", "Transbank answered without a detail line", {
            hint: "Malformed Oneclick response; do not re-submit without checking the status.",
            preSubmission: false,
            details: { railId: this.id },
          }),
        );
      }
      return this.settlementOf(detail, terms.buyOrder, terms.amount, result, payload.username);
    } catch (err) {
      return this.notSettled(this.classify(err, "SETTLEMENT_FAILED"));
    }
  }

  /** No secrets, no commerce codes: only what discovery may publish. */
  describe(): PaymentRailDescription {
    return {
      id: this.id,
      label: this.label,
      protocol: "transbank-webpay-rest",
      protocolVersion: PROTOCOL_VERSIONS.transbank.version,
      capabilities: {
        networks: [`transbank:${this.environment}`],
        currencies: [CURRENCY],
        minAmount: this.minAmount,
        ...(this.maxAmount !== undefined ? { maxAmount: this.maxAmount } : {}),
        settlesOnLedger: false,
      },
      spec: PROTOCOL_VERSIONS.transbank.source,
      railInterfaceVersion: PAYMENT_RAIL_INTERFACE_VERSION,
      adapterVersion: ADAPTER_VERSION,
    };
  }

  // ---------------------------------------------------------------------------

  private assertSupported(input: RailQuoteInput): void {
    const decision = this.supports({
      amount: input.amount,
      ...(input.network !== undefined ? { network: input.network } : {}),
    });
    if (!decision.supported) {
      throw new AgentPOSError(decision.code, decision.message, {
        hint: decision.hint,
        ...(decision.details ? { details: decision.details } : {}),
      });
    }
  }

  /** One HTTP call to Transbank with the given commerce code. Throws on non-2xx. */
  private async call<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    commerceCode: string,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.host}${path}`, {
      method,
      headers: {
        "Tbk-Api-Key-Id": commerceCode,
        "Tbk-Api-Key-Secret": this.apiKey,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new TransbankHttpError(
        res.status,
        readErrorMessage(data) ?? `Transbank responded ${res.status}`,
        data,
      );
    }
    return data as T;
  }

  private decide(status: WebpayStatus, terms: WebpayPlusTerms): RailVerification {
    if (status.status === AUTHORIZED && status.response_code === 0) {
      if (String(status.amount) !== terms.amount || status.buy_order !== terms.buyOrder) {
        return this.refused(
          "PAYMENT_REJECTED",
          "Authorized amount or order differs from the quote",
          {
            hint: "Never accept a payment that does not match the quoted terms.",
            details: {
              expected: { amount: terms.amount, buyOrder: terms.buyOrder },
              actual: { amount: String(status.amount), buyOrder: status.buy_order },
            },
          },
        );
      }
      return { railId: this.id, ok: true, raw: status };
    }
    if (status.status === "INITIALIZED") {
      return {
        railId: this.id,
        ok: false,
        failure: railUnavailable(
          "PAYMENT_PENDING",
          "The buyer has not completed the card payment",
          {
            hint: "Send the buyer to terms.url; ask again after they return. Do not re-quote.",
            preSubmission: false,
            details: { railId: this.id, status: status.status },
          },
        ),
        raw: status,
      };
    }
    return {
      railId: this.id,
      ok: false,
      failure: railRejected("PAYMENT_REJECTED", `Transbank did not authorize (${status.status})`, {
        hint: "Nothing was charged. The buyer may retry with another card.",
        details: {
          railId: this.id,
          status: status.status,
          ...(status.response_code !== undefined ? { responseCode: status.response_code } : {}),
        },
      }),
      raw: status,
    };
  }

  private settlementOf(
    line: { status?: string; response_code?: number; authorization_code?: string; amount?: number },
    buyOrder: string,
    amount: string,
    raw: unknown,
    payer?: string,
  ): RailSettlement {
    if (line.status !== AUTHORIZED || line.response_code !== 0) {
      return this.notSettled(
        railRejected("SETTLEMENT_FAILED", `Transbank did not authorize (${line.status ?? "?"})`, {
          hint: "Nothing was charged. Do not create the order.",
          details: {
            railId: this.id,
            ...(line.status !== undefined ? { status: line.status } : {}),
            ...(line.response_code !== undefined ? { responseCode: line.response_code } : {}),
          },
        }),
        raw,
      );
    }
    if (String(line.amount) !== amount) {
      return this.notSettled(
        railRejected("PAYMENT_MISMATCH", "Authorized amount differs from the quoted amount", {
          hint: "Hold the order; the merchant must reconcile this manually.",
          details: { railId: this.id, expected: amount, actual: String(line.amount) },
        }),
        raw,
      );
    }
    return {
      railId: this.id,
      settled: true,
      reference: buyOrder,
      amount: minorAmount(BigInt(amount), CURRENCY, CLP_DECIMALS),
      ...(payer !== undefined ? { payer } : {}),
      raw,
    };
  }

  private notSettled(failure: RailFailure, raw?: unknown): RailSettlement {
    return {
      railId: this.id,
      settled: false,
      reference: "",
      failure,
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  private refused(
    code: "PAYMENT_REJECTED",
    message: string,
    options: { hint: string; details?: Record<string, unknown> },
  ): RailVerification {
    return {
      railId: this.id,
      ok: false,
      failure: railRejected(code, message, {
        hint: options.hint,
        details: { railId: this.id, ...options.details },
      }),
    };
  }

  private classify(
    err: unknown,
    rejectedCode: "PAYMENT_REJECTED" | "SETTLEMENT_FAILED",
  ): RailFailure {
    const failure = classifyRailFailure(err, {
      unavailableCode: "RAIL_UNAVAILABLE",
      rejectedCode,
      hint:
        rejectedCode === "SETTLEMENT_FAILED"
          ? "Transbank refused the commit. A token commits once; check the status before retrying."
          : "Transbank refused the request. Nothing was charged.",
    });
    if (err instanceof TransbankHttpError) {
      return {
        ...failure,
        details: { ...failure.details, railId: this.id, status: err.statusCode, body: err.body },
      };
    }
    return { ...failure, details: { ...failure.details, railId: this.id } };
  }
}

/** Webpay Plus status/commit response, as documented (subset we read). */
interface WebpayStatus {
  status?: string;
  response_code?: number;
  authorization_code?: string;
  amount?: number;
  buy_order?: string;
  vci?: string;
  transaction_date?: string;
}

/** Oneclick Mall authorization response (subset we read). */
interface OneclickAuthorization {
  buy_order?: string;
  details?: Array<{
    status?: string;
    response_code?: number;
    authorization_code?: string;
    amount?: number;
    buy_order?: string;
    commerce_code?: string;
  }>;
}

/** Builds the Transbank rail. Credentials are the merchant's own. */
export function createTransbankRail(options: TransbankRailOptions): TransbankRail {
  return new TransbankRail(options);
}
