import { describe, expect, it } from "vitest";
import { usdc } from "@agentpos/core";
import {
  allowedNetworks,
  evaluateMandate,
  mandateSchema,
  migrateMandateJson,
  periodStart,
} from "./mandate.js";

const base = mandateSchema.parse({
  maxPerTx: "10",
  maxTotal: "25",
  period: "day",
  allowPhysicalGoods: true,
});
const input = {
  amount: usdc("5"),
  siteHost: "shop.test",
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

  it("enforces the seller allowlist, and says so when it is empty", () => {
    const listed = mandateSchema.parse({ ...base, allowedSellers: ["good.test"] });
    const v1 = evaluateMandate(listed, input);
    expect(v1.ok === false && v1.code).toBe("SELLER_UNVERIFIED");
    expect(evaluateMandate(listed, { ...input, siteHost: "good.test" })).toEqual({ ok: true });
    const empty = mandateSchema.parse({ ...base, allowedSellers: [] });
    const v2 = evaluateMandate(empty, input);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.hint).toContain("allowlist is empty");
  });

  it("refuses the retired verified-only mode outright", () => {
    const parsed = mandateSchema.safeParse({ ...base, allowedSellers: "verified-only" });
    expect(parsed.success).toBe(false);
  });

  it("migrates a verified-only profile into an explicit empty list, with a warning", () => {
    const { mandate, warnings } = migrateMandateJson({
      maxPerTx: "10",
      maxTotal: "25",
      allowedSellers: "verified-only",
    });
    expect((mandate as { allowedSellers: string[] }).allowedSellers).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("MANDATE_MODE_RETIRED");
    expect(warnings[0]?.message).toContain("verified-only");
    expect(warnings[0]?.hint).toContain("allowedSellers");

    // The migrated mandate parses, and behaves exactly as before: it refuses every site.
    const migrated = mandateSchema.parse(mandate);
    expect(evaluateMandate(migrated, input).ok).toBe(false);

    // Anything else is passed through untouched, warnings included.
    expect(migrateMandateJson({ allowedSellers: "any" })).toEqual({
      mandate: { allowedSellers: "any" },
      warnings: [],
    });
    expect(migrateMandateJson(undefined)).toEqual({ mandate: undefined, warnings: [] });
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

describe("allowedNetworks (M3)", () => {
  it("defaults to the profile's own network only", () => {
    const m = mandateSchema.parse({ maxPerTx: "1", maxTotal: "1" });
    expect(allowedNetworks(m, "stellar:testnet")).toEqual(["stellar:testnet"]);
  });

  it("takes an explicit list of CAIP-2 ids and refuses anything else", () => {
    const m = mandateSchema.parse({
      maxPerTx: "1",
      maxTotal: "1",
      allowedNetworks: ["stellar:testnet", "eip155:5042002"],
    });
    expect(allowedNetworks(m, "stellar:testnet")).toEqual(["stellar:testnet", "eip155:5042002"]);
    expect(() =>
      mandateSchema.parse({ maxPerTx: "1", maxTotal: "1", allowedNetworks: ["arc"] }),
    ).toThrow(/CAIP-2/);
    expect(() =>
      mandateSchema.parse({ maxPerTx: "1", maxTotal: "1", allowedNetworks: [] }),
    ).toThrow();
  });
});
