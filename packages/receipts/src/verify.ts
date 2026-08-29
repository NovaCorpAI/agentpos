/**
 * Standalone verification (M4). Nothing here touches the merchant's database: a third party
 * holding only the JSON can check it, which is the whole point of a receipt.
 *
 * Verification is deliberately split in two:
 *  - `verifyReceipt` / `verifyChain` are offline and total: schema, hash, signature, linkage.
 *  - `verifyPaymentOnChain` (onchain.ts) is the only part that needs the network, and it is
 *    optional, because a receipt must still be checkable when Horizon is down.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { GENESIS_PREV, receiptSchema } from "./types.js";
import type { Receipt } from "./types.js";
import { hashBody, receiptPayload } from "./chain.js";

export interface VerificationIssue {
  code:
    | "RECEIPT_MALFORMED"
    | "RECEIPT_TAMPERED"
    | "RECEIPT_SIGNATURE_INVALID"
    | "CHAIN_SEQUENCE_GAP"
    | "CHAIN_LINK_BROKEN"
    | "CHAIN_SIGNER_CHANGED"
    | "TOTAL_MISMATCH"
    | "PAYMENT_MISMATCH";
  message: string;
  /** Receipt this issue is about, when it is about one. */
  seq?: number;
  hash?: string;
  details?: Record<string, unknown>;
}

export interface VerificationResult {
  valid: boolean;
  issues: VerificationIssue[];
}

const ok: VerificationResult = { valid: true, issues: [] };

/**
 * One receipt, on its own terms: it parses, its hash matches its body, its signature matches the
 * signer it names, and its declared total equals the sum of its lines.
 *
 * What this does NOT prove: that the store told the truth about its own catalog. It proves the
 * store cannot later change its story.
 */
export function verifyReceipt(candidate: unknown): VerificationResult {
  const parsed = receiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      issues: [
        {
          code: "RECEIPT_MALFORMED",
          message: "Receipt does not match the receipt schema",
          details: { issues: parsed.error.issues },
        },
      ],
    };
  }
  const receipt = parsed.data;
  const issues: VerificationIssue[] = [];
  const where = { seq: receipt.body.seq, hash: receipt.hash };

  const recomputed = hashBody(receipt.body);
  if (recomputed !== receipt.hash) {
    issues.push({
      ...where,
      code: "RECEIPT_TAMPERED",
      message: "The receipt body does not hash to the stated hash",
      details: { stated: receipt.hash, recomputed },
    });
    // The signature covers the hash, so with a broken hash there is nothing left to trust.
    return { valid: false, issues };
  }

  let signatureValid = false;
  try {
    signatureValid = Keypair.fromPublicKey(receipt.body.store.signer).verify(
      receiptPayload(receipt.hash),
      Buffer.from(receipt.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    issues.push({
      ...where,
      code: "RECEIPT_SIGNATURE_INVALID",
      message: "The signature does not verify against the store signer named in the receipt",
      details: { signer: receipt.body.store.signer },
    });
  }

  if (receipt.body.terms) {
    const sum = receipt.body.terms.lines.reduce((acc, l) => acc + BigInt(l.lineTotalMinor), 0n);
    if (sum !== BigInt(receipt.body.terms.totalMinor)) {
      issues.push({
        ...where,
        code: "TOTAL_MISMATCH",
        message: "The stated total is not the sum of the lines",
        details: { stated: receipt.body.terms.totalMinor, sum: sum.toString() },
      });
    }
  }

  // A settled payment must be for the amount, asset and network that were quoted.
  const { terms, payment } = receipt.body;
  if (terms && payment) {
    const mismatch: Record<string, unknown> = {};
    if (BigInt(payment.amountMinor) !== BigInt(terms.totalMinor))
      mismatch.amount = { quoted: terms.totalMinor, paid: payment.amountMinor };
    if (payment.network !== terms.network)
      mismatch.network = { quoted: terms.network, paid: payment.network };
    if (payment.asset !== terms.asset) mismatch.asset = { quoted: terms.asset, paid: payment.asset };
    if (Object.keys(mismatch).length > 0 && receipt.body.event === "order.settled") {
      issues.push({
        ...where,
        code: "PAYMENT_MISMATCH",
        message: "A settled receipt records a payment that does not match its own terms",
        details: mismatch,
      });
    }
  }

  return issues.length === 0 ? ok : { valid: false, issues };
}

/**
 * A run of receipts, in order. Catches what a single receipt cannot: a link removed (sequence
 * gap), a link rewritten (broken `prev`), or a chain re-signed by a different key.
 *
 * `receipts` need not start at seq 1; verification is relative to what it was given, and says so
 * by reporting gaps rather than assuming the caller has everything.
 */
export function verifyChain(receipts: Receipt[]): VerificationResult {
  const issues: VerificationIssue[] = [];
  let previous: Receipt | undefined;

  for (const receipt of receipts) {
    issues.push(...verifyReceipt(receipt).issues);
    const where = { seq: receipt.body.seq, hash: receipt.hash };

    if (previous) {
      if (receipt.body.seq !== previous.body.seq + 1) {
        issues.push({
          ...where,
          code: "CHAIN_SEQUENCE_GAP",
          message: `Receipt ${previous.body.seq} is followed by ${receipt.body.seq}: a link is missing`,
          details: { after: previous.body.seq, found: receipt.body.seq },
        });
      }
      if (receipt.body.prev !== previous.hash) {
        issues.push({
          ...where,
          code: "CHAIN_LINK_BROKEN",
          message: "This receipt does not point at the previous one",
          details: { expected: previous.hash, found: receipt.body.prev },
        });
      }
      if (receipt.body.store.signer !== previous.body.store.signer) {
        issues.push({
          ...where,
          code: "CHAIN_SIGNER_CHANGED",
          message: "The store signing key changed mid-chain",
          details: { from: previous.body.store.signer, to: receipt.body.store.signer },
        });
      }
    } else if (receipt.body.seq === 1 && receipt.body.prev !== GENESIS_PREV) {
      issues.push({
        ...where,
        code: "CHAIN_LINK_BROKEN",
        message: `The first receipt must point at '${GENESIS_PREV}'`,
        details: { found: receipt.body.prev },
      });
    }
    previous = receipt;
  }

  return issues.length === 0 ? ok : { valid: false, issues };
}
