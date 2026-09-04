/**
 * The wallet field is where the zero-custody guardrail meets a human with a clipboard: a public
 * key passes, a secret key is refused loudly (and never echoed back), garbage gets a hint.
 */
import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { AgentPOSError } from "@agentpos/core";
import { validateWalletAddress } from "./wallet.js";

function caught(fn: () => unknown): AgentPOSError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AgentPOSError);
    return err as AgentPOSError;
  }
  throw new Error("expected the call to throw");
}

describe("validateWalletAddress", () => {
  it("accepts a valid G... public key, trimmed", () => {
    const pub = Keypair.random().publicKey();
    expect(validateWalletAddress(`  ${pub}  `)).toBe(pub);
  });

  it("accepts a C... contract address, like siteConfigSchema does", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32));
    expect(contract.startsWith("C")).toBe(true);
    expect(validateWalletAddress(contract)).toBe(contract);
  });

  it("refuses a secret key with SECRET_IN_CONFIG and does not echo it back", () => {
    const secret = Keypair.random().secret();
    const err = caught(() => validateWalletAddress(secret));
    expect(err.code).toBe("SECRET_IN_CONFIG");
    expect(err.message).not.toContain(secret);
    expect(err.hint).not.toContain(secret);
    expect(JSON.stringify(err.toJSON())).not.toContain(secret);
    expect(err.hint).toContain("PUBLIC");
  });

  it("refuses anything that merely starts with S, even if it is not a valid seed", () => {
    expect(caught(() => validateWalletAddress("S12345")).code).toBe("SECRET_IN_CONFIG");
  });

  it("refuses garbage with CONFIG_INVALID", () => {
    const err = caught(() => validateWalletAddress("not-an-address"));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.hint).toContain("56 characters");
  });

  it("refuses a G-prefixed string with a bad checksum", () => {
    const almost = `${Keypair.random().publicKey().slice(0, 55)}A`;
    const err = caught(() => validateWalletAddress(almost));
    // Either it is coincidentally valid (astronomically unlikely) or it must be CONFIG_INVALID.
    expect(err.code).toBe("CONFIG_INVALID");
  });

  it("refuses empty and non-string input", () => {
    expect(caught(() => validateWalletAddress("")).code).toBe("CONFIG_INVALID");
    expect(caught(() => validateWalletAddress("   ")).code).toBe("CONFIG_INVALID");
    expect(caught(() => validateWalletAddress(undefined)).code).toBe("CONFIG_INVALID");
    expect(caught(() => validateWalletAddress(42)).code).toBe("CONFIG_INVALID");
  });
});
