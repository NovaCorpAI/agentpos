/**
 * Request signatures (M3). The agent signs what it is asking for, not just who it is: method,
 * path, body, timestamp and a nonce. A captured signature is therefore useless for a different
 * request, and useless twice for the same one.
 */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export const AGENT_ID_HEADER = "x-agent-id";
export const AGENT_TIMESTAMP_HEADER = "x-agent-timestamp";
export const AGENT_NONCE_HEADER = "x-agent-nonce";
export const AGENT_SIGNATURE_HEADER = "x-agent-signature";
export const AGENT_ATTESTATION_HEADER = "x-agent-attestation";

export const REQUEST_VERSION = "AGENTPOS-REQUEST-V1";
/** How far the agent's clock may be from the merchant's. */
export const REQUEST_WINDOW_SECONDS = 60;

export interface SignableRequest {
  method: string;
  /** Path with query string, exactly as sent. */
  path: string;
  /** Raw body; empty string for GET. */
  body: string;
  timestamp: string;
  nonce: string;
}

/** Canonical bytes both sides agree on. Body is hashed so large payloads stay cheap to sign. */
export function requestPayload(request: SignableRequest): Buffer {
  const bodyHash = createHash("sha256").update(request.body ?? "", "utf8").digest("hex");
  return Buffer.from(
    [REQUEST_VERSION, request.method.toUpperCase(), request.path, bodyHash, request.timestamp, request.nonce].join("\n"),
    "utf8",
  );
}

export interface SignedRequestHeaders extends Record<string, string> {
  [AGENT_ID_HEADER]: string;
  [AGENT_TIMESTAMP_HEADER]: string;
  [AGENT_NONCE_HEADER]: string;
  [AGENT_SIGNATURE_HEADER]: string;
}

/** Builds the headers an agent sends. Runs on the AGENT's machine; the secret never leaves it. */
export function signRequest(
  agentSecret: string,
  request: Omit<SignableRequest, "timestamp" | "nonce"> & { timestamp?: string; nonce?: string },
): SignedRequestHeaders {
  const keypair = Keypair.fromSecret(agentSecret);
  const timestamp = request.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = request.nonce ?? Buffer.from(Keypair.random().rawPublicKey()).subarray(0, 12).toString("base64url");
  const payload = requestPayload({ ...request, timestamp, nonce });
  return {
    [AGENT_ID_HEADER]: keypair.publicKey(),
    [AGENT_TIMESTAMP_HEADER]: timestamp,
    [AGENT_NONCE_HEADER]: nonce,
    [AGENT_SIGNATURE_HEADER]: keypair.sign(payload).toString("base64"),
  };
}

export function verifyRequestSignature(agentKey: string, request: SignableRequest, signature: string): boolean {
  try {
    return Keypair.fromPublicKey(agentKey).verify(requestPayload(request), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
