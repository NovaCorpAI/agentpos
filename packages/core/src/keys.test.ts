/**
 * The encrypted key file of a buyer or a seller: it has to open with the right passphrase on
 * the Node versions we support, and with nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret, encryptSecret, generateAndStoreKeypair, loadKeypair } from "./keys.js";

describe("encrypted key files", () => {
  let home: string;
  const previous = process.env.AGENTPOS_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-keys-"));
    process.env.AGENTPOS_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AGENTPOS_HOME;
    else process.env.AGENTPOS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("stores a new key and opens it again with the passphrase", () => {
    const { publicKey } = generateAndStoreKeypair("buyer", "correct horse battery staple");
    expect(loadKeypair("buyer", "correct horse battery staple").publicKey()).toBe(publicKey);
  });

  it("does not open with another passphrase", () => {
    generateAndStoreKeypair("buyer", "correct horse battery staple");
    expect(() => loadKeypair("buyer", "wrong passphrase")).toThrow();
  });

  it("keeps the derivation parameters a key file already written depends on", () => {
    const keypair = Keypair.random();
    const file = encryptSecret(keypair.secret(), "passphrase", keypair.publicKey());
    expect(file.kdf).toMatchObject({ name: "scrypt", N: 2 ** 15, r: 8, p: 1 });
    expect(decryptSecret(file, "passphrase")).toBe(keypair.secret());
  });
});
