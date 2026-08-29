/**
 * Know Your Agent (M3): the merchant decides how much it needs to know about who is buying.
 *
 *  - `open`          nothing is required; an anonymous wallet can pay, as today.
 *  - `identified`    identity is optional, but a signature that IS sent must be valid and is
 *                    recorded on the order. Half-truths are worse than no truth.
 *  - `verified-only` only agents with a valid, unrevoked owner attestation may buy.
 *
 * A signature is always verified when present, in every mode. The mode decides what happens
 * when identity is absent, never whether a bad signature is tolerated.
 */
import { AgentGateError } from "@agentgate/core";
import type { Logger } from "@agentgate/core";
import { silentLogger } from "@agentgate/core";
import { decodeAttestation, verifyAttestation } from "./attestation.js";
import type { SignedAttestation } from "./attestation.js";
import {
  AGENT_ATTESTATION_HEADER,
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  REQUEST_WINDOW_SECONDS,
  verifyRequestSignature,
} from "./request.js";
import type { SignableRequest } from "./request.js";
import { MemoryAgentStore, MemoryNonceStore, recordFromAttestation } from "./registry.js";
import type { AgentRecord, AgentStatus, AgentStore, NonceStore } from "./registry.js";

export const IDENTITY_MODES = ["open", "identified", "verified-only"] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

/** What gets recorded on the order. `anonymous` is a legitimate outcome in open/identified mode. */
export interface AgentIdentity {
  authenticated: boolean;
  agentKey?: string | undefined;
  owner?: string | undefined;
  name?: string | undefined;
  attested: boolean;
  verifiedAt?: string | undefined;
}

export const ANONYMOUS: AgentIdentity = { authenticated: false, attested: false };

export interface IdentityServiceOptions {
  mode?: IdentityMode;
  agents?: AgentStore;
  nonces?: NonceStore;
  /** Hostname used to check attestation scope. */
  siteHost?: string | undefined;
  logger?: Logger;
  /** Register an agent automatically the first time it presents a valid attestation. */
  autoRegister?: boolean;
}

export type HeaderLookup = (name: string) => string | undefined | null;

export class IdentityService {
  readonly mode: IdentityMode;
  readonly agents: AgentStore;
  private readonly nonces: NonceStore;
  private readonly logger: Logger;

  constructor(private readonly opts: IdentityServiceOptions = {}) {
    this.mode = opts.mode ?? "open";
    this.agents = opts.agents ?? new MemoryAgentStore();
    this.nonces = opts.nonces ?? new MemoryNonceStore();
    this.logger = opts.logger ?? silentLogger;
  }

  /**
   * Authenticates one request. Throws a typed error the agent can act on; returns the identity
   * to record on the order otherwise.
   */
  authenticate(headers: HeaderLookup, request: Omit<SignableRequest, "timestamp" | "nonce">, now: Date = new Date()): AgentIdentity {
    const agentKey = headers(AGENT_ID_HEADER) ?? undefined;
    const signature = headers(AGENT_SIGNATURE_HEADER) ?? undefined;
    const timestamp = headers(AGENT_TIMESTAMP_HEADER) ?? undefined;
    const nonce = headers(AGENT_NONCE_HEADER) ?? undefined;
    const attestationHeader = headers(AGENT_ATTESTATION_HEADER) ?? undefined;

    if (!agentKey && !signature) {
      if (this.mode === "verified-only") {
        throw new AgentGateError("AGENT_IDENTITY_REQUIRED", "This store only sells to identified agents", {
          hint: `Sign the request with your agent key and send ${AGENT_ID_HEADER}, ${AGENT_TIMESTAMP_HEADER}, ${AGENT_NONCE_HEADER} and ${AGENT_SIGNATURE_HEADER}, plus ${AGENT_ATTESTATION_HEADER} with an owner attestation.`,
          details: { mode: this.mode },
        });
      }
      return ANONYMOUS;
    }

    // From here identity was offered, so it must hold up, whatever the mode.
    if (!agentKey || !signature || !timestamp || !nonce) {
      throw new AgentGateError("AGENT_SIGNATURE_INVALID", "Incomplete agent signature headers", {
        hint: `Send all of ${AGENT_ID_HEADER}, ${AGENT_TIMESTAMP_HEADER}, ${AGENT_NONCE_HEADER} and ${AGENT_SIGNATURE_HEADER}.`,
      });
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > REQUEST_WINDOW_SECONDS) {
      throw new AgentGateError("AGENT_TIMESTAMP_OUT_OF_WINDOW", "Agent signature timestamp is outside the accepted window", {
        hint: `Signatures are valid for ${REQUEST_WINDOW_SECONDS}s; check your clock and re-sign.`,
        details: { windowSeconds: REQUEST_WINDOW_SECONDS },
      });
    }
    if (!verifyRequestSignature(agentKey, { ...request, timestamp, nonce }, signature)) {
      throw new AgentGateError("AGENT_SIGNATURE_INVALID", "Agent signature does not match this request", {
        hint: "Sign method, path, body hash, timestamp and nonce with your agent key (see the identity SPEC).",
      });
    }
    // Nonce is spent only after the signature checks out, so noise cannot exhaust the store.
    if (!this.nonces.useOnce(`${agentKey}:${nonce}`, new Date(now.getTime() + REQUEST_WINDOW_SECONDS * 1000))) {
      throw new AgentGateError("AGENT_NONCE_REUSED", "This signature was already used", {
        hint: "Use a fresh nonce for every request; replays are refused.",
      });
    }

    const record = this.agents.get(agentKey);
    if (record?.status === "revoked") {
      throw new AgentGateError("AGENT_REVOKED", "This agent key was revoked", {
        hint: record.revokedReason ?? "Ask the merchant to register the agent again.",
        details: { agentKey, revokedAt: record.revokedAt },
      });
    }

    const attested = this.checkAttestation(agentKey, attestationHeader, record, now);
    if (this.mode === "verified-only" && !attested.ok) {
      throw new AgentGateError("AGENT_ATTESTATION_INVALID", `This store only sells to attested agents: ${attested.reason}`, {
        hint: `Send ${AGENT_ATTESTATION_HEADER} with an owner attestation for this key, or ask the merchant to register it.`,
        details: { agentKey, reason: attested.reason },
      });
    }

    const identity: AgentIdentity = {
      authenticated: true,
      agentKey,
      owner: attested.owner ?? record?.owner,
      name: attested.name ?? record?.name,
      attested: attested.ok,
      verifiedAt: now.toISOString(),
    };
    this.logger.info("agent.authenticated", { agentKey, attested: identity.attested, owner: identity.owner, mode: this.mode });
    return identity;
  }

