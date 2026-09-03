/**
 * Money is ALWAYS an integer in the asset's smallest unit (guardrail 4).
 * Stellar classic assets and Stellar USDC use 7 decimals.
 */
import { AgentPOSError } from "./errors.js";

export const USDC_DECIMALS = 7;
export const XLM_DECIMALS = 7;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** USDC amount in smallest units (1 USDC = 10_000_000). */
export type UsdcMinor = Brand<bigint, "UsdcMinor">;
/** XLM amount in stroops (1 XLM = 10_000_000 stroops). */
export type Stroops = Brand<bigint, "Stroops">;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

function parseDecimalToMinor(input: string | number, decimals: number, label: string): bigint {
  const text = typeof input === "number" ? input.toString() : input.trim();
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new AgentPOSError("INVALID_AMOUNT", `${label} amount is not finite`, {
      hint: "Pass a decimal string like '1.50' or a finite number.",
    });
  }
  const match = DECIMAL_RE.exec(text);
  if (!match) {
    throw new AgentPOSError("INVALID_AMOUNT", `Invalid ${label} amount: '${text}'`, {
      hint: "Use a non-negative decimal string with '.' as separator, e.g. '12.5'.",
      details: { input: text },
    });
  }
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) {
    throw new AgentPOSError("INVALID_AMOUNT", `${label} supports at most ${decimals} decimals`, {
      hint: `Round '${text}' to ${decimals} decimal places before passing it.`,
      details: { input: text, decimals },
    });
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function formatMinor(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function usdc(value: string | number): UsdcMinor {
  return parseDecimalToMinor(value, USDC_DECIMALS, "USDC") as UsdcMinor;
}

export function usdcFromMinor(value: bigint | string | number): UsdcMinor {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) {
    throw new AgentPOSError("INVALID_AMOUNT", "USDC amount cannot be negative", {
      hint: "Amounts are unsigned; use separate debit/credit semantics.",
    });
  }
  return big as UsdcMinor;
}

export function formatUsdc(value: UsdcMinor): string {
  return formatMinor(value, USDC_DECIMALS);
}

export function stroops(value: string | number): Stroops {
  return parseDecimalToMinor(value, XLM_DECIMALS, "XLM") as Stroops;
}

export function formatXlm(value: Stroops): string {
  return formatMinor(value, XLM_DECIMALS);
}

export function addUsdc(a: UsdcMinor, b: UsdcMinor): UsdcMinor {
  return (a + b) as UsdcMinor;
}

export function mulUsdc(a: UsdcMinor, quantity: number): UsdcMinor {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new AgentPOSError("INVALID_AMOUNT", "Quantity must be a non-negative integer", {
      hint: "Multiply money only by integer quantities; never by floats.",
      details: { quantity },
    });
  }
  return (a * BigInt(quantity)) as UsdcMinor;
}

export function compareUsdc(a: UsdcMinor, b: UsdcMinor): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minimum price accepted for a catalog item: 0.001 USDC. */
export const MIN_PRICE_USDC: UsdcMinor = usdc("0.001");
