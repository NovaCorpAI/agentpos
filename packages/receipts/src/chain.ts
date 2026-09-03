/**
 * The chain (M4): canonical hashing, store signature and append.
 *
 * The point of chaining is not secrecy, it is that a store cannot quietly rewrite its own past.
 * Each receipt commits to the hash of the one before it, so altering a field changes its hash and
 * orphans everything after it, and removing a link leaves a gap that verification reports.
 */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPOSError } from "@agentpos/core";
import type { Logger } from "@agentpos/core";
import { silentLogger } from "@agentpos/core";
import { GENESIS_PREV, RECEIPT_VERSION, receiptBodySchema } from "./types.js";
import type { Receipt, ReceiptBody, ReceiptBodyInput, ReceiptStore } from "./types.js";

/** Deterministic serialization: keys sorted at every depth, undefined dropped, arrays in order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function hashBody(body: ReceiptBody): string {
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

/**
 * Signed bytes. The version prefix domain-separates this signature: a receipt signature can
 * never be replayed as an agent request signature, an attestation, or anything else we sign.
 */
export function receiptPayload(hash: string): Buffer {
  return Buffer.from(`${RECEIPT_VERSION}\n${hash}`, "utf8");
}

export function signReceipt(signerSecret: string, body: ReceiptBody): Receipt {
  const keypair = Keypair.fromSecret(signerSecret);
  if (keypair.publicKey() !== body.store.signer) {
    throw new AgentPOSError("RECEIPT_SIGNATURE_INVALID", "The signing key is not the store signer", {
      hint: "body.store.signer must be the public key of the secret used to sign.",
    });
  }
  const hash = hashBody(body);
  return { body, hash, signature: keypair.sign(receiptPayload(hash)).toString("base64") };
}

/** Everything the caller supplies; seq, prev, v and signer are the chain's business, not theirs. */
export type ReceiptDraft = Omit<ReceiptBodyInput, "v" | "seq" | "prev" | "store"> & {
  store?: { name?: string; url?: string };
};

export interface ReceiptChainOptions {
  store: ReceiptStore;
  /** Ed25519 secret the store signs with. Lives on the merchant's machine; holds no funds. */
  signerSecret: string;
  storeName: string;
  storeUrl: string;
  logger?: Logger;
}

export class ReceiptChain {
  readonly signer: string;
  private readonly logger: Logger;

  constructor(private readonly opts: ReceiptChainOptions) {
    this.signer = Keypair.fromSecret(opts.signerSecret).publicKey();
    this.logger = opts.logger ?? silentLogger;
  }

  /**
   * Appends one receipt. Never throws into the caller's critical path: a store that cannot write
   * its audit log must still be able to deliver the order it was paid for. Failures are logged
   * and surfaced by verification, not by dropping a paid order on the floor.
   */
  append(draft: ReceiptDraft): Receipt | undefined {
    try {
      const previous = this.opts.store.last();
      const body = receiptBodySchema.parse({
        ...draft,
        v: RECEIPT_VERSION,
        seq: (previous?.body.seq ?? 0) + 1,
        prev: previous?.hash ?? GENESIS_PREV,
        store: { name: this.opts.storeName, url: this.opts.storeUrl, signer: this.signer },
      } satisfies ReceiptBodyInput);
      const receipt = signReceipt(this.opts.signerSecret, body);
      this.opts.store.append(receipt);
      this.logger.info("receipt.appended", {
        seq: body.seq,
        event: body.event,
        hash: receipt.hash,
        orderId: body.order?.id,
        traceId: body.traceId,
      });
      return receipt;
    } catch (err) {
      this.logger.error("receipt.append_failed", {
        event: draft.event,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  head(): Receipt | undefined {
    return this.opts.store.last();
  }

  get(hash: string): Receipt | undefined {
    return this.opts.store.get(hash);
  }

  forOrder(orderId: string): Receipt[] {
    return this.opts.store.byOrder(orderId);
  }

  list(options: { from?: string; to?: string; limit?: number } = {}): Receipt[] {
    return this.opts.store.list(options);
  }
}
