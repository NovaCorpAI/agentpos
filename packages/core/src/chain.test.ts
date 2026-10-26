import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  assertAddressFor,
  chainFamilyOf,
  FAMILY_ADDRESS_CHECKS,
  getChainProfile,
  isCaip2,
  parseCaip2,
  registerChainProfile,
  requireChainProfile,
  resetChainProfilesForTests,
  usdcOnChain,
} from "./chain.js";
import type { ChainProfile } from "./chain.js";
import { AgentPOSError } from "./errors.js";
import { rescaleMinor, usdc } from "./money.js";

const arcTestnet: ChainProfile = {
  caip2: "eip155:5042002",
  family: "eip155",
  label: "Arc testnet",
  testnet: true,
  usdcDecimals: 6,
  isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof AgentPOSError ? err.code : "NOT_AGENTPOS_ERROR";
  }
  return undefined;
};

afterEach(() => resetChainProfilesForTests());

describe("CAIP-2", () => {
  it("accepts the ids AgentPOS uses and rejects malformed ones", () => {
    for (const id of [
      "stellar:pubnet",
      "stellar:testnet",
      "eip155:5042",
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]) {
      expect(isCaip2(id)).toBe(true);
    }
    for (const id of ["stellar", "eip155:", ":5042", "EIP155:1", "eip155:5042:extra", 42]) {
      expect(isCaip2(id)).toBe(false);
    }
    expect(parseCaip2("eip155:5042")).toEqual({ namespace: "eip155", reference: "5042" });
    expect(codeOf(() => parseCaip2("nope"))).toBe("CHAIN_UNKNOWN");
  });

  it("maps namespaces to families and leaves unknown namespaces undefined", () => {
    expect(chainFamilyOf("stellar:pubnet")).toBe("stellar");
    expect(chainFamilyOf("eip155:5042")).toBe("eip155");
    expect(chainFamilyOf("cosmos:cosmoshub-4")).toBeUndefined();
  });
});

describe("chain profiles", () => {
  it("ships Stellar with 7-decimal USDC and nothing else", () => {
    expect(requireChainProfile("stellar:pubnet").usdcDecimals).toBe(7);
    expect(requireChainProfile("stellar:testnet").testnet).toBe(true);
    expect(getChainProfile("eip155:5042002")).toBeUndefined();
    expect(codeOf(() => requireChainProfile("eip155:5042002"))).toBe("CHAIN_UNKNOWN");
  });

  it("lets a rail package register its network, once and consistently", () => {
    registerChainProfile(arcTestnet);
    registerChainProfile(arcTestnet); // idempotent
    expect(requireChainProfile("eip155:5042002").usdcDecimals).toBe(6);
    expect(codeOf(() => registerChainProfile({ ...arcTestnet, usdcDecimals: 18 }))).toBe(
      "CHAIN_UNKNOWN",
    );
    expect(codeOf(() => registerChainProfile({ ...arcTestnet, family: "solana" }))).toBe(
      "CHAIN_UNKNOWN",
    );
  });

  it("links to the public explorer for Stellar transactions", () => {
    expect(requireChainProfile("stellar:pubnet").explorerTxUrl?.("abc")).toBe(
      "https://stellar.expert/explorer/public/tx/abc",
    );
  });
});

describe("addresses", () => {
  it("validates Stellar receiving addresses", () => {
    const g = Keypair.random().publicKey();
    expect(assertAddressFor("stellar:pubnet", g)).toBe(g);
    expect(codeOf(() => assertAddressFor("stellar:pubnet", "0x" + "a".repeat(40)))).toBe(
      "ADDRESS_INVALID",
    );
    expect(codeOf(() => assertAddressFor("stellar:pubnet", Keypair.random().secret()))).toBe(
      "ADDRESS_INVALID",
    );
  });

  it("validates EVM addresses once the network is registered, and refuses the zero address", () => {
    registerChainProfile(arcTestnet);
    expect(assertAddressFor("eip155:5042002", "0x3600000000000000000000000000000000000000")).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(codeOf(() => assertAddressFor("eip155:5042002", "0x" + "0".repeat(40)))).toBe(
      "ADDRESS_INVALID",
    );
    expect(codeOf(() => assertAddressFor("eip155:5042002", "0x123"))).toBe("ADDRESS_INVALID");
  });
});

describe("money across networks", () => {
  it("rescales exactly in both directions", () => {
    expect(rescaleMinor(15_000_000n, 7, 6)).toBe(1_500_000n);
    expect(rescaleMinor(1_500_000n, 6, 7)).toBe(15_000_000n);
    expect(rescaleMinor(42n, 2, 2)).toBe(42n);
  });

  it("refuses to round: a 7th decimal cannot be charged on a 6-decimal network", () => {
    expect(codeOf(() => rescaleMinor(15_000_001n, 7, 6))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => rescaleMinor(-1n, 7, 6))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => rescaleMinor(1n, 7, 19))).toBe("INVALID_AMOUNT");
  });

  it("expresses a catalog price in the USDC unit of the target network", () => {
    registerChainProfile(arcTestnet);
    expect(usdcOnChain(usdc("1.5"), "stellar:pubnet")).toEqual({
      minor: 15_000_000n,
      currency: "USDC",
      decimals: 7,
    });
    expect(usdcOnChain(usdc("1.5"), "eip155:5042002")).toEqual({
      minor: 1_500_000n,
      currency: "USDC",
      decimals: 6,
    });
    expect(codeOf(() => usdcOnChain(usdc("1.2345678"), "eip155:5042002"))).toBe("INVALID_AMOUNT");
  });
});
