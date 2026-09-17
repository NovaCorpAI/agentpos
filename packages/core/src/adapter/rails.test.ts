import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { resolveConfig } from "../config.js";
import { AgentPOSError } from "../errors.js";
import { usdc, usdcFromMinor } from "../money.js";
import type { FacilitatorClient, PaymentPayload, PaymentRequirements } from "./x402.js";
import { ADAPTER_VERSION, PAYMENT_RAIL_IDS, PAYMENT_RAIL_INTERFACE_VERSION } from "./versions.js";
import type {
  PaymentRail,
  PaymentRailDescription,
  RailQuote,
  RailQuoteInput,
  RailSettlement,
  RailSupportContext,
  RailSupportDecision,
  RailVerification,
} from "./rails.js";
import {
  PaymentRailRegistry,
  isPaymentRailId,
  minorAmount,
  paymentRailId,
  railFailureToError,
  toUsdcMinor,
  usdcAmount,
} from "./rails.js";
import type { X402StellarRail } from "./rails/x402-stellar.js";
import { X402_STELLAR_RAIL_ID, createX402StellarRail } from "./rails/x402-stellar.js";

const cfg = resolveConfig();
const payTo = Keypair.random().publicKey();

// ---------------------------------------------------------------------------
// Rail ids
// ---------------------------------------------------------------------------

describe("payment rail ids", () => {
  it("accepts reverse-DNS ids", () => {
    for (const id of [
      "org.x402.stellar",
      "com.amazon.payments",
      "com.amazon.payments.wallet",
      "com.mercado-pago.checkout",
      "io.a.b.c.d.e",
      "cl.fintoc.transfer3",
    ]) {
      expect(isPaymentRailId(id)).toBe(true);
      expect(paymentRailId(id)).toBe(id);
    }
  });

  it("rejects junk", () => {
    for (const junk of [
      "",
      "x402", // single segment is not reverse-DNS
      "Org.X402.Stellar", // uppercase
      "org..stellar",
      ".org.x402",
      "org.x402.",
      "org x402.stellar",
      "org.x402-", // trailing hyphen inside a segment
      "org.-x402",
      "1org.x402", // must start with a letter
      "org.x402.stellar/pay",
      "org.x402.stellar ",
      `org.${"a".repeat(200)}`,
    ]) {
      expect(isPaymentRailId(junk)).toBe(false);
      expect(() => paymentRailId(junk)).toThrowError(AgentPOSError);
      try {
        paymentRailId(junk);
        expect.unreachable();
      } catch (err) {
        expect((err as AgentPOSError).code).toBe("RAIL_ID_INVALID");
        expect((err as AgentPOSError).hint).toBeTruthy();
      }
    }
  });

  it("rejects non-strings without throwing", () => {
    for (const value of [undefined, null, 42, {}, ["org.x402.stellar"]]) {
      expect(isPaymentRailId(value)).toBe(false);
    }
  });

  it("pins the x402 rail id to the UCP payment handler name", () => {
    expect(X402_STELLAR_RAIL_ID).toBe(PAYMENT_RAIL_IDS.x402Stellar);
    expect(PAYMENT_RAIL_IDS.x402Stellar).toBe("org.x402.stellar");
  });
});

// ---------------------------------------------------------------------------
// Money at the rail boundary
// ---------------------------------------------------------------------------

