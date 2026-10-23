import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createWalletChallenge,
  registerWalletProofVerifier,
  verifyStellarMessageSignature,
  verifyWalletProof,
} from "./wallet-proof.js";
import type { WalletChallenge } from "./wallet-proof.js";
import {
  FAMILY_ADDRESS_CHECKS,
  registerChainProfile,
  resetChainProfilesForTests,
} from "./chain.js";
import { AgentPOSError } from "./errors.js";

/** What a SEP-53 wallet (Freighter signMessage) produces. */
function sep53Sign(kp: Keypair, message: string): string {
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message)]))
    .digest();
  return kp.sign(digest).toString("base64");
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof AgentPOSError ? err.code : "NOT_AGENTPOS_ERROR";
  }
  return undefined;
}

const now = new Date("2026-10-23T12:00:00.000Z");

afterEach(() => resetChainProfilesForTests());

describe("wallet challenge", () => {
  it("binds address, network, store and a nonce, with an expiry", () => {
    const kp = Keypair.random();
    const c = createWalletChallenge({
      caip2: "stellar:pubnet",
      address: kp.publicKey(),
      domain: "Demo.AgentPOSHQ.com",
      now,
      nonce: "n1",
    });
    expect(c.domain).toBe("demo.agentposhq.com");
    expect(c.expiresAt).toBe("2026-10-23T12:10:00.000Z");
    expect(c.message).toContain(`Address: ${kp.publicKey()}`);
    expect(c.message).toContain("Network: stellar:pubnet");
    expect(c.message).toContain("moves no funds");
  });

  it("refuses an invalid address, domain or lifetime before anything is signed", () => {
    const g = Keypair.random().publicKey();
    expect(() =>
      createWalletChallenge({ caip2: "stellar:pubnet", address: "nope", domain: "a.com" }),
    ).toThrow(AgentPOSError);
    expect(() =>
      createWalletChallenge({ caip2: "stellar:pubnet", address: g, domain: "bad domain" }),
    ).toThrow(AgentPOSError);
    expect(() =>
      createWalletChallenge({
        caip2: "stellar:pubnet",
        address: g,
        domain: "a.com",
        ttlSeconds: 99_999,
      }),
    ).toThrow(AgentPOSError);
  });
});

describe("Stellar proof of control (SEP-53)", () => {
  const kp = Keypair.random();
  const challenge = (): WalletChallenge =>
    createWalletChallenge({
      caip2: "stellar:pubnet",
      address: kp.publicKey(),
      domain: "shop.cl",
      now,
    });

  it("accepts the wallet's own signature", async () => {
    const c = challenge();
    const result = await verifyWalletProof(c, sep53Sign(kp, c.message), { now });
    expect(result.address).toBe(kp.publicKey());
  });

  it("rejects another wallet's signature", async () => {
    const c = challenge();
    expect(
      await codeOf(verifyWalletProof(c, sep53Sign(Keypair.random(), c.message), { now })),
    ).toBe("WALLET_PROOF_INVALID");
  });

  it("rejects a signature over a modified challenge", async () => {
    const c = challenge();
    const tampered = { ...c, address: Keypair.random().publicKey() };
    expect(await codeOf(verifyWalletProof(tampered, sep53Sign(kp, c.message), { now }))).toBe(
      "WALLET_PROOF_INVALID",
    );
  });

  it("rejects an expired challenge even with a valid signature", async () => {
    const c = challenge();
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    expect(await codeOf(verifyWalletProof(c, sep53Sign(kp, c.message), { now: later }))).toBe(
      "WALLET_PROOF_EXPIRED",
    );
  });

  it("returns false, not throws, for garbage signatures", async () => {
    expect(
      await verifyStellarMessageSignature({
        caip2: "stellar:pubnet",
        address: kp.publicKey(),
        message: "x",
        signature: "AAAA",
      }),
    ).toBe(false);
  });
});

describe("other chain families", () => {
  const evm = "0x1111111111111111111111111111111111111111";

  it("asks for the rail package when no verifier is registered", async () => {
    registerChainProfile({
      caip2: "eip155:84532",
      family: "eip155",
      label: "Base Sepolia",
      testnet: true,
      usdcDecimals: 6,
      isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
    });
    const c = createWalletChallenge({
      caip2: "eip155:84532",
      address: evm,
      domain: "shop.cl",
      now,
    });
    expect(await codeOf(verifyWalletProof(c, "0xsig", { now }))).toBe("SIGNER_NOT_IMPLEMENTED");
  });

  it("uses a verifier a rail package registers", async () => {
    registerChainProfile({
      caip2: "eip155:84532",
      family: "eip155",
      label: "Base Sepolia",
      testnet: true,
      usdcDecimals: 6,
      isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
    });
    registerWalletProofVerifier("eip155", async ({ signature }) => signature === "0xgood");
    const c = createWalletChallenge({
      caip2: "eip155:84532",
      address: evm,
      domain: "shop.cl",
      now,
    });
    expect((await verifyWalletProof(c, "0xgood", { now })).address).toBe(evm);
    expect(await codeOf(verifyWalletProof(c, "0xbad", { now }))).toBe("WALLET_PROOF_INVALID");
  });
});
