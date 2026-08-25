/**
 * x402 adapter: the ONLY place that touches @x402/* APIs (guardrail 3).
 * Verify/settle are never reimplemented; we wrap the SDK and pin its version.
 */
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorConfig, RouteConfig } from "@x402/core/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import { getUsdcAddress } from "@x402/stellar";
import type { CoreConfig } from "../config.js";
import type { UsdcMinor } from "../money.js";
import { usdcFromMinor } from "../money.js";
import type { SignerProvider } from "../signer.js";
import { AgentGateError } from "../errors.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export type { RouteConfig, SettleResponse, PaymentRequired };

export interface PaymentTerms {
  /** Stellar address (G... or C...) that receives the funds. Never ours. */
  payTo: string;
  amount: UsdcMinor;
  /** Human description shown in the 402 body and discovery. */
  description?: string;
  /** Seconds the payment authorization stays valid. */
  maxTimeoutSeconds?: number;
  /** Order id or similar, echoed to the 402 `extra` for reconciliation. */
  reference?: string;
}

export interface SettlementReceipt {
  txHash: string;
  network: string;
  payer: string | undefined;
  /** Settled amount in USDC minor units when the facilitator reports it. */
  amount: UsdcMinor | undefined;
  adapterVersion: string;
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

/** Resource (seller) side: an x402ResourceServer bound to the Stellar exact scheme. */
export function createResourceServer(config: CoreConfig): x402ResourceServer {
  return new x402ResourceServer(facilitatorClient(config)).register(
    config.caip2,
    new ExactStellarServerScheme(),
  );
}

/** Builds a RouteConfig entry for the SDK middlewares from integer USDC terms. */
export function buildRouteConfig(config: CoreConfig, terms: PaymentTerms): RouteConfig {
  const accept = {
    scheme: PROTOCOL_VERSIONS.x402.scheme,
    network: config.caip2,
    payTo: terms.payTo,
    // AssetAmount form keeps money as integers end to end (guardrail 4).
    price: { asset: getUsdcAddress(config.caip2), amount: terms.amount.toString() },
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

/** Buyer side: HTTP client that signs auth entries with the given signer. */
export function createBuyerClient(config: CoreConfig, signer: SignerProvider): x402HTTPClient {
  const scheme = new ExactStellarClientScheme(
    signer,
    config.rpcUrl ? { url: config.rpcUrl } : undefined,
  );
  const core = new x402Client().register(config.caip2, scheme);
  return new x402HTTPClient(core);
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
