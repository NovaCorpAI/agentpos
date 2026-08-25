/**
 * Cart -> quote -> order state machine (SPEC 08).
 * The merchant-platform order is created ONLY from markPaid(), i.e. after settlement (guardrail 6).
 */
import { randomBytes } from "node:crypto";
import type {
  Address,
  BuyerContact,
  Cart,
  CartLine,
  Order,
  OrderConnector,
  PaymentRecord,
  Quote,
  QuoteLine,
  SettlementReceipt,
  UsdcMinor,
} from "@agentgate/core";
import { AgentGateError, addUsdc, mulUsdc, usdcFromMinor } from "@agentgate/core";
import type { CatalogService } from "./catalog.js";
import type { SiteStorage } from "./storage.js";

export interface CheckoutOptions {
  storage: SiteStorage;
  catalog: CatalogService;
  connector: OrderConnector;
  defaultPayTo: string;
  cartTtlMinutes: number;
  network: string;
  asset: string;
  /** Immediate connector retries after settlement before giving up (background retry continues). */
  connectorAttempts?: number;
  log?: (message: string) => void;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export class CheckoutService {
  private readonly attempts: number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: CheckoutOptions) {
    this.attempts = opts.connectorAttempts ?? 3;
    this.log = opts.log ?? (() => {});
  }

  async createCart(lines: CartLine[], buyer?: BuyerContact, shipping?: Address): Promise<Cart> {
    if (lines.length === 0) {
      throw new AgentGateError("CONFIG_INVALID", "Cart needs at least one line", {
        hint: "Send items: [{ itemId, quantity }].",
      });
    }
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + l.quantity);

    const items = [...merged.entries()].map(([itemId, quantity]) => ({
      item: this.opts.catalog.getPublished(itemId),
      quantity,
    }));

    const availability = await this.opts.connector.getAvailability(
      items.map(({ item, quantity }) => ({
        itemId: item.id,
        ...(item.externalId ? { externalId: item.externalId } : {}),
        quantity,
      })),
    );
    const unavailable = items.filter(({ item }) => {
      const a = availability.find((r) => r.itemId === item.id);
      return item.stockMode === "tracked"
        ? !a?.available
        : a !== undefined && a.available === false;
    });
    if (unavailable.length) {
      throw new AgentGateError(
        "OUT_OF_STOCK",
        "Some items are not available in the requested quantity",
        {
          hint: "Reduce quantity or remove the items listed in details.",
          details: { items: unavailable.map((u) => u.item.id) },
        },
      );
    }

    const payTos = new Set(items.map(({ item }) => item.payTo ?? this.opts.defaultPayTo));
    if (payTos.size > 1) {
      throw new AgentGateError(
        "MIXED_PAYTO",
        "Items in this cart are paid to different addresses",
        {
          hint: "Create one cart per seller wallet (v1 limitation).",
        },
      );
    }
    const [payTo] = payTos;

    const quoteLines: QuoteLine[] = items.map(({ item, quantity }) => {
      const unit = item.priceUsdc as UsdcMinor;
      return {
        itemId: item.id,
        ...(item.externalId ? { externalId: item.externalId } : {}),
        title: item.title,
        quantity,
        unitPriceUsdc: unit,
        lineTotalUsdc: mulUsdc(unit, quantity),
        physical: item.physical,
      };
    });
    const totalUsdc = quoteLines.reduce(
      (acc, l) => addUsdc(acc, l.lineTotalUsdc),
      usdcFromMinor(0n),
    );
    const requiresShipping = quoteLines.some((l) => l.physical);
    if (requiresShipping && !shipping) {
      throw new AgentGateError("SHIPPING_REQUIRED", "Physical items need a shipping address", {
        hint: "Include shipping: { name, line1, city, postalCode, country } when creating the cart.",
      });
    }
    if (requiresShipping && !buyer?.email) {
      throw new AgentGateError(
        "SHIPPING_REQUIRED",
        "Physical items need a buyer email for order updates",
        {
          hint: "Include buyer: { email } when creating the cart.",
        },
      );
    }

    const quote: Quote = { lines: quoteLines, totalUsdc, payTo: payTo as string, requiresShipping };
    const now = new Date();
    const cart: Cart = {
      id: newId("cart"),
      lines: [...merged.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
      quote,
      ...(buyer ? { buyer } : {}),
      ...(shipping ? { shipping } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.opts.cartTtlMinutes * 60_000).toISOString(),
    };
    this.opts.storage.saveCart(cart);
    this.opts.storage.deleteExpiredCarts(now);
    return cart;
  }

