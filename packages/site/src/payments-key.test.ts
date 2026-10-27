/**
 * The idempotency key of a payment is the network plus the transaction hash (D2, guardrail 6):
 * one payment pays one order, a payment on one network never stands in for one on another, and
 * databases written before the key changed move over intact.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { usdc } from "@agentpos/core";
import type { PaymentRecord } from "@agentpos/core";
import { SiteStorage } from "./storage.js";

const ARC = "eip155:5042002";
const STELLAR = "stellar:testnet";

const payment = (network: string, txHash: string): PaymentRecord => ({
  txHash,
  network,
  asset: "USDC",
  amountMinor: usdc("2.5"),
  ts: "2026-10-27T12:00:00.000Z",
});

describe("payments keyed by network and hash", () => {
  it("records a payment once per network and hash", () => {
    const storage = new SiteStorage(":memory:");
    expect(storage.recordPayment("ord_1", payment(STELLAR, "abc123"))).toBe(true);
    expect(storage.recordPayment("ord_2", payment(STELLAR, "abc123"))).toBe(false);
    expect(storage.getPayment(STELLAR, "abc123")?.orderId).toBe("ord_1");
  });

  it("never lets a hash on one network stand in for the same hash on another", () => {
    const storage = new SiteStorage(":memory:");
    storage.recordPayment("ord_1", payment(STELLAR, "0xfeed"));
    expect(storage.getPayment(ARC, "0xfeed")).toBeUndefined();
    expect(storage.recordPayment("ord_2", payment(ARC, "0xfeed"))).toBe(true);
    expect(storage.getPayment(ARC, "0xfeed")?.orderId).toBe("ord_2");
  });

  it("treats an EVM hash spelled in another case as the same payment", () => {
    const storage = new SiteStorage(":memory:");
    storage.recordPayment("ord_1", payment(ARC, "0xABCDEF"));
    expect(storage.recordPayment("ord_2", payment(ARC, "0xabcdef"))).toBe(false);
    expect(storage.getPayment(ARC, "0xAbCdEf")?.orderId).toBe("ord_1");
  });

  it("keeps the exact reference on other networks (a card reference is case-sensitive)", () => {
    const storage = new SiteStorage(":memory:");
    storage.recordPayment("ord_1", payment("transbank:integration", "BuyOrder-A"));
    expect(storage.getPayment("transbank:integration", "buyorder-a")).toBeUndefined();
  });
});

describe("migration from payments keyed by hash alone", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("moves every payment over with its own network, once", () => {
    dir = mkdtempSync(join(tmpdir(), "agentpos-payments-"));
    const file = join(dir, "agentpos.sqlite");
    const old = new DatabaseSync(file);
    old.exec(
      "create table payments (tx_hash text primary key, order_id text not null, json text not null)",
    );
    const insert = old.prepare("insert into payments (tx_hash, order_id, json) values (?, ?, ?)");
    for (const [orderId, p] of [
      ["ord_s", payment(STELLAR, "stellar_hash")],
      ["ord_a", payment(ARC, "0xABC")],
    ] as const) {
      insert.run(
        p.txHash,
        orderId,
        JSON.stringify({ ...p, amountMinor: p.amountMinor.toString() }),
      );
    }
    old.close();

    const storage = new SiteStorage(file);
    expect(storage.getPayment(STELLAR, "stellar_hash")?.orderId).toBe("ord_s");
    expect(storage.getPayment(ARC, "0xabc")?.orderId).toBe("ord_a");
    expect(storage.recordPayment("ord_x", payment(ARC, "0xAbC"))).toBe(false);
    expect(storage.counts().payments).toBe(2);
    storage.close();

    // A second start finds the new key and leaves the table as it is.
    const again = new SiteStorage(file);
    expect(again.getPayment(STELLAR, "stellar_hash")?.orderId).toBe("ord_s");
    again.close();
  });
});
