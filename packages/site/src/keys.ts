/**
 * Local keypair fallback (SPEC 07): AES-256-GCM with a scrypt-derived key from a passphrase.
 * Stored under ~/.agentgate/keys/<name>.json. Linking an existing wallet is always preferred.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentGateError } from "@agentgate/core";

export interface EncryptedKeyFile {
  version: 1;
  publicKey: string;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; data: string };
  createdAt: string;
}

export function keysDir(): string {
  return process.env.AGENTGATE_HOME
    ? join(process.env.AGENTGATE_HOME, "keys")
    : join(homedir(), ".agentgate", "keys");
}

function derive(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1 });
}

export function encryptSecret(
  secret: string,
  passphrase: string,
  publicKey: string,
): EncryptedKeyFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    version: 1,
    publicKey,
    kdf: { name: "scrypt", salt: salt.toString("base64"), N: 2 ** 15, r: 8, p: 1 },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    },
    createdAt: new Date().toISOString(),
  };
}

export function decryptSecret(file: EncryptedKeyFile, passphrase: string): string {
  const key = derive(passphrase, Buffer.from(file.kdf.salt, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(file.cipher.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AgentGateError("INVALID_SECRET_KEY", "Wrong passphrase or corrupted key file", {
      hint: "Check the passphrase used at `agentgate init`.",
    });
  }
}

export function generateAndStoreKeypair(
  name: string,
  passphrase: string,
): { publicKey: string; path: string } {
  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  if (existsSync(path)) {
    throw new AgentGateError("CONFIG_INVALID", `Key file already exists: ${path}`, {
      hint: "Use another name or reuse the existing key.",
    });
  }
  const kp = Keypair.random();
  writeFileSync(
    path,
    JSON.stringify(encryptSecret(kp.secret(), passphrase, kp.publicKey()), null, 2),
    { mode: 0o600 },
  );
  return { publicKey: kp.publicKey(), path };
}

export function loadKeypair(name: string, passphrase: string): Keypair {
  const path = join(keysDir(), `${name}.json`);
  if (!existsSync(path))
    throw new AgentGateError("CONFIG_INVALID", `Key file not found: ${path}`, {
      hint: "Run `agentgate init` with --generate-wallet.",
    });
  const file = JSON.parse(readFileSync(path, "utf8")) as EncryptedKeyFile;
  return Keypair.fromSecret(decryptSecret(file, passphrase));
}
