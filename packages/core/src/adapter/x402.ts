/**
 * x402 adapter: the ONLY place that touches @x402/* APIs (guardrail 3).
 * Verify/settle are never reimplemented; we wrap the SDK and pin its version.
 */
import { Asset } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, FacilitatorConfig, RouteConfig } from "@x402/core/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeNetworkServer,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import { getNetworkPassphrase, getUsdcAddress } from "@x402/stellar";
import type { CoreConfig } from "../config.js";
import { MAINNET_READY_NETWORKS } from "../config.js";
import type { UsdcMinor } from "../money.js";
import type { MinorAmount } from "./rails.js";
import { assertAddressFor, requireChainProfile } from "../chain.js";
import { usdcFromMinor } from "../money.js";
import type { SignerProvider } from "../signer.js";
import { AgentPOSError } from "../errors.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export type {
  RouteConfig,
  SettleResponse,
  PaymentRequired,
  FacilitatorClient,
  // Re-exported so consumers (and the x402 rail) never import @x402/* themselves (guardrail 3).
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  x402ResourceServer,
  // Rail packages implement these with their chain's official x402 package.
  SchemeNetworkServer,
  SchemeNetworkClient,
  FacilitatorConfig,
};

/**
 * Another network a rail package adds to this store's x402 checkout, next to Stellar. The rail
 * brings the official x402 scheme for its chain (for example `ExactEvmScheme` from `@x402/evm`)
 * and the facilitator that settles there; the core only wires them in. The network must have a
 * registered {@link ChainProfile} (see `registerChainProfile`).
 */
export interface X402NetworkExtension {
  /** CAIP-2 id, e.g. "eip155:5042". */
  network: string;
  /** Seller-side scheme for this network. */
  server: SchemeNetworkServer;
  /** Facilitator that verifies and settles on this network: a config or a ready client. */
  facilitator: FacilitatorConfig | FacilitatorClient;
}

/** One more way to pay the same route: same price, settled on another network. */
export interface ExtraAccept {
  network: string;
  /** Merchant's own receiving address on that network. Never ours. */
  payTo: string;
  /** Asset id on that network (for EVM, the USDC contract address). */
  asset: string;
  /** Price in that network's USDC minor unit (use `usdcOnChain`). */
  amount: MinorAmount;
  /** Asset metadata the scheme needs (EVM: the USDC EIP-712 domain name and version). */
  extra?: Record<string, unknown>;
}

function isFacilitatorClient(f: FacilitatorConfig | FacilitatorClient): f is FacilitatorClient {
  return typeof (f as FacilitatorClient).verify === "function";
}

function toFacilitatorClient(f: FacilitatorConfig | FacilitatorClient): FacilitatorClient {
  return isFacilitatorClient(f) ? f : new HTTPFacilitatorClient(f);
}

/**
 * Guardrail 2 for every network a rail adds. A testnet store never charges on a mainnet (and a
 * mainnet store never on a testnet); a mainnet network needs the explicit flag AND its own
 * production gate in MAINNET_READY_NETWORKS, which today holds Stellar only.
 */
export function assertNetworkAllowed(config: CoreConfig, network: string): void {
  const profile = requireChainProfile(network);
  const storeIsTestnet = config.network === "testnet";
  if (profile.testnet !== storeIsTestnet) {
    throw new AgentPOSError(
      "CONFIG_INVALID",
      `${profile.label} is a ${profile.testnet ? "test" : "main"} network but this store runs on ${config.network}`,
      {
        hint: "Pair testnet with testnet and mainnet with mainnet; a test store must never move real money.",
        details: { network, storeNetwork: config.network },
      },
    );
  }
  if (!profile.testnet) {
    if (!config.allowMainnet) {
      throw new AgentPOSError(
        "MAINNET_NOT_CONFIRMED",
        `${profile.label} mainnet requires an explicit flag`,
        {
          hint: "Set allowMainnet: true (AGENTPOS_ALLOW_MAINNET=true) after the founder confirms.",
          details: { network },
        },
      );
    }
    if (!MAINNET_READY_NETWORKS.has(network)) {
      throw new AgentPOSError(
        "MAINNET_NOT_CONFIRMED",
        `${profile.label} mainnet is locked: its production gate is not closed in this release`,
        {
          hint: "A network joins MAINNET_READY_NETWORKS (packages/core/src/config.ts) only after its own gate is green on testnet and the founder confirms.",
          details: { network, ready: [...MAINNET_READY_NETWORKS] },
        },
      );
    }
  }
}