  private checkAttestation(
    agentKey: string,
    header: string | undefined,
    record: AgentRecord | undefined,
    now: Date,
  ): { ok: boolean; reason?: string; owner?: string; name?: string } {
    // A registered agent carries its attestation with it; the header is for first contact.
    const candidate = header ? decodeAttestation(header) : record?.attestation;
    if (!candidate) return { ok: false, reason: "no attestation presented" };
    const check = verifyAttestation(candidate, { agentKey, now, ...(this.opts.siteHost ? { siteHost: this.opts.siteHost } : {}) });
    if (!check.valid || !check.attestation) return { ok: false, ...(check.reason ? { reason: check.reason } : {}) };

    if (this.opts.autoRegister !== false && !record) {
      this.agents.save(recordFromAttestation(candidate as SignedAttestation, check.attestation, now));
      this.logger.info("agent.registered", { agentKey, owner: check.attestation.owner });
    }
    return {
      ok: true,
      owner: check.attestation.owner,
      ...(check.attestation.name !== undefined ? { name: check.attestation.name } : {}),
    };
  }

  /**
   * Re-checks an identity established earlier (at cart time) against the registry as it stands
   * now. Used at payment time so a revocation between quoting and paying still bites, without
   * demanding a second signature: an x402 client replays its request to attach the payment, and
   * a replayed signature would (correctly) be refused as a reused nonce.
   */
  recheck(identity: AgentIdentity | undefined): void {
    if (!identity?.agentKey) {
      if (this.mode === "verified-only") {
        throw new AgentGateError("AGENT_IDENTITY_REQUIRED", "This store only sells to identified agents", {
          hint: "Create the cart with a signed request; the identity established there is carried to payment.",
          details: { mode: this.mode },
        });
      }
      return;
    }
    const record = this.agents.get(identity.agentKey);
    if (record?.status === "revoked") {
      throw new AgentGateError("AGENT_REVOKED", "This agent key was revoked", {
        hint: record.revokedReason ?? "The cart was quoted before the key was revoked; ask the merchant to register it again.",
        details: { agentKey: identity.agentKey, revokedAt: record.revokedAt },
      });
    }
    if (this.mode === "verified-only" && !identity.attested) {
      throw new AgentGateError("AGENT_ATTESTATION_INVALID", "This store only sells to attested agents", {
        hint: "Create the cart presenting an owner attestation for this key.",
        details: { agentKey: identity.agentKey },
      });
    }
  }

  /** Merchant-side registry management. */
  register(signed: SignedAttestation, metadata?: Record<string, string>, now: Date = new Date()): AgentRecord {
    const check = verifyAttestation(signed, { now });
    if (!check.valid || !check.attestation) {
      throw new AgentGateError("AGENT_ATTESTATION_INVALID", `Cannot register: ${check.reason ?? "invalid attestation"}`, {
        hint: "The owner must sign the attestation with the key named in `owner`.",
      });
    }
    const record: AgentRecord = {
      ...recordFromAttestation(signed, check.attestation, now),
      ...(metadata ? { metadata } : {}),
    };
    this.agents.save(record);
    this.logger.info("agent.registered", { agentKey: record.agentKey, owner: record.owner });
    return record;
  }

  /** Takes effect on the next request: the registry is read on every authentication. */
  revoke(agentKey: string, reason?: string, now: Date = new Date()): AgentRecord {
    const record = this.agents.get(agentKey);
    if (!record) {
      throw new AgentGateError("AGENT_NOT_FOUND", `Unknown agent '${agentKey}'`, { hint: "List registered agents with `agentgate agents list`." });
    }
    const revoked: AgentRecord = {
      ...record,
      status: "revoked",
      revokedAt: now.toISOString(),
      ...(reason !== undefined ? { revokedReason: reason } : {}),
    };
    this.agents.save(revoked);
    this.logger.info("agent.revoked", { agentKey, reason });
    return revoked;
  }

  list(options: { status?: AgentStatus; limit?: number } = {}): AgentRecord[] {
    return this.agents.list(options);
  }

  sweepNonces(now?: Date): number {
    return this.nonces.sweep(now);
  }
}
