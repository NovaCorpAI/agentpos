/**
 * The snapshot hash is what makes an approval mean something: the merchant approves a specific
 * cart, at specific prices, to a specific address. If any of that drifts, the approval is void
 * and the agent must re-quote. Canonical JSON so the same content always hashes the same.
 */
import { createHash } from "node:crypto";
import type { ApprovalSnapshot } from "./types.js";

/** Deterministic serialization: object keys sorted at every depth, arrays kept in order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function hashSnapshot(snapshot: ApprovalSnapshot): string {
  return createHash("sha256").update(canonicalize(snapshot)).digest("hex");
}
