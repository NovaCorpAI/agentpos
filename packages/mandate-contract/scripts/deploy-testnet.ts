/**
 * Deploys the mandate contracts to Stellar TESTNET (never mainnet) and leaves an account
 * ready to pay: verifier, policy, an account with an owner, a USDC balance and one agent
 * session.
 *
 *   stellar contract build            (in contracts/)
 *   pnpm --filter @agentpos/mandate-contract deploy:testnet
 *
 * Every key is generated here and is a throwaway testnet key. `SMOKE_USDC_SOURCE_SECRET`
 * (an account that holds testnet USDC, see https://faucet.circle.com) funds the account;
 * without it the script stops after the deployment and says what to fund.
 */
import { readFileSync } from "node:fs";
import { Contract, Keypair, hash } from "@stellar/stellar-sdk";
import {
  deployContract,
  deployMandateAccount,
  getMandate,
  issueSession,
  submit,
  uploadWasm,
  type ExternalSigner,
} from "../src/index.js";
import { scv } from "../src/scval.js";
import {
  DEPLOYMENT_FILE,
  STATE_FILE,
  WASM_DIR,
  chainFor,
  explorerContract,
  explorerTx,
  friendbot,
  loadConfig,
  trustUsdc,
  usdcContract,
  writeJson,
  type TestnetState,
} from "./testnet.js";

const USDC = 10_000_000n;
const ACCOUNT_FUNDING = 3n * USDC;
const PER_PAYMENT_CAP = 1n * USDC;
const PERIOD_CAP = 2n * USDC;
const DAY_IN_LEDGERS = 17_280;
const SESSION_DAYS = 14;

const wasm = (name: string): Buffer => readFileSync(`${WASM_DIR}${name}.wasm`);

async function main(): Promise<void> {
  const config = loadConfig();
  const payer = Keypair.random();
  const owner = Keypair.random();
  const agent = Keypair.random();
  const seller = Keypair.random();
  const chain = chainFor(config, payer);
  const usdc = usdcContract(config);

  await Promise.all([friendbot(payer), friendbot(seller)]);
  await trustUsdc(config, seller);
  console.log(
    `fee payer ${payer.publicKey()}\nseller    ${seller.publicKey()} (USDC trustline open)`,
  );

  const artifacts = {
    verifier: wasm("agentpos_ed25519_verifier"),
    policy: wasm("agentpos_mandate_policy"),
    account: wasm("agentpos_mandate_account"),
  };
  const verifierHash = await uploadWasm(chain, artifacts.verifier);
  const policyHash = await uploadWasm(chain, artifacts.policy);
  const accountHash = await uploadWasm(chain, artifacts.account);

  const verifier = await deployContract(chain, verifierHash);
  const policy = await deployContract(chain, policyHash);
  const ownerSigner: ExternalSigner = { verifier, publicKey: owner.rawPublicKey() };
  const account = await deployMandateAccount(chain, accountHash, [ownerSigner]);
  console.log(`verifier  ${verifier}\npolicy    ${policy}\naccount   ${account}`);

  const latest = await chain.server.getLatestLedger();
  const validUntilLedger = latest.sequence + SESSION_DAYS * DAY_IN_LEDGERS;
  const session = await issueSession(
    chain,
    { account, contextRuleId: 0, verifier, keys: [owner] },
    {
      token: usdc,
      policy,
      signers: [{ verifier, publicKey: agent.rawPublicKey() }],
      validUntilLedger,
      mandate: {
        perPaymentCap: PER_PAYMENT_CAP,
        periodCap: PERIOD_CAP,
        periodLedgers: DAY_IN_LEDGERS,
        sellers: [seller.publicKey()],
      },
    },
  );
  console.log(`session   rule ${session.contextRuleId}, issued in ${explorerTx(session.hash)}`);

  const state: TestnetState = {
    payerSecret: payer.secret(),
    ownerSecret: owner.secret(),
    agentSecret: agent.secret(),
    sellerSecret: seller.secret(),
    verifier,
    policy,
    account,
    usdc,
    session: session.contextRuleId,
    sessionValidUntilLedger: validUntilLedger,
  };
  writeJson(STATE_FILE, state);
  writeJson(DEPLOYMENT_FILE, {
    network: "stellar:testnet",
    deployedAtLedger: latest.sequence,
    contracts: {
      "ed25519-verifier": { id: verifier, wasmHash: hash(artifacts.verifier).toString("hex") },
      "mandate-policy": { id: policy, wasmHash: hash(artifacts.policy).toString("hex") },
      "mandate-account": { id: account, wasmHash: hash(artifacts.account).toString("hex") },
    },
    usdc,
    demoSession: {
      contextRuleId: session.contextRuleId,
      issuedIn: session.hash,
      validUntilLedger,
      perPaymentCap: PER_PAYMENT_CAP.toString(),
      periodCap: PERIOD_CAP.toString(),
      periodLedgers: DAY_IN_LEDGERS,
      sellers: [seller.publicKey()],
    },
  });

  const sourceSecret = process.env.SMOKE_USDC_SOURCE_SECRET;
  if (!sourceSecret) {
    console.log(
      `SMOKE_USDC_SOURCE_SECRET not set: send testnet USDC to ${account} to pay with it.`,
    );
  } else {
    const source = Keypair.fromSecret(sourceSecret);
    const funded = await submit(
      { ...chain, payer: source },
      new Contract(usdc).call(
        "transfer",
        scv.address(source.publicKey()),
        scv.address(account),
        scv.i128(ACCOUNT_FUNDING),
      ),
    );
    console.log(`funded    ${ACCOUNT_FUNDING} units of USDC in ${explorerTx(funded.hash)}`);
  }

  const mandate = await getMandate(chain, policy, account, session.contextRuleId);
  console.log(
    `mandate   per payment ${mandate.perPaymentCap}, per period ${mandate.periodCap}, spent ${mandate.spentInPeriod}`,
  );
  console.log(`\n${explorerContract(account)}\nDEPLOY OK`);
}

main().catch((error: unknown) => {
  console.error("DEPLOY FAILED", error);
  process.exit(1);
});
