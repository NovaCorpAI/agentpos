import { describe, expect, it } from "vitest";
import { usdc, usdcFromMinor } from "@agentgate/core";
import {
  OPEN_POLICY,
  evaluatePolicy,
  merchantPolicySchema,
  periodStart,
  totalOf,
} from "./policy.js";
import type { MerchantPolicyInput, PolicyInput } from "./policy.js";

const policy = (p: MerchantPolicyInput = {}) => merchantPolicySchema.parse(p);

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  lines: [{ itemId: "mug", quantity: 1, lineTotalUsdc: usdc("9.9") }],
  totalUsdc: usdc("9.9"),
  periodSpentUsdc: usdcFromMinor(0n),
  requiresShipping: false,
  ...over,
});

describe("merchant policy", () => {
  it("allows everything by default", () => {
    expect(evaluatePolicy(OPEN_POLICY, input())).toEqual({ decision: "allowed" });
  });

  it("denies every sale while suspended, before any other rule", () => {
    const d = evaluatePolicy(policy({ status: "suspended", maxOrderUsdc: "1000" }), input());
    expect(d.decision).toBe("denied");
    if (d.decision === "denied") expect(d.code).toBe("POLICY_SUSPENDED");
  });

  it("denies excluded items and names them", () => {
    const d = evaluatePolicy(policy({ excludedItems: ["mug", "vase"] }), input());
    expect(d.decision === "denied" && d.code).toBe("POLICY_ITEM_EXCLUDED");
    if (d.decision === "denied") expect(d.details).toEqual({ items: ["mug"] });
    // an item that is not excluded passes
    expect(evaluatePolicy(policy({ excludedItems: ["vase"] }), input())).toEqual({
      decision: "allowed",
    });
  });

  it("enforces max quantity per item", () => {
    const p = policy({ maxQuantityPerItem: 2 });
    expect(
      evaluatePolicy(
        p,
        input({ lines: [{ itemId: "mug", quantity: 2, lineTotalUsdc: usdc("19.8") }] }),
      ).decision,
    ).toBe("allowed");
    const d = evaluatePolicy(
      p,
      input({ lines: [{ itemId: "mug", quantity: 3, lineTotalUsdc: usdc("29.7") }] }),
    );
    expect(d.decision === "denied" && d.code).toBe("POLICY_ITEM_QUANTITY");
  });

  it("enforces max quantity per order across lines", () => {
    const p = policy({ maxQuantityPerOrder: 4 });
    const lines = [
      { itemId: "mug", quantity: 3, lineTotalUsdc: usdc("29.7") },
      { itemId: "pen", quantity: 2, lineTotalUsdc: usdc("4") },
    ];
    const d = evaluatePolicy(p, input({ lines, totalUsdc: totalOf(lines) }));
    expect(d.decision === "denied" && d.code).toBe("POLICY_ORDER_QUANTITY");
    if (d.decision === "denied") expect(d.details).toMatchObject({ max: 4, units: 5 });
  });

  it("enforces the per-order amount limit, inclusive at the boundary", () => {
    const p = policy({ maxOrderUsdc: "9.9" });
    expect(evaluatePolicy(p, input()).decision).toBe("allowed"); // exactly at the limit
    const d = evaluatePolicy(p, input({ totalUsdc: usdc("9.9000001") }));
    expect(d.decision === "denied" && d.code).toBe("POLICY_ORDER_LIMIT");
  });

  it("enforces the period limit counting what is already committed", () => {
    const p = policy({ maxPeriodUsdc: "50", period: "daily" });
    expect(evaluatePolicy(p, input({ periodSpentUsdc: usdc("40") })).decision).toBe("allowed"); // 49.9
    const d = evaluatePolicy(p, input({ periodSpentUsdc: usdc("40.2") })); // 50.1
    expect(d.decision === "denied" && d.code).toBe("POLICY_PERIOD_LIMIT");
    if (d.decision === "denied")
      expect(d.details).toMatchObject({
        period: "daily",
        alreadyCommitted: usdc("40.2").toString(),
      });
  });

  it("restricts shipping countries only when shipping is required", () => {
    const p = policy({ allowedShippingCountries: ["CL", "AR"] });
    expect(
      evaluatePolicy(p, input({ requiresShipping: true, shippingCountry: "cl" })).decision,
    ).toBe("allowed");
    const d = evaluatePolicy(p, input({ requiresShipping: true, shippingCountry: "US" }));
    expect(d.decision === "denied" && d.code).toBe("POLICY_SHIPPING_COUNTRY");
    const missing = evaluatePolicy(p, input({ requiresShipping: true }));
    expect(missing.decision).toBe("denied");
    // digital goods are unaffected
    expect(evaluatePolicy(p, input({ requiresShipping: false })).decision).toBe("allowed");
  });

  it("asks for human approval above the threshold, without denying", () => {
    const p = policy({ approvalThresholdUsdc: "5" });
    expect(evaluatePolicy(p, input({ totalUsdc: usdc("5") })).decision).toBe("allowed"); // at the threshold
    const d = evaluatePolicy(p, input());
    expect(d.decision).toBe("requires_approval");
    if (d.decision === "requires_approval") {
      expect(d.code).toBe("POLICY_APPROVAL_REQUIRED");
      expect(d.hint).toMatch(/Nothing was charged/);
    }
  });

  it("prefers a denial over an approval when both apply", () => {
    const p = policy({ approvalThresholdUsdc: "5", maxOrderUsdc: "8" });
    const d = evaluatePolicy(p, input()); // 9.9: over both
    expect(d.decision === "denied" && d.code).toBe("POLICY_ORDER_LIMIT");
  });

  it("computes UTC period starts", () => {
    const now = new Date("2026-08-26T15:30:00Z"); // Wednesday
    expect(periodStart("hourly", now).toISOString()).toBe("2026-08-26T15:00:00.000Z");
    expect(periodStart("daily", now).toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(periodStart("weekly", now).toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("rejects malformed policies", () => {
    expect(() => policy({ maxOrderUsdc: "-1" })).toThrow();
    expect(() => policy({ maxOrderUsdc: "1.123456789" })).toThrow();
    expect(() => policy({ allowedShippingCountries: ["CHL"] })).toThrow();
    expect(() => policy({ maxQuantityPerItem: 0 })).toThrow();
  });
});
