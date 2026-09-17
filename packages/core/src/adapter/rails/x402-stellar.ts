/**
 * The x402 / Stellar payment rail: today the only way an AgentPOS store gets paid.
 *
 * This file is a THIN WRAPPER. It owns no protocol logic: quoting compiles terms through the
 * existing `buildRouteConfig` + the SDK's own requirements compiler, and verify/settle are the
 * SDK's `verifyPayment` / `settlePayment` on the resource server that `createResourceServer`
 * already builds. Nothing about the wire format, the headers or the facilitator contract changes
 * because this file exists; the behavior and the error codes are the ones the store had before.
 *
 * Its whole job is to present that one code path through the `PaymentRail` interface, so the next
 * rail (a merchant fiat acquirer, a network agentic credential) is an addition rather than a
 * rewrite. See plan/RIELES.md.
 */
import type { CoreConfig } from "../../config.js";
import { AgentPOSError } from "../../errors.js";
import type { UsdcMinor } from "../../money.js";
import { usdcFromMinor } from "../../money.js";
import { USDC_DECIMALS, XLM_DECIMALS } from "../../money.js";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  x402ResourceServer,
} from "../x402.js";
import {
  assetAddress,
  buildPaymentRequirements,
  createResourceServer,
  toReceipt,
} from "../x402.js";
import {
  ADAPTER_VERSION,
  PAYMENT_RAIL_IDS,
  PAYMENT_RAIL_INTERFACE_VERSION,
  PROTOCOL_VERSIONS,
} from "../versions.js";
import type {
  MinorAmount,
  PaymentRail,
  PaymentRailDescription,
  PaymentRailId,
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
  toUsdcMinor,
} from "../rails.js";

/** Rail id of x402 over Stellar, validated once. Same string as the UCP payment handler name. */
export const X402_STELLAR_RAIL_ID: PaymentRailId = paymentRailId(PAYMENT_RAIL_IDS.x402Stellar);

export interface X402StellarRailOptions {
  config: CoreConfig;
  /**
   * Resource server verify/settle go through. Pass the store's own server so its hooks
   * (onAfterSettle, onSettleFailure) keep firing; omit it and one is built from `facilitator`.
   */
  resourceServer?: x402ResourceServer;
  /** Facilitator client used when no resource server is given. Tests inject a stub here. */
  facilitator?: FacilitatorClient;
  /** Smallest amount this rail will quote, in the checkout asset's minor units. Default: 1. */
  minAmount?: UsdcMinor;
  /** Largest amount this rail will quote, in the checkout asset's minor units. Default: none. */
  maxAmount?: UsdcMinor;
}

/** Decimals of the checkout asset. Stellar classic assets and Stellar USDC both use 7. */
function decimalsOf(asset: "USDC" | "XLM"): number {
  return asset === "USDC" ? USDC_DECIMALS : XLM_DECIMALS;
}

export class X402StellarRail implements PaymentRail<PaymentRequirements, PaymentPayload> {
  readonly id = X402_STELLAR_RAIL_ID;
  readonly label = "x402 on Stellar";

  private readonly config: CoreConfig;
  private readonly server: x402ResourceServer;
  private readonly minAmount: MinorAmount;
  private readonly maxAmount: MinorAmount | undefined;
  /** Supported kinds are fetched once; a failed attempt is not cached, so an outage is transient. */
  private initialized: Promise<void> | undefined;

  constructor(options: X402StellarRailOptions) {
    this.config = options.config;
    this.server =
      options.resourceServer ?? createResourceServer(options.config, options.facilitator);
    const decimals = decimalsOf(options.config.checkoutAsset);
    this.minAmount = minorAmount(options.minAmount ?? 1n, options.config.checkoutAsset, decimals);
    this.maxAmount =
      options.maxAmount === undefined
        ? undefined
        : minorAmount(options.maxAmount, options.config.checkoutAsset, decimals);
  }

