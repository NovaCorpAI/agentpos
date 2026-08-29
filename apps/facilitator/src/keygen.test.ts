/**
 * The fee account generator has one job beyond generating: never letting the secret out. These
 * tests pin that the secret reaches the file and only the file, and that a funded key cannot be
 * overwritten by accident.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import { generateFacilitatorKey } from "./keygen.js";

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-keygen-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("facilitator keygen", () => {
  it("writes a usable env file and returns only the public key", () => {
    const { dir, done } = scratch();
    try {
      const result = generateFacilitatorKey({ network: "testnet", dir });
      expect(StrKey.isValidEd25519PublicKey(result.publicKey)).toBe(true);
      expect(result).not.toHaveProperty("secret");

      const file = readFileSync(result.path, "utf8");
      expect(file).toContain(`AGENTGATE_FACILITATOR_SIGNER_PUBLIC=${result.publicKey}`);
      const secret = /AGENTGATE_FACILITATOR_SIGNER_SECRET=(S[A-Z2-7]{55})/.exec(file)?.[1];
      expect(secret).toBeDefined();
      expect(StrKey.isValidEd25519SecretSeed(secret as string)).toBe(true);
      expect(file).toContain("XLM only");
    } finally {
      done();
    }
  });

  it("refuses to overwrite an existing key unless forced", () => {
    const { dir, done } = scratch();
    try {
      const first = generateFacilitatorKey({ network: "mainnet", dir });
      expect(() => generateFacilitatorKey({ network: "mainnet", dir })).toThrow(/strand its balance/);
      const second = generateFacilitatorKey({ network: "mainnet", dir, force: true });
      expect(second.publicKey).not.toBe(first.publicKey);
    } finally {
      done();
    }
  });

  it("keeps networks apart: testnet and mainnet never share a file", () => {
    const { dir, done } = scratch();
    try {
      const t = generateFacilitatorKey({ network: "testnet", dir });
      const m = generateFacilitatorKey({ network: "mainnet", dir });
      expect(t.path).not.toBe(m.path);
      expect(t.publicKey).not.toBe(m.publicKey);
    } finally {
      done();
    }
  });
});
