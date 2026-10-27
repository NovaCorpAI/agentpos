/**
 * Reconciliation for the extra networks a rail adds (risk D3): what the chain says the merchant
 * received, against the payments the store recorded. The failure it catches is the one that
 * costs a buyer money: a payment that settled into the merchant's wallet with no order behind it
 * (the facilitator settled, then the store crashed before recording the transaction).
 *
 * Read-only and alert-only: it never creates an order and never moves funds. The merchant
 * decides, with the candidates it lists (pending orders on that network with the same amount).
 * The chain side comes from the rail as a `PaymentWatcher`, so this file imports no network.
 */
import type { Logger, UsdcMinor } from "@agentpos/core";
import { formatUsdc, silentLogger } from "@agentpos/core";
import type { AlertEvent, AlertSink } from "./checkout.js";
import type { SiteStorage } from "./storage.js";

/** A payment the merchant's wallet received on one network, amount in the catalog's unit. */
export interface ReceivedPayment {
  txHash: string;
  amountMinor: UsdcMinor;
  /** Payer address on that network. */
  from: string;
}

/**
 * Brought by a rail (for Arc, `createArcPaymentWatcher` in `@agentpos/rail-arc`). Each call
 * returns the payments received since the previous one; the watcher keeps its own cursor and
 * converts amounts exactly to the catalog's unit.
 */
export interface PaymentWatcher {
  recentPayments(): Promise<ReceivedPayment[]>;
}

export interface NetworkReconciliation {
  network: string;
  lastRunAt?: string;
  /** Set when the last run could not read the chain. */
  error?: string;
  /** Payments past the grace period that still have no order. */
  paymentsWithoutOrder: number;
}

interface Unresolved {
  network: string;
  payment: ReceivedPayment;
  firstSeen: number;
  alerted: boolean;
}

export interface PaymentReconcilerOptions {
  storage: SiteStorage;
  watchers: ReadonlyArray<{ network: string; watcher: PaymentWatcher }>;
  /**
   * How long a payment may go unmatched before it is reported: the store records the transaction
   * right after settle, so a payment seen in that instant is not lost. Default 2 minutes.
   */
  graceMs?: number;
  logger?: Logger;
  alert?: AlertSink;
}

export class PaymentReconciler {
  private readonly unresolved = new Map<string, Unresolved>();
  private readonly status = new Map<string, NetworkReconciliation>();
  private readonly graceMs: number;
  private readonly logger: Logger;
  private readonly alert: AlertSink;

  constructor(private readonly opts: PaymentReconcilerOptions) {
    this.graceMs = opts.graceMs ?? 2 * 60_000;
    this.logger = opts.logger ?? silentLogger;
    this.alert = opts.alert ?? (() => {});
    for (const { network } of opts.watchers) {
      this.status.set(network, { network, paymentsWithoutOrder: 0 });
    }
  }

  /** Last outcome per network, for /health. */
  report(): NetworkReconciliation[] {
    return [...this.status.values()].map((s) => ({ ...s }));
  }

  /** One pass over every network. A network whose chain cannot be read never blocks the rest. */
  async run(now = Date.now()): Promise<NetworkReconciliation[]> {
    for (const { network, watcher } of this.opts.watchers) {
      const at = new Date(now).toISOString();
      try {
        for (const payment of await watcher.recentPayments()) {
          const key = `${network}:${payment.txHash.toLowerCase()}`;
          if (!this.unresolved.has(key)) {
            this.unresolved.set(key, { network, payment, firstSeen: now, alerted: false });
          }
        }
        this.status.set(network, { network, lastRunAt: at, paymentsWithoutOrder: 0 });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn("reconcile.read_failed", { network, error });
        this.status.set(network, { network, lastRunAt: at, error, paymentsWithoutOrder: 0 });
      }
    }
    // Payments already seen are re-checked on every pass, whether or not the watcher returns
    // them again, so a store that records late clears them and one that never does is reported.
    for (const [key, entry] of this.unresolved) {
      if (this.isRecorded(entry.network, entry.payment.txHash)) {
        this.unresolved.delete(key);
        continue;
      }
      if (now - entry.firstSeen < this.graceMs) continue;
      const s = this.status.get(entry.network);
      if (s) s.paymentsWithoutOrder += 1;
      if (entry.alerted) continue;
      entry.alerted = true;
      await this.raise(entry);
    }
    return this.report();
  }

  private isRecorded(network: string, txHash: string): boolean {
    return this.opts.storage.getPayment(network, txHash) !== undefined;
  }

  private async raise({ network, payment }: Unresolved): Promise<void> {
    // Orders still waiting for payment with the same total: the likely owner of this money.
    const candidates = this.opts.storage
      .listOrders({ status: "pending_payment", limit: 500 })
      .filter((o) => o.quote.totalUsdc === payment.amountMinor)
      .slice(0, 5)
      .map((o) => o.id);
    const event: AlertEvent = {
      severity: "critical",
      code: "PAYMENT_WITHOUT_ORDER",
      message: `The store received ${formatUsdc(payment.amountMinor)} USDC on ${network} with no order. Match it to an order or refund it.`,
      details: {
        network,
        txHash: payment.txHash,
        from: payment.from,
        amountMinor: payment.amountMinor.toString(),
        candidateOrders: candidates,
      },
      at: new Date().toISOString(),
    };
    this.logger.error(`alert.${event.code}`, { severity: event.severity, ...event.details });
    try {
      await this.alert(event);
    } catch (err) {
      this.logger.warn("alert.sink_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
