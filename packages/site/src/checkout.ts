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
  PaymentRecord,
  Quote,
  QuoteLine,
  SettlementReceipt,
  UsdcMinor,
} from "@agentgate/core";
import {
  AgentGateError,
  addUsdc,
  compareUsdc,
  mulUsdc,
  silentLogger,
  usdcFromMinor,
} from "@agentgate/core";
import { OPEN_POLICY, evaluatePolicy, periodStart } from "@agentgate/policy";
import type { MerchantPolicy, PolicyDecision } from "@agentgate/policy";
import type { ApprovalRequest, ApprovalService, ApprovalSnapshot } from "@agentgate/approvals";
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
  /** Immediate connector retries after settlement before giving up (background retry continues). */
  connectorAttempts?: number;
  logger?: Logger;
  alert?: AlertSink;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export class CheckoutService {
  private readonly attempts: number;
  private readonly logger: Logger;
  private readonly alert: AlertSink;
  private readonly policy: MerchantPolicy;
  private approvals: ApprovalService | undefined;

  constructor(private readonly opts: CheckoutOptions) {
    this.attempts = opts.connectorAttempts ?? 3;
    this.logger = opts.logger ?? silentLogger;
    this.alert = opts.alert ?? (() => {});
    this.policy = opts.policy ?? OPEN_POLICY;
    this.approvals = opts.approvals;
  }

  /** Wires the approval queue after construction (the app builds it from the same storage). */
  setApprovals(approvals: ApprovalService | undefined): void {
    this.approvals = approvals;
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

  /** Denied decisions become typed errors the agent can reason about. */
  private assertNotDenied(decision: PolicyDecision): void {
    if (decision.decision !== "denied") return;
    throw new AgentGateError(decision.code, decision.message, {
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
    await this.assertAvailable(
      items.map(({ item, quantity }) => ({
        itemId: item.id,
        externalId: item.externalId,
        stockMode: item.stockMode,
        quantity,
      })),
    );

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

    // Merchant policy, first pass (M1). A denial stops the quote here: the agent gets a typed
    // reason instead of a cart it could never pay.
    const decision = this.runPolicy(quote, shipping?.country);
    this.assertNotDenied(decision);

    const now = new Date();
    const cart: Cart = {
      id: newId("cart"),
      lines: [...merged.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
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
      throw new AgentGateError(
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
        if (err instanceof AgentGateError && err.code === "OUT_OF_STOCK")
          drift.push({ reason: "out_of_stock", ...err.details });
        else throw err;
      }
    }
    if (drift.length > 0) {
      this.opts.storage.saveCart({ ...cart, expiresAt: new Date(0).toISOString() });
      this.logger.warn("cart.requote_required", { traceId: cart.traceId, cartId: id, drift });
      throw new AgentGateError(
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
    this.assertNotDenied(decision);
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
      throw new AgentGateError("POLICY_APPROVAL_REQUIRED", decision.message, {
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
      throw new AgentGateError("POLICY_APPROVAL_REQUIRED", decision.message, {
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
    return this.pushToConnector(paid);
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
        log.info("order.created_in_platform", {
          platform: this.opts.connector.platform,
          externalOrderId: result.externalOrderId,
          attempts,
        });
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
        hint: lastError?.hint ?? "Retry from the dashboard or `agentgate status --retry`.",
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

  getOrder(id: string): Order {
    const order = this.opts.storage.getOrder(id);
    if (!order)
      throw new AgentGateError("ORDER_NOT_FOUND", `Unknown order '${id}'`, {
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
    await this.raise({
      severity: "warning",
      code: "SETTLEMENT_FAILED",
      message: "Facilitator failed to settle a verified payment; nothing was charged",
      details: { orderId: order.id, cartId, reason },
    });
  }
}
