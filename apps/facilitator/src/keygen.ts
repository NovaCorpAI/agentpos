/**
 * `agentpos-facilitator keygen`: creates the fee-paying account for a facilitator.
 *
 * The secret is written to a file with owner-only permissions and NEVER printed. The only thing
 * that reaches the terminal is the public address, which is what the operator needs in order to
 * fund the account. A secret that appears on a screen ends up in a scrollback, a screenshot, a
 * chat transcript or a shell history; a secret that only ever exists in a 0600 file does not.
 *
 * What this account is for, stated where the operator will read it: paying transaction fees.
 * It is not the merchant's revenue wallet, not the buyer's wallet, and not an AgentPOS account.
 * Fund it with XLM and nothing else.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

export interface KeygenOptions {
  network: "testnet" | "mainnet";
  /** Directory for the env file. Defaults to ~/.agentpos/facilitator, outside any repo. */
  dir?: string | undefined;
  /** Overwrite an existing file. Off by default: silently replacing a funded key loses funds. */
  force?: boolean;
}

export interface KeygenResult {
  publicKey: string;
  path: string;
}

export function defaultKeyDir(): string {
  return process.env.AGENTPOS_HOME
    ? join(process.env.AGENTPOS_HOME, "facilitator")
    : join(homedir(), ".agentpos", "facilitator");
}

/** Generates the keypair and writes an env file the service can be started from. */
export function generateFacilitatorKey(options: KeygenOptions): KeygenResult {
  const dir = resolve(options.dir ?? defaultKeyDir());
  const path = join(dir, `${options.network}.env`);
  if (existsSync(path) && !options.force) {
    throw new Error(
      `${path} already exists. If that account is funded, generating a new key would strand its balance. Pass --force only if you are sure.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  const kp = Keypair.random();
  const contents = [
    `# AgentPOS facilitator fee account (${options.network}). Generated ${new Date().toISOString()}.`,
    `# This key signs settlements and pays transaction fees. Fund the PUBLIC address with XLM only.`,
    `# It must never hold merchant revenue or buyer funds, and must never be a store's payTo.`,
    `# Back this file up with the same care as a password. Never commit it.`,
    `AGENTPOS_FACILITATOR_NETWORK=${options.network}`,
    `AGENTPOS_FACILITATOR_SIGNER_PUBLIC=${kp.publicKey()}`,
    `AGENTPOS_FACILITATOR_SIGNER_SECRET=${kp.secret()}`,
    "",
  ].join("\n");
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs do not map onto POSIX modes; the file still lives under the user's home.
  }
  return { publicKey: kp.publicKey(), path };
}

// CLI entry: `tsx src/keygen.ts [--network testnet|mainnet] [--dir <path>] [--force]`
if (process.argv[1] && /keygen\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const network = (flag("--network") ?? "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") {
    console.error("--network must be testnet or mainnet");
    process.exit(1);
  }
  try {
    const { publicKey, path } = generateFacilitatorKey({
      network,
      dir: flag("--dir"),
      force: args.includes("--force"),
    });
    console.log(`fee account (${network}):  ${publicKey}`);
    console.log(`secret written to:        ${path}   (owner-only; never printed)`);
    console.log("");
    console.log("Next:");
    console.log(`  1. Send XLM to ${publicKey}. It pays fees only; 20-30 XLM lasts thousands of settlements.`);
    console.log(`  2. Start the service with that file:  set -a && . ${path} && set +a && pnpm --filter @agentpos/facilitator start`);
    console.log("  3. Check /health: it must report the same address and funded: true.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