  getCart(id: string): Cart {
    const cart = this.opts.storage.getCart(id);
    if (!cart) {
      throw new AgentGateError("CART_NOT_FOUND", `Unknown cart '${id}'`, {
        hint: "Create a cart first (POST /agentgate/cart).",
      });
    }
    if (
      new Date(cart.expiresAt).getTime() < Date.now() &&
      !this.opts.storage.getOrderByCart(id)?.payment
    ) {
      throw new AgentGateError("CART_EXPIRED", `Cart '${id}' expired`, {
        hint: "Create a new cart; quotes are valid for a limited time.",
        details: { expiresAt: cart.expiresAt },
      });
    }
    return cart;
  }

  /** Called from the protected checkout handler after verify, before settle. Idempotent per cart. */
  beginOrder(cartId: string): Order {
    const existing = this.opts.storage.getOrderByCart(cartId);
    if (existing) return existing;
    const cart = this.getCart(cartId);
    const now = new Date().toISOString();
    const order: Order = {
      id: newId("ord"),
      cartId,
      status: "pending_payment",
      quote: cart.quote,
      ...(cart.buyer ? { buyer: cart.buyer } : {}),
      ...(cart.shipping ? { shipping: cart.shipping } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.opts.storage.saveOrder(order);
    return order;
  }

  /** Settlement confirmed by the facilitator: record payment, mark paid, create the platform order. */
  async markPaid(cartId: string, receipt: SettlementReceipt): Promise<Order> {
    const order = this.beginOrder(cartId);
    const payment: PaymentRecord = {
      txHash: receipt.txHash,
      network: receipt.network,
      asset: this.opts.asset,
      amountMinor: receipt.amount ?? order.quote.totalUsdc,
      ...(receipt.payer ? { payer: receipt.payer } : {}),
      ts: new Date().toISOString(),
    };
    const fresh = this.opts.storage.recordPayment(order.id, payment);
    if (!fresh) {
      this.log(`payment ${receipt.txHash} already recorded; skipping (idempotent)`);
      return this.opts.storage.getOrder(order.id) as Order;
    }
    const paid: Order = { ...order, status: "paid", payment, updatedAt: new Date().toISOString() };
    this.opts.storage.saveOrder(paid);
    return this.pushToConnector(paid);
  }

  private async pushToConnector(order: Order): Promise<Order> {
    if (order.externalOrderId || !order.payment) return order;
    let attempts = order.connectorError?.attempts ?? 0;
    let lastError: AgentGateError | undefined;
    for (let i = 0; i < this.attempts; i += 1) {
      attempts += 1;
      try {
        const result = await this.opts.connector.createOrder({
          orderId: order.id,
          lines: order.quote.lines,
          totalUsdc: order.quote.totalUsdc,
          payment: order.payment,
          ...(order.buyer ? { buyer: order.buyer } : {}),
          ...(order.shipping ? { shipping: order.shipping } : {}),
          createdAt: order.createdAt,
        });
        const { connectorError: _drop, ...rest } = order;
        const done: Order = {
          ...rest,
          externalOrderId: result.externalOrderId,
          ...(result.adminUrl ? { externalAdminUrl: result.adminUrl } : {}),
          updatedAt: new Date().toISOString(),
        };
        this.opts.storage.saveOrder(done);
        this.log(
          `order ${order.id} created in ${this.opts.connector.platform} as ${result.externalOrderId}`,
        );
        return done;
      } catch (err) {
        lastError =
          err instanceof AgentGateError
            ? err
            : new AgentGateError("ORDER_NOT_CREATED", String(err), {
                hint: "Connector threw a non-AgentGate error.",
                retryable: true,
                cause: err,
              });
        this.log(
          `connector attempt ${attempts} failed for ${order.id}: ${lastError.code} ${lastError.message}`,
        );
        if (!lastError.retryable) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    const failed: Order = {
      ...order,
      connectorError: {
        code: lastError?.code ?? "ORDER_NOT_CREATED",
        message: lastError?.message ?? "unknown",
        hint: lastError?.hint ?? "Retry from the dashboard or `agentgate status --retry`.",
        retryable: lastError?.retryable ?? true,
        attempts,
      },
      updatedAt: new Date().toISOString(),
    };
    this.opts.storage.saveOrder(failed);
    return failed;
  }

  /** Re-attempts platform order creation for a paid order that failed (ORDER_NOT_CREATED). */
  async retryConnector(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (order.status !== "paid" || order.externalOrderId) return order;
    return this.pushToConnector(order);
  }

  getOrder(id: string): Order {
    const order = this.opts.storage.getOrder(id);
    if (!order)
      throw new AgentGateError("ORDER_NOT_FOUND", `Unknown order '${id}'`, {
        hint: "Use the orderId returned by checkout.",
      });
    return order;
  }

  markSettlementFailed(cartId: string, reason: string): void {
    const order = this.opts.storage.getOrderByCart(cartId);
    if (!order || order.status !== "pending_payment") return;
    this.log(`settlement failed for cart ${cartId}: ${reason}`);
  }
}
