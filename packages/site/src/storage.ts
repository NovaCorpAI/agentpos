/**
 * Local storage on `node:sqlite` (built into Node >= 22.5): zero native dependencies, so a
 * merchant can `npx agentpos serve` on any box without compilers. The site is the source of
 * truth for its catalog and orders. Rows keep a JSON document plus lookup columns.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Cart,
  CatalogItem,
  CatalogItemDraft,
  ItemStatus,
  Order,
  OrderStatus,
  PaymentRecord,
} from "@agentpos/core";
import {
  ORDER_STATUSES,
  catalogItemFromJson,
  catalogItemToJson,
  draftFromJson,
  draftToJson,
  jsonStringify,
  usdcFromMinor,
} from "@agentpos/core";
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from "@agentpos/approvals";
import type { AgentRecord, AgentStatus, AgentStore } from "@agentpos/identity";
import type { Receipt, ReceiptStore } from "@agentpos/receipts";

type Row = { json: string };

/** Aggregated, publishable metrics: counts and totals, never a buyer or an address. */
export interface PublicMetrics {
  since: string;
  until: string;
  paidOrders: number;
  /** Subset of `paidOrders` the merchant's own platform already reports as completed. */
  fulfilledOrders: number;
  totalMinor: string;
  heldOrders: number;
  /** Paid orders whose platform order has not been created yet (connector retrying). */
  pendingPlatformOrders: number;
  uniquePayers: number;
  uniqueIdentifiedAgents: number;
  latencyMs: { samples: number; p50?: number; p95?: number };
  byDay: Array<{ day: string; orders: number; totalMinor: string }>;
}

/** A fiat amount comes back from JSON with its minor as a string; make it a bigint again. */
function reviveFiat(v: unknown) {
  if (!v || typeof v !== "object") return {};
  const f = v as { minor: unknown; currency: string; decimals: number };
  return { minor: BigInt(String(f.minor)), currency: f.currency, decimals: f.decimals };
}

function reviveQuote(q: Record<string, unknown>) {
  const lines = (q.lines as Array<Record<string, unknown>>).map((l) => ({
    ...l,
    unitPriceUsdc: usdcFromMinor(String(l.unitPriceUsdc)),
    lineTotalUsdc: usdcFromMinor(String(l.lineTotalUsdc)),
    ...(l.unitPriceFiat ? { unitPriceFiat: reviveFiat(l.unitPriceFiat) } : {}),
    ...(l.lineTotalFiat ? { lineTotalFiat: reviveFiat(l.lineTotalFiat) } : {}),
  }));
  return {
    ...q,
    lines,
    totalUsdc: usdcFromMinor(String(q.totalUsdc)),
    ...(q.totalFiat ? { totalFiat: reviveFiat(q.totalFiat) } : {}),
  };
}

function reviveCart(json: string): Cart {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return { ...raw, quote: reviveQuote(raw.quote as Record<string, unknown>) } as Cart;
}

function reviveOrder(json: string): Order {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const payment = raw.payment as Record<string, unknown> | undefined;
  return {
    ...raw,
    quote: reviveQuote(raw.quote as Record<string, unknown>),
    ...(payment
      ? { payment: { ...payment, amountMinor: usdcFromMinor(String(payment.amountMinor)) } }
      : {}),
  } as Order;
}

/**
 * The hash as the payments table keys it. EVM hashes are hex and case-insensitive, so one
 * transaction spelled two ways is one payment; every other network keeps the reference verbatim
 * (a card rail's reference is case-sensitive).
 */
export function paymentKey(network: string, txHash: string): string {
  return network.startsWith("eip155:") ? txHash.toLowerCase() : txHash;
}

