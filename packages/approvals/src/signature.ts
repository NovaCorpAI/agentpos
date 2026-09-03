/**
 * Resolutions are signed with the merchant's shared secret (registered at onboarding).
 * Without a valid signature the sidecar answers 401: an approval is the merchant's word, and
 * nothing else may speak it. Timestamped and compared in constant time to resist replay.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AgentPOSError } from "@agentpos/core";

export const SIGNATURE_HEADER = "x-agentpos-signature";
export const TIMESTAMP_HEADER = "x-agentpos-timestamp";
/** How far a signed resolution may be from the server clock. */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** Canonical payload: timestamp, approval id and decision. Changing any of them breaks the signature. */
export function signaturePayload(timestamp: string, approvalId: string, decision: string): string {
  return `${timestamp}.${approvalId}.${decision}`;
}

export function signResolution(
  secret: string,
  timestamp: string,
  approvalId: string,
  decision: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(signaturePayload(timestamp, approvalId, decision))
    .digest("hex")}`;
}

export interface VerifyInput {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  approvalId: string;
  decision: string;
  now?: Date;
}

/** Throws a typed 401-shaped error when the signature is missing, stale or wrong. */
export function assertValidResolutionSignature(input: VerifyInput): void {
  const fail = (message: string, hint: string): never => {
    throw new AgentPOSError("APPROVAL_UNAUTHORIZED", message, { hint });
  };
  if (!input.signature || !input.timestamp) {
    fail(
      "Missing resolution signature",
      `Send ${TIMESTAMP_HEADER} and ${SIGNATURE_HEADER} signed with the merchant secret.`,
    );
  }
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) fail("Invalid timestamp", `${TIMESTAMP_HEADER} must be unix seconds.`);
  const skew = Math.abs((input.now ?? new Date()).getTime() / 1000 - ts);
  if (skew > SIGNATURE_WINDOW_SECONDS) {
    fail(
      "Resolution signature expired",
      `Signatures are valid for ${SIGNATURE_WINDOW_SECONDS}s; re-sign with the current time.`,
    );
  }
  const expected = signResolution(
    input.secret,
    input.timestamp as string,
    input.approvalId,
    input.decision,
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    fail(
      "Invalid resolution signature",
      "Sign `${timestamp}.${approvalId}.${decision}` with HMAC-SHA256 and the merchant secret.",
    );
  }
}