export type CheckoutAsset = "USDC" | "XLM";

export interface PaymentTerms {
  /** Stellar address (G... or C...) that receives the funds. Never ours. */
  payTo: string;
  /** Amount in the asset's minor units (7 decimals for both USDC and XLM). */
  amount: UsdcMinor;
  /** Human description shown in the 402 body and discovery. */
  description?: string;
  /** Seconds the payment authorization stays valid. */
  maxTimeoutSeconds?: number;
  /** Order/cart id echoed to the 402 `extra` for reconciliation. */
  reference?: string;
}

export interface SettlementReceipt {
  txHash: string;
  network: string;
  payer: string | undefined;
  /** Settled amount in minor units when the facilitator reports it. */
  amount: UsdcMinor | undefined;
  adapterVersion: string;
}

/** Contract id of the checkout asset on the configured network. */
export function assetAddress(
  config: CoreConfig,
  asset: CheckoutAsset = config.checkoutAsset,
): string {
  if (asset === "USDC") return getUsdcAddress(config.caip2);
  // Native XLM Stellar Asset Contract id is derived from the network passphrase.
  return Asset.native().contractId(getNetworkPassphrase(config.caip2));
}

function facilitatorClient(config: CoreConfig): HTTPFacilitatorClient {
  const keys = config.facilitatorApiKeys;
  let index = 0;
  const facilitator: FacilitatorConfig = { url: config.facilitatorUrl };
  if (keys.length > 0) {
    facilitator.createAuthHeaders = async () => {
      const key = keys[index % keys.length] as string;
      index += 1;
      const headers = { Authorization: `Bearer ${key}` };
      return { verify: headers, settle: headers, supported: headers };
    };
  }
  return new HTTPFacilitatorClient(facilitator);
}

export interface FacilitatorHealth {
  ok: boolean;
  status: number | undefined;
  supportsNetwork: boolean;
  checkedAt: string;
  error?: string;
}

