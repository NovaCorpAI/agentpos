/**
 * Signer factory (SPEC 07). No package instantiates signers directly.
 * Zero custody (guardrail 1): keys never leave the user's machine or wallet.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import type { ClientStellarSigner } from "@x402/stellar";
import { AgentPOSError } from "./errors.js";
import type { NetworkName } from "./config.js";
import { CAIP2 } from "./config.js";

export type SignerKind = "local-keypair" | "wallets-kit" | "passkey";

export interface SignerProvider extends ClientStellarSigner {
  readonly kind: SignerKind;
  readonly network: NetworkName;
}

export type SignerConfig =
  | { kind: "local-keypair"; secretKey: string; network: NetworkName }
  | { kind: "wallets-kit"; network: NetworkName }
  | { kind: "passkey"; network: NetworkName };

export function createLocalKeypairSigner(secretKey: string, network: NetworkName): SignerProvider {
  try {
    Keypair.fromSecret(secretKey);
  } catch (cause) {
    throw new AgentPOSError("INVALID_SECRET_KEY", "Secret key is not a valid Stellar seed", {
      hint: "Expected an 'S...' 56-character seed. Generate one with `Keypair.random()` or use a wallet instead.",
      cause,
    });
  }
  const inner = createEd25519Signer(secretKey, CAIP2[network]);
  return {
    kind: "local-keypair",
    network,
    address: inner.address,
    signAuthEntry: inner.signAuthEntry,
    signTransaction: inner.signTransaction,
  };
}

export function createSigner(config: SignerConfig): SignerProvider {
  switch (config.kind) {
    case "local-keypair":
      return createLocalKeypairSigner(config.secretKey, config.network);
    case "wallets-kit":
      throw new AgentPOSError(
        "SIGNER_NOT_IMPLEMENTED",
        "WalletsKitSigner lands in Phase 2 (SPEC 07)",
        {
          hint: "Browser-only signer via @creit.tech/stellar-wallets-kit; use local-keypair for headless flows.",
        },
      );
    case "passkey":
      throw new AgentPOSError("SIGNER_NOT_IMPLEMENTED", "PasskeySigner is a Build-phase slot", {
        hint: "Planned; not available yet.",
      });
  }
}
