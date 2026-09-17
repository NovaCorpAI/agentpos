/**
 * Cart -> quote -> order state machine (SPEC 08, hardened for gate G1).
 * The merchant-platform order is created ONLY from markPaid(), i.e. after settlement (guardrail 6),
 * and only when the settled terms match the quoted terms exactly.
 */
import { randomBytes } from "node:crypto";
import type {
  Address,
  AgentIdentityRecord,
  BuyerContact,
  Cart,
  CartLine,
  Logger,
  Order,
  OrderConnector,
  OrderStatus,
  PaymentRecord,
  Quote,
  QuoteLine,
  SettlementReceipt,
  UsdcMinor,
} from "@agentpos/core";
import {
  ADAPTER_VERSION,
  AgentPOSError,
  addUsdc,
  compareUsdc,
  mulUsdc,
  silentLogger,
  usdcFromMinor,
} from "@agentpos/core";
import { OPEN_POLICY, evaluatePolicy, periodStart } from "@agentpos/policy";
import type { MerchantPolicy, PolicyDecision } from "@agentpos/policy";
import type { ApprovalRequest, ApprovalService, ApprovalSnapshot } from "@agentpos/approvals";
import type { ReceiptChain, ReceiptTerms } from "@agentpos/receipts";
import type { CatalogService } from "./catalog.js";
import type { SiteStorage } from "./storage.js";

export interface AlertEvent {
  severity: "warning" | "critical";
  code: "PAYMENT_MISMATCH" | "ORDER_NOT_CREATED" | "SETTLEMENT_FAILED" | "RETRY_LOOP_STALLED";
  message: string;
  details: Record<string, unknown>;
  at: string;
}

export type AlertSink = (event: AlertEvent) => void | Promise<void>;

/** Outcome of the payment gate: either the agent may pay now, or a human owes a decision. */
export type GateForPaymentResult =
  | { status: "ready"; cart: Cart; approval?: ApprovalRequest }
  | { status: "pending_approval"; cart: Cart; approval: ApprovalRequest };

/** Terms the facilitator actually settled, as seen by the resource server. */
export interface SettledTerms {
  payTo: string;
  asset: string;
  amountMinor: UsdcMinor;
  network: string;
}

