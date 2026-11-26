/**
 * Shared setup of the testnet scripts: configuration, the local state file and classic
 * account helpers. Testnet only (guardrail 2); the scripts exit on any other network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Keypair } from "@stellar/stellar-sdk";
import {
  Keypair as KeypairValue,
  Asset,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, assetAddress, configFromEnv, type CoreConfig } from "@agentpos/core";
import type { MandateChain } from "../src/index.js";

export const SOROBAN_RPC_TESTNET = "https://soroban-testnet.stellar.org";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * Throwaway testnet keys and contract ids. Git-ignored (`.agentpos/`). An ad hoc deployment (CI,
 * a second asset) keeps its own file through AGENTPOS_MANDATE_STATE_FILE.
 */
export const STATE_FILE =
  process.env.AGENTPOS_MANDATE_STATE_FILE ?? `${repoRoot}.agentpos/mandate-testnet.json`;
/**
 * Public record of the reference deployment: contract ids and WASM hashes, no keys. Undefined
 * for an ad hoc deployment, which leaves the record alone.
 */
export const DEPLOYMENT_FILE = process.env.AGENTPOS_MANDATE_STATE_FILE
  ? undefined
  : `${repoRoot}contracts/deployments/testnet.json`;
export const WASM_DIR = `${repoRoot}contracts/target/wasm32v1-none/release/`;

export interface TestnetState {
  payerSecret: string;
  ownerSecret: string;
  agentSecret: string;
  sellerSecret: string;
  verifier: string;
  policy: string;
  account: string;
  /** The token the session may move: the checkout asset's contract (USDC, or XLM in CI). */
  token: string;
  session: number;
  sessionValidUntilLedger: number;
}

export function loadConfig(): CoreConfig {
  const candidates = [process.env.AGENTPOS_ENV_FILE, `${repoRoot}.env`];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }
  const config = configFromEnv({ ...process.env, AGENTPOS_ALLOW_MAINNET: "false" });
  if (config.network !== "testnet") {
    console.error("The mandate contracts run on testnet only (guardrail 2).");
    process.exit(1);
  }
  return config;
}

export function chainFor(config: CoreConfig, payer: Keypair): MandateChain {
  return {
    server: new rpc.Server(config.rpcUrl ?? SOROBAN_RPC_TESTNET),
    networkPassphrase: Networks.TESTNET,
    payer,
  };
}

export function readState(): TestnetState {
  if (!existsSync(STATE_FILE)) {
    console.error(`No deployment found at ${STATE_FILE}. Run deploy:testnet first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as TestnetState;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Contract of the checkout asset: USDC by default, XLM when AGENTPOS_CHECKOUT_ASSET says so. */
export const tokenContract = (config: CoreConfig): string => assetAddress(config);

/**
 * The account that funds the mandate account with the checkout asset. XLM comes from the fee
 * payer, which friendbot funded. USDC has no faucet a script can call, so it comes from
 * SMOKE_USDC_SOURCE_SECRET (an account funded at https://faucet.circle.com).
 */
export function fundingSource(config: CoreConfig, payer: Keypair): Keypair | undefined {
  if (config.checkoutAsset === "XLM") return payer;
  const secret = process.env.SMOKE_USDC_SOURCE_SECRET;
  return secret ? KeypairValue.fromSecret(secret) : undefined;
}
export const explorerTx = (hash: string): string =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const explorerContract = (id: string): string =>
  `https://stellar.expert/explorer/testnet/contract/${id}`;

export async function friendbot(keypair: Keypair): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(keypair.publicKey())}`);
  if (!res.ok) throw new Error(`friendbot failed for ${keypair.publicKey()}: ${res.status}`);
}

/** Opens the USDC trustline a classic account needs before it can be paid. */
export async function trustUsdc(config: CoreConfig, keypair: Keypair): Promise<string> {
  const horizon = new Horizon.Server(config.horizonUrl);
  const account = await horizon.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", config.usdcIssuer) }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  return (await horizon.submitTransaction(tx)).hash;
}
