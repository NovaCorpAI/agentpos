/**
 * Reconciliation of extra networks (D3): a payment the chain shows with no order behind it is
 * reported once, after a grace period, with the pending orders that could own it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { usdc } from "@agentpos/core";
import type { Order, PaymentRecord, Quote } from "@agentpos/core";
import type { AlertEvent } from "./checkout.js";
import { PaymentReconciler } from "./reconcile.js";
import type { PaymentWatcher, ReceivedPayment } from "./reconcile.js";
import { SiteStorage } from "./storage.js";

const ARC = "eip155:5042002";
const T0 = Date.parse("2026-10-27T12:00:00.000Z");

const quote: Quote = {
  lines: [],
  totalUsdc: usdc("2.5"),
  payTo: "0x75284c0856d11112321014Cd4405dEc5d84393f8",
  requiresShipping: false,
};

function saveOrder(storage: SiteStorage, id: string, status: Order["status"]): void {
  const createdAt = new Date(T0).toISOString();
  storage.saveCart({
    id: `cart_${id}`,
    lines: [],
    quote,
    createdAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  storage.saveOrder({ id, cartId: `cart_${id}`, status, quote, createdAt, updatedAt: createdAt });
}

/** A watcher that hands out whatever the test queued, once, like a cursor over the chain. */
function queueWatcher(): PaymentWatcher & { push(p: ReceivedPayment): void; fail: boolean } {
  let queue: ReceivedPayment[] = [];
  const w = {
    fail: false,
    push(p: ReceivedPayment) {
      queue.push(p);
    },
    async recentPayments() {
      if (w.fail) throw new Error("RPC timeout");
      const out = queue;
      queue = [];
      return out;
    },
  };
  return w;
}

const paid = (txHash: string): ReceivedPayment => ({
  txHash,
  amountMinor: usdc("2.5"),
  from: "0x42Db000000000000000000000000000000000Bf0",
});

describe("PaymentReconciler", () => {
  let storage: SiteStorage;
  let alerts: AlertEvent[];
  let watcher: ReturnType<typeof queueWatcher>;
  let reconciler: PaymentReconciler;

  beforeEach(() => {
    storage = new SiteStorage(":memory:");
    alerts = [];
    watcher = queueWatcher();
    reconciler = new PaymentReconciler({
      storage,
      watchers: [{ network: ARC, watcher }],
      alert: (e) => {
        alerts.push(e);
      },
    });
  });

  it("stays quiet when every payment has its order", async () => {
    saveOrder(storage, "ord_1", "paid");
    const record: PaymentRecord = {
      txHash: "0xabc",
      network: ARC,
      asset: "USDC",
      amountMinor: usdc("2.5"),
      ts: new Date(T0).toISOString(),
    };
    storage.recordPayment("ord_1", record);
    watcher.push(paid("0xABC")); // the chain may spell the hash in another case
    await reconciler.run(T0);
    const report = await reconciler.run(T0 + 10 * 60_000);
    expect(alerts).toEqual([]);
    expect(report).toEqual([expect.objectContaining({ network: ARC, paymentsWithoutOrder: 0 })]);
  });

  it("reports a payment with no order once, after the grace period, with its candidates", async () => {
    saveOrder(storage, "ord_waiting", "pending_payment");
    watcher.push(paid("0xlost"));
    await reconciler.run(T0);
    expect(alerts).toEqual([]); // the store may be recording it right now

    const report = await reconciler.run(T0 + 3 * 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      code: "PAYMENT_WITHOUT_ORDER",
      details: {
        network: ARC,
        txHash: "0xlost",
        amountMinor: usdc("2.5").toString(),
        candidateOrders: ["ord_waiting"],
      },
    });
    expect(report[0]?.paymentsWithoutOrder).toBe(1);

    await reconciler.run(T0 + 10 * 60_000);
    expect(alerts).toHaveLength(1); // never twice for the same transaction
  });

  it("clears a payment the store records late, without alerting", async () => {
    saveOrder(storage, "ord_late", "paid");
    watcher.push(paid("0xlate"));
    await reconciler.run(T0);
    storage.recordPayment("ord_late", {
      txHash: "0xlate",
      network: ARC,
      asset: "USDC",
      amountMinor: usdc("2.5"),
      ts: new Date(T0 + 30_000).toISOString(),
    });
    const report = await reconciler.run(T0 + 3 * 60_000);
    expect(alerts).toEqual([]);
    expect(report[0]?.paymentsWithoutOrder).toBe(0);
  });

  it("keeps the last count and reports the error when the chain cannot be read", async () => {
    watcher.push(paid("0xlost"));
    await reconciler.run(T0);
    watcher.fail = true;
    const report = await reconciler.run(T0 + 3 * 60_000);
    expect(report[0]).toMatchObject({ error: "RPC timeout", paymentsWithoutOrder: 1 });
    expect(alerts).toHaveLength(1); // already-seen payments are still checked
  });
});
