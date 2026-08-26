/**
 * x402 adapter: the ONLY place that touches @x402/* APIs (guardrail 3).
 * Verify/settle are never reimplemented; we wrap the SDK and pin its version.
 */
import { Asset } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, FacilitatorConfig, RouteConfig } from "@x402/core/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import { getNetworkPassphrase, getUsdcAddress } from "@x402/stellar";
import type { CoreConfig } from "../config.js";
import type { UsdcMinor } from "../money.js";
import { usdcFromMinor } from "../money.js";
import type { SignerProvider } from "../signer.js";
import { AgentGateError } from "../errors.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export type { RouteConfig, SettleResponse, PaymentRequired, FacilitatorClient };

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

/**
 * Resource (seller) side: an x402ResourceServer bound to the Stellar exact scheme.
 * Pass a custom FacilitatorClient only in tests (stub); production always uses the HTTP client.
 */
export function createResourceServer(
  config: CoreConfig,
  facilitator?: FacilitatorClient,
): x402ResourceServer {
  return new x402ResourceServer(facilitator ?? facilitatorClient(config)).register(
    config.caip2,
    new ExactStellarServerScheme(),
  );
}

/** Builds a RouteConfig entry for the SDK middlewares from integer terms. */
export function buildRouteConfig(config: CoreConfig, terms: PaymentTerms): RouteConfig {
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
  return {
    accepts: [accept],
    ...(terms.description ? { description: terms.description } : {}),
    mimeType: "application/json",
  };
}

/**
 * Hard per-payment ceiling enforced by the SDK before any signature happens. An agent client
 * always carries a limit; the buyer mandate (SPEC 02) layers period/total limits on top.
 */
export interface BuyerLimits {
  /** Maximum a single payment may authorize, in the checkout asset's minor units. */
  maxPerPayment: UsdcMinor;
}

/** Buyer side: HTTP client that signs auth entries with the given signer, bounded by limits. */
export function createBuyerClient(
  config: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
): x402HTTPClient {
  const scheme = new ExactStellarClientScheme(
    signer,
    config.rpcUrl ? { url: config.rpcUrl } : undefined,
  );
  const core = x402Client.fromConfig({
    schemes: [{ network: config.caip2, client: scheme }],
    spendControls: {
      // Only the configured checkout asset on the configured network, capped in atomic units.
      maxAmountPerPayment: false,
      allowedAssets: [
        {
          network: config.caip2,
          asset: assetAddress(config),
          maxAmountPerPayment: limits.maxPerPayment.toString(),
        },
      ],
    },
  });
  return new x402HTTPClient(core);
}

/** Buyer side: a fetch that transparently pays 402 responses within the limits. */
export function createBuyerFetch(
  config: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
): typeof globalThis.fetch {
  return wrapFetchWithPayment(globalThis.fetch, createBuyerClient(config, signer, limits));
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
    throw new AgentGateError(
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
