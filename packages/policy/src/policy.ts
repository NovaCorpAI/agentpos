/**
 * Merchant policy engine (M1): verifiable rules the merchant sets over agentic sales.
 *
 * Evaluated twice, by design: once when quoting a cart and again at checkout, because the
 * merchant's state (period volume, suspension, catalog exclusions) can change in between.
 * The engine is pure: the caller supplies the already-accumulated period volume, so the same
 * function serves the sidecar, tests and any future dashboard preview.
 */
import { z } from "zod";
import { addUsdc, compareUsdc, usdc, usdcFromMinor } from "@agentgate/core";
import type { UsdcMinor } from "@agentgate/core";

const money = z.string().regex(/^\d+(\.\d{1,7})?$/, "decimal amount, up to 7 decimals");

export const PERIODS = ["hourly", "daily", "weekly"] as const;
export type PolicyPeriod = (typeof PERIODS)[number];

export const merchantPolicySchema = z.object({
  /** A suspended policy denies every agentic sale without touching the catalog. */
  status: z.enum(["active", "suspended"]).default("active"),
  /** Maximum total for a single order, in USDC. */
  maxOrderUsdc: money.optional(),
  /** Maximum settled + pending volume inside `period`, in USDC. */
  maxPeriodUsdc: money.optional(),
  period: z.enum(PERIODS).default("daily"),
  /** Maximum units of the same item in one order. */
  maxQuantityPerItem: z.number().int().positive().optional(),
  /** Maximum units across the whole order. */
  maxQuantityPerOrder: z.number().int().positive().optional(),
  /** Catalog item ids the merchant does not sell to agents (they stay sellable to humans). */
  excludedItems: z.array(z.string().min(1)).default([]),
  /** ISO 3166-1 alpha-2 codes. Empty means every country the merchant already ships to. */
  allowedShippingCountries: z.array(z.string().length(2)).default([]),
  /** Orders above this amount pause for human approval instead of settling (M2). */
  approvalThresholdUsdc: money.optional(),
});

export type MerchantPolicyInput = z.input<typeof merchantPolicySchema>;
export type MerchantPolicy = z.output<typeof merchantPolicySchema>;

/** A policy that allows everything: the default when a merchant sets no rules. */
export const OPEN_POLICY: MerchantPolicy = merchantPolicySchema.parse({});

export const POLICY_DENY_CODES = [
  "POLICY_SUSPENDED",
  "POLICY_ITEM_EXCLUDED",
  "POLICY_ITEM_QUANTITY",
  "POLICY_ORDER_QUANTITY",
  "POLICY_ORDER_LIMIT",
  "POLICY_PERIOD_LIMIT",
  "POLICY_SHIPPING_COUNTRY",
] as const;
export type PolicyDenyCode = (typeof POLICY_DENY_CODES)[number];

export interface PolicyLine {
  itemId: string;
  quantity: number;
  lineTotalUsdc: UsdcMinor;
}

export interface PolicyInput {
  lines: PolicyLine[];
  totalUsdc: UsdcMinor;
  /**
   * Volume already committed in the current period: settled orders plus orders awaiting
   * approval. Counting pending ones is deliberate; otherwise a burst of unapproved orders
   * could collectively blow past the limit while each one looks fine on its own.
   */
  periodSpentUsdc: UsdcMinor;
  requiresShipping: boolean;
  shippingCountry?: string | undefined;
}

