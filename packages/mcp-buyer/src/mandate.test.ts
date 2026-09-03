import { describe, expect, it } from "vitest";
import { usdc } from "@agentpos/core";
import { evaluateMandate, mandateSchema, periodStart } from "./mandate.js";

const base = mandateSchema.parse({
  maxPerTx: "10",
  maxTotal: "25",
  period: "day",
  allowPhysicalGoods: true,
});
const input = {
  amount: usdc("5"),
  siteHost: "shop.test",
  siteVerified: false,
  hasPhysicalItems: false,
  spentInPeriod: usdc("0"),
  humanApproved: false,
};

describe("mandate", () => {
  it("allows payments inside every limit", () => {
    expect(evaluateMandate(base, input)).toEqual({ ok: true });
  });

  it.each([
    ["per-tx limit", { amount: usdc("10.0000001") }, "MANDATE_EXCEEDED"],
    ["period total", { amount: usdc("6"), spentInPeriod: usdc("20") }, "MANDATE_EXCEEDED"],
    ["physical goods when not allowed", { hasPhysicalItems: true }, "MANDATE_EXCEEDED"],
  ] as const)("rejects %s", (_label, patch, code) => {
    const mandate = _label.includes("physical")
      ? mandateSchema.parse({ ...base, allowPhysicalGoods: false })
      : base;
    const verdict = evaluateMandate(mandate, { ...input, ...patch });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe(code);
  });

  it("enforces seller allowlists and verified-only", () => {
    const listed = mandateSchema.parse({ ...base, allowedSellers: ["good.test"] });
    const v1 = evaluateMandate(listed, input);
    expect(v1.ok === false && v1.code).toBe("SELLER_UNVERIFIED");
    expect(evaluateMandate(listed, { ...input, siteHost: "good.test" })).toEqual({ ok: true });
    const verified = mandateSchema.parse({ ...base, allowedSellers: "verified-only" });
    expect(evaluateMandate(verified, input).ok).toBe(false);
    expect(evaluateMandate(verified, { ...input, siteVerified: true })).toEqual({ ok: true });
  });

  it("requires human confirmation above the threshold until approved", () => {
    const m = mandateSchema.parse({ ...base, requireConfirmAboveUsdc: "3" });
    const v = evaluateMandate(m, input);
    expect(v.ok === false && v.code).toBe("CONFIRMATION_REQUIRED");
    expect(evaluateMandate(m, { ...input, humanApproved: true })).toEqual({ ok: true });
    expect(evaluateMandate(m, { ...input, amount: usdc("3") })).toEqual({ ok: true });
  });

  it("computes UTC period starts", () => {
    const now = new Date("2026-08-26T15:30:00Z"); // Wednesday
    expect(periodStart("day", now).toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(periodStart("week", now).toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(periodStart("month", now).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
