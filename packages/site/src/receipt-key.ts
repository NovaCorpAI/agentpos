/**
 * The key a store signs its receipts with (M4).
 *
 * This is NOT a payment key and must never be one: it holds no funds, receives nothing and only
 * proves that a receipt came from this store and has not been rewritten since. It lives on the
 * merchant's own machine, next to their database, and never reaches us (guardrail 1).
 *
 * Resolution order: `AGENTPOS_RECEIPT_SECRET` if set, otherwise a file in the data directory,
 * created on first use. Generating it silently is deliberate: a store that would have to read a
 * setup guide before its receipts start chaining is a store with no receipts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPOSError } from "@agentpos/core";

export const RECEIPT_KEY_FILE = "receipt-signer.json";

interface ReceiptKeyFile {
  v: 1;
  publicKey: string;
  secret: string;
  createdAt: string;
  note: string;
}

export interface ReceiptSigner {
  secret: string;
  publicKey: string;
  /** Where it came from, for `agentpos status` and the runbook. */
  source: "env" | "file";
  path?: string;
}

export function loadOrCreateReceiptSigner(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): ReceiptSigner {
  const fromEnv = env.AGENTPOS_RECEIPT_SECRET;
  if (fromEnv) {
    try {
      const kp = Keypair.fromSecret(fromEnv.trim());
      return { secret: kp.secret(), publicKey: kp.publicKey(), source: "env" };
    } catch {
      throw new AgentPOSError("INVALID_SECRET_KEY", "AGENTPOS_RECEIPT_SECRET is not a valid key", {
        hint: "It must be a Stellar secret seed (S...). Unset it to let the sidecar manage its own receipt key.",
      });
    }
  }

  const path = join(dataDir, RECEIPT_KEY_FILE);
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, "utf8")) as ReceiptKeyFile;
    const kp = Keypair.fromSecret(file.secret);
    return { secret: kp.secret(), publicKey: kp.publicKey(), source: "file", path };
  }

  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.random();
  const file: ReceiptKeyFile = {
    v: 1,
    publicKey: kp.publicKey(),
    secret: kp.secret(),
    createdAt: new Date().toISOString(),
    note: "Signs this store's receipts. Holds no funds and must never receive any. Back it up with the database: losing it means new receipts are signed by a new key, and the old chain can still be verified but no longer extended.",
  };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs do not map onto POSIX modes; the file still sits inside the data dir.
  }
  return { secret: kp.secret(), publicKey: kp.publicKey(), source: "file", path };
}