export interface PolicyReason {
  /** Machine-readable, stable across versions: an agent can branch on it. */
  code: PolicyDenyCode | "POLICY_APPROVAL_REQUIRED";
  /** Actionable sentence for the agent (goes into the 402/4xx body). */
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

export type PolicyDecision =
  | { decision: "allowed" }
  | ({ decision: "requires_approval" } & PolicyReason)
  | ({ decision: "denied" } & PolicyReason);

export function periodStart(period: PolicyPeriod, now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  if (period === "hourly") return d;
  d.setUTCHours(0, 0, 0, 0);
  if (period === "daily") return d;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // ISO week starts Monday
  return d;
}

/**
 * Evaluates the policy against a cart. Denials win over approval: an order that is both over
 * the hard limit and over the approval threshold is denied, never queued for a human.
 */
export function evaluatePolicy(policy: MerchantPolicy, input: PolicyInput): PolicyDecision {
  if (policy.status === "suspended") {
    return deny(
      "POLICY_SUSPENDED",
      "This store is not accepting agentic orders right now",
      "Try again later or contact the merchant.",
      {},
    );
  }

  const excluded = input.lines.filter((l) => policy.excludedItems.includes(l.itemId));
  if (excluded.length > 0) {
    return deny(
      "POLICY_ITEM_EXCLUDED",
      "Some items are not sold to agents",
      "Remove the items listed in details and quote again.",
      { items: excluded.map((l) => l.itemId) },
    );
  }

  if (policy.maxQuantityPerItem !== undefined) {
    const over = input.lines.filter((l) => l.quantity > (policy.maxQuantityPerItem as number));
    if (over.length > 0) {
      return deny(
        "POLICY_ITEM_QUANTITY",
        `At most ${policy.maxQuantityPerItem} units per item`,
        "Reduce the quantity of the items listed in details.",
        {
          max: policy.maxQuantityPerItem,
          items: over.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        },
      );
    }
  }

  if (policy.maxQuantityPerOrder !== undefined) {
    const units = input.lines.reduce((acc, l) => acc + l.quantity, 0);
    if (units > policy.maxQuantityPerOrder) {
      return deny(
        "POLICY_ORDER_QUANTITY",
        `At most ${policy.maxQuantityPerOrder} units per order`,
        "Split the purchase into smaller orders.",
        { max: policy.maxQuantityPerOrder, units },
      );
    }
  }

  if (policy.maxOrderUsdc !== undefined) {
    const max = usdc(policy.maxOrderUsdc);
    if (compareUsdc(input.totalUsdc, max) > 0) {
      return deny(
        "POLICY_ORDER_LIMIT",
        `Order total exceeds the merchant limit of ${policy.maxOrderUsdc} USDC`,
        "Reduce the cart total.",
        { max: max.toString(), total: input.totalUsdc.toString() },
      );
    }
  }

  if (policy.maxPeriodUsdc !== undefined) {
    const max = usdc(policy.maxPeriodUsdc);
    const projected = addUsdc(input.periodSpentUsdc, input.totalUsdc);
    if (compareUsdc(projected, max) > 0) {
      return deny(
        "POLICY_PERIOD_LIMIT",
        `This order would exceed the merchant's ${policy.period} limit of ${policy.maxPeriodUsdc} USDC`,
        "Retry in the next period or reduce the cart total.",
        {
          period: policy.period,
          max: max.toString(),
          alreadyCommitted: input.periodSpentUsdc.toString(),
          total: input.totalUsdc.toString(),
        },
      );
    }
  }

  if (input.requiresShipping && policy.allowedShippingCountries.length > 0) {
    const country = input.shippingCountry?.toUpperCase();
    if (!country || !policy.allowedShippingCountries.includes(country)) {
      return deny(
        "POLICY_SHIPPING_COUNTRY",
        "The merchant does not ship to that country",
        `Allowed: ${policy.allowedShippingCountries.join(", ")}.`,
        { allowed: policy.allowedShippingCountries, requested: country ?? null },
      );
    }
  }

  if (policy.approvalThresholdUsdc !== undefined) {
    const threshold = usdc(policy.approvalThresholdUsdc);
    if (compareUsdc(input.totalUsdc, threshold) > 0) {
      return {
        decision: "requires_approval",
        code: "POLICY_APPROVAL_REQUIRED",
        message: `Orders above ${policy.approvalThresholdUsdc} USDC need the merchant's approval`,
        hint: "Nothing was charged. Poll the order until the merchant approves or rejects it.",
        details: { threshold: threshold.toString(), total: input.totalUsdc.toString() },
      };
    }
  }

  return { decision: "allowed" };
}

function deny(
  code: PolicyDenyCode,
  message: string,
  hint: string,
  details: Record<string, unknown>,
): PolicyDecision {
  return { decision: "denied", code, message, hint, details };
}

/** Sums line totals; helper for callers building a PolicyInput. */
export function totalOf(lines: PolicyLine[]): UsdcMinor {
  return lines.reduce((acc, l) => addUsdc(acc, l.lineTotalUsdc), usdcFromMinor(0n));
}