describe("rail amounts", () => {
  it("round-trips USDC minor units without ever leaving integers", () => {
    const amount = usdcAmount(usdc("1.25"));
    expect(amount).toEqual({ minor: 12_500_000n, currency: "USDC", decimals: 7 });
    expect(typeof amount.minor).toBe("bigint");
    expect(toUsdcMinor(amount)).toBe(12_500_000n);
  });

  it("refuses amounts that are not the expected currency or minor unit", () => {
    expect(() => toUsdcMinor(minorAmount(990n, "USD", 2))).toThrowError(AgentPOSError);
    expect(() => toUsdcMinor({ minor: 1n, currency: "USDC", decimals: 6 })).toThrowError(
      AgentPOSError,
    );
  });

  it("rejects negatives, impossible decimals and bogus currencies", () => {
    expect(() => minorAmount(-1n, "USDC", 7)).toThrowError(AgentPOSError);
    expect(() => minorAmount(1n, "USDC", 7.5)).toThrowError(AgentPOSError);
    expect(() => minorAmount(1n, "USDC", 99)).toThrowError(AgentPOSError);
    expect(() => minorAmount(1n, "", 2)).toThrowError(AgentPOSError);
    expect(() => minorAmount(1n, "us dollars", 2)).toThrowError(AgentPOSError);
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Minimal rail used to test the registry's ordering and lookup, nothing else. */
function fakeRail(id: string, supports: (ctx: RailSupportContext) => boolean): PaymentRail {
  const railId = paymentRailId(id);
  return {
    id: railId,
    label: id,
    supports(ctx: RailSupportContext): RailSupportDecision {
      return supports(ctx)
        ? { supported: true }
        : {
            supported: false,
            code: "RAIL_UNSUPPORTED",
            message: `${id} cannot take this charge`,
            hint: "Try another rail.",
          };
    },
    quote(input: RailQuoteInput): Promise<RailQuote> {
      return Promise.resolve({
        railId,
        terms: {},
        amount: input.amount,
        payTo: input.payTo,
        network: input.network ?? "test",
      });
    },
    verify(): Promise<RailVerification> {
      return Promise.resolve({ railId, ok: true });
    },
    settle(): Promise<RailSettlement> {
      return Promise.resolve({ railId, settled: true, reference: "ref" });
    },
    describe(): PaymentRailDescription {
      return {
        id: railId,
        label: id,
        protocol: "test",
        protocolVersion: "0",
        capabilities: { networks: [], currencies: [], settlesOnLedger: false },
        railInterfaceVersion: PAYMENT_RAIL_INTERFACE_VERSION,
        adapterVersion: ADAPTER_VERSION,
      };
    },
  };
}

describe("PaymentRailRegistry", () => {
  const first = fakeRail("com.example.first", (ctx) => ctx.currency === "CLP");
  const second = fakeRail("com.example.second", () => true);

  it("keeps declaration order and indexes by id", () => {
    const registry = new PaymentRailRegistry([first, second]);
    expect(registry.size).toBe(2);
    expect(registry.ids()).toEqual(["com.example.first", "com.example.second"]);
    expect(registry.list().map((r) => r.label)).toEqual([
      "com.example.first",
      "com.example.second",
    ]);
    expect(registry.get("com.example.second")).toBe(second);
    expect(registry.get("com.example.missing")).toBeUndefined();
    expect(registry.require("com.example.first")).toBe(first);
    expect(registry.describe().map((d) => d.id)).toEqual([
      "com.example.first",
      "com.example.second",
    ]);
  });

  it("registers in the order given, not the order sorted", () => {
    const registry = new PaymentRailRegistry([second]).register(first);
    expect(registry.ids()).toEqual(["com.example.second", "com.example.first"]);
  });

  it("refuses duplicates and invalid ids", () => {
    const registry = new PaymentRailRegistry([first]);
    try {
      registry.register(first);
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("RAIL_DUPLICATE");
    }
    try {
      registry.register({ ...second, id: "NOPE" as never });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("RAIL_ID_INVALID");
    }
  });

  it("names the rails it has when asked for one it does not", () => {
    const registry = new PaymentRailRegistry([first, second]);
    try {
      registry.require("com.example.nope");
      expect.unreachable();
    } catch (err) {
      const e = err as AgentPOSError;
      expect(e.code).toBe("RAIL_NOT_FOUND");
      expect(e.details?.available).toEqual(["com.example.first", "com.example.second"]);
    }
  });

  it("selects the first supporting rail in declaration order", () => {
    const registry = new PaymentRailRegistry([first, second]);
    expect(registry.firstSupporting({ currency: "CLP" })?.id).toBe("com.example.first");
    // `first` says no, so the ordered scan falls through to `second`.
    expect(registry.firstSupporting({ currency: "USDC" })?.id).toBe("com.example.second");
  });

  it("explains per rail when nothing supports the charge", () => {
    const registry = new PaymentRailRegistry([first]);
    expect(registry.firstSupporting({ currency: "USDC" })).toBeUndefined();
    try {
      registry.requireSupporting({ currency: "USDC", amount: usdcAmount(usdc("1")) });
      expect.unreachable();
    } catch (err) {
      const e = err as AgentPOSError;
      expect(e.code).toBe("RAIL_UNSUPPORTED");
      expect(e.details?.rails).toEqual([
        {
          railId: "com.example.first",
          code: "RAIL_UNSUPPORTED",
          message: "com.example.first cannot take this charge",
        },
      ]);
      // Amounts inside error details stay integer strings, never floats.
      expect((e.details?.requested as { amountMinor: string }).amountMinor).toBe("10000000");
    }
  });
});

// ---------------------------------------------------------------------------
// The x402 Stellar rail
// ---------------------------------------------------------------------------

const SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
  extensions: [],
  signers: {},
};

interface StubOptions {
  verify?: () => Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle?: () => Promise<{
    success: boolean;
    transaction: string;
    network: string;
    payer?: string;
    amount?: string;
    errorReason?: string;
    errorMessage?: string;
  }>;
}

/** Stands in for the facilitator, exactly as the existing adapter tests stub it. */
function stubFacilitator(options: StubOptions = {}): FacilitatorClient {
  return {
    getSupported: () => Promise.resolve(SUPPORTED),
    verify: options.verify ?? (() => Promise.resolve({ isValid: true, payer: "GPAYER" })),
    settle:
      options.settle ??
      (() =>
        Promise.resolve({
          success: true,
          transaction: "tx_hash_1",
          network: "stellar:testnet",
          payer: "GPAYER",
          amount: "12500000",
        })),
  } as unknown as FacilitatorClient;
}

function rail(options: StubOptions = {}): X402StellarRail {
  return createX402StellarRail({ config: cfg, facilitator: stubFacilitator(options) });
}

/** A payload shaped like the agent's, with the terms it accepted. */
function payload(terms: PaymentRequirements): PaymentPayload {
  return { x402Version: 2, accepted: terms, payload: { signature: "sig" } } as PaymentPayload;
}

/** An error that carries an HTTP status, like the SDK's VerifyError/SettleError. */
function httpError(status: number): Error {
  return Object.assign(new Error(`facilitator responded ${status}`), { statusCode: status });
}

describe("x402 Stellar rail: quote", () => {
  it("compiles integer terms into x402 payment requirements", async () => {
    const quote = await rail().quote({
      payTo,
      amount: usdcAmount(usdc("1.25")),
      description: "Test item",
      reference: "cart_1",
    });
    expect(quote.railId).toBe("org.x402.stellar");
    expect(quote.network).toBe("stellar:testnet");
    expect(quote.payTo).toBe(payTo);
    expect(quote.reference).toBe("cart_1");
    // Same wire values the existing route config emits: integers, in the asset's minor units.
    expect(quote.terms.scheme).toBe("exact");
    expect(quote.terms.asset).toBe(USDC_TESTNET_ADDRESS);
    expect(quote.terms.amount).toBe("12500000");
    expect(quote.terms.payTo).toBe(payTo);
    expect(quote.terms.extra).toMatchObject({
      adapterVersion: ADAPTER_VERSION,
      reference: "cart_1",
    });
    // Nothing in the public surface is a float.
    expect(typeof quote.amount.minor).toBe("bigint");
    expect(quote.amount).toEqual({ minor: 12_500_000n, currency: "USDC", decimals: 7 });
    expect(Number.isInteger(quote.expiresInSeconds)).toBe(true);
  });

  it("refuses to quote an amount the rail does not support", async () => {
    const r = createX402StellarRail({
      config: cfg,
      facilitator: stubFacilitator(),
      maxAmount: usdc("10"),
    });
    await expect(r.quote({ payTo, amount: usdcAmount(usdc("11")) })).rejects.toThrowError(
      AgentPOSError,
    );
    await expect(r.quote({ payTo, amount: minorAmount(990n, "USD", 2) })).rejects.toThrowError(
      AgentPOSError,
    );
  });
});

describe("x402 Stellar rail: verify", () => {
  it("returns an accepted decision when the facilitator validates the payment", async () => {
    const r = rail();
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.verify(payload(quote.terms), quote.terms);
    expect(result.ok).toBe(true);
    expect(result.ok && result.payer).toBe("GPAYER");
  });

  it("maps a facilitator refusal to a deterministic PAYMENT_REJECTED failure", async () => {
    const r = rail({
      verify: () => Promise.resolve({ isValid: false, invalidReason: "insufficient_funds" }),
    });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.verify(payload(quote.terms), quote.terms);
    expect(result.ok).toBe(false);
    if (result.ok) expect.unreachable();
    expect(result.failure.kind).toBe("rejected");
    expect(result.failure.code).toBe("PAYMENT_REJECTED");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.details?.invalidReason).toBe("insufficient_funds");
  });

  it("maps an unreachable facilitator to a retryable, unavailable failure", async () => {
    const r = rail({
      verify: () => Promise.reject(Object.assign(new Error("boom"), { code: "ECONNREFUSED" })),
    });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.verify(payload(quote.terms), quote.terms);
    expect(result.ok).toBe(false);
    if (result.ok) expect.unreachable();
    expect(result.failure.kind).toBe("unavailable");
    expect(result.failure.code).toBe("FACILITATOR_UNAVAILABLE");
    expect(result.failure.retryable).toBe(true);
  });

  it("keeps a deterministic 4xx refusal out of the unavailable bucket", async () => {
    const r = rail({ verify: () => Promise.reject(httpError(400)) });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.verify(payload(quote.terms), quote.terms);
    expect(result.ok).toBe(false);
    if (result.ok) expect.unreachable();
    expect(result.failure.kind).toBe("rejected");
    expect(result.failure.retryable).toBe(false);
  });
});

describe("x402 Stellar rail: settle", () => {
  it("returns the transaction hash and the settled amount in minor units", async () => {
    const r = rail();
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.settle(payload(quote.terms), quote.terms);
    expect(result).toMatchObject({
      railId: "org.x402.stellar",
      settled: true,
      reference: "tx_hash_1",
      payer: "GPAYER",
    });
    expect(result.amount).toEqual({ minor: 12_500_000n, currency: "USDC", decimals: 7 });
    expect(typeof result.amount?.minor).toBe("bigint");
    expect(result.failure).toBeUndefined();
  });

  it("preserves SETTLEMENT_FAILED when the facilitator settles nothing", async () => {
    const r = rail({
      settle: () =>
        Promise.resolve({
          success: false,
          transaction: "",
          network: "stellar:testnet",
          errorReason: "insufficient_balance",
        }),
    });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.settle(payload(quote.terms), quote.terms);
    expect(result.settled).toBe(false);
    expect(result.reference).toBe("");
    // Same code the store already emits through toReceipt(): the wrapper relabels nothing.
    expect(result.failure?.code).toBe("SETTLEMENT_FAILED");
    expect(result.failure?.kind).toBe("rejected");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.details?.errorReason).toBe("insufficient_balance");
  });

  it("marks a connection-level settle failure as provably pre-submission", async () => {
    const r = rail({
      settle: () => Promise.reject(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })),
    });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.settle(payload(quote.terms), quote.terms);
    expect(result.settled).toBe(false);
    expect(result.failure?.kind).toBe("unavailable");
    expect(result.failure?.code).toBe("FACILITATOR_UNAVAILABLE");
    expect(result.failure?.preSubmission).toBe(true);
  });

  it("never claims pre-submission for an ambiguous settle failure", async () => {
    for (const err of [
      httpError(503),
      Object.assign(new Error("timed out"), { name: "FacilitatorTimeoutError" }),
      new Error("malformed facilitator response"),
    ]) {
      const r = rail({ settle: () => Promise.reject(err) });
      const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
      const result = await r.settle(payload(quote.terms), quote.terms);
      expect(result.settled).toBe(false);
      expect(result.failure?.kind).toBe("unavailable");
      // Guardrail 6: an ambiguous failure may already be on chain, so it is never re-submitted.
      expect(result.failure?.preSubmission).toBe(false);
    }
  });

  it("re-raises a rail failure as the project's typed error, code intact", async () => {
    const r = rail({
      settle: () =>
        Promise.resolve({ success: false, transaction: "", network: "stellar:testnet" }),
    });
    const quote = await r.quote({ payTo, amount: usdcAmount(usdc("1.25")) });
    const result = await r.settle(payload(quote.terms), quote.terms);
    const error = railFailureToError(result.failure!, r.id);
    expect(error).toBeInstanceOf(AgentPOSError);
    expect(error.code).toBe("SETTLEMENT_FAILED");
    expect(error.retryable).toBe(false);
    expect(error.details?.railId).toBe("org.x402.stellar");
    expect(error.details?.railFailureKind).toBe("rejected");
  });
});

