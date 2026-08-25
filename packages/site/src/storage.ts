/**
 * Local storage on `node:sqlite` (built into Node >= 22.5): zero native dependencies, so a
 * merchant can `npx agentgate serve` on any box without compilers. The site is the source of
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
} from "@agentgate/core";
import {
  catalogItemFromJson,
  catalogItemToJson,
  draftFromJson,
  draftToJson,
  jsonStringify,
  usdcFromMinor,
} from "@agentgate/core";

type Row = { json: string };

function reviveQuote(q: Record<string, unknown>) {
  const lines = (q.lines as Array<Record<string, unknown>>).map((l) => ({
    ...l,
    unitPriceUsdc: usdcFromMinor(String(l.unitPriceUsdc)),
    lineTotalUsdc: usdcFromMinor(String(l.lineTotalUsdc)),
  }));
  return { ...q, lines, totalUsdc: usdcFromMinor(String(q.totalUsdc)) };
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
      create table if not exists payments (tx_hash text primary key, order_id text not null, json text not null);
      create table if not exists meta (key text primary key, value text not null);
    `);
  }

  close(): void {
    this.db.close();
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

  // payments (idempotency by tx hash, guardrail 6) --------------------------
  recordPayment(orderId: string, payment: PaymentRecord): boolean {
    const result = this.db
      .prepare("insert or ignore into payments (tx_hash, order_id, json) values (?, ?, ?)")
      .run(payment.txHash, orderId, jsonStringify(payment));
    return Number(result.changes) === 1;
  }

  getPayment(txHash: string): { orderId: string; payment: PaymentRecord } | undefined {
    const row = this.db
      .prepare("select order_id, json from payments where tx_hash = ?")
      .get(txHash) as { order_id: string; json: string } | undefined;
    if (!row) return undefined;
    const raw = JSON.parse(row.json) as Record<string, unknown>;
    return {
      orderId: row.order_id,
      payment: { ...raw, amountMinor: usdcFromMinor(String(raw.amountMinor)) } as PaymentRecord,
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
