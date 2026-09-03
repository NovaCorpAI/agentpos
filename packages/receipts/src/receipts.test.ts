/**
 * M4 acceptance criteria: altering a field invalidates the receipt, removing a link breaks the
 * chain, verifyReceipt validates a real testnet payment, and the export is faithful to its period.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  GENESIS_PREV,
  MemoryReceiptStore,
  ReceiptChain,
  RECEIPT_VERSION,
  exportAuditTrail,
  formatAuditTrail,
  hashBody,
  signReceipt,
  verifyChain,
  verifyPaymentOnChain,
  verifyReceipt,
} from "./index.js";
import type { Receipt, ReceiptDraft } from "./index.js";

const store = Keypair.random();

function chain(): { chain: ReceiptChain; store: MemoryReceiptStore } {
  const receiptStore = new MemoryReceiptStore();
  return {
    store: receiptStore,
    chain: new ReceiptChain({
      store: receiptStore,
      signerSecret: store.secret(),
      storeName: "Test Shop",
      storeUrl: "https://shop.test",
    }),
  };
}

const payTo = Keypair.random().publicKey();

function settledDraft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    event: "order.settled",
    at: new Date("2026-08-29T12:00:00.000Z").toISOString(),
    order: { id: "ord_1", cartId: "cart_1", status: "paid", externalOrderId: "woo-1" },
    terms: {
      lines: [
        {
          itemId: "mug",
          title: "Ceramic Mug",
          quantity: 1,
          unitPriceMinor: "99000000",
          lineTotalMinor: "99000000",
        },
      ],
      totalMinor: "99000000",
      payTo,
      network: "stellar:testnet",
      asset: "USDC",
      assetAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    policy: { decision: "allowed", evaluatedAt: new Date("2026-08-29T11:59:00.000Z").toISOString() },
    payment: {
      txHash: "6e5007492399a2378d39ae762c7ba7e82b6c6b0e756de21d568a291004f1f2b7",
      network: "stellar:testnet",
      asset: "USDC",
      amountMinor: "99000000",
      payer: Keypair.random().publicKey(),
      ts: new Date("2026-08-29T12:00:00.000Z").toISOString(),
    },
    adapterVersion: "test-1",
    traceId: "trace-1",
    ...overrides,
  } as ReceiptDraft;
}

describe("a single receipt", () => {
  it("is signed by the store and verifies on its own", () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft());
    expect(receipt).toBeDefined();
    expect(receipt?.body.seq).toBe(1);
    expect(receipt?.body.prev).toBe(GENESIS_PREV);
    expect(receipt?.body.store.signer).toBe(store.publicKey());
    expect(verifyReceipt(receipt).valid).toBe(true);
  });

  it("altering any field invalidates it", () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;

    // Change the amount and leave hash and signature alone: the hash no longer matches.
    const edited = structuredClone(receipt);
    edited.body.terms!.totalMinor = "1";
    const tampered = verifyReceipt(edited);
    expect(tampered.valid).toBe(false);
    expect(tampered.issues[0]?.code).toBe("RECEIPT_TAMPERED");

    // Recompute the hash to hide the edit: the signature no longer matches.
    const resealed = structuredClone(edited);
    resealed.hash = hashBody(resealed.body);
    const forged = verifyReceipt(resealed);
    expect(forged.valid).toBe(false);
    expect(forged.issues.map((i) => i.code)).toContain("RECEIPT_SIGNATURE_INVALID");
  });

  it("re-signing with another key is caught: the signer is named inside the body", () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;
    const attacker = Keypair.random();
    const forged = signReceipt(attacker.secret(), {
      ...receipt.body,
      store: { ...receipt.body.store, signer: attacker.publicKey() },
    });
    // It verifies as a document, but it is a different store's document, and in a chain the
    // signer change is reported.
    expect(verifyReceipt(forged).valid).toBe(true);
    expect(forged.body.store.signer).not.toBe(store.publicKey());
    const asChain = verifyChain([receipt, { ...forged, body: { ...forged.body, seq: 2, prev: receipt.hash } }]);
    expect(asChain.valid).toBe(false);
    expect(asChain.issues.map((i) => i.code)).toContain("CHAIN_SIGNER_CHANGED");
  });

  it("refuses a total that is not the sum of its lines", () => {
    const { chain: c } = chain();
    const draft = settledDraft();
    draft.terms!.totalMinor = "10";
    draft.payment!.amountMinor = "10";
    const receipt = c.append(draft) as Receipt;
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("TOTAL_MISMATCH");
  });

  it("refuses a settled receipt whose payment contradicts its own terms", () => {
    const { chain: c } = chain();
    const draft = settledDraft();
    draft.payment!.amountMinor = "1000";
    const receipt = c.append(draft) as Receipt;
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("PAYMENT_MISMATCH");
  });

  it("rejects anything that is not a receipt", () => {
    expect(verifyReceipt({ hello: "world" }).issues[0]?.code).toBe("RECEIPT_MALFORMED");
    expect(verifyReceipt(undefined).valid).toBe(false);
  });
});

describe("the chain", () => {
  it("links each receipt to the previous one", () => {
    const { chain: c } = chain();
    const first = c.append(settledDraft()) as Receipt;
    const second = c.append(settledDraft({ order: { id: "ord_2", cartId: "cart_2", status: "paid" } })) as Receipt;
    expect(second.body.seq).toBe(2);
    expect(second.body.prev).toBe(first.hash);
    expect(verifyChain([first, second]).valid).toBe(true);
  });

  it("removing a link breaks the chain", () => {
    const { chain: c, store: s } = chain();
    c.append(settledDraft());
    c.append(settledDraft({ order: { id: "ord_2", cartId: "cart_2", status: "paid" } }));
    c.append(settledDraft({ order: { id: "ord_3", cartId: "cart_3", status: "paid" } }));
    const all = s.list();
    const withHole = [all[0] as Receipt, all[2] as Receipt];

    const result = verifyChain(withHole);
    expect(result.valid).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("CHAIN_SEQUENCE_GAP");
    expect(codes).toContain("CHAIN_LINK_BROKEN");
  });

  it("rewriting a middle receipt orphans the ones after it", () => {
    const { chain: c, store: s } = chain();
    c.append(settledDraft());
    c.append(settledDraft({ order: { id: "ord_2", cartId: "cart_2", status: "paid" } }));
    c.append(settledDraft({ order: { id: "ord_3", cartId: "cart_3", status: "paid" } }));
    const all = s.list();
    // The store re-signs the middle receipt with a smaller amount: it is internally consistent,
    // but the next receipt still commits to the old hash.
    const rewritten = signReceipt(store.secret(), {
      ...(all[1] as Receipt).body,
      terms: { ...(all[1] as Receipt).body.terms!, totalMinor: "1", lines: [{ ...(all[1] as Receipt).body.terms!.lines[0]!, lineTotalMinor: "1", unitPriceMinor: "1" }] },
      payment: { ...(all[1] as Receipt).body.payment!, amountMinor: "1" },
    });
    expect(verifyReceipt(rewritten).valid).toBe(true);

    const result = verifyChain([all[0] as Receipt, rewritten, all[2] as Receipt]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("CHAIN_LINK_BROKEN");
  });

  it("records what did not happen: a denied sale is a receipt too", () => {
    const { chain: c } = chain();
    const denial = c.append({
      event: "policy.denied",
      at: new Date().toISOString(),
      policy: {
        decision: "denied",
        code: "POLICY_ORDER_LIMIT",
        message: "Order above the per-order limit",
        evaluatedAt: new Date().toISOString(),
      },
      agent: { authenticated: true, attested: false, agentKey: Keypair.random().publicKey() },
      adapterVersion: "test-1",
    }) as Receipt;
    expect(denial.body.event).toBe("policy.denied");
    expect(denial.body.terms).toBeUndefined();
    expect(verifyReceipt(denial).valid).toBe(true);
  });

  it("never throws into the caller: a malformed draft is logged, not raised", () => {
    const { chain: c, store: s } = chain();
    const bad = c.append({ event: "order.settled", at: "not a date", adapterVersion: "x" } as ReceiptDraft);
    expect(bad).toBeUndefined();
    expect(s.list()).toHaveLength(0);
  });
});

describe("audit trail export", () => {
  it("is faithful to the period and carries its own verification", () => {
    const { chain: c } = chain();
    c.append(settledDraft({ at: "2026-08-01T10:00:00.000Z" }));
    c.append(
      settledDraft({
        at: "2026-08-15T10:00:00.000Z",
        order: { id: "ord_2", cartId: "cart_2", status: "paid" },
      }),
    );
    c.append(
      settledDraft({
        at: "2026-09-02T10:00:00.000Z",
        order: { id: "ord_3", cartId: "cart_3", status: "paid" },
      }),
    );

    const august = exportAuditTrail(c, { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" });
    expect(august.summary.receipts).toBe(2);
    expect(august.summary.settled.orders).toBe(2);
    expect(august.summary.settled.total).toBe("19.8");
    expect(august.receipts.every((r) => r.body.at.startsWith("2026-08"))).toBe(true);

    // A partial export is not a broken chain: the first receipt in the slice starts at seq 1 here.
    expect(august.verification.valid).toBe(true);
    expect(formatAuditTrail(august)).toContain("Verification: PASS");
  });

  it("reports a broken chain in the export instead of hiding it", () => {
    const { chain: c, store: s } = chain();
    c.append(settledDraft());
    c.append(settledDraft({ order: { id: "ord_2", cartId: "cart_2", status: "paid" } }));
    c.append(settledDraft({ order: { id: "ord_3", cartId: "cart_3", status: "paid" } }));
    const all = s.list();
    const holed = {
      list: () => [all[0] as Receipt, all[2] as Receipt],
    };
    const trail = exportAuditTrail(holed);
    expect(trail.verification.valid).toBe(false);
    expect(formatAuditTrail(trail)).toContain("Verification: FAIL");
  });
});

describe("on-chain confirmation", () => {
  const horizonStub = (records: unknown[], successful = true): typeof globalThis.fetch =>
    (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/effects"))
        return new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });
      return new Response(JSON.stringify({ successful, ledger: 4336868, created_at: "2026-08-26T01:27:14Z" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

  it("confirms a payment whose ledger effects match the receipt", async () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;
    const result = await verifyPaymentOnChain(receipt, {
      fetchImpl: horizonStub([
        { type: "account_debited", account: "GPAYER", amount: "9.9000000", asset_code: "USDC" },
        {
          type: "account_credited",
          account: payTo,
          amount: "9.9000000",
          asset_code: "USDC",
          asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        },
      ]),
    });
    expect(result.confirmed).toBe(true);
    expect(result.credited?.account).toBe(payTo);
    expect(result.ledger).toBe(4336868);
  });

  it("refuses when the ledger credits a different address or amount", async () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;
    const wrongAmount = await verifyPaymentOnChain(receipt, {
      fetchImpl: horizonStub([
        { type: "account_credited", account: payTo, amount: "1.0000000", asset_code: "USDC" },
      ]),
    });
    expect(wrongAmount.confirmed).toBe(false);

    const wrongAccount = await verifyPaymentOnChain(receipt, {
      fetchImpl: horizonStub([
        {
          type: "account_credited",
          account: Keypair.random().publicKey(),
          amount: "9.9000000",
          asset_code: "USDC",
        },
      ]),
    });
    expect(wrongAccount.confirmed).toBe(false);
  });

  it("refuses a transaction that failed on chain, and one that does not exist", async () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;
    const failed = await verifyPaymentOnChain(receipt, { fetchImpl: horizonStub([], false) });
    expect(failed.confirmed).toBe(false);
    expect(failed.reason).toContain("failed on chain");

    const missing = await verifyPaymentOnChain(receipt, {
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof globalThis.fetch,
    });
    expect(missing.confirmed).toBe(false);
    expect(missing.reason).toContain("No transaction with that hash");
  });

  it("says so plainly when it cannot reach the network", async () => {
    const { chain: c } = chain();
    const receipt = c.append(settledDraft()) as Receipt;
    const result = await verifyPaymentOnChain(receipt, {
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof globalThis.fetch,
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("Could not reach Horizon");
  });
});

describe("format stability", () => {
  it("pins the version string that third-party verifiers key on", () => {
    expect(RECEIPT_VERSION).toBe("agentpos-receipt-1");
  });
});

/**
 * The real thing. Opt-in because it needs the network: AGENTPOS_NETWORK_TESTS=1 pnpm test.
 * The hash below is the USDC payment from our testnet e2e (docs/GATE-G1.md), 9.9 USDC to the
 * merchant wallet, and this asserts that a receipt for it confirms against public Horizon.
 */
describe.runIf(process.env.AGENTPOS_NETWORK_TESTS === "1")("against real testnet", () => {
  it("confirms the e2e payment on public Horizon", async () => {
    const merchant = "GBMKYHRYTJSQO2LPSSJKWKUSUAVEYHO2GOOKBTQF6ZZSVJ5G2XBLBIJM";
    const { chain: c } = chain();
    const receipt = c.append(
      settledDraft({
        terms: {
          lines: [
            {
              itemId: "mug",
              title: "Ceramic Mug",
              quantity: 1,
              unitPriceMinor: "99000000",
              lineTotalMinor: "99000000",
            },
          ],
          totalMinor: "99000000",
          payTo: merchant,
          network: "stellar:testnet",
          asset: "USDC",
          assetAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    ) as Receipt;

    expect(verifyReceipt(receipt).valid).toBe(true);
    const onChain = await verifyPaymentOnChain(receipt, { timeoutMs: 20_000 });
    expect(onChain.reason).toBeUndefined();
    expect(onChain.confirmed).toBe(true);
    expect(onChain.credited?.account).toBe(merchant);
    expect(onChain.credited?.amount).toBe("9.9000000");
    expect(onChain.credited?.assetIssuer).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  }, 30_000);
});
