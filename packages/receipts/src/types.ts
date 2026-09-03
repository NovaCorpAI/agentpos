/**
 * Receipt format (M4). A receipt states what the store offered, what its policy said, who
 * approved, who bought and what settled on chain, and it is chained to the one before it.
 *
 * Design rules that the rest of the package depends on:
 *  - Money stays a decimal *string* in minor units. A receipt is JSON that travels; bigints do
 *    not survive that trip, and floats would quietly lose the last cents.
 *  - The body is the only thing signed. Hash and signature live outside it, so a verifier can
 *    recompute the hash from the body it was handed.
 *  - Negative events are receipts too. What did NOT happen is evidence: a denied policy, an
 *    expired approval, a payment refused for mismatched terms.
 */
import { z } from "zod";

export const RECEIPT_VERSION = "agentpos-receipt-1";

/** First link of a chain points here, so "no previous receipt" is stated rather than implied. */
export const GENESIS_PREV = "genesis";

export const RECEIPT_EVENTS = [
  "order.settled",
  "order.held",
  "order.failed",
  "policy.denied",
  "approval.requested",
  "approval.resolved",
] as const;
export type ReceiptEvent = (typeof RECEIPT_EVENTS)[number];

const minorString = z.string().regex(/^\d+$/, "amounts are integers in minor units");
const stellarKey = z.string().regex(/^[GC][A-Z2-7]{55}$/);

export const receiptTermsSchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        title: z.string(),
        quantity: z.number().int().positive(),
        unitPriceMinor: minorString,
        lineTotalMinor: minorString,
      }),
    )
    .min(1),
  totalMinor: minorString,
  payTo: stellarKey,
  network: z.string().min(1),
  asset: z.string().min(1),
  assetAddress: z.string().min(1),
});

export const receiptBodySchema = z.object({
  v: z.literal(RECEIPT_VERSION),
  /** 1-based position in this store's chain. A gap is a deleted link. */
  seq: z.number().int().positive(),
  /** Hash of the previous receipt, or GENESIS_PREV for the first. */
  prev: z.string().min(1),
  event: z.enum(RECEIPT_EVENTS),
  at: z.iso.datetime(),
  store: z.object({
    name: z.string().min(1),
    url: z.string().min(1),
    /** Public key the store signs receipts with. Never a payment key. */
    signer: stellarKey,
  }),
  /** The cart a receipt is about, when there is no order yet (a refusal, a pending approval). */
  cart: z.object({ id: z.string().min(1) }).optional(),
  order: z
    .object({
      id: z.string().min(1),
      cartId: z.string().min(1),
      status: z.string().min(1),
      externalOrderId: z.string().optional(),
    })
    .optional(),
  /** Exactly what the 402 offered: the terms the buyer agreed to. */
  terms: receiptTermsSchema.optional(),
  policy: z
    .object({
      decision: z.enum(["allowed", "requires_approval", "denied"]),
      code: z.string().optional(),
      message: z.string().optional(),
      evaluatedAt: z.iso.datetime(),
    })
    .optional(),
  approval: z
    .object({
      id: z.string().min(1),
      status: z.enum(["pending", "approved", "rejected", "expired"]),
      snapshotHash: z.string().min(1),
      resolvedAt: z.iso.datetime().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  agent: z
    .object({
      authenticated: z.boolean(),
      attested: z.boolean(),
      agentKey: stellarKey.optional(),
      owner: stellarKey.optional(),
      name: z.string().optional(),
    })
    .optional(),
  payment: z
    .object({
      txHash: z.string().min(1),
      network: z.string().min(1),
      asset: z.string().min(1),
      amountMinor: minorString,
      payer: z.string().optional(),
      ts: z.iso.datetime(),
    })
    .optional(),
  /** Why an order is held or a payment refused: the discrepancy, in full. */
  discrepancy: z.record(z.string(), z.unknown()).optional(),
  adapterVersion: z.string().min(1),
  traceId: z.string().optional(),
});

export const receiptSchema = z.object({
  body: receiptBodySchema,
  /** sha256 of the canonical body, lowercase hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** base64 Ed25519 signature by body.store.signer. */
  signature: z.string().min(1),
});

export type ReceiptTerms = z.output<typeof receiptTermsSchema>;
export type ReceiptBody = z.output<typeof receiptBodySchema>;
export type ReceiptBodyInput = z.input<typeof receiptBodySchema>;
export type Receipt = z.output<typeof receiptSchema>;

/** What the chain persists. Append-only by contract; the storage adapter must not update. */
export interface ReceiptStore {
  append(receipt: Receipt): void;
  last(): Receipt | undefined;
  get(hash: string): Receipt | undefined;
  /** Ascending by seq. `from`/`to` filter on body.at. */
  list(options?: { from?: string; to?: string; limit?: number }): Receipt[];
  byOrder(orderId: string): Receipt[];
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts: Receipt[] = [];
  append(receipt: Receipt): void {
    this.receipts.push(receipt);
  }
  last(): Receipt | undefined {
    return this.receipts[this.receipts.length - 1];
  }
  get(hash: string): Receipt | undefined {
    return this.receipts.find((r) => r.hash === hash);
  }
  list(options: { from?: string; to?: string; limit?: number } = {}): Receipt[] {
    return this.receipts
      .filter((r) => (!options.from || r.body.at >= options.from) && (!options.to || r.body.at <= options.to))
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
  }
  byOrder(orderId: string): Receipt[] {
    return this.receipts.filter((r) => r.body.order?.id === orderId);
  }
}
