/**
 * Probe: does the facilitator verify and settle an x402 payment from the mandate account when
 * the account's authorization emits no contract event?
 *
 * It issues a second session with a signer and NO policy (so `__check_auth` emits nothing),
 * pays 0.1 USDC through the facilitator and revokes that session. It isolates one question:
 * whether the contract-account path works apart from the events a policy emits. TESTNET only.
 * A session without a policy has no mandate; it exists here for one payment and is removed.
 */
import { Contract, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  buildPaymentRequirements,
  createContractAccountScheme,
  createResourceServer,
  usdc,
  type PaymentPayload,
} from "@agentpos/core";
import {
  callContractRuleScVal,
  revokeSession,
  signMandateAuthEntry,
  signerScVal,
  submit,
} from "../src/index.js";
import { scv } from "../src/scval.js";
import { chainFor, explorerTx, loadConfig, readState } from "./testnet.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const state = readState();
  const owner = {
    account: state.account,
    contextRuleId: 0,
    verifier: state.verifier,
    keys: [Keypair.fromSecret(state.ownerSecret)],
  };
  const chain = chainFor(config, Keypair.fromSecret(state.payerSecret));
  const probeKey = Keypair.random();
  const seller = Keypair.fromSecret(state.sellerSecret).publicKey();

  const latest = await chain.server.getLatestLedger();
  const added = await submit(
    chain,
    new Contract(state.account).call(
      "add_context_rule",
      callContractRuleScVal(state.token),
      xdr.ScVal.scvString("probe, no policy"),
      scv.u32(latest.sequence + 500),
      xdr.ScVal.scvVec([
        signerScVal({ verifier: state.verifier, publicKey: probeKey.rawPublicKey() }),
      ]),
      xdr.ScVal.scvMap([]),
    ),
    owner,
  );
  const rule = (scValToNative(added.returnValue as xdr.ScVal) as { id: number }).id;
  console.log(`probe session: rule ${rule}, no policy`);

  try {
    const scheme = createContractAccountScheme({
      address: state.account,
      authorize: (entry, validUntilLedger, networkPassphrase) =>
        signMandateAuthEntry(
          entry,
          {
            account: state.account,
            contextRuleId: rule,
            verifier: state.verifier,
            keys: [probeKey],
          },
          validUntilLedger,
          networkPassphrase,
        ),
    });
    const server = createResourceServer(config);
    await server.initialize();
    const requirements = await buildPaymentRequirements(config, server, {
      payTo: seller,
      amount: usdc("0.1"),
      description: "Probe: contract account, no policy events",
    });
    const signed = await scheme.createPaymentPayload(2, requirements);
    const payload: PaymentPayload = { ...signed, accepted: requirements };
    const verification = await server.verifyPayment(payload, requirements);
    console.log(`verify -> ${JSON.stringify(verification)}`);
    if (verification.isValid) {
      const settlement = await server.settlePayment(payload, requirements);
      console.log(`settle -> ${JSON.stringify(settlement)}`);
      if (settlement.success) console.log(`settled in ${explorerTx(settlement.transaction)}`);
    }
  } finally {
    const revoked = await revokeSession(chain, owner, rule);
    console.log(`probe session revoked in ${explorerTx(revoked.hash)}`);
  }
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED", error);
  process.exit(1);
});
