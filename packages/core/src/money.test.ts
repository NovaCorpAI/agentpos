import { describe, expect, it } from "vitest";
import {
  addUsdc,
  compareUsdc,
  formatUsdc,
  formatXlm,
  mulUsdc,
  stroops,
  usdc,
  usdcFromMinor,
} from "./money.js";
import { AgentPOSError } from "./errors.js";

describe("money", () => {
  it("parses decimal strings into 7-decimal integers", () => {
    expect(usdc("1")).toBe(10_000_000n);
    expect(usdc("1.5")).toBe(15_000_000n);
    expect(usdc("0.001")).toBe(10_000n);
    expect(usdc("0.0000001")).toBe(1n);
    expect(usdc(2)).toBe(20_000_000n);
  });

  it("rejects malformed or over-precise amounts with typed errors", () => {
    for (const bad of ["-1", "1,5", "abc", "1.00000001", ""]) {
      expect(() => usdc(bad)).toThrowError(AgentPOSError);
    }
    expect(() => usdc(Number.NaN)).toThrowError(AgentPOSError);
    try {
      usdc("1.00000001");
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("INVALID_AMOUNT");
      expect((err as AgentPOSError).hint).toMatch(/decimal/);
    }
  });

  it("formats back without floats", () => {
    expect(formatUsdc(usdc("12.5"))).toBe("12.5");
    expect(formatUsdc(usdc("0.0000001"))).toBe("0.0000001");
    expect(formatUsdc(usdc("100"))).toBe("100");
    expect(formatXlm(stroops("1"))).toBe("1");
  });

  it("does integer arithmetic", () => {
    expect(addUsdc(usdc("0.1"), usdc("0.2"))).toBe(usdc("0.3"));
    expect(mulUsdc(usdc("1.25"), 3)).toBe(usdc("3.75"));
    expect(() => mulUsdc(usdc("1"), 1.5)).toThrowError(AgentPOSError);
    expect(compareUsdc(usdc("1"), usdc("2"))).toBe(-1);
    expect(compareUsdc(usdc("2"), usdc("2"))).toBe(0);
  });

  it("wraps minor units from strings/bigints and rejects negatives", () => {
    expect(usdcFromMinor("15000000")).toBe(usdc("1.5"));
    expect(() => usdcFromMinor(-1n)).toThrowError(AgentPOSError);
  });
});