export interface CheckoutOptions {
  storage: SiteStorage;
  catalog: CatalogService;
  connector: OrderConnector;
  defaultPayTo: string;
  cartTtlMinutes: number;
  network: string;
  asset: string;
  /** Contract id of the checkout asset; settled asset must match it exactly. */
  assetAddress: string;
  /** Merchant policy over agentic sales (M1). Defaults to no restrictions. */
  policy?: MerchantPolicy;
  /** Human approval queue (M2). Without it, flagged orders are refused instead of parked. */
  approvals?: ApprovalService;
  /** Signed audit chain (M4). Without it the store simply keeps no receipts. */
  receipts?: ReceiptChain;
  /** Immediate connector retries after settlement before giving up (background retry continues). */
  connectorAttempts?: number;
  logger?: Logger;
  alert?: AlertSink;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/**
 * Platform order status -> AgentPOS order status. THE table: every platform vocabulary we can
 * read lives here and nowhere else, so a new platform adds rows instead of branches.
 *
 * WooCommerce (REST v3) speaks: pending, processing, on-hold, completed, cancelled, refunded,
 * failed, trash. Only the endings are mapped. An order moving through the merchant's own
 * workflow is not our business, and a status that is not in this table is deliberately absent:
 * `mapPlatformStatus` returns undefined and the caller leaves the order exactly as it was.
 * Guessing here would move an order (and the merchant's books) on a hunch.
 */
export const PLATFORM_ORDER_STATUS: Readonly<Record<string, OrderStatus>> = Object.freeze({
  completed: "fulfilled",
  cancelled: "cancelled",
  refunded: "cancelled",
  failed: "cancelled",
});

/** Once an order reaches one of these it never moves again, and nothing keeps polling it. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  "fulfilled",
  "cancelled",
  "expired",
]);

/**
 * Maps one platform status string, or undefined when we do not know it (a no-op for callers).
 * WooCommerce stores its statuses internally with a `wc-` prefix and hands them out without it;
 * both spellings mean the same thing, so the prefix is normalized away rather than duplicated.
 */
export function mapPlatformStatus(platformStatus: string): OrderStatus | undefined {
  const key = platformStatus.trim().toLowerCase().replace(/^wc-/, "");
  return PLATFORM_ORDER_STATUS[key];
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export class CheckoutService {
  private readonly attempts: number;
  private readonly logger: Logger;
  private readonly alert: AlertSink;
  private readonly policy: MerchantPolicy;
  private approvals: ApprovalService | undefined;
  private receipts: ReceiptChain | undefined;

  constructor(private readonly opts: CheckoutOptions) {
    this.attempts = opts.connectorAttempts ?? 3;
    this.logger = opts.logger ?? silentLogger;
    this.alert = opts.alert ?? (() => {});
    this.policy = opts.policy ?? OPEN_POLICY;
    this.approvals = opts.approvals;
    this.receipts = opts.receipts;
  }

  /** Wires the approval queue after construction (the app builds it from the same storage). */
  setApprovals(approvals: ApprovalService | undefined): void {
    this.approvals = approvals;
  }

  /** Wires the audit chain after construction (the app builds it from the same storage). */
  setReceipts(receipts: ReceiptChain | undefined): void {
    this.receipts = receipts;
  }

  /** Terms exactly as they were offered, in the shape a receipt records them. */
  private termsOf(quote: Quote): ReceiptTerms {
    return {
      lines: quote.lines.map((l) => ({
        itemId: l.itemId,
        title: l.title,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceUsdc.toString(),
        lineTotalMinor: l.lineTotalUsdc.toString(),
      })),
      totalMinor: quote.totalUsdc.toString(),
      payTo: quote.payTo,
      network: this.opts.network,
      asset: this.opts.asset,
      assetAddress: this.opts.assetAddress,
    };
  }

  /**
   * Everything a receipt says about an order, gathered in one place: the terms offered, the
   * policy that let it through, the human who approved it if one did, who bought, and what
   * settled. The cart may already have been swept, in which case the policy is simply absent
   * rather than invented.
   */
  private receiptContext(order: Order) {
    const cart = this.opts.storage.getCart(order.cartId);
    const approval = this.approvals?.store.getByCart(order.cartId);
    return {
      ...(cart?.policy
        ? {
            policy: {
              decision: cart.policy.decision,
              ...(cart.policy.code ? { code: cart.policy.code } : {}),
              ...(cart.policy.message ? { message: cart.policy.message } : {}),
              evaluatedAt: cart.policy.evaluatedAt,
            },
          }
        : {}),
      ...(approval
        ? {
            approval: {
              id: approval.id,
              status: approval.status,
              snapshotHash: approval.snapshotHash,
              ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
              ...(approval.reason ? { reason: approval.reason } : {}),
            },
          }
        : {}),
      order: {
        id: order.id,
        cartId: order.cartId,
        status: order.status,
        ...(order.externalOrderId ? { externalOrderId: order.externalOrderId } : {}),
      },
      terms: this.termsOf(order.quote),
      ...(order.agent ? { agent: order.agent } : {}),
      ...(order.payment
        ? {
            payment: {
              txHash: order.payment.txHash,
              network: order.payment.network,
              asset: order.payment.asset,
              amountMinor: order.payment.amountMinor.toString(),
              ...(order.payment.payer ? { payer: order.payment.payer } : {}),
              ts: order.payment.ts,
            },
          }
        : {}),
      adapterVersion: ADAPTER_VERSION,
      ...(order.traceId ? { traceId: order.traceId } : {}),
    };
  }

  /**
   * Runs the merchant policy over a quote (M1). Evaluated at cart time and AGAIN at checkout,
   * because suspension, catalog exclusions and period volume can change in between.
   */
  private runPolicy(
    quote: Quote,
    shippingCountry: string | undefined,
    excludeCartId?: string,
  ): PolicyDecision {
    const committed = this.opts.storage.committedSince(
      periodStart(this.policy.period),
      new Date(),
      excludeCartId,
    );
    const decision = evaluatePolicy(this.policy, {
      lines: quote.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        lineTotalUsdc: l.lineTotalUsdc,
      })),
      totalUsdc: quote.totalUsdc,
      periodSpentUsdc: usdcFromMinor(committed),
      requiresShipping: quote.requiresShipping,
      shippingCountry,
    });
    this.logger.info("policy.evaluated", {
      decision: decision.decision,
      code: decision.decision === "allowed" ? undefined : decision.code,
      total: quote.totalUsdc,
      committed,
      period: this.policy.period,
    });
    return decision;
  }

  /**
   * Denied decisions become typed errors the agent can reason about, and a receipt (M4): a sale
   * the store refused is evidence too, and the merchant may later need to prove it refused it.
   */
  private assertNotDenied(
    decision: PolicyDecision,
    context?: { quote: Quote; agent?: AgentIdentityRecord | undefined; traceId?: string | undefined; cartId?: string },
  ): void {
    if (decision.decision !== "denied") return;
    if (context) {
      this.receipts?.append({
        event: "policy.denied",
        at: new Date().toISOString(),
        terms: this.termsOf(context.quote),
        policy: {
          decision: "denied",
          code: decision.code,
          message: decision.message,
          evaluatedAt: new Date().toISOString(),
        },
        ...(context.agent ? { agent: context.agent } : {}),
        ...(context.cartId ? { cart: { id: context.cartId } } : {}),
        adapterVersion: ADAPTER_VERSION,
        ...(context.traceId ? { traceId: context.traceId } : {}),
      });
    }
    throw new AgentPOSError(decision.code, decision.message, {
      hint: decision.hint,
      details: decision.details,
    });
  }

  private async raise(event: Omit<AlertEvent, "at">): Promise<void> {
    const full = { ...event, at: new Date().toISOString() };
    this.logger.error(`alert.${event.code}`, { severity: event.severity, ...event.details });
    try {
      await this.alert(full);
    } catch (err) {
      this.logger.warn("alert.sink_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async createCart(
    lines: CartLine[],
    buyer?: BuyerContact,
    shipping?: Address,
    traceId?: string,
    agent?: AgentIdentityRecord,
  ): Promise<Cart> {
    if (lines.length === 0) {
      throw new AgentPOSError("CONFIG_INVALID", "Cart needs at least one line", {
        hint: "Send items: [{ itemId, quantity }].",
      });
    }
    const merged = new Map<string, CartLine>();
    // Merge duplicates, but a personalization note is part of the identity of a line: two
    // frames with different dedications must stay two lines.
    for (const l of lines) {
      const key = JSON.stringify([l.itemId, l.note ?? null]);
      const prev = merged.get(key);
      merged.set(key, {
        itemId: l.itemId,
        quantity: (prev?.quantity ?? 0) + l.quantity,
        ...(l.note !== undefined ? { note: l.note } : {}),
      });
    }

    const items = [...merged.values()].map(({ itemId, quantity, note }) => ({
      item: this.opts.catalog.getPublished(itemId),
      quantity,
      note,
    }));
    // Availability is checked against the SUM per item: two lines of the same frame with
    // different dedications still draw from the same stock.
    const availabilityTotals = new Map<string, number>();
    for (const { item, quantity } of items) {
      availabilityTotals.set(item.id, (availabilityTotals.get(item.id) ?? 0) + quantity);
    }
    await this.assertAvailable(
      items
        .filter(({ item }, i, arr) => arr.findIndex((e) => e.item.id === item.id) === i)
        .map(({ item }) => ({
          itemId: item.id,
          externalId: item.externalId,
          stockMode: item.stockMode,
          quantity: availabilityTotals.get(item.id) ?? 0,
        })),
    );

    const payTos = new Set(items.map(({ item }) => item.payTo ?? this.opts.defaultPayTo));
    if (payTos.size > 1) {
      throw new AgentPOSError(
        "MIXED_PAYTO",
        "Items in this cart are paid to different addresses",
        {
          hint: "Create one cart per seller wallet (v1 limitation).",
        },
      );
    }
    const [payTo] = payTos;

    const quoteLines: QuoteLine[] = items.map(({ item, quantity, note }) => {
      const unit = item.priceUsdc as UsdcMinor;
      return {
        itemId: item.id,
        ...(item.externalId ? { externalId: item.externalId } : {}),
        title: item.title,
        quantity,
        ...(note !== undefined ? { note } : {}),
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
      throw new AgentPOSError("SHIPPING_REQUIRED", "Physical items need a shipping address", {
        hint: "Include shipping: { name, line1, city, postalCode, country } when creating the cart.",
      });
    }
    if (requiresShipping && !buyer?.email) {
      throw new AgentPOSError(
        "SHIPPING_REQUIRED",
        "Physical items need a buyer email for order updates",
        {
          hint: "Include buyer: { email } when creating the cart.",
        },
      );
    }

    const quote: Quote = { lines: quoteLines, totalUsdc, payTo: payTo as string, requiresShipping };

    // Merchant policy, first pass (M1). A denial stops the quote here: the agent gets a typed
    // reason instead of a cart it could never pay.
    const decision = this.runPolicy(quote, shipping?.country);
    this.assertNotDenied(decision, { quote, agent, traceId });

    const now = new Date();
    const cart: Cart = {
      id: newId("cart"),
      lines: [...merged.values()],
      quote,
      ...(buyer ? { buyer } : {}),
      ...(shipping ? { shipping } : {}),
      policy: {
        decision: decision.decision === "requires_approval" ? "requires_approval" : "allowed",
        ...(decision.decision !== "allowed"
          ? { code: decision.code, message: decision.message }
          : {}),
        evaluatedAt: new Date().toISOString(),
      },
      // Who asked (M3). Recorded even when anonymous, so the receipt can say so explicitly.
      ...(agent ? { agent } : {}),
      ...(traceId ? { traceId } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.opts.cartTtlMinutes * 60_000).toISOString(),
    };
    this.opts.storage.saveCart(cart);
    this.opts.storage.deleteExpiredCarts(now);
    this.logger.info("cart.created", {
      traceId,
      cartId: cart.id,
      total: totalUsdc,
      lines: quoteLines.length,
    });
    return cart;
  }

  private async assertAvailable(
    items: Array<{
      itemId: string;
      externalId?: string | undefined;
      stockMode: "tracked" | "untracked";
      quantity: number;
    }>,
  ): Promise<void> {
    const availability = await this.opts.connector.getAvailability(
      items.map((i) => ({
        itemId: i.itemId,
        ...(i.externalId ? { externalId: i.externalId } : {}),
        quantity: i.quantity,
      })),
    );
    const unavailable = items.filter((i) => {
      const a = availability.find((r) => r.itemId === i.itemId);
      return i.stockMode === "tracked" ? !a?.available : a !== undefined && a.available === false;
    });
    if (unavailable.length) {
      throw new AgentPOSError(
        "OUT_OF_STOCK",
        "Some items are not available in the requested quantity",
        {
          hint: "Reduce quantity or remove the items listed in details.",
          details: { items: unavailable.map((u) => u.itemId) },
        },
      );
    }
  }

  getCart(id: string): Cart {
    const cart = this.opts.storage.getCart(id);
    if (!cart) {
      throw new AgentPOSError("CART_NOT_FOUND", `Unknown cart '${id}'`, {
        hint: "Create a cart first (POST /agentpos/cart).",
      });
    }
    if (
      new Date(cart.expiresAt).getTime() < Date.now() &&
      !this.opts.storage.getOrderByCart(id)?.payment
    ) {
      throw new AgentPOSError("CART_EXPIRED", `Cart '${id}' expired`, {
        hint: "Create a new cart; quotes are valid for a limited time.",
        details: { expiresAt: cart.expiresAt },
      });
    }
    return cart;
  }

  /**
   * G1: the quote must still hold at payment time. Re-checks every line's published price and
   * live availability; any drift expires the cart and asks the agent to re-quote. Never settles
   * against stale terms.
   */
  private async revalidate(id: string): Promise<{ cart: Cart; decision: PolicyDecision }> {
    const cart = this.getCart(id);
    // Already paid: nothing to revalidate, and no policy gate to re-apply.
    if (this.opts.storage.getOrderByCart(id)?.payment)
      return { cart, decision: { decision: "allowed" } };
    const drift: Array<Record<string, unknown>> = [];
    for (const line of cart.quote.lines) {
      let current: UsdcMinor | undefined;
      try {
        current = this.opts.catalog.getPublished(line.itemId).priceUsdc;
      } catch {
        drift.push({ itemId: line.itemId, reason: "item_no_longer_published" });
        continue;
      }
      if (current === undefined || compareUsdc(current, line.unitPriceUsdc) !== 0) {
        drift.push({
          itemId: line.itemId,
          reason: "price_changed",
          quoted: line.unitPriceUsdc,
          current,
        });
      }
    }
    if (drift.length === 0) {
      try {
        await this.assertAvailable(
          cart.quote.lines.map((l) => ({
            itemId: l.itemId,
            externalId: l.externalId,
            stockMode: this.opts.catalog.getPublished(l.itemId).stockMode,
            quantity: l.quantity,
          })),
        );
      } catch (err) {
        if (err instanceof AgentPOSError && err.code === "OUT_OF_STOCK")
          drift.push({ reason: "out_of_stock", ...err.details });
        else throw err;
      }
    }
    if (drift.length > 0) {
      this.opts.storage.saveCart({ ...cart, expiresAt: new Date(0).toISOString() });
      this.logger.warn("cart.requote_required", { traceId: cart.traceId, cartId: id, drift });
      throw new AgentPOSError(
        "REQUOTE_REQUIRED",
        "Price or availability changed since the quote",
        {
          hint: "Create a new cart to get current terms; nothing was charged.",
          details: { cartId: id, drift },
        },
      );
    }

    // Merchant policy, second pass (M1): suspension, exclusions and period volume can have
    // changed since the quote. Nothing is charged when this blocks.
    const decision = this.runPolicy(cart.quote, cart.shipping?.country, cart.id);
    this.assertNotDenied(decision, {
      quote: cart.quote,
      agent: cart.agent,
      traceId: cart.traceId,
      cartId: cart.id,
    });
    return { cart, decision };
  }

  /**
   * Backwards-compatible wrapper: throws when the cart needs approval and no queue is wired.
   * Sites with M2 enabled call `gateForPayment` instead, which parks the order rather than
   * refusing it.
   */
  async revalidateCart(id: string): Promise<Cart> {
    const { cart, decision } = await this.revalidate(id);
    if (decision.decision === "requires_approval") {
      throw new AgentPOSError("POLICY_APPROVAL_REQUIRED", decision.message, {
        hint: decision.hint,
        details: { cartId: cart.id, ...decision.details },
      });
    }
    return cart;
  }

  /**
   * The gate every payment passes through (M1 + M2). Returns `ready` when the agent may be shown
   * x402 terms, or `pending_approval` when a human has to decide first. It never charges: an
   * order waiting for approval has not been quoted a 402 at all.
   */
  async gateForPayment(cartId: string): Promise<GateForPaymentResult> {
    const { cart, decision } = await this.revalidate(cartId);
    if (decision.decision !== "requires_approval") return { status: "ready", cart };

    const approvals = this.approvals;
    if (!approvals) {
      throw new AgentPOSError("POLICY_APPROVAL_REQUIRED", decision.message, {
        hint: decision.hint,
        details: { cartId: cart.id, ...decision.details },
      });
    }
    const outcome = await approvals.gate(this.snapshotOf(cart, decision));
    if (outcome.status === "approved") {
      this.logger.info("approval.cleared", { cartId, approvalId: outcome.request.id });
      return { status: "ready", cart, approval: outcome.request };
    }
    return { status: "pending_approval", cart, approval: outcome.request };
  }

  /** What the merchant is asked to approve, and what settlement is later checked against. */
  private snapshotOf(
    cart: Cart,
    decision: Extract<PolicyDecision, { decision: "requires_approval" }>,
  ): ApprovalSnapshot {
    return {
      cartId: cart.id,
      lines: cart.quote.lines.map((l) => ({
        itemId: l.itemId,
        title: l.title,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceUsdc.toString(),
        lineTotalMinor: l.lineTotalUsdc.toString(),
      })),
      totalMinor: cart.quote.totalUsdc.toString(),
      asset: this.opts.asset,
      network: this.opts.network,
      payTo: cart.quote.payTo,
      buyer: cart.buyer,
      shipping: cart.shipping,
      policy: {
        code: decision.code,
        message: decision.message,
        thresholdMinor:
          typeof decision.details.threshold === "string" ? decision.details.threshold : undefined,
      },
    };
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
      ...(cart.agent ? { agent: cart.agent } : {}),
      ...(cart.traceId ? { traceId: cart.traceId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.opts.storage.saveOrder(order);
    this.logger.info("order.pending", { traceId: order.traceId, orderId: order.id, cartId });
    return order;
  }

  /**
   * Settlement confirmed by the facilitator: record payment (idempotent by tx hash), verify the
   * settled terms against the quote, mark paid and create the platform order. A mismatch keeps
   * the payment, puts the order on hold and raises a critical alert (the merchant decides).
   */
  async markPaid(
    cartId: string,
    receipt: SettlementReceipt,
    settled?: SettledTerms,
  ): Promise<Order> {
    const order = this.beginOrder(cartId);
    const log = this.logger.child({
      traceId: order.traceId,
      orderId: order.id,
      cartId,
      txHash: receipt.txHash,
    });
    const payment: PaymentRecord = {
      txHash: receipt.txHash,
      network: receipt.network,
      asset: this.opts.asset,
      amountMinor: receipt.amount ?? settled?.amountMinor ?? order.quote.totalUsdc,
      ...(receipt.payer ? { payer: receipt.payer } : {}),
      ts: new Date().toISOString(),
    };
    const fresh = this.opts.storage.recordPayment(order.id, payment);
    if (!fresh) {
      log.warn("payment.duplicate_ignored");
      return this.opts.storage.getOrder(order.id) as Order;
    }

    const mismatch = settled ? this.mismatch(order.quote, settled, receipt) : [];
    if (mismatch.length > 0) {
      const held: Order = {
        ...order,
        status: "paid",
        payment,
        hold: { reason: "PAYMENT_MISMATCH", details: { mismatch }, at: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      this.opts.storage.saveOrder(held);
      // The store was paid something it did not quote. Record it before alerting: this is
      // precisely the case a merchant will later have to account for.
      this.receipts?.append({
        ...this.receiptContext(held),
        event: "order.held",
        at: new Date().toISOString(),
        discrepancy: { mismatch },
      });
      await this.raise({
        severity: "critical",
        code: "PAYMENT_MISMATCH",
        message:
          "Settled payment does not match the quoted terms; order on hold, platform order NOT created",
        details: { orderId: order.id, cartId, txHash: receipt.txHash, mismatch },
      });
      return held;
    }

    const paid: Order = { ...order, status: "paid", payment, updatedAt: new Date().toISOString() };
    this.opts.storage.saveOrder(paid);
    log.info("payment.settled", { amount: payment.amountMinor, payer: payment.payer });
    const final = await this.pushToConnector(paid);
    // One receipt per settled order, written after the platform order so the receipt names it.
    // A connector failure does not withhold the receipt: the buyer paid, and that is the fact
    // the receipt exists to record.
    this.receipts?.append({
      ...this.receiptContext(final),
      event: "order.settled",
      at: new Date().toISOString(),
      ...(final.connectorError
        ? { discrepancy: { connectorError: final.connectorError } }
        : {}),
    });
    return final;
  }

  private mismatch(
    quote: Quote,
    settled: SettledTerms,
    receipt: SettlementReceipt,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (settled.payTo !== quote.payTo)
      out.push({ field: "payTo", expected: quote.payTo, actual: settled.payTo });
    if (settled.asset !== this.opts.assetAddress)
      out.push({ field: "asset", expected: this.opts.assetAddress, actual: settled.asset });
    if (settled.network !== this.opts.network)
      out.push({ field: "network", expected: this.opts.network, actual: settled.network });
    if (compareUsdc(settled.amountMinor, quote.totalUsdc) !== 0)
      out.push({ field: "amount", expected: quote.totalUsdc, actual: settled.amountMinor });
    if (receipt.amount !== undefined && compareUsdc(receipt.amount, quote.totalUsdc) !== 0)
      out.push({ field: "settledAmount", expected: quote.totalUsdc, actual: receipt.amount });
    if (receipt.network !== this.opts.network)
      out.push({ field: "settledNetwork", expected: this.opts.network, actual: receipt.network });
    return out;
  }

  private async pushToConnector(order: Order): Promise<Order> {
    if (order.externalOrderId || !order.payment || order.hold) return order;
    const log = this.logger.child({ traceId: order.traceId, orderId: order.id });
    let attempts = order.connectorError?.attempts ?? 0;
    let lastError: AgentPOSError | undefined;
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
        log.info("order.created_in_platform", {
          platform: this.opts.connector.platform,
          externalOrderId: result.externalOrderId,
          attempts,
        });
        return done;
      } catch (err) {
        lastError =
          err instanceof AgentPOSError
            ? err
            : new AgentPOSError("ORDER_NOT_CREATED", String(err), {
                hint: "Connector threw a non-AgentPOS error.",
                retryable: true,
                cause: err,
              });
        log.warn("order.connector_attempt_failed", {
          attempt: attempts,
          code: lastError.code,
          message: lastError.message,
        });
        if (!lastError.retryable) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    const failed: Order = {
      ...order,
      connectorError: {
        code: lastError?.code ?? "ORDER_NOT_CREATED",
        message: lastError?.message ?? "unknown",
        hint: lastError?.hint ?? "Retry from the dashboard or `agentpos status --retry`.",
        retryable: lastError?.retryable ?? true,
        attempts,
      },
      updatedAt: new Date().toISOString(),
    };
    this.opts.storage.saveOrder(failed);
    await this.raise({
      severity: "critical",
      code: "ORDER_NOT_CREATED",
      message: "Payment settled but the platform order could not be created; retry loop engaged",
      details: {
        orderId: order.id,
        txHash: order.payment.txHash,
        attempts,
        code: failed.connectorError?.code,
        retryable: failed.connectorError?.retryable,
      },
    });
    return failed;
  }

  /** Re-attempts platform order creation for a paid order that failed (ORDER_NOT_CREATED). */
  async retryConnector(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (order.status !== "paid" || order.externalOrderId || order.hold) return order;
    return this.pushToConnector(order);
  }

  /** Orders that are paid, not on hold, and still without a platform order. */
  stuckOrders(): Order[] {
    return this.opts.storage
      .listOrders({ status: "paid", limit: 500 })
      .filter((o) => !o.externalOrderId && !o.hold);
  }

  /**
   * Persistent retry loop (G1): called periodically by the worker. Backoff grows with attempts
   * (30s, 1m, 2m, ... capped at 30m); an order older than `stallAfterMs` raises a stall alert.
   */
  async retryPending(now = Date.now(), stallAfterMs = 60 * 60_000): Promise<Order[]> {
    const retried: Order[] = [];
    for (const order of this.stuckOrders()) {
      const attempts = order.connectorError?.attempts ?? 0;
      const wait = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - this.attempts));
      const last = new Date(order.updatedAt).getTime();
      if (now - last < wait) continue;
      const result = await this.retryConnector(order.id);
      retried.push(result);
      if (!result.externalOrderId && now - new Date(order.createdAt).getTime() > stallAfterMs) {
        await this.raise({
          severity: "critical",
          code: "RETRY_LOOP_STALLED",
          message: "A paid order has had no platform order for over an hour",
          details: {
            orderId: order.id,
            txHash: order.payment?.txHash,
            attempts: result.connectorError?.attempts,
          },
        });
      }
    }
    return retried;
  }

  // --- order lifecycle (pending_payment -> paid -> fulfilled | cancelled | expired) ----------

  /**
   * Writes one lifecycle transition: storage, log line, and the audit chain when one fits.
   *
   * Receipts (M4): `order.failed` is the chain's "this order did not complete" link, and a
   * cancellation, a refund or an expiry is exactly that, with `discrepancy` saying which. There
   * is no positive counterpart for fulfilment, and inventing a receipt event would fork the
   * receipt format for every verifier that already reads it, so fulfilment is logged only.
   */
  private transition(order: Order, to: OrderStatus, reason: Record<string, unknown>): Order {
    const at = new Date().toISOString();
    const moved: Order = { ...order, status: to, updatedAt: at };
    this.opts.storage.saveOrder(moved);
    this.logger.info("order.status_changed", {
      traceId: order.traceId,
      orderId: order.id,
      from: order.status,
      to,
      ...reason,
    });
    if (to === "cancelled" || to === "expired") {
      this.receipts?.append({
        ...this.receiptContext(moved),
        event: "order.failed",
        at,
        discrepancy: { from: order.status, to, ...reason },
      });
    }
    return moved;
  }

  /**
   * Asks the merchant's platform what became of an order after we handed it over, and mirrors
   * the answer into our own status. Only a `paid` order that already exists in the platform can
   * move: before that there is nothing to ask about, and a terminal order is done.
   *
   * A connector without `getOrderStatus`, a platform status outside the mapping table, or a
   * failing call all leave the order untouched. Nothing here ever creates or reverses a payment.
   */
  async syncOrderStatus(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (isTerminalStatus(order.status) || order.status !== "paid" || !order.externalOrderId) {
      return order;
    }
    const connector = this.opts.connector;
    if (!connector.getOrderStatus) return order;
    const log = this.logger.child({ traceId: order.traceId, orderId: order.id });
    let platformStatus: string;
    try {
      ({ status: platformStatus } = await connector.getOrderStatus(order.externalOrderId));
    } catch (err) {
      log.warn("order.status_sync_failed", {
        externalOrderId: order.externalOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return order;
    }
    const mapped = mapPlatformStatus(platformStatus);
    if (mapped === undefined) {
      // Unknown or still-in-flight status: say so and change nothing.
      log.debug("order.status_unmapped", {
        platform: connector.platform,
        platformStatus,
      });
      return order;
    }
    if (mapped === order.status) return order;
    return this.transition(order, mapped, {
      reason: "platform_status",
      platform: connector.platform,
      platformStatus,
    });
  }

  /**
   * Periodic lifecycle sweep (called by the sidecar worker, like the connector retry loop):
   *
   *  1. `paid` orders that exist in the platform are re-read there, oldest first, at most
   *     `batch` per pass so a large backlog cannot hammer the merchant's API.
   *  2. `pending_payment` orders whose cart has expired become `expired`, so a quote nobody paid
   *     stops looking like a sale in flight.
   *
   * An order with a payment record is NEVER expired here: a settled payment whose order is still
   * pending is the stuck-settlement path, which has its own alerting, and quietly writing it off
   * as expired would hide the one case a merchant must see.
   */
  async sweepOrderLifecycle(now: Date = new Date(), batch = 25): Promise<Order[]> {
    const moved: Order[] = [];
    for (const order of this.opts.storage.listOrdersToSync(batch)) {
      const result = await this.syncOrderStatus(order.id);
      if (result.status !== order.status) moved.push(result);
    }
    for (const order of this.opts.storage.listExpiredPendingOrders(now, batch)) {
      if (order.payment || this.opts.storage.hasPaymentForOrder(order.id)) continue;
      moved.push(this.transition(order, "expired", { reason: "cart_expired" }));
    }
    return moved;
  }

  getOrder(id: string): Order {
    const order = this.opts.storage.getOrder(id);
    if (!order)
      throw new AgentPOSError("ORDER_NOT_FOUND", `Unknown order '${id}'`, {
        hint: "Use the orderId returned by checkout.",
      });
    return order;
  }

  async markSettlementFailed(cartId: string, reason: string): Promise<void> {
    const order = this.opts.storage.getOrderByCart(cartId);
    if (!order || order.status !== "pending_payment") return;
    this.logger.warn("settlement.failed", {
      traceId: order.traceId,
      orderId: order.id,
      cartId,
      reason,
    });
    this.receipts?.append({
      ...this.receiptContext(order),
      event: "order.failed",
      at: new Date().toISOString(),
      discrepancy: { reason },
    });
    await this.raise({
      severity: "warning",
      code: "SETTLEMENT_FAILED",
      message: "Facilitator failed to settle a verified payment; nothing was charged",
      details: { orderId: order.id, cartId, reason },
    });
  }
}