  /**
   * What this rail can charge: the configured CAIP-2 network, the configured checkout asset, and
   * amounts within the configured bounds. Pure: no network, no facilitator call.
   */
  supports(ctx: RailSupportContext): RailSupportDecision {
    const asset = this.config.checkoutAsset;
    if (
      ctx.network !== undefined &&
      ctx.network !== this.config.network &&
      ctx.network !== this.config.caip2
    ) {
      return {
        supported: false,
        code: "RAIL_UNSUPPORTED",
        message: `This rail settles on ${this.config.caip2}, not '${ctx.network}'`,
        hint: "Quote against the network this store is configured for.",
        details: { railId: this.id, network: this.config.caip2, requested: ctx.network },
      };
    }
    if (ctx.currency !== undefined && ctx.currency.toUpperCase() !== asset) {
      return {
        supported: false,
        code: "RAIL_UNSUPPORTED",
        message: `This rail charges ${asset}, not '${ctx.currency}'`,
        hint: "x402 on Stellar settles the store's configured checkout asset only.",
        details: { railId: this.id, asset, requested: ctx.currency },
      };
    }
    const amount = ctx.amount;
    if (amount !== undefined) {
      if (amount.currency !== asset || amount.decimals !== decimalsOf(asset)) {
        return {
          supported: false,
          code: "RAIL_UNSUPPORTED",
          message: `This rail charges ${asset} in ${decimalsOf(asset)} decimals`,
          hint: "Convert the amount before quoting; this rail never converts at settlement time.",
          details: {
            railId: this.id,
            asset,
            requested: { currency: amount.currency, decimals: amount.decimals },
          },
        };
      }
      if (amount.minor < this.minAmount.minor) {
        return {
          supported: false,
          code: "RAIL_UNSUPPORTED",
          message: "Amount is below this rail's minimum",
          hint: "Raise the price or route this cart to another rail.",
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
   * The terms an agent must satisfy: the x402 payment requirements that go into the 402 response,
   * compiled by the SDK from the same route config the HTTP middleware uses.
   */
  async quote(input: RailQuoteInput): Promise<RailQuote<PaymentRequirements>> {
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
    await this.ensureInitialized();
    const requirements = await buildPaymentRequirements(this.config, this.server, {
      payTo: input.payTo,
      // Integers only, all the way to the wire (guardrail 4).
      amount: toUsdcMinor(input.amount),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: input.maxTimeoutSeconds }
        : {}),
    });
    return {
      railId: this.id,
      terms: requirements,
      amount: input.amount,
      payTo: requirements.payTo,
      network: requirements.network,
      expiresInSeconds: requirements.maxTimeoutSeconds,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    };
  }

  /**
   * The facilitator's decision about a signed payment, through the SDK. Never moves money, so a
   * transport failure here is always safe to retry (`preSubmission` is irrelevant for verify).
   */
  async verify(payload: PaymentPayload, terms: PaymentRequirements): Promise<RailVerification> {
    try {
      const result = await this.server.verifyPayment(payload, terms);
      if (result.isValid) {
        return {
          railId: this.id,
          ok: true,
          ...(result.payer !== undefined ? { payer: result.payer } : {}),
          raw: result,
        };
      }
      return {
        railId: this.id,
        ok: false,
        failure: railRejected(
          "PAYMENT_REJECTED",
          result.invalidMessage ?? result.invalidReason ?? "Facilitator rejected the payment",
          {
            hint: "Inspect details.invalidReason; nothing was charged. Re-sign the payment against the current terms.",
            details: {
              railId: this.id,
              ...(result.invalidReason !== undefined
                ? { invalidReason: result.invalidReason }
                : {}),
            },
          },
        ),
        raw: result,
      };
    } catch (err) {
      return {
        railId: this.id,
        ok: false,
        failure: classifyRailFailure(err, {
          unavailableCode: "FACILITATOR_UNAVAILABLE",
          rejectedCode: "PAYMENT_REJECTED",
        }),
      };
    }
  }

  /**
   * Moves the money, through the SDK's settle path, and converts the response with the same
   * `toReceipt` the HTTP surface uses: a facilitator that answers "not settled" produces the
   * existing SETTLEMENT_FAILED code, unchanged.
   *
   * A settle that fails deterministically is `rejected`; one that never got an answer is
   * `unavailable`, and only carries `preSubmission: true` when the request provably never left
   * this machine (guardrail 6: never risk a second settlement).
   */
  async settle(payload: PaymentPayload, terms: PaymentRequirements): Promise<RailSettlement> {
    try {
      const response = await this.server.settlePayment(payload, terms);
      const receipt = toReceipt(response);
      return {
        railId: this.id,
        settled: true,
        reference: receipt.txHash,
        ...(receipt.amount !== undefined ? { amount: this.amountOf(receipt.amount) } : {}),
        ...(receipt.payer !== undefined ? { payer: receipt.payer } : {}),
        raw: response,
      };
    } catch (err) {
      return {
        railId: this.id,
        settled: false,
        reference: "",
        failure: classifyRailFailure(err, {
          unavailableCode: "FACILITATOR_UNAVAILABLE",
          rejectedCode: "SETTLEMENT_FAILED",
        }),
      };
    }
  }

  describe(): PaymentRailDescription {
    return {
      id: this.id,
      label: this.label,
      protocol: "x402",
      protocolVersion: String(PROTOCOL_VERSIONS.x402.protocol),
      capabilities: {
        networks: [this.config.caip2],
        currencies: [this.config.checkoutAsset],
        minAmount: this.minAmount,
        ...(this.maxAmount !== undefined ? { maxAmount: this.maxAmount } : {}),
        settlesOnLedger: true,
      },
      spec: PROTOCOL_VERSIONS.x402.source,
      railInterfaceVersion: PAYMENT_RAIL_INTERFACE_VERSION,
      adapterVersion: ADAPTER_VERSION,
    };
  }

  /** Contract id of the asset this rail charges, for surfaces that publish it. */
  get assetAddress(): string {
    return assetAddress(this.config);
  }

  private amountOf(value: UsdcMinor | bigint): MinorAmount {
    return minorAmount(
      usdcFromMinor(value),
      this.config.checkoutAsset,
      decimalsOf(this.config.checkoutAsset),
    );
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.server.initialize().catch((err: unknown) => {
        // Do not cache a failed handshake: the facilitator may simply have been down.
        this.initialized = undefined;
        throw err;
      });
    }
    return this.initialized;
  }
}

/** Builds the x402 Stellar rail. The only rail AgentPOS implements today. */
export function createX402StellarRail(options: X402StellarRailOptions): X402StellarRail {
  return new X402StellarRail(options);
}
