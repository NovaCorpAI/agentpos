/**
 * Human mandate (SPEC 02): the agent can never change it. Evaluated before any signature.
 * Amounts are decimal strings in the JSON file and UsdcMinor in memory.
 */
import { z } from "zod";
import { AgentGateError, addUsdc, compareUsdc, usdc, usdcFromMinor } from "@agentgate/core";
import type { UsdcMinor } from "@agentgate/core";

const money = z.string().regex(/^\d+(\.\d{1,7})?$/, "decimal amount, up to 7 decimals");

export const mandateSchema = z.object({
  /** Hard ceiling per single payment. */
  maxPerTx: money,
  /** Ceiling for the sum of payments inside `period`. */
  maxTotal: money,
  period: z.enum(["day", "week", "month"]).default("day"),
  /** "any", "verified-only" (reserved until the hosted registry exists) or a list of site hostnames. */
  allowedSellers: z
    .union([z.literal("any"), z.literal("verified-only"), z.array(z.string().min(1))])
    .default("any"),
  /** Above this amount the human must approve out of band (`agentgate-buyer approve <cartId>`). */
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
  siteVerified: boolean;
  hasPhysicalItems: boolean;
  spentInPeriod: UsdcMinor;
  humanApproved: boolean;
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
  if (mandate.allowedSellers === "verified-only" && !input.siteVerified) {
    return {
      ok: false,
      code: "SELLER_UNVERIFIED",
      message: "Mandate only allows verified sellers",
      hint: "This site is not verified by the AgentGate registry. Ask the human to allowlist its hostname.",
      details: { siteHost: input.siteHost },
    };
  }
  if (Array.isArray(mandate.allowedSellers) && !mandate.allowedSellers.includes(input.siteHost)) {
    return {
      ok: false,
      code: "SELLER_UNVERIFIED",
      message: "Seller is not in the mandate allowlist",
      hint: `Allowed: ${mandate.allowedSellers.join(", ")}. Ask the human to add ${input.siteHost}.`,
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
      hint: "Tell the human to run `agentgate-buyer approve <cartId>` and then call buy again.",
      details: {
        amount: input.amount.toString(),
        threshold: usdc(mandate.requireConfirmAboveUsdc).toString(),
      },
    };
  }
  return { ok: true };
}

export function toMandateError(verdict: Exclude<MandateVerdict, { ok: true }>): AgentGateError {
  return new AgentGateError(verdict.code, verdict.message, {
    hint: verdict.hint,
    details: verdict.details,
  });
}

export const zeroUsdc = usdcFromMinor(0n);
