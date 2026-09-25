/**
 * Receipts for a rail that does not settle on a ledger (SPEC 4.4): a card payment through the
 * merchant's acquirer. The receipt is signed and verifies offline exactly like an x402 one; what
 * changes is that on-chain confirmation has nothing to look up and must say so, not fail.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MemoryReceiptStore,
  ReceiptChain,
  verifyChain,
  verifyPaymentOnChain,
  verifyReceipt,
} from "./index.js";
import type { Receipt, ReceiptDraft } from "./index.js";

const store = Keypair.random();
const payTo = Keypair.random().publicKey();

function chain(): ReceiptChain {
  return new ReceiptChain({
    store: new MemoryReceiptStore(),
    signerSecret: store.secret(),
    storeName: "Tienda de prueba",
    storeUrl: "https://tienda.test",
  });
}

/** 14.990 pesos by card: whole pesos, the rail's network, our buy order as the reference. */
function cardDraft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    event: "order.settled",
    at: new Date("2026-09-25T12:00:00.000Z").toISOString(),
    order: { id: "ord_9", cartId: "cart_9", status: "paid", externalOrderId: "woo-9" },
    terms: {
      lines: [
        {
          itemId: "mug",
          title: "Taza de cerámica",
          quantity: 1,
          unitPriceMinor: "14990",
          lineTotalMinor: "14990",
        },
      ],
      totalMinor: "14990",
      payTo,
      network: "transbank:integration",
      asset: "CLP",
      assetAddress: "iso4217:CLP",
      rail: "cl.transbank.webpay",
    },
    policy: {
      decision: "allowed",
      evaluatedAt: new Date("2026-09-25T11:59:00.000Z").toISOString(),
    },
    payment: {
      txHash: "bo-cart_9",
      network: "transbank:integration",
      asset: "CLP",
      amountMinor: "14990",
      payer: "cliente-42",
      ts: new Date("2026-09-25T12:00:00.000Z").toISOString(),
      rail: "cl.transbank.webpay",
    },
    adapterVersion: "test-1",
    traceId: "trace-9",
    ...overrides,
  } as ReceiptDraft;
}

describe("a receipt on a rail without a ledger", () => {
  it("is signed and verifies offline like any other receipt", () => {
    const receipt = chain().append(cardDraft()) as Receipt;
    expect(receipt.body.terms?.rail).toBe("cl.transbank.webpay");
    expect(receipt.body.payment?.rail).toBe("cl.transbank.webpay");
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(true);
  });

  it("still catches a payment that does not match its own terms", () => {
    const receipt = chain().append(
      cardDraft({
        payment: { ...cardDraft().payment!, amountMinor: "14000" },
      }),
    ) as Receipt;
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("PAYMENT_MISMATCH");
  });

  it("chains with x402 receipts of the same store: one account, two rails", () => {
    const c = chain();
    c.append(cardDraft());
    c.append(
      cardDraft({
        order: { id: "ord_10", cartId: "cart_10", status: "paid", externalOrderId: "woo-10" },
        terms: {
          ...cardDraft().terms!,
          network: "stellar:testnet",
          asset: "USDC",
          assetAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          totalMinor: "99000000",
          lines: [
            {
              itemId: "mug",
              title: "Taza",
              quantity: 1,
              unitPriceMinor: "99000000",
              lineTotalMinor: "99000000",
            },
          ],
          rail: undefined,
        },
        payment: {
          txHash: "6e5007492399a2378d39ae762c7ba7e82b6c6b0e756de21d568a291004f1f2b7",
          network: "stellar:testnet",
          asset: "USDC",
          amountMinor: "99000000",
          ts: new Date("2026-09-25T12:01:00.000Z").toISOString(),
        },
      }),
    );
    const receipts = c.list();
    expect(receipts).toHaveLength(2);
    expect(verifyChain(receipts).valid).toBe(true);
  });

  it("reports 'not a ledger rail' on chain confirmation, and never calls a Horizon", async () => {
    const receipt = chain().append(cardDraft()) as Receipt;
    const fetchImpl = vi.fn();
    const result = await verifyPaymentOnChain(receipt, {
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("does not settle on a ledger");
    expect(result.txHash).toBe("bo-cart_9");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
