/**
 * Owner attestation (M3): a signed statement that says "this agent key acts for me".
 *
 * Keys are Ed25519 in Stellar StrKey form (`G...`) because that is the format this ecosystem
 * already reads, and because a third party can verify an attestation with any Stellar SDK and
 * the format spec, without AgentPOS installed. See SPEC.md.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import { AgentPOSError } from "@agentpos/core";

export const ATTESTATION_VERSION = "agentpos-attestation-1";

const stellarKey = z.string().regex(/^G[A-Z2-7]{55}$/, "Ed25519 public key in Stellar StrKey form");

export const attestationSchema = z.object({
  v: z.literal(ATTESTATION_VERSION),
  /** The agent's own public key: what signs each request. */
  agent: stellarKey,
  /** The human or organization answering for the agent. */
  owner: stellarKey,
  /** Display name for merchant-facing surfaces. */
  name: z.string().min(1).max(120).optional(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Optional bounds the owner puts on the delegation. Merchants may narrow, never widen them. */
  scope: z
    .object({
      /** Hostnames the agent may buy from. Empty means any. */
      sites: z.array(z.string().min(1)).default([]),
      /** Ceiling per payment, in USDC. Informational for the merchant. */
      maxPerTxUsdc: z.string().regex(/^\d+(\.\d{1,7})?$/).optional(),
    })
    .default({ sites: [] }),
});

export type Attestation = z.output<typeof attestationSchema>;
export type AttestationInput = z.input<typeof attestationSchema>;

export const signedAttestationSchema = z.object({
  attestation: attestationSchema,
  /** Base64 Ed25519 signature by `attestation.owner` over the canonical attestation. */
  signature: z.string().min(1),
});

export type SignedAttestation = z.output<typeof signedAttestationSchema>;

/** Deterministic serialization: sorted keys at every depth. Identical to the approvals canonicalizer. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** What the owner signs. Prefixed so an attestation signature can never be replayed elsewhere. */
export function attestationPayload(attestation: Attestation): Buffer {
  return Buffer.from(`${ATTESTATION_VERSION}\n${canonicalize(attestation)}`, "utf8");
}

/** Signs with the owner's secret seed. Runs on the OWNER's machine, never on the merchant's. */
export function signAttestation(ownerSecret: string, input: AttestationInput): SignedAttestation {
  const attestation = attestationSchema.parse(input);
  const owner = Keypair.fromSecret(ownerSecret);
  if (owner.publicKey() !== attestation.owner) {
    throw new AgentPOSError("AGENT_ATTESTATION_INVALID", "The signing key is not the attested owner", {
      hint: "Sign with the secret of the key named in `owner`.",
    });
  }
  return { attestation, signature: owner.sign(attestationPayload(attestation)).toString("base64") };
}

export interface AttestationCheck {
  valid: boolean;
  reason?: string;
  attestation?: Attestation;
}

/**
 * Verifies an attestation on its own terms: signed by the stated owner, not expired, and (when
 * `agentKey` is given) actually about the agent making the request.
 */
export function verifyAttestation(signed: unknown, options: { agentKey?: string; now?: Date; siteHost?: string } = {}): AttestationCheck {
  const parsed = signedAttestationSchema.safeParse(signed);
  if (!parsed.success) return { valid: false, reason: "malformed attestation" };
  const { attestation, signature } = parsed.data;
  const now = options.now ?? new Date();

  let signatureOk = false;
  try {
    signatureOk = Keypair.fromPublicKey(attestation.owner).verify(attestationPayload(attestation), Buffer.from(signature, "base64"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { valid: false, reason: "signature does not match the owner key" };

  if (new Date(attestation.expiresAt).getTime() <= now.getTime()) return { valid: false, reason: "attestation expired", attestation };
  if (new Date(attestation.issuedAt).getTime() > now.getTime()) return { valid: false, reason: "attestation not yet valid", attestation };
  if (options.agentKey && attestation.agent !== options.agentKey) {
    return { valid: false, reason: "attestation is for a different agent key", attestation };
  }
  if (options.siteHost && attestation.scope.sites.length > 0 && !attestation.scope.sites.includes(options.siteHost)) {
    return { valid: false, reason: `attestation does not cover ${options.siteHost}`, attestation };
  }
  return { valid: true, attestation };
}

/** Compact transport form for the request header. */
export function encodeAttestation(signed: SignedAttestation): string {
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
}

export function decodeAttestation(encoded: string): unknown {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
