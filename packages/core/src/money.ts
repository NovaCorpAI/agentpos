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

/**
 * A fiat amount as an integer in its ISO 4217 minor unit: "14990" CLP (0 decimals) is 14990n,
 * "12.50" USD (2 decimals) is 1250n. Same strictness as {@link usdc}: no floats, no rounding,
 * more decimals than the currency has is an error rather than a silent truncation.
 */
export function fiatMinor(value: string | number, decimals: number, currency: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new AgentPOSError("INVALID_AMOUNT", `Invalid decimals for ${currency}: ${decimals}`, {
      hint: "ISO 4217 minor units: CLP has 0 decimals, USD has 2.",
      details: { currency, decimals },
    });
  }
  return parseDecimalToMinor(value, decimals, currency);
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

/**
 * Moves an integer amount between two minor units EXACTLY: 7 to 6 decimals divides by 10 only
 * when nothing is lost, 6 to 7 multiplies. Never rounds (guardrail 4): an amount that cannot be
 * represented in the target unit is an error, so a price is never silently changed when it is
 * charged on a network whose USDC has fewer decimals.
 */
export function rescaleMinor(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  for (const d of [fromDecimals, toDecimals]) {
    if (!Number.isInteger(d) || d < 0 || d > 18) {
      throw new AgentPOSError("INVALID_AMOUNT", `Invalid minor-unit exponent: ${d}`, {
        hint: "Decimals must be an integer between 0 and 18 (USDC is 7 on Stellar, 6 on EVM).",
        details: { fromDecimals, toDecimals },
      });
    }
  }
  if (value < 0n) {
    throw new AgentPOSError("INVALID_AMOUNT", "Amount cannot be negative", {
      hint: "Amounts are unsigned integers in the asset's smallest unit.",
    });
  }
  if (toDecimals >= fromDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals);
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  if (value % factor !== 0n) {
    throw new AgentPOSError(
      "INVALID_AMOUNT",
      `Amount has more precision than ${toDecimals} decimals allow`,
      {
        hint: `Price it with at most ${toDecimals} decimals; this network cannot charge the remainder and AgentPOS never rounds money.`,
        details: { minor: value.toString(), fromDecimals, toDecimals },
      },
    );
  }
  return value / factor;
}

/** Minimum price accepted for a catalog item: 0.001 USDC. */
export const MIN_PRICE_USDC: UsdcMinor = usdc("0.001");
