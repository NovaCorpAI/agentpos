/**
 * Fiscal as a plugin (SPEC 03). Interface only in core; implementations live in
 * packages/fiscal and are optional. Nothing here is on the v1 critical path.
 */
import type { UsdcMinor } from "./money.js";

export interface FiscalPayment {
  paymentId: string;
  txHash: string;
  amountUsdc: UsdcMinor;
  /** Ledger close time, ISO 8601. */
  ts: string;
}

export interface FiscalValorization {
  /** Units of local currency per 1 USDC, as a decimal string (never a float). */
  rate: string;
  /** Local value in the currency's smallest unit. */
  localValueMinor: bigint;
  currency: string;
  source: string;
  ts: string;
}

export interface FiscalSummary {
  from: string;
  to: string;
  currency: string;
  orders: number;
  totalUsdc: UsdcMinor;
  totalLocalMinor: bigint;
}

export interface FiscalAdapter {
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** ISO 4217. */
  readonly currency: string;
  valorize(payment: FiscalPayment): Promise<FiscalValorization>;
  summarize(range: { from: string; to: string }): Promise<FiscalSummary>;
  export(range: { from: string; to: string }, format: "csv" | "json"): Promise<Uint8Array>;
}
