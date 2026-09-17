/**
 * Human mandate (SPEC 02): the agent can never change it. Evaluated before any signature.
 * Amounts are decimal strings in the JSON file and UsdcMinor in memory.
 */
import { z } from "zod";
import { AgentPOSError, addUsdc, compareUsdc, usdc, usdcFromMinor } from "@agentpos/core";
import type { UsdcMinor } from "@agentpos/core";

const money = z.string().regex(/^\d+(\.\d{1,7})?$/, "decimal amount, up to 7 decimals");

export const mandateSchema = z.object({
  /** Hard ceiling per single payment. */
  maxPerTx: money,
  /** Ceiling for the sum of payments inside `period`. */
  maxTotal: money,
  period: z.enum(["day", "week", "month"]).default("day"),
  /**
   * "any" (every site), or an explicit list of site hostnames. Two modes, both enforceable here
   * and now. There used to be a third, "verified-only", which asked a hosted registry that does
   * not exist, so it refused every site on earth; `migrateMandateJson` turns it into an explicit
   * empty list and says so out loud.
   */
  allowedSellers: z.union([z.literal("any"), z.array(z.string().min(1))]).default("any"),
  /** Above this amount the human must approve out of band (`agentpos-buyer approve <cartId>`). */
  requireConfirmAboveUsdc: money.optional(),
  allowPhysicalGoods: z.boolean().default(false),
  /** When true the agent cannot supply a shipping address; the profile's address is used. */
  shippingAddressLocked: z.boolean().default(true),
});

export type MandateJson = z.input<typeof mandateSchema>;
export type Mandate = z.output<typeof mandateSchema>;

export interface MandateCheckInput {
  amount: UsdcMinor;
  siteHost: string;
  hasPhysicalItems: boolean;
  spentInPeriod: UsdcMinor;
  humanApproved: boolean;
}

/** Retired mandate value, kept only so an existing profile can be recognized and explained. */
export const RETIRED_VERIFIED_ONLY = "verified-only";

/** A problem with a stored profile that is worth saying out loud but must not stop the buyer. */
export interface MandateWarning {
  code: "MANDATE_MODE_RETIRED";
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

/**
 * Reads a mandate as it was written on disk and returns it in today's vocabulary, plus whatever
 * had to change. `allowedSellers: "verified-only"` depended on a hosted registry that was never
 * built, so it refused every site: it becomes an explicit empty allowlist, which refuses every
 * site too. Behaviour is identical on purpose; what changes is that the refusal now names a
 * reason the human can act on instead of pointing at a registry that does not exist.
 */
export function migrateMandateJson(raw: unknown): {
  mandate: unknown;
  warnings: MandateWarning[];
} {
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { allowedSellers?: unknown }).allowedSellers !== RETIRED_VERIFIED_ONLY
  ) {
    return { mandate: raw, warnings: [] };
  }
  return {
    mandate: { ...(raw as Record<string, unknown>), allowedSellers: [] },
    warnings: [
      {
        code: "MANDATE_MODE_RETIRED",
        message:
          'allowedSellers: "verified-only" no longer exists (the seller registry it asked was never built, so it refused every site). This profile now carries an empty allowlist and still refuses every site.',
        hint: 'Edit the profile and set "allowedSellers" to the hostnames you trust, e.g. ["shop.example"], or to "any" to allow every site the mandate limits already cover.',
        details: { allowedSellers: [] },
      },
    ],
  };
}

export type MandateVerdict =
  | { ok: true }
  | {
      ok: false;
      code: "MANDATE_EXCEEDED" | "SELLER_UNVERIFIED" | "CONFIRMATION_REQUIRED";
      message: string;
      hint: string;
      details: Record<string, unknown>;
    };

export function periodStart(period: Mandate["period"], now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  if (period === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === "month") d.setUTCDate(1);
  return d;
}

export function evaluateMandate(mandate: Mandate, input: MandateCheckInput): MandateVerdict {
  const maxPerTx = usdc(mandate.maxPerTx);
  const maxTotal = usdc(mandate.maxTotal);

  if (compareUsdc(input.amount, maxPerTx) > 0) {
    return {
      ok: false,
      code: "MANDATE_EXCEEDED",
      message: "Payment exceeds the per-transaction limit",
      hint: "Ask the human to raise maxPerTx in the profile mandate, or choose a cheaper cart.",
      details: { amount: input.amount.toString(), maxPerTx: maxPerTx.toString() },
    };
  }
  const projected = addUsdc(input.spentInPeriod, input.amount);
  if (compareUsdc(projected, maxTotal) > 0) {
    return {
      ok: false,
      code: "MANDATE_EXCEEDED",
      message: `Payment would exceed the ${mandate.period} spending limit`,
      hint: "Wait for the next period or ask the human to raise maxTotal.",
      details: {
        spentInPeriod: input.spentInPeriod.toString(),
        amount: input.amount.toString(),
        maxTotal: maxTotal.toString(),
        period: mandate.period,
      },
    };
  }
  if (Array.isArray(mandate.allowedSellers) && !mandate.allowedSellers.includes(input.siteHost)) {
    return {
      ok: false,
      code: "SELLER_UNVERIFIED",
      message: "Seller is not in the mandate allowlist",
      hint:
        mandate.allowedSellers.length === 0
          ? `The allowlist is empty, so no site can be paid. Ask the human to add ${input.siteHost} to allowedSellers, or to set it to "any".`
          : `Allowed: ${mandate.allowedSellers.join(", ")}. Ask the human to add ${input.siteHost}.`,
      details: { siteHost: input.siteHost, allowedSellers: mandate.allowedSellers },
    };
  }
  if (input.hasPhysicalItems && !mandate.allowPhysicalGoods) {
    return {
      ok: false,
      code: "MANDATE_EXCEEDED",
      message: "Mandate does not allow physical goods",
      hint: "Only digital items/services can be bought with this profile; ask the human to set allowPhysicalGoods.",
      details: {},
    };
  }
  if (
    mandate.requireConfirmAboveUsdc !== undefined &&
    compareUsdc(input.amount, usdc(mandate.requireConfirmAboveUsdc)) > 0 &&
    !input.humanApproved
  ) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: "Amount is above the confirmation threshold; a human must approve this cart",
      hint: "Tell the human to run `agentpos-buyer approve <cartId>` and then call buy again.",
      details: {
        amount: input.amount.toString(),
        threshold: usdc(mandate.requireConfirmAboveUsdc).toString(),
      },
    };
  }
  return { ok: true };
}

export function toMandateError(verdict: Exclude<MandateVerdict, { ok: true }>): AgentPOSError {
  return new AgentPOSError(verdict.code, verdict.message, {
    hint: verdict.hint,
    details: verdict.details,
  });
}

export const zeroUsdc = usdcFromMinor(0n);
