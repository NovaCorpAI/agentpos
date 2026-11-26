/**
 * x402 "exact" on Stellar, paid from a contract account (`C...`) with its own signature format.
 *
 * The official client scheme (`@x402/stellar/exact/client`) builds the same transaction, but it
 * hands the signature to the SDK as raw bytes, which the SDK then wraps as the classic
 * `{public_key, signature}` value of a `G...` account. A smart account whose `__check_auth`
 * takes another value (OpenZeppelin's `AuthPayload`, for one) cannot be signed for that way.
 *
 * This scheme is the official one with a single difference: the caller signs the authorization
 * entry itself. The payload it returns is the same wire object, and verify and settle stay the
 * facilitator's (guardrail 3: nothing of the protocol is reimplemented here).
 */
import { contract, nativeToScVal, rpc, type xdr } from "@stellar/stellar-sdk";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  isStellarNetwork,
} from "@x402/stellar";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { AgentPOSError } from "../errors.js";

/** Signs one authorization entry of the paying account. Returns the signed copy. */
export type ContractAccountAuthorizer = (
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  networkPassphrase: string,
) => Promise<xdr.SorobanAuthorizationEntry>;

export interface ContractAccountPayer {
  /** The paying contract account (`C...`). */
  address: string;
  authorize: ContractAccountAuthorizer;
  /** Soroban RPC URL. Required on mainnet; testnet has a public default. */
  rpcUrl?: string;
}

/**
 * Contract error code behind a refused simulation (for example 4105), when there is one.
 *
 * When an account's `__check_auth` refuses, the simulation's error is a generic authorization
 * error whatever the reason. The reason, the contract's own error code, is in the diagnostic
 * events, so both places are read.
 */
export function contractErrorFromSimulation(
  simulation: rpc.Api.SimulateTransactionResponse | undefined,
): number | undefined {
  if (!simulation || !rpc.Api.isSimulationError(simulation)) return undefined;
  const inText = /Error\(Contract, #(\d+)\)/.exec(simulation.error);
  if (inText) return Number(inText[1]);
  let found: number | undefined;
  for (const diagnostic of simulation.events ?? []) {
    const body = diagnostic.event().body().v0();
    for (const value of [...body.topics(), body.data()]) {
      if (value.switch().name !== "scvError") continue;
      const error = value.error();
      // The first contract error is the one the refusing contract raised.
      if (error.switch().name === "sceContract") found ??= error.contractCode();
    }
  }
  return found;
}

function assertSimulated(
  simulation: rpc.Api.SimulateTransactionResponse | undefined,
  stage: "unsigned" | "signed",
  payer: string,
): void {
  if (simulation && !rpc.Api.isSimulationError(simulation)) return;
  const reason = simulation?.error ?? "no simulation result";
  const code = contractErrorFromSimulation(simulation);
  throw new AgentPOSError(
    "PAYMENT_REJECTED",
    `The paying account refused the payment in simulation (${stage})`,
    {
      hint:
        code === undefined
          ? "Nothing was signed for or charged. Check the account's balance and that its session is still valid."
          : `Nothing was charged. The account's contract answered with error ${code}; that code names the rule that refused the payment.`,
      details: { payer, stage, ...(code === undefined ? {} : { contractCode: code }), reason },
    },
  );
}

/** Buyer-side scheme for the Stellar exact scheme, for a payer that is a contract account. */
export function createContractAccountScheme(payer: ContractAccountPayer): SchemeNetworkClient {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
      const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = requirements;
      if (requirements.scheme !== "exact" || !isStellarNetwork(network)) {
        throw new AgentPOSError(
          "SPEC_MISMATCH",
          `A Stellar contract account cannot pay '${requirements.scheme}' on ${network}`,
          { hint: "This payer only pays the exact scheme on a Stellar network." },
        );
      }
      if (extra.areFeesSponsored !== true) {
        throw new AgentPOSError("SPEC_MISMATCH", "The exact scheme needs sponsored fees", {
          hint: "The facilitator must declare areFeesSponsored: a contract account does not pay network fees itself.",
        });
      }
      const rpcConfig = payer.rpcUrl ? { url: payer.rpcUrl } : undefined;
      const networkPassphrase = getNetworkPassphrase(network);
      const latest = await getRpcClient(network, rpcConfig).getLatestLedger();
      const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
      const maxLedger = latest.sequence + Math.ceil(maxTimeoutSeconds / ledgerSeconds);

      // SEP-41 transfer(from, to, amount), the call the facilitator expects.
      const tx = await contract.AssembledTransaction.build({
        contractId: asset,
        method: "transfer",
        args: [
          nativeToScVal(payer.address, { type: "address" }),
          nativeToScVal(payTo, { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
        ],
        networkPassphrase,
        rpcUrl: getRpcUrl(network, rpcConfig),
        parseResultXdr: (result: xdr.ScVal) => result,
      });
      assertSimulated(tx.simulation, "unsigned", payer.address);

      await tx.signAuthEntries({
        address: payer.address,
        expiration: maxLedger,
        authorizeEntry: (entry, _signer, validUntilLedger, passphrase) =>
          payer.authorize(entry, validUntilLedger, passphrase ?? networkPassphrase),
      });
      // With the signature in place the simulation runs the account's own checks.
      await tx.simulate();
      assertSimulated(tx.simulation, "signed", payer.address);

      if (!tx.built) {
        throw new AgentPOSError("SPEC_MISMATCH", "The payment transaction was not assembled", {
          hint: "This is an adapter bug: a simulated transaction always has a built form.",
        });
      }
      return { x402Version, payload: { transaction: tx.built.toXDR() } };
    },
  };
}
