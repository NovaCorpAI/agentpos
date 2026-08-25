/**
 * Test helpers: a stub facilitator (never used in production) and a paid-request helper that
 * mimics what an x402 client does, without touching the network.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

export interface StubFacilitatorOptions {
  network?: string;
  payer?: string;
  txHash?: string;
  failSettle?: boolean;
}

export function stubFacilitator(
  options: StubFacilitatorOptions = {},
): FacilitatorClient & { verifyCalls: number; settleCalls: number } {
  const network = options.network ?? "stellar:testnet";
  const state = {
    verifyCalls: 0,
    settleCalls: 0,
    async verify(
      _payload: PaymentPayload,
      _requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
      state.verifyCalls += 1;
      return { isValid: true, payer: options.payer ?? "GPAYER" };
    },
    async settle(
      _payload: PaymentPayload,
      requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
      state.settleCalls += 1;
      if (options.failSettle)
        return {
          success: false,
          transaction: "",
          network: requirements.network,
          errorReason: "stub_failure",
        };
      return {
        success: true,
        transaction: options.txHash ?? `tx_${state.settleCalls}`,
        network: requirements.network,
        payer: options.payer ?? "GPAYER",
        amount: requirements.amount,
      };
    },
    async getSupported(): Promise<SupportedResponse> {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: network as `${string}:${string}` }],
        extensions: [],
        signers: {},
      };
    },
  };
  return state as FacilitatorClient & { verifyCalls: number; settleCalls: number };
}

/** Sends the request once, and if it gets a 402, retries with a fake PAYMENT-SIGNATURE. */
export async function payLikeAnAgent(
  fetchImpl: (req: Request) => Promise<Response>,
  url: string,
  init: RequestInit = {},
) {
  const client = new x402HTTPClient(new x402Client());
  const first = await fetchImpl(new Request(url, init));
  if (first.status !== 402) return { first, paid: undefined };
  const body = await first
    .clone()
    .json()
    .catch(() => undefined);
  const required = client.getPaymentRequiredResponse((name) => first.headers.get(name), body);
  const accepted = required.accepts[0];
  if (!accepted) throw new Error("402 without accepts");
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted,
    payload: { transaction: "stub-signed-xdr" },
  } as PaymentPayload;
  const headers = client.encodePaymentSignatureHeader(payload);
  const paid = await fetchImpl(
    new Request(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...headers },
    }),
  );
  return { first, paid, required };
}
