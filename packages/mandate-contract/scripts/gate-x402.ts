/**
 * Gate of the week: an x402 payment whose payer is the mandate account (`C...`), verified
 * and settled by the facilitator on Stellar TESTNET, then a payment over the cap, which the
 * account refuses before anything is sent.
 *
 *   pnpm --filter @agentpos/mandate-contract gate:x402
 *
 * Needs a deployment (`deploy:testnet`) and `AGENTPOS_FACILITATOR_API_KEY`. Pass `--verify-only`
 * to stop after the facilitator's verify.
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  AgentPOSError,
  buildPaymentRequirements,
  createContractAccountScheme,
  createResourceServer,
  usdc,
  type PaymentPayload,
} from "@agentpos/core";
import { getMandate, signMandateAuthEntry } from "../src/index.js";
import { chainFor, explorerTx, loadConfig, readState } from "./testnet.js";

const X402_VERSION = 2;
const WITHIN_CAP = usdc("0.5");
const OVER_CAP = usdc("1.5");

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes("--verify-only");
  const config = loadConfig();
  const state = readState();
  const agent = Keypair.fromSecret(state.agentSecret);
  const seller = Keypair.fromSecret(state.sellerSecret).publicKey();
  const chain = chainFor(config, Keypair.fromSecret(state.payerSecret));

  const scheme = createContractAccountScheme({
    address: state.account,
    authorize: (entry, validUntilLedger, networkPassphrase) =>
      signMandateAuthEntry(
        entry,
        {
          account: state.account,
          contextRuleId: state.session,
          verifier: state.verifier,
          keys: [agent],
        },
        validUntilLedger,
        networkPassphrase,
      ),
  });

  const server = createResourceServer(config);
  await server.initialize();
  console.log(`payer  ${state.account} (contract account, session rule ${state.session})`);
  console.log(`seller ${seller}\nfacilitator ${config.facilitatorUrl}`);

  // 1. A payment within the mandate.
  const requirements = await buildPaymentRequirements(config, server, {
    payTo: seller,
    amount: WITHIN_CAP,
    description: "Mandate gate: payment within the cap",
  });
  const signed = await scheme.createPaymentPayload(X402_VERSION, requirements);
  const payload: PaymentPayload = { ...signed, accepted: requirements };

  const verification = await server.verifyPayment(payload, requirements);
  console.log(`verify -> ${JSON.stringify(verification)}`);
  if (!verification.isValid) throw new Error("The facilitator did not verify the payment");

  if (verifyOnly) {
    console.log("GATE VERIFY OK (settle skipped)");
    return;
  }
  const settlement = await server.settlePayment(payload, requirements);
  console.log(`settle -> ${JSON.stringify(settlement)}`);
  if (!settlement.success) throw new Error("The facilitator did not settle the payment");
  console.log(`settled in ${explorerTx(settlement.transaction)}`);

  // 2. A payment over the cap per payment: the account refuses it in simulation.
  const overCap = await buildPaymentRequirements(config, server, {
    payTo: seller,
    amount: OVER_CAP,
    description: "Mandate gate: payment over the cap",
  });
  try {
    await scheme.createPaymentPayload(X402_VERSION, overCap);
    throw new Error("The payment over the cap was signed; the mandate did not hold");
  } catch (error) {
    if (!(error instanceof AgentPOSError)) throw error;
    console.log(`over the cap -> ${error.code}: ${error.message}`);
    console.log(`  details ${JSON.stringify(error.details)}`);
  }

  const mandate = await getMandate(chain, state.policy, state.account, state.session);
  console.log(`spent in period: ${mandate.spentInPeriod} of ${mandate.periodCap}`);
  console.log("GATE OK");
}

main().catch((error: unknown) => {
  console.error("GATE FAILED", error);
  process.exit(1);
});
