/**
 * Order lifecycle (GAP 1): platform status mapping, the periodic sweep, and cart expiry.
 * Everything here is about statuses that money already moved through, so the tests are written
 * around the two rules that matter: never guess a status, and never touch a paid order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, Logger, Order, OrderConnector, PaymentRecord } from "@agentpos/core";
import { ReceiptChain } from "@agentpos/receipts";
import { CatalogService } from "./catalog.js";
import { CheckoutService, mapPlatformStatus } from "./checkout.js";
import { SiteStorage } from "./storage.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });

const mug: CatalogItem = {
  id: "mug",
  externalId: "12",
  type: "product",
  title: "Ceramic Mug 350ml",
  descriptionAgent: "White ceramic mug, 350 ml.",
  url: "https://shop.test/product/mug/",
  attributes: {},
  priceUsdc: usdc("9.9"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};

function connectorMock(statuses: Record<string, string> = {}): OrderConnector & {
  statusCalls: string[];
} {
  const statusCalls: string[] = [];
  return {
    platform: "woocommerce",
    statusCalls,
    getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
    createOrder: async () => ({ externalOrderId: "woo-1" }),
    getOrderStatus: async (externalOrderId: string) => {
      statusCalls.push(externalOrderId);
      const status = statuses[externalOrderId];
      if (status === undefined) throw new Error("no such order");
      return { status };
    },
  };
}

const quote = {
  lines: [
    {
      itemId: "mug",
      title: "Ceramic Mug 350ml",
      quantity: 1,
      unitPriceUsdc: usdc("9.9"),
      lineTotalUsdc: usdc("9.9"),
      physical: false,
    },
  ],
  totalUsdc: usdc("9.9"),
  payTo,
  requiresShipping: false,
};

const payment: PaymentRecord = {
  txHash: "tx_lifecycle",
  network: core.caip2,
  asset: core.checkoutAsset,
  amountMinor: usdc("9.9"),
  ts: "2026-09-01T10:00:00.000Z",
};

describe("order lifecycle", () => {
  let storage: SiteStorage;
  let connector: ReturnType<typeof connectorMock>;
  let checkout: CheckoutService;

  const build = (c: OrderConnector = connector): CheckoutService =>
    new CheckoutService({
      storage,
      catalog: new CatalogService(storage),
      connector: c,
      defaultPayTo: payTo,
      cartTtlMinutes: 15,
      network: core.caip2,
      asset: core.checkoutAsset,
      assetAddress: "USDC:GTEST",
    });

  /** An order in `status`, with the cart it came from (expired or not). */
  function seed(
    id: string,
    status: Order["status"],
    options: {
      externalOrderId?: string;
      cartExpired?: boolean;
      withPayment?: boolean;
      createdAt?: string;
    } = {},
  ): Order {
    const cartId = `cart_${id}`;
    const createdAt = options.createdAt ?? "2026-09-01T09:00:00.000Z";
    storage.saveCart({
      id: cartId,
      lines: [{ itemId: "mug", quantity: 1 }],
      quote,
      createdAt,
      expiresAt: options.cartExpired ? "2026-09-01T09:15:00.000Z" : "2099-01-01T00:00:00.000Z",
    });
    const order: Order = {
      id,
      cartId,
      status,
      quote,
      ...(options.externalOrderId ? { externalOrderId: options.externalOrderId } : {}),
      ...(options.withPayment ? { payment: { ...payment, txHash: `tx_${id}` } } : {}),
      traceId: `trace_${id}`,
      createdAt,
      updatedAt: createdAt,
    };
    storage.saveOrder(order);
    if (options.withPayment) storage.recordPayment(id, { ...payment, txHash: `tx_${id}` });
    return order;
  }

  beforeEach(() => {
    storage = new SiteStorage(":memory:");
    storage.upsertItem(mug);
    connector = connectorMock();
    checkout = build();
  });

  it("maps every platform status through one table, and nothing else", () => {
    expect(mapPlatformStatus("completed")).toBe("fulfilled");
    expect(mapPlatformStatus("cancelled")).toBe("cancelled");
    expect(mapPlatformStatus("refunded")).toBe("cancelled");
    expect(mapPlatformStatus("failed")).toBe("cancelled");
    // WooCommerce's internal spelling means the same thing.
    expect(mapPlatformStatus("wc-completed")).toBe("fulfilled");
    expect(mapPlatformStatus("  COMPLETED ")).toBe("fulfilled");
    // In-flight and unknown vocabularies are not guesses we make.
    for (const unknown of ["pending", "processing", "on-hold", "trash", "", "shipped"])
      expect(mapPlatformStatus(unknown)).toBeUndefined();
  });

  it("syncs a paid order to fulfilled and logs the transition", async () => {
    const info = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    connector = connectorMock({ "woo-7": "completed" });
    checkout = new CheckoutService({
      storage,
      catalog: new CatalogService(storage),
      connector,
      defaultPayTo: payTo,
      cartTtlMinutes: 15,
      network: core.caip2,
      asset: core.checkoutAsset,
      assetAddress: "USDC:GTEST",
      logger,
    });
    seed("ord_a", "paid", { externalOrderId: "woo-7", withPayment: true });

    const synced = await checkout.syncOrderStatus("ord_a");
    expect(synced.status).toBe("fulfilled");
    expect(storage.getOrder("ord_a")?.status).toBe("fulfilled");
    expect(info).toHaveBeenCalledWith(
      "order.status_changed",
      expect.objectContaining({
        orderId: "ord_a",
        from: "paid",
        to: "fulfilled",
        traceId: "trace_ord_a",
      }),
    );
  });

  it("leaves the order untouched on an unknown platform status, and stops at terminal", async () => {
    connector = connectorMock({ "woo-1": "processing" });
    checkout = build();
    seed("ord_b", "paid", { externalOrderId: "woo-1", withPayment: true });

    expect((await checkout.syncOrderStatus("ord_b")).status).toBe("paid");
    expect(storage.getOrder("ord_b")?.updatedAt).toBe("2026-09-01T09:00:00.000Z");

    // Once terminal, the platform is not asked again.
    seed("ord_c", "fulfilled", { externalOrderId: "woo-1", withPayment: true });
    connector.statusCalls.length = 0;
    expect((await checkout.syncOrderStatus("ord_c")).status).toBe("fulfilled");
    expect(connector.statusCalls).toEqual([]);
  });

  it("keeps the order as it is when the connector cannot answer or does not support status", async () => {
    seed("ord_d", "paid", { externalOrderId: "unknown-in-platform", withPayment: true });
    expect((await checkout.syncOrderStatus("ord_d")).status).toBe("paid");

    const blind: OrderConnector = {
      platform: "generic",
      getAvailability: async () => [],
      createOrder: async () => ({ externalOrderId: "x" }),
    };
    const other = build(blind);
    expect((await other.syncOrderStatus("ord_d")).status).toBe("paid");
  });

  it("sweeps paid orders oldest first, with a batch cap", async () => {
    connector = connectorMock({ "woo-1": "completed", "woo-2": "refunded", "woo-3": "completed" });
    checkout = build();
    for (const [i, ext] of ["woo-1", "woo-2", "woo-3"].entries()) {
      seed(`ord_${i}`, "paid", {
        externalOrderId: ext,
        withPayment: true,
        createdAt: `2026-09-0${i + 1}T09:00:00.000Z`,
      });
    }
    const first = await checkout.sweepOrderLifecycle(new Date("2026-09-10T00:00:00.000Z"), 2);
    expect(first.map((o) => o.id)).toEqual(["ord_0", "ord_1"]);
    expect(first.map((o) => o.status)).toEqual(["fulfilled", "cancelled"]);

    const second = await checkout.sweepOrderLifecycle(new Date("2026-09-10T00:00:00.000Z"), 2);
    expect(second.map((o) => o.id)).toEqual(["ord_2"]);
    expect(storage.orderStatusCounts()).toMatchObject({ fulfilled: 2, cancelled: 1, paid: 0 });
  });

  it("expires unpaid orders whose cart expired, and never one that has a payment", async () => {
    seed("ord_unpaid", "pending_payment", { cartExpired: true });
    // Same shape, but settled: this is the stuck-settlement path, which has its own alerting.
    seed("ord_stuck", "pending_payment", { cartExpired: true, withPayment: true });
    // Settled with only the payments row written (mid-flight): still off limits.
    const partial = seed("ord_partial", "pending_payment", { cartExpired: true });
    storage.recordPayment(partial.id, { ...payment, txHash: "tx_partial" });
    seed("ord_fresh", "pending_payment", { cartExpired: false });

    const moved = await checkout.sweepOrderLifecycle(new Date("2026-09-01T10:00:00.000Z"));
    expect(moved.map((o) => o.id)).toEqual(["ord_unpaid"]);
    expect(storage.getOrder("ord_unpaid")?.status).toBe("expired");
    expect(storage.getOrder("ord_stuck")?.status).toBe("pending_payment");
    expect(storage.getOrder("ord_partial")?.status).toBe("pending_payment");
    expect(storage.getOrder("ord_fresh")?.status).toBe("pending_payment");
  });

  it("records negative transitions in the receipt chain and invents no event for fulfilment", async () => {
    connector = connectorMock({ "woo-1": "completed", "woo-2": "cancelled" });
    checkout = build();
    const receipts = new ReceiptChain({
      store: storage.receiptStore(),
      signerSecret: Keypair.random().secret(),
      storeName: "Test Shop",
      storeUrl: "https://shop.test",
    });
    checkout.setReceipts(receipts);
    seed("ord_done", "paid", { externalOrderId: "woo-1", withPayment: true });
    seed("ord_gone", "paid", { externalOrderId: "woo-2", withPayment: true });
    seed("ord_old", "pending_payment", { cartExpired: true });

    await checkout.sweepOrderLifecycle(new Date("2026-09-01T10:00:00.000Z"));

    expect(receipts.forOrder("ord_done")).toEqual([]);
    const cancelled = receipts.forOrder("ord_gone");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.body.event).toBe("order.failed");
    expect(cancelled[0]?.body.discrepancy).toMatchObject({
      from: "paid",
      to: "cancelled",
      platformStatus: "cancelled",
    });
    const expired = receipts.forOrder("ord_old");
    expect(expired[0]?.body.discrepancy).toMatchObject({ to: "expired", reason: "cart_expired" });
  });

  it("reports every lifecycle status in the counts, zero included", () => {
    seed("ord_x", "paid", { externalOrderId: "woo-1", withPayment: true });
    expect(storage.orderStatusCounts()).toEqual({
      pending_payment: 0,
      paid: 1,
      fulfilled: 0,
      cancelled: 0,
      expired: 0,
    });
    expect(storage.publicMetrics(new Date("2026-01-01T00:00:00.000Z")).fulfilledOrders).toBe(0);
  });
});
