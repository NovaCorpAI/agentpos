/**
 * Human approval queue (M2). An order above the merchant's policy threshold pauses here:
 * the agent is never charged while it waits, and settlement executes exactly the snapshot the
 * merchant approved, never a quote that drifted afterwards.
 */
import type { Address, BuyerContact } from "@agentpos/core";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalLine {
  itemId: string;
  title: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
}

/**
 * Immutable description of what the merchant is being asked to approve. Its hash is what binds
 * the approval to the order: if anything changed, the approval no longer applies.
 */
export interface ApprovalSnapshot {
  cartId: string;
  lines: ApprovalLine[];
  totalMinor: string;
  asset: string;
  network: string;
  payTo: string;
  buyer?: BuyerContact | undefined;
  shipping?: Address | undefined;
  /** Why this needed approval: the policy rule that triggered it. */
  policy: { code: string; message: string; thresholdMinor?: string | undefined };
}

export interface ApprovalRequest {
  id: string;
  cartId: string;
  /** Hash of the snapshot. Settlement re-checks it (guardrail: approve exactly what was shown). */
  snapshotHash: string;
  snapshot: ApprovalSnapshot;
  status: ApprovalStatus;
  /** Free text from the merchant when rejecting, or the system reason when expiring. */
  reason?: string | undefined;
  /** Channels the merchant was notified through, for the audit trail. */
  notified: string[];
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | undefined;
}

/** Persistence boundary: the site library implements this over its local database. */
export interface ApprovalStore {
  save(request: ApprovalRequest): void;
  get(id: string): ApprovalRequest | undefined;
  getByCart(cartId: string): ApprovalRequest | undefined;
  list(options?: { status?: ApprovalStatus; limit?: number }): ApprovalRequest[];
}

/** Where the merchant gets told. Implementations must never throw into the payment path. */
export interface NotificationChannel {
  readonly name: string;
  notify(request: ApprovalRequest, links: ApprovalLinks): Promise<void>;
}

export interface ApprovalLinks {
  /** Where the agent polls the decision. */
  poll: string;
  /** Where the merchant (or their tool) posts a signed resolution. */
  resolve: string;
}