export class SiteStorage {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("pragma journal_mode = WAL");
    this.db.exec(`
      create table if not exists items (id text primary key, status text not null, json text not null, updated_at text not null);
      create table if not exists drafts (id text primary key, json text not null);
      create table if not exists carts (id text primary key, json text not null, expires_at text not null);
      create table if not exists orders (id text primary key, cart_id text not null unique, status text not null, json text not null, created_at text not null, updated_at text not null);
      create table if not exists payments (network text not null, tx_hash text not null, order_id text not null, json text not null, primary key (network, tx_hash));
      create table if not exists approvals (id text primary key, cart_id text not null, status text not null, json text not null, created_at text not null, expires_at text not null);
      create index if not exists approvals_cart_idx on approvals(cart_id);
      create table if not exists agents (agent_key text primary key, owner text not null, status text not null, json text not null, registered_at text not null);
      create table if not exists receipts (seq integer primary key, hash text not null unique, prev text not null, event text not null, order_id text, at text not null, json text not null);
      create index if not exists receipts_order_idx on receipts(order_id);
      create index if not exists receipts_at_idx on receipts(at);
      create table if not exists meta (key text primary key, value text not null);
    `);
    this.migratePaymentsKey();
  }

  /**
   * Databases created before 0.1.3 keyed payments by the transaction hash alone. The key is now
   * the network plus the hash (D2): two networks may one day produce the same hash, and a payment
   * on one must never count as the payment on another. Each row keeps its own network, so the
   * move is exact; it runs once, in a transaction, before the store serves anything.
   */
  private migratePaymentsKey(): void {
    const columns = this.db.prepare("pragma table_info(payments)").all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "network")) return;
    this.db.exec(`
      begin;
      alter table payments rename to payments_by_hash;
      create table payments (network text not null, tx_hash text not null, order_id text not null, json text not null, primary key (network, tx_hash));
      insert into payments (network, tx_hash, order_id, json)
        select coalesce(json_extract(json, '$.network'), ''),
               case when json_extract(json, '$.network') like 'eip155:%' then lower(tx_hash) else tx_hash end,
               order_id, json
        from payments_by_hash;
      drop table payments_by_hash;
      commit;
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Consistent online backup (G1 operations): SQLite `VACUUM INTO` a new file. */
  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.db.exec(`vacuum into '${destination.replace(/'/g, "''")}'`);
  }

  /** Counts for health and status. */
  counts(): { items: number; drafts: number; carts: number; orders: number; payments: number } {
    const n = (table: string) =>
      Number((this.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
    return {
      items: n("items"),
      drafts: n("drafts"),
      carts: n("carts"),
      orders: n("orders"),
      payments: n("payments"),
    };
  }

  /**
   * Aggregated public metrics (G2). Deliberately counts and totals only: no buyer data, no
   * addresses, no order ids. A merchant can publish this without publishing their customers.
   *
   * `latency` measures the loop the merchant actually cares about: from the moment the order was
   * registered at checkout to the moment their own platform confirmed it. Orders still waiting on
   * a failing connector are excluded from the percentiles and counted in `pendingPlatformOrders`,
   * because averaging in an order that never completed would flatter the number.
   */
  publicMetrics(since: Date, now: Date = new Date()): PublicMetrics {
    const rows = this.db
      .prepare("select json from orders where created_at >= ? order by created_at asc")
      .all(since.toISOString()) as Row[];

    const byDay = new Map<string, { orders: number; totalMinor: bigint }>();
    const payers = new Set<string>();
    const agents = new Set<string>();
    const latencies: number[] = [];
    let paidOrders = 0;
    let fulfilledOrders = 0;
    let totalMinor = 0n;
    let held = 0;
    let pendingPlatformOrders = 0;

    for (const row of rows) {
      const order = JSON.parse(row.json) as {
        status: string;
        createdAt: string;
        updatedAt: string;
        quote: { totalUsdc: string };
        payment?: { payer?: string };
        agent?: { agentKey?: string };
        hold?: unknown;
        externalOrderId?: string;
      };
      if (order.hold) held += 1;
      if (order.status !== "paid" && order.status !== "fulfilled") continue;
      paidOrders += 1;
      if (order.status === "fulfilled") fulfilledOrders += 1;
      const amount = BigInt(order.quote.totalUsdc);
      totalMinor += amount;
      const day = order.createdAt.slice(0, 10);
      const bucket = byDay.get(day) ?? { orders: 0, totalMinor: 0n };
      bucket.orders += 1;
      bucket.totalMinor += amount;
      byDay.set(day, bucket);
      if (order.payment?.payer) payers.add(order.payment.payer);
      if (order.agent?.agentKey) agents.add(order.agent.agentKey);
      if (order.externalOrderId) {
        const ms = new Date(order.updatedAt).getTime() - new Date(order.createdAt).getTime();
        if (Number.isFinite(ms) && ms >= 0) latencies.push(ms);
      } else {
        pendingPlatformOrders += 1;
      }
    }

    latencies.sort((a, b) => a - b);
    const percentile = (p: number): number | undefined =>
      latencies.length === 0
        ? undefined
        : (latencies[
            Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
          ] as number);

    return {
      since: since.toISOString(),
      until: now.toISOString(),
      paidOrders,
      fulfilledOrders,
      totalMinor: totalMinor.toString(),
      heldOrders: held,
      pendingPlatformOrders,
      uniquePayers: payers.size,
      uniqueIdentifiedAgents: agents.size,
      latencyMs: {
        samples: latencies.length,
        ...(percentile(50) !== undefined ? { p50: percentile(50) as number } : {}),
        ...(percentile(95) !== undefined ? { p95: percentile(95) as number } : {}),
      },
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, v]) => ({ day, orders: v.orders, totalMinor: v.totalMinor.toString() })),
    };
  }

  private transaction(fn: () => void): void {
    this.db.exec("begin");
    try {
      fn();
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  // items -------------------------------------------------------------------
  upsertItem(item: CatalogItem): void {
    this.db
      .prepare(
        "insert into items (id, status, json, updated_at) values (?, ?, ?, ?) on conflict(id) do update set status = excluded.status, json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(item.id, item.status, jsonStringify(catalogItemToJson(item)), new Date().toISOString());
  }

  getItem(id: string): CatalogItem | undefined {
    const row = this.db.prepare("select json from items where id = ?").get(id) as Row | undefined;
    return row ? catalogItemFromJson(JSON.parse(row.json)) : undefined;
  }

  listItems(status?: ItemStatus): CatalogItem[] {
    const rows = (
      status
        ? this.db.prepare("select json from items where status = ? order by id").all(status)
        : this.db.prepare("select json from items order by id").all()
    ) as Row[];
    return rows.map((r) => catalogItemFromJson(JSON.parse(r.json)));
  }

  setItemStatus(id: string, status: ItemStatus): void {
    const item = this.getItem(id);
    if (item) this.upsertItem({ ...item, status });
  }

  deleteItem(id: string): void {
    this.db.prepare("delete from items where id = ?").run(id);
  }

  // drafts ------------------------------------------------------------------
  replaceDrafts(drafts: CatalogItemDraft[]): void {
    this.transaction(() => {
      this.db.prepare("delete from drafts").run();
      const insert = this.db.prepare("insert into drafts (id, json) values (?, ?)");
      for (const d of drafts) insert.run(d.id, jsonStringify(draftToJson(d)));
    });
  }

  listDrafts(): CatalogItemDraft[] {
    const rows = this.db.prepare("select json from drafts order by id").all() as Row[];
    return rows.map((r) => draftFromJson(JSON.parse(r.json)));
  }

  deleteDraft(id: string): void {
    this.db.prepare("delete from drafts where id = ?").run(id);
  }

  // carts -------------------------------------------------------------------
  saveCart(cart: Cart): void {
    this.db
      .prepare(
        "insert into carts (id, json, expires_at) values (?, ?, ?) on conflict(id) do update set json = excluded.json, expires_at = excluded.expires_at",
      )
      .run(cart.id, jsonStringify(cart), cart.expiresAt);
  }

  getCart(id: string): Cart | undefined {
    const row = this.db.prepare("select json from carts where id = ?").get(id) as Row | undefined;
    return row ? reviveCart(row.json) : undefined;
  }

  deleteExpiredCarts(now: Date = new Date()): number {
    // Keep carts that already have an order (needed for reconciliation of late payments).
    const result = this.db
      .prepare("delete from carts where expires_at < ? and id not in (select cart_id from orders)")
      .run(now.toISOString());
    return Number(result.changes);
  }

  // orders ------------------------------------------------------------------
  saveOrder(order: Order): void {
    this.db
      .prepare(
        "insert into orders (id, cart_id, status, json, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do update set status = excluded.status, json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(
        order.id,
        order.cartId,
        order.status,
        jsonStringify(order),
        order.createdAt,
        order.updatedAt,
      );
  }

  getOrder(id: string): Order | undefined {
    const row = this.db.prepare("select json from orders where id = ?").get(id) as Row | undefined;
    return row ? reviveOrder(row.json) : undefined;
  }

  getOrderByCart(cartId: string): Order | undefined {
    const row = this.db.prepare("select json from orders where cart_id = ?").get(cartId) as
      Row | undefined;
    return row ? reviveOrder(row.json) : undefined;
  }

  listOrders(options: { status?: OrderStatus; limit?: number } = {}): Order[] {
    const rows = (
      options.status
        ? this.db
            .prepare("select json from orders where status = ? order by created_at desc limit ?")
            .all(options.status, options.limit ?? 50)
        : this.db
            .prepare("select json from orders order by created_at desc limit ?")
            .all(options.limit ?? 50)
    ) as Row[];
    return rows.map((r) => reviveOrder(r.json));
  }

  /**
   * Keyset-paginated order page, oldest first (merchant API). The `(created_at, id)` pair is a
   * total order over rows, so a cursor made of the last row's pair resumes exactly where the
   * previous page ended even when two orders share a timestamp; AgentPOS Cloud syncs
   * incrementally by keeping the last cursor and asking again.
   */
  listOrdersPage(options: {
    status?: OrderStatus;
    since?: Date;
    until?: Date;
    limit: number;
    after?: { createdAt: string; id: string };
  }): Order[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.since) {
      where.push("created_at >= ?");
      params.push(options.since.toISOString());
    }
    if (options.until) {
      where.push("created_at <= ?");
      params.push(options.until.toISOString());
    }
    if (options.after) {
      where.push("(created_at > ? or (created_at = ? and id > ?))");
      params.push(options.after.createdAt, options.after.createdAt, options.after.id);
    }
    const rows = this.db
      .prepare(
        `select json from orders${where.length > 0 ? ` where ${where.join(" and ")}` : ""} order by created_at asc, id asc limit ?`,
      )
      .all(...params, options.limit) as Row[];
    return rows.map((r) => reviveOrder(r.json));
  }

  /**
   * Orders per status (merchant API summary). Every status in the lifecycle is present, zero
   * included, so a reader never has to guess whether a missing key means "none" or "this store
   * does not track that status".
   */
  orderStatusCounts(): Record<OrderStatus, number> {
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<
      OrderStatus,
      number
    >;
    const rows = this.db
      .prepare("select status, count(*) as n from orders group by status")
      .all() as Array<{ status: string; n: number }>;
    for (const row of rows) counts[row.status as OrderStatus] = Number(row.n);
    return counts;
  }

  /**
   * Paid orders that already exist in the merchant's platform, oldest first (status sweep).
   * These are the only ones worth asking the platform about: an order with no platform id has
   * nothing to sync, and a terminal one never moves again.
   */
  listOrdersToSync(limit: number): Order[] {
    const rows = this.db
      .prepare(
        "select json from orders where status = 'paid' and json_extract(json, '$.externalOrderId') is not null order by created_at asc limit ?",
      )
      .all(limit) as Row[];
    return rows.map((r) => reviveOrder(r.json));
  }

  /**
   * Orders still waiting for a payment whose cart has already expired, oldest first. The caller
   * decides what to do with them; an order that has a payment is NOT excluded here, so the
   * caller can (and must) apply that rule explicitly.
   */
  listExpiredPendingOrders(now: Date, limit: number): Order[] {
    const rows = this.db
      .prepare(
        "select o.json as json from orders o join carts c on c.id = o.cart_id where o.status = 'pending_payment' and c.expires_at < ? order by o.created_at asc limit ?",
      )
      .all(now.toISOString(), limit) as Row[];
    return rows.map((r) => reviveOrder(r.json));
  }

  /** True when any settlement was ever recorded for this order (idempotency table, guardrail 6). */
  hasPaymentForOrder(orderId: string): boolean {
    const row = this.db
      .prepare("select count(*) as n from payments where order_id = ?")
      .get(orderId) as { n: number };
    return Number(row.n) > 0;
  }

  /** Published items only, without deserializing them (merchant API summary). */
  publishedItemCount(): number {
    const row = this.db
      .prepare("select count(*) as n from items where status = 'published'")
      .get() as { n: number };
    return Number(row.n);
  }

  /** Height of the receipt chain as stored (merchant API summary). */
  receiptCount(): number {
    const row = this.db.prepare("select count(*) as n from receipts").get() as { n: number };
    return Number(row.n);
  }

  /** Receipt chain page by sequence, ascending (merchant API). `seq` is 1-based and gap-free. */
  listReceiptsAfterSeq(afterSeq: number, limit: number): Receipt[] {
    const rows = this.db
      .prepare("select json from receipts where seq > ? order by seq asc limit ?")
      .all(afterSeq, limit) as Row[];
    return rows.map((r) => JSON.parse(r.json) as Receipt);
  }

  /** One receipt by chain position (merchant API detail). */
  getReceiptBySeq(seq: number): Receipt | undefined {
    const row = this.db.prepare("select json from receipts where seq = ?").get(seq) as
      Row | undefined;
    return row ? (JSON.parse(row.json) as Receipt) : undefined;
  }

  /** Orders created inside [since, until], oldest first (reconciliation export). */
  listOrdersBetween(since: Date, until: Date): Order[] {
    const rows = this.db
      .prepare(
        "select json from orders where created_at >= ? and created_at <= ? order by created_at asc",
      )
      .all(since.toISOString(), until.toISOString()) as Row[];
    return rows.map((r) => reviveOrder(r.json));
  }

  /**
   * Volume already committed since `since` (M1 policy accumulator): settled orders plus carts
   * awaiting merchant approval that have not expired. Counting the pending ones is deliberate,
   * otherwise a burst of unapproved carts could collectively pass the period limit.
   */
  committedSince(since: Date, now: Date = new Date(), excludeCartId?: string): bigint {
    const iso = since.toISOString();
    const paid = this.db
      .prepare("select json from orders where created_at >= ? and status in ('paid','fulfilled')")
      .all(iso) as Row[];
    let total = 0n;
    for (const row of paid)
      total += BigInt((JSON.parse(row.json) as { quote: { totalUsdc: string } }).quote.totalUsdc);
    const carts = this.db
      .prepare(
        "select json from carts where expires_at > ? and id not in (select cart_id from orders)",
      )
      .all(now.toISOString()) as Row[];
    for (const row of carts) {
      const cart = JSON.parse(row.json) as {
        id: string;
        createdAt: string;
        policy?: { decision: string };
        quote: { totalUsdc: string };
      };
      if (cart.id === excludeCartId) continue; // never count the cart being evaluated against itself
      if (cart.policy?.decision === "requires_approval" && cart.createdAt >= iso)
        total += BigInt(cart.quote.totalUsdc);
    }
    return total;
  }

  // payments (idempotency by network + tx hash, guardrail 6 and D2) ---------
  recordPayment(orderId: string, payment: PaymentRecord): boolean {
    const result = this.db
      .prepare(
        "insert or ignore into payments (network, tx_hash, order_id, json) values (?, ?, ?, ?)",
      )
      .run(
        payment.network,
        paymentKey(payment.network, payment.txHash),
        orderId,
        jsonStringify(payment),
      );
    return Number(result.changes) === 1;
  }

  getPayment(
    network: string,
    txHash: string,
  ): { orderId: string; payment: PaymentRecord } | undefined {
    const row = this.db
      .prepare("select order_id, json from payments where network = ? and tx_hash = ?")
      .get(network, paymentKey(network, txHash)) as { order_id: string; json: string } | undefined;
    if (!row) return undefined;
    const raw = JSON.parse(row.json) as Record<string, unknown>;
    return {
      orderId: row.order_id,
      payment: { ...raw, amountMinor: usdcFromMinor(String(raw.amountMinor)) } as PaymentRecord,
    };
  }

  // approvals (M2) -----------------------------------------------------------
  /** ApprovalStore backed by this database, for @agentpos/approvals. */
  approvalStore(): ApprovalStore {
    const db = this.db;
    return {
      save(request: ApprovalRequest): void {
        db.prepare(
          "insert into approvals (id, cart_id, status, json, created_at, expires_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do update set status = excluded.status, json = excluded.json",
        ).run(
          request.id,
          request.cartId,
          request.status,
          JSON.stringify(request),
          request.createdAt,
          request.expiresAt,
        );
      },
      get(id: string): ApprovalRequest | undefined {
        const row = db.prepare("select json from approvals where id = ?").get(id) as
          Row | undefined;
        return row ? (JSON.parse(row.json) as ApprovalRequest) : undefined;
      },
      getByCart(cartId: string): ApprovalRequest | undefined {
        const row = db
          .prepare("select json from approvals where cart_id = ? order by created_at desc limit 1")
          .get(cartId) as Row | undefined;
        return row ? (JSON.parse(row.json) as ApprovalRequest) : undefined;
      },
      list(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
        const rows = (
          options.status
            ? db
                .prepare(
                  "select json from approvals where status = ? order by created_at desc limit ?",
                )
                .all(options.status, options.limit ?? 100)
            : db
                .prepare("select json from approvals order by created_at desc limit ?")
                .all(options.limit ?? 100)
        ) as Row[];
        return rows.map((r) => JSON.parse(r.json) as ApprovalRequest);
      },
    };
  }

  // agents (M3) --------------------------------------------------------------
  /** AgentStore backed by this database, for @agentpos/identity. Read on every request, so a
   *  revocation takes effect on the next call rather than on a cache expiry. */
  agentStore(): AgentStore {
    const db = this.db;
    return {
      save(record: AgentRecord): void {
        db.prepare(
          "insert into agents (agent_key, owner, status, json, registered_at) values (?, ?, ?, ?, ?) on conflict(agent_key) do update set owner = excluded.owner, status = excluded.status, json = excluded.json",
        ).run(
          record.agentKey,
          record.owner,
          record.status,
          JSON.stringify(record),
          record.registeredAt,
        );
      },
      get(agentKey: string): AgentRecord | undefined {
        const row = db.prepare("select json from agents where agent_key = ?").get(agentKey) as
          Row | undefined;
        return row ? (JSON.parse(row.json) as AgentRecord) : undefined;
      },
      list(options: { status?: AgentStatus; limit?: number } = {}): AgentRecord[] {
        const rows = (
          options.status
            ? db
                .prepare(
                  "select json from agents where status = ? order by registered_at desc limit ?",
                )
                .all(options.status, options.limit ?? 200)
            : db
                .prepare("select json from agents order by registered_at desc limit ?")
                .all(options.limit ?? 200)
        ) as Row[];
        return rows.map((r) => JSON.parse(r.json) as AgentRecord);
      },
    };
  }

  // receipts (M4) ------------------------------------------------------------
  /**
   * Append-only receipt chain. `seq` is the primary key and `hash` is unique, so a duplicated or
   * re-numbered link is refused by the database rather than by convention.
   */
  receiptStore(): ReceiptStore {
    const db = this.db;
    return {
      append(receipt: Receipt): void {
        db.prepare(
          "insert into receipts (seq, hash, prev, event, order_id, at, json) values (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          receipt.body.seq,
          receipt.hash,
          receipt.body.prev,
          receipt.body.event,
          receipt.body.order?.id ?? null,
          receipt.body.at,
          JSON.stringify(receipt),
        );
      },
      last(): Receipt | undefined {
        const row = db.prepare("select json from receipts order by seq desc limit 1").get() as
          Row | undefined;
        return row ? (JSON.parse(row.json) as Receipt) : undefined;
      },
      get(hash: string): Receipt | undefined {
        const row = db.prepare("select json from receipts where hash = ?").get(hash) as
          Row | undefined;
        return row ? (JSON.parse(row.json) as Receipt) : undefined;
      },
      list(options: { from?: string; to?: string; limit?: number } = {}): Receipt[] {
        const rows = db
          .prepare("select json from receipts where at >= ? and at <= ? order by seq asc limit ?")
          .all(options.from ?? "", options.to ?? "9999", options.limit ?? 100_000) as Row[];
        return rows.map((r) => JSON.parse(r.json) as Receipt);
      },
      byOrder(orderId: string): Receipt[] {
        const rows = db
          .prepare("select json from receipts where order_id = ? order by seq asc")
          .all(orderId) as Row[];
        return rows.map((r) => JSON.parse(r.json) as Receipt);
      },
    };
  }

  // meta --------------------------------------------------------------------
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("select value from meta where key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }
}