/** Liveness of the facilitator for the configured network (uses the API key when set). */
export async function checkFacilitator(
  config: CoreConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<FacilitatorHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const key = config.facilitatorApiKeys[0];
    const res = await fetchImpl(`${config.facilitatorUrl}/supported`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, status: res.status, supportsNetwork: false, checkedAt };
    const body = (await res.json()) as { kinds?: Array<{ scheme: string; network: string }> };
    const supportsNetwork = Boolean(
      body.kinds?.some((k) => k.scheme === "exact" && k.network === config.caip2),
    );
    return { ok: supportsNetwork, status: res.status, supportsNetwork, checkedAt };
  } catch (err) {
    return {
      ok: false,
      status: undefined,
      supportsNetwork: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Facilitator health for one extra network. */
export interface NetworkFacilitatorHealth extends FacilitatorHealth {
  network: string;
}

/**
 * Asks each extra network's facilitator whether it is up and settles the exact scheme there.
 * One slow or failing facilitator never blocks the others or the Stellar checkout: each check
 * has its own timeout and its own result.
 */
export async function checkNetworkFacilitators(
  extensions: ReadonlyArray<X402NetworkExtension>,
  timeoutMs = 10_000,
): Promise<NetworkFacilitatorHealth[]> {
  return Promise.all(
    extensions.map(async (ext): Promise<NetworkFacilitatorHealth> => {
      const checkedAt = new Date().toISOString();
      try {
        const client = toFacilitatorClient(ext.facilitator);
        const supported = await Promise.race([
          client.getSupported(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs),
          ),
        ]);
        const supportsNetwork = supported.kinds.some(
          (k) => k.scheme === PROTOCOL_VERSIONS.x402.scheme && k.network === ext.network,
        );
        return {
          network: ext.network,
          ok: supportsNetwork,
          status: 200,
          supportsNetwork,
          checkedAt,
        };
      } catch (err) {
        return {
          network: ext.network,
          ok: false,
          status: undefined,
          supportsNetwork: false,
          checkedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * Degrades instead of failing: keeps only the extra payment options whose network's
 * facilitator is healthy, so an outage on one network leaves the store payable on the rest
 * (Stellar always stays, it is not an extra).
 */
export function healthyOnly<T extends { network: string }>(
  items: ReadonlyArray<T>,
  health: ReadonlyArray<NetworkFacilitatorHealth>,
): T[] {
  const up = new Set(health.filter((h) => h.ok).map((h) => h.network));
  return items.filter((item) => up.has(item.network));
}

/**
 * Resource (seller) side: an x402ResourceServer bound to the Stellar exact scheme.
 * Pass a custom FacilitatorClient only in tests (stub); production always uses the HTTP client.
 */
export function createResourceServer(
  config: CoreConfig,
  facilitator?: FacilitatorClient,
  extensions: ReadonlyArray<X402NetworkExtension> = [],
): x402ResourceServer {
  const clients: FacilitatorClient[] = [facilitator ?? facilitatorClient(config)];
  for (const ext of extensions) {
    assertNetworkAllowed(config, ext.network);
    clients.push(toFacilitatorClient(ext.facilitator));
  }
  let server = new x402ResourceServer(clients).register(
    config.caip2,
    new ExactStellarServerScheme(),
  );
  for (const ext of extensions) server = server.register(ext.network as Network, ext.server);
  return server;
}

/** Builds a RouteConfig entry for the SDK middlewares from integer terms. */
export function buildRouteConfig(
  config: CoreConfig,
  terms: PaymentTerms,
  extraAccepts: ReadonlyArray<ExtraAccept> = [],
): RouteConfig {
  const accept = {
    scheme: PROTOCOL_VERSIONS.x402.scheme,
    network: config.caip2,
    payTo: terms.payTo,
    // AssetAmount form keeps money as integers end to end (guardrail 4).
    price: { asset: assetAddress(config), amount: terms.amount.toString() },
    ...(terms.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: terms.maxTimeoutSeconds }
      : {}),
    extra: {
      adapterVersion: ADAPTER_VERSION,
      ...(terms.reference ? { reference: terms.reference } : {}),
    },
  };
  const extras = extraAccepts.map((extra) => {
    assertNetworkAllowed(config, extra.network);
    const profile = requireChainProfile(extra.network);
    assertAddressFor(extra.network, extra.payTo);
    if (extra.amount.currency !== "USDC" || extra.amount.decimals !== profile.usdcDecimals) {
      throw new AgentPOSError(
        "INVALID_AMOUNT",
        `Price for ${profile.label} must be USDC with ${profile.usdcDecimals} decimals`,
        {
          hint: "Convert the catalog price with usdcOnChain(price, network); never reuse the Stellar amount.",
          details: {
            network: extra.network,
            currency: extra.amount.currency,
            decimals: extra.amount.decimals,
          },
        },
      );
    }
    return {
      scheme: PROTOCOL_VERSIONS.x402.scheme,
      network: extra.network as Network,
      payTo: extra.payTo,
      price: { asset: extra.asset, amount: extra.amount.minor.toString() },
      ...(terms.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: terms.maxTimeoutSeconds }
        : {}),
      extra: {
        ...extra.extra,
        adapterVersion: ADAPTER_VERSION,
        ...(terms.reference ? { reference: terms.reference } : {}),
      },
    };
  });
  return {
    accepts: [accept, ...extras],
    ...(terms.description ? { description: terms.description } : {}),
    mimeType: "application/json",
  };
}

/**
 * Compiles our integer terms into the wire `PaymentRequirements` a facilitator verifies and
 * settles against. The object is produced by the SDK's own compiler from the same RouteConfig the
 * HTTP middleware uses, never hand-built here: the wire format stays the SDK's business.
 *
 * The resource server must already know the facilitator's supported kinds (`server.initialize()`),
 * exactly as it does when serving a 402 over HTTP.
 */
export async function buildPaymentRequirements(
  config: CoreConfig,
  server: x402ResourceServer,
  terms: PaymentTerms,
): Promise<PaymentRequirements> {
  const route = buildRouteConfig(config, terms);
  const accept = Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;
  if (!accept) {
    throw new AgentPOSError("SPEC_MISMATCH", "Route config produced no payment option", {
      hint: "This is an adapter bug; buildRouteConfig always emits exactly one accept entry.",
    });
  }
  const [requirements] = await server.buildPaymentRequirements({
    scheme: accept.scheme,
    network: accept.network,
    payTo: accept.payTo as string,
    price: accept.price as { asset: string; amount: string },
    ...(accept.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: accept.maxTimeoutSeconds }
      : {}),
    ...(accept.extra ? { extra: accept.extra } : {}),
  });
  if (!requirements) {
    throw new AgentPOSError(
      "SPEC_MISMATCH",
      `Facilitator does not support scheme '${accept.scheme}' on ${config.caip2}`,
      {
        hint: "Check the facilitator URL and API key for this network; /supported must list the exact scheme.",
        details: { network: config.caip2, scheme: accept.scheme },
      },
    );
  }
  return requirements;
}

/**
 * Hard per-payment ceiling enforced by the SDK before any signature happens. An agent client
 * always carries a limit; the buyer mandate (SPEC 02) layers period/total limits on top.
 */
export interface BuyerLimits {
  /** Maximum a single payment may authorize, in the checkout asset's minor units. */
  maxPerPayment: UsdcMinor;
}

/** Another network the buyer may pay on, brought by a rail package. */
export interface BuyerNetworkExtension {
  network: string;
  /** Buyer-side scheme for that network, already bound to the buyer's own signer. */
  client: SchemeNetworkClient;
  /** Asset id the buyer allows on that network (the USDC contract). */
  asset: string;
  /** Per-payment ceiling in that network's minor unit (use `usdcOnChain` on the same limit). */
  maxPerPayment: MinorAmount;
}

/** Buyer side: HTTP client that signs auth entries with the given signer, bounded by limits. */
export function createBuyerClient(
  config: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
  extensions: ReadonlyArray<BuyerNetworkExtension> = [],
): x402HTTPClient {
  const scheme = new ExactStellarClientScheme(
    signer,
    config.rpcUrl ? { url: config.rpcUrl } : undefined,
  );
  const core = x402Client.fromConfig({
    schemes: [
      { network: config.caip2, client: scheme },
      ...extensions.map((ext) => {
        assertNetworkAllowed(config, ext.network);
        return { network: ext.network as Network, client: ext.client };
      }),
    ],
    spendControls: {
      // Only the configured checkout asset on the configured network, capped in atomic units.
      maxAmountPerPayment: false,
      allowedAssets: [
        {
          network: config.caip2,
          asset: assetAddress(config),
          maxAmountPerPayment: limits.maxPerPayment.toString(),
        },
        ...extensions.map((ext) => ({
          network: ext.network as Network,
          asset: ext.asset,
          maxAmountPerPayment: ext.maxPerPayment.minor.toString(),
        })),
      ],
    },
  });
  return new x402HTTPClient(core);
}

/**
 * Buyer side: a fetch that transparently pays 402 responses within the limits, on the profile's
 * network and on any extra network a rail brings.
 */
export function createBuyerFetch(
  config: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
  extensions: ReadonlyArray<BuyerNetworkExtension> = [],
): typeof globalThis.fetch {
  return wrapFetchWithPayment(
    globalThis.fetch,
    createBuyerClient(config, signer, limits, extensions),
  );
}

/** Decodes the PAYMENT-RESPONSE header of a paid response into a receipt. */
export function receiptFromResponse(response: Response): SettlementReceipt {
  const settle = new x402HTTPClient(new x402Client()).getPaymentSettleResponse((name) =>
    response.headers.get(name),
  );
  return toReceipt(settle);
}

export function toReceipt(settle: SettleResponse): SettlementReceipt {
  if (!settle.success) {
    throw new AgentPOSError(
      "SETTLEMENT_FAILED",
      settle.errorMessage ?? "Facilitator rejected settlement",
      {
        hint: "Inspect details.errorReason; the buyer was not charged.",
        details: { errorReason: settle.errorReason, network: settle.network },
      },
    );
  }
  return {
    txHash: settle.transaction,
    network: settle.network,
    payer: settle.payer,
    amount: settle.amount !== undefined ? usdcFromMinor(settle.amount) : undefined,
    adapterVersion: ADAPTER_VERSION,
  };
}

/** Why a facilitator turned down a signed payment, as the store saw it (F3). */
export interface SignedPaymentFailure {
  /** Network the buyer signed for, from its PAYMENT-SIGNATURE. */
  network?: string | undefined;
  /** The facilitator's reason code, or the transport error x402 put in its place. */
  reason?: string | undefined;
}

const header = (get: (name: string) => string | null | undefined, name: string) =>
  get(name) ?? get(name.toLowerCase()) ?? undefined;

/**
 * Reads, from a checkout request that carried a signed payment and the 402 (or 502) the x402
 * middleware answered, which network was tried and why the facilitator refused it. Undefined
 * when the request carried no payment: that 402 is an offer, not a refusal.
 */
export function signedPaymentFailure(
  requestHeader: (name: string) => string | null | undefined,
  responseHeader: (name: string) => string | null | undefined,
  bodyError?: string,
): SignedPaymentFailure | undefined {
  const signature = header(requestHeader, "PAYMENT-SIGNATURE");
  if (!signature) return undefined;
  let network: string | undefined;
  try {
    network = decodePaymentSignatureHeader(signature).accepted?.network;
  } catch {
    network = undefined;
  }
  // A failed settle carries PAYMENT-RESPONSE; a failed verify reuses the 402 with `error` set.
  let reason: string | undefined;
  const settled = header(responseHeader, "PAYMENT-RESPONSE");
  if (settled) {
    try {
      const s = decodePaymentResponseHeader(settled);
      reason = s.errorReason ?? s.errorMessage;
      network = network ?? s.network;
    } catch {
      reason = undefined;
    }
  }
  if (!reason) {
    const required = header(responseHeader, "PAYMENT-REQUIRED");
    if (required) {
      try {
        reason = decodePaymentRequiredHeader(required).error;
      } catch {
        reason = undefined;
      }
    }
  }
  return { network, reason: reason ?? bodyError };
}

const PENDING = /^settlement_pending$/;
const FUNDS = /insufficient_(funds|balance)/;
// The buyer's own authorization: stale, reused, malformed or already bound to another payment.
// A fresh signature fixes it.
const BUYER_SIGNATURE =
  /signature|nonce|valid_(before|after)|authorization_(expired|reused|validity)|deadline|not_yet_valid|transaction_state|invalid_payload$|failed_to_parse|permit2|credential_|payment_identifier_conflict|\(409\)/;
// The store's own payment terms or account at the facilitator: the merchant has to fix them.
const STORE_SETUP =
  /recipient_mismatch|receiver_mismatch|invalid_network|network_mismatch|unsupported_scheme|invalid_payment_requirements|invalid_x402_version|token_(name|version)_mismatch|asset_mismatch|registration_required|\((400|401)\)|unauthorized/i;
const UNAVAILABLE =
  /\((429|5\d\d)\)|timed? ?out|timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i;

/**
 * Turns a facilitator's refusal of a signed payment into an error an agent can reason about.
 * Nothing was charged in any of these cases except `PAYMENT_PENDING`, where the charge may still
 * land and paying again could charge twice. A refusal the facilitator does not explain, or a
 * 403 from it, is `PAYMENT_DECLINED`: Circle screens the buyer and the merchant and documents no
 * reason code for a failed screen, so this is what one looks like. It is never retryable, and
 * the hint tells the agent not to move the payment to another network on its own.
 */
export function paymentFailureError(failure: SignedPaymentFailure): AgentPOSError {
  const network = failure.network ?? "the network it chose";
  const reason = failure.reason ?? "";
  const details = { network: failure.network, facilitatorReason: failure.reason };
  if (PENDING.test(reason)) {
    return new AgentPOSError("PAYMENT_PENDING", `Settlement on ${network} is still unresolved`, {
      hint: "Do not pay again: the charge may still land. Check the order with get_order later; the store reconciles it.",
      details,
    });
  }
  if (FUNDS.test(reason)) {
    return new AgentPOSError("INSUFFICIENT_FUNDS", `Not enough USDC on ${network}`, {
      hint: `The paying wallet on ${network} cannot cover this cart. Nothing was charged. Ask the human to top it up.`,
      details,
    });
  }
  if (BUYER_SIGNATURE.test(reason)) {
    return new AgentPOSError(
      "PAYMENT_REJECTED",
      `The payment authorization was refused on ${network}`,
      {
        hint: "Nothing was charged. Pay the same cart again: a fresh authorization is signed.",
        retryable: true,
        details,
      },
    );
  }
  if (STORE_SETUP.test(reason)) {
    return new AgentPOSError(
      "PAYMENT_REJECTED",
      `The store cannot take payments on ${network} right now`,
      {
        hint: "Nothing was charged. The merchant's payment setup on that network needs fixing; tell the human and try later.",
        details,
      },
    );
  }
  if (UNAVAILABLE.test(reason)) {
    return new AgentPOSError(
      "FACILITATOR_UNAVAILABLE",
      `The facilitator on ${network} did not answer`,
      {
        hint: "Nothing was charged. Retry the same cart after Retry-After seconds.",
        retryable: true,
        details,
      },
    );
  }
  return new AgentPOSError("PAYMENT_DECLINED", `The payment was declined on ${network}`, {
    hint: `Nothing was charged. The facilitator on ${network} refused this payment without a documented reason, which is how a compliance screen of the buyer or the merchant shows up. Do not retry, and do not pay on another network on your own: tell the human, who decides.`,
    details,
  });
}