describe("x402 Stellar rail: supports and describe", () => {
  it("accepts the configured network, asset and amount range", () => {
    const r = createX402StellarRail({
      config: cfg,
      facilitator: stubFacilitator(),
      minAmount: usdc("0.5"),
      maxAmount: usdc("10"),
    });
    expect(r.supports({}).supported).toBe(true);
    expect(r.supports({ network: "stellar:testnet", currency: "USDC" }).supported).toBe(true);
    expect(r.supports({ amount: usdcAmount(usdc("1")) }).supported).toBe(true);
    expect(r.supports({ network: "stellar:pubnet" }).supported).toBe(false);
    expect(r.supports({ currency: "CLP" }).supported).toBe(false);
    expect(r.supports({ amount: usdcAmount(usdc("0.1")) }).supported).toBe(false);
    expect(r.supports({ amount: usdcAmount(usdc("11")) }).supported).toBe(false);
    expect(r.supports({ amount: minorAmount(100n, "USD", 2) }).supported).toBe(false);
    const denied = r.supports({ currency: "CLP" });
    expect(denied.supported === false && denied.code).toBe("RAIL_UNSUPPORTED");
  });

  it("publishes a description with integer bounds and pinned versions", () => {
    const description = rail().describe();
    expect(description).toMatchObject({
      id: "org.x402.stellar",
      protocol: "x402",
      protocolVersion: "2",
      railInterfaceVersion: PAYMENT_RAIL_INTERFACE_VERSION,
      adapterVersion: ADAPTER_VERSION,
    });
    expect(description.capabilities.networks).toEqual(["stellar:testnet"]);
    expect(description.capabilities.currencies).toEqual(["USDC"]);
    expect(description.capabilities.settlesOnLedger).toBe(true);
    expect(typeof description.capabilities.minAmount?.minor).toBe("bigint");
    expect(description.capabilities.maxAmount).toBeUndefined();
  });

  it("plugs into the registry as the store's only rail today", () => {
    const registry = new PaymentRailRegistry([rail()]);
    expect(registry.ids()).toEqual(["org.x402.stellar"]);
    expect(
      registry.firstSupporting({
        network: "stellar:testnet",
        currency: "USDC",
        amount: usdcAmount(usdcFromMinor(10n)),
      })?.id,
    ).toBe("org.x402.stellar");
    expect(registry.requireSupporting({ currency: "USDC" }).id).toBe("org.x402.stellar");
    expect(() => registry.requireSupporting({ currency: "CLP" })).toThrowError(AgentPOSError);
  });
});
