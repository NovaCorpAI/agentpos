/**
 * Agent registry and replay guard (M3).
 *
 * The registry is deliberately thin: a public key, who vouches for it, and whether it is still
 * allowed. No documents, no personal data. Revocation is a local write checked on every request,
 * so it takes effect on the next call rather than on a cache expiry.
 */
import type { Attestation, SignedAttestation } from "./attestation.js";

export const AGENT_STATUSES = ["active", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface AgentRecord {
  /** Ed25519 public key in Stellar StrKey form; the identifier of the agent. */
  agentKey: string;
  owner: string;
  name?: string | undefined;
  status: AgentStatus;
  attestation?: SignedAttestation | undefined;
  registeredAt: string;
  revokedAt?: string | undefined;
  revokedReason?: string | undefined;
  /** Free-form notes the merchant keeps about this agent. */
  metadata?: Record<string, string> | undefined;
}

export interface AgentStore {
  save(record: AgentRecord): void;
  get(agentKey: string): AgentRecord | undefined;
  list(options?: { status?: AgentStatus; limit?: number }): AgentRecord[];
}

export class MemoryAgentStore implements AgentStore {
  private readonly byKey = new Map<string, AgentRecord>();
  save(record: AgentRecord): void {
    this.byKey.set(record.agentKey, record);
  }
  get(agentKey: string): AgentRecord | undefined {
    return this.byKey.get(agentKey);
  }
  list(options: { status?: AgentStatus; limit?: number } = {}): AgentRecord[] {
    return [...this.byKey.values()]
      .filter((r) => !options.status || r.status === options.status)
      .sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1))
      .slice(0, options.limit ?? 200);
  }
}

/**
 * Anti-replay: a nonce may be spent once inside the signature window. Entries are dropped once
 * the window passes, so memory stays bounded by traffic in the last minute rather than by
 * traffic ever seen.
 */
export interface NonceStore {
  /** Returns false when the nonce was already spent. */
  useOnce(nonce: string, expiresAt: Date): boolean;
  sweep(now?: Date): number;
}

export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  useOnce(nonce: string, expiresAt: Date): boolean {
    const now = Date.now();
    const existing = this.seen.get(nonce);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(nonce, expiresAt.getTime());
    if (this.seen.size > 10_000) this.sweep();
    return true;
  }

  sweep(now: Date = new Date()): number {
    let dropped = 0;
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now.getTime()) {
        this.seen.delete(nonce);
        dropped += 1;
      }
    }
    return dropped;
  }
}

export function recordFromAttestation(signed: SignedAttestation, attestation: Attestation, now: Date = new Date()): AgentRecord {
  return {
    agentKey: attestation.agent,
    owner: attestation.owner,
    ...(attestation.name !== undefined ? { name: attestation.name } : {}),
    status: "active",
    attestation: signed,
    registeredAt: now.toISOString(),
  };
}
