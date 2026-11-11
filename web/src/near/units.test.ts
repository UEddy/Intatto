import { describe, expect, it } from "vitest";
import { formatNear, formatUnits, parseUnits, toBig } from "./units";

describe("formatUnits", () => {
  it("formats exactly, with grouping", () => {
    expect(formatUnits(1234500000n, 6)).toBe("1,234.5");
    expect(formatNear(997400000000000000000000n)).toBe("0.9974");
    expect(formatNear(0n)).toBe("0");
    expect(formatUnits(5n, 0)).toBe("5");
  });
  it("truncates instead of rounding, and says so", () => {
    expect(formatNear(1999999999999999999999999n, { maxFraction: 4 })).toBe("1.9999…");
    // Unmarked: rounded down, never up, and no ellipsis (the board's bounty and baseline).
    expect(formatNear(997610000000000000000000n, { maxFraction: 4, mark: false })).toBe("0.9976");
    expect(formatNear(1999999999999999999999999n, { maxFraction: 4, mark: false })).toBe("1.9999");
    expect(formatNear(1500000000000000000000000n, { maxFraction: 4, mark: false })).toBe("1.5");
    expect(formatNear(1500000000000000000000000n, { maxFraction: 4 })).toBe("1.5");
  });
  it("never shows a non-zero amount as zero", () => {
    expect(formatNear(1n, { maxFraction: 4 })).toBe("<0.0001");
  });
  it("handles USDt's 6 decimals and testnet USDT's 24 alike", () => {
    expect(formatUnits(1918076432n, 6)).toBe("1,918.076432");
    expect(formatUnits(124161233475233043857166n, 24, { maxFraction: 2 })).toBe("0.12…");
  });
});

describe("parseUnits", () => {
  it("parses exactly", () => {
    expect(parseUnits("1.5", 24)).toEqual({ ok: true, value: 1500000000000000000000000n });
    expect(parseUnits("0.1", 6)).toEqual({ ok: true, value: 100000n });
    expect(parseUnits("1,000", 6)).toEqual({ ok: true, value: 1000000000n });
    expect(parseUnits(".5", 1)).toEqual({ ok: true, value: 5n });
  });
  it("rejects what it cannot represent", () => {
    expect(parseUnits("0.0000001", 6).ok).toBe(false);
    expect(parseUnits("-1", 6).ok).toBe(false);
    expect(parseUnits("1e3", 6).ok).toBe(false);
    expect(parseUnits("", 6).ok).toBe(false);
    expect(parseUnits(".", 6).ok).toBe(false);
  });
});

describe("toBig", () => {
  it("accepts only the contract's decimal strings", () => {
    expect(toBig("340282366920938463463374607431768211455")).toBe(2n ** 128n - 1n);
    expect(() => toBig("01")).toThrow();
    expect(() => toBig("1.0")).toThrow();
    expect(() => toBig("-1")).toThrow();
  });
});
