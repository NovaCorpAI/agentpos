/**
 * Fee-bump wrapper around transaction submission.
 *
 * Why this exists, found the expensive way (2026-09-04): the x402 Stellar client builds the
 * inner transaction with a hardcoded BASE_FEE (100 stroops) of inclusion fee, and the buyer's
 * signature covers it, so nobody downstream can raise it. When the network's minimum inclusion
 * fee rises above 100 (it was at 200 when this bit us), every settlement submits as PENDING and
 * is silently never included: verify passes, settle times out, and the failure looks like an RPC
 * outage. The protocol-correct escape hatch is a FeeBumpTransaction: our fee account wraps the
 * signed inner transaction and bids a real inclusion fee without touching the buyer's signature.
 *
 * The SDK's own feeBumpSigner option wraps with the same BASE_FEE, which re-creates the problem,
 * so we wrap at the submission boundary ourselves. Patching the Server prototype is blunt but
 * deliberate: this process exists solely to run one facilitator, and the alternative is forking
 * the scheme's settle method wholesale.
 *
 * Cost ceiling: INCLUSION_BID stroops per settlement on top of resources (0.0002 XLM at the
 * default), paid by the fee account like every other fee. Report upstream: the scheme should
 * expose an inclusion-fee strategy.
 */
import { FeeBumpTransaction, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import type { Logger } from "@agentpos/core";

/** Per-operation inclusion bid, in stroops. 10x the surge level that caused the incident. */
export const DEFAULT_INCLUSION_BID_STROOPS = 2_000;

let patched = false;

export function enableFeeBumpSubmission(options: {
  signerSecret: string;
  networkPassphrase: string;
  logger: Logger;
  inclusionBidStroops?: number;
}): void {
  if (patched) return;
  patched = true;
  const keypair = Keypair.fromSecret(options.signerSecret);
  const bid = String(options.inclusionBidStroops ?? DEFAULT_INCLUSION_BID_STROOPS);
  const original = rpc.Server.prototype.sendTransaction;

  rpc.Server.prototype.sendTransaction = async function (
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    let toSubmit: Transaction | FeeBumpTransaction = tx;
    if (!(tx instanceof FeeBumpTransaction)) {
      try {
        const bump = TransactionBuilder.buildFeeBumpTransaction(
          keypair.publicKey(),
          bid,
          tx,
          options.networkPassphrase,
        );
        bump.sign(keypair);
        toSubmit = bump;
        options.logger.info("facilitator.fee_bump", {
          innerFee: tx.fee,
          bumpFee: bump.fee,
          hash: bump.hash().toString("hex"),
        });
      } catch (err) {
        // A bump that cannot be built must not block the payment: fall through to the
        // original submission, which is exactly what happened before this module existed.
        options.logger.warn("facilitator.fee_bump_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return original.call(this, toSubmit);
  };
}
