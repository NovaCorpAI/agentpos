/**
 * Proof of control of a receiving wallet (guardrail 1: link an existing wallet, public address
 * plus proof of control by signing a nonce; never custody).
 *
 * The flow is the same on every chain:
 *  1. {@link createWalletChallenge} issues a short text message with a random nonce and an
 *     expiry, bound to one address on one network and to the store's domain.
 *  2. The merchant signs that text in their own wallet (Freighter, MetaMask...). AgentPOS never
 *     sees a key.
 *  3. {@link verifyWalletProof} checks expiry, binding and the signature with the verifier for
 *     that chain family.
 *
 * Stellar's verifier ships here (SEP-53 message signing, ed25519). Other families register
 * theirs from their rail package with {@link registerWalletProofVerifier} (for EVM, an
 * EIP-191 `personal_sign` verifier that also understands ERC-1271 smart accounts), so the core
 * stays free of chain-specific crypto libraries.
 */
import { createHash, randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { AgentPOSError } from "./errors.js";
import type { ChainFamily } from "./chain.js";
import { assertAddressFor, requireChainProfile } from "./chain.js";

/** A challenge the merchant signs. Store it server-side until it is verified or expires. */
export interface WalletChallenge {
  readonly caip2: string;
  readonly address: string;
  readonly domain: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Exact text to sign. Verification rebuilds it from the fields above, never trusts a copy. */
  readonly message: string;
}

export interface CreateWalletChallengeInput {
  caip2: string;
  address: string;
  /** The store's domain, e.g. "demo.agentposhq.com". Binds the signature to this store. */
  domain: string;
  /** Seconds the challenge stays signable. Default 600, max 3600. */
  ttlSeconds?: number;
  /** Tests only. */
  now?: Date;
  /** Tests only. */
  nonce?: string;
}

const DOMAIN_RE = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const DEFAULT_TTL = 600;
const MAX_TTL = 3600;

/** Builds the text the wallet shows and signs. Plain, human-readable, chain-neutral. */
export function walletChallengeMessage(c: Omit<WalletChallenge, "message">): string {
  return [
    `${c.domain} asks you to prove that you control this wallet to receive payments with AgentPOS.`,
    "This signature moves no funds and grants no permissions.",
    "",
    `Address: ${c.address}`,
    `Network: ${c.caip2}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expiresAt}`,
  ].join("\n");
}

export function createWalletChallenge(input: CreateWalletChallengeInput): WalletChallenge {
  assertAddressFor(input.caip2, input.address);
  const domain = input.domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid store domain: '${input.domain}'`, {
      hint: "Pass the bare host the store is served from, e.g. 'shop.example.com'.",
      details: { domain: input.domain },
    });
  }
  const ttl = input.ttlSeconds ?? DEFAULT_TTL;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL) {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid challenge lifetime: ${ttl}s`, {
      hint: `Use a whole number of seconds between 1 and ${MAX_TTL}.`,
      details: { ttlSeconds: ttl },
    });
  }
  const now = input.now ?? new Date();
  const fields = {
    caip2: input.caip2,
    address: input.address,
    domain,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
  return { ...fields, message: walletChallengeMessage(fields) };
}

/**
 * Checks a signature over `message` by `address`. Returns false for a wrong signature; throws
 * only for inputs it cannot interpret. Async because some families need a network call
 * (ERC-1271 smart accounts ask the contract).
 */
export type WalletProofVerifier = (input: {
  caip2: string;
  address: string;
  message: string;
  signature: string;
}) => Promise<boolean>;

/** SEP-53: ed25519 over SHA-256("Stellar Signed Message:\n" + message), signature in base64. */
export const verifyStellarMessageSignature: WalletProofVerifier = async ({
  address,
  message,
  signature,
}) => {
  if (!StrKey.isValidEd25519PublicKey(address)) return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("Stellar Signed Message:\n", "utf8"),
        Buffer.from(message, "utf8"),
      ]),
    )
    .digest();
  return Keypair.fromPublicKey(address).verify(digest, sig);
};

const verifiers = new Map<ChainFamily, WalletProofVerifier>([
  ["stellar", verifyStellarMessageSignature],
]);

/** Adds (or replaces) the verifier for a chain family. Called by rail packages at import. */
export function registerWalletProofVerifier(
  family: ChainFamily,
  verifier: WalletProofVerifier,
): void {
  verifiers.set(family, verifier);
}

export interface WalletProofResult {
  readonly caip2: string;
  readonly address: string;
  readonly verifiedAt: string;
}

/**
 * Verifies a signed challenge. Every failure is typed so a merchant UI can say exactly what to
 * do; nothing here is retryable with the same challenge except an unavailable verifier.
 */
export async function verifyWalletProof(
  challenge: WalletChallenge,
  signature: string,
  options: { now?: Date } = {},
): Promise<WalletProofResult> {
  const now = options.now ?? new Date();
  const expected = walletChallengeMessage(challenge);
  if (challenge.message !== expected) {
    throw new AgentPOSError("WALLET_PROOF_INVALID", "The challenge was modified", {
      hint: "Request a new challenge and sign it unchanged.",
    });
  }
  if (now.getTime() > Date.parse(challenge.expiresAt)) {
    throw new AgentPOSError("WALLET_PROOF_EXPIRED", "The challenge expired before it was signed", {
      hint: "Request a new challenge and sign it within its lifetime.",
      details: { expiresAt: challenge.expiresAt },
    });
  }
  const profile = requireChainProfile(challenge.caip2);
  const verifier = verifiers.get(profile.family);
  if (!verifier) {
    throw new AgentPOSError(
      "SIGNER_NOT_IMPLEMENTED",
      `No wallet-proof verifier for ${profile.label}`,
      {
        hint: "Import the rail package for this network; it registers its verifier.",
        details: { caip2: challenge.caip2, family: profile.family },
      },
    );
  }
  const ok = await verifier({
    caip2: challenge.caip2,
    address: challenge.address,
    message: challenge.message,
    signature,
  });
  if (!ok) {
    throw new AgentPOSError("WALLET_PROOF_INVALID", "The signature does not match this wallet", {
      hint: "Sign the challenge text with the same wallet whose address you entered.",
      details: { caip2: challenge.caip2, address: challenge.address },
    });
  }
  return { caip2: challenge.caip2, address: challenge.address, verifiedAt: now.toISOString() };
}
