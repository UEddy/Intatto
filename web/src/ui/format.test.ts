import { describe, expect, it } from "vitest";
import { formatDateTime, formatShortDate } from "./format";

// 2026-11-20T12:00:00Z, the mainnet canary's lock, and a moment just before midnight UTC.
const LOCK = 1795176000000000000n;
const LATE = BigInt(Date.UTC(2026, 10, 11, 23, 59)) * 1_000_000n;

describe("displayed times", () => {
  it("are UTC and say so, in any viewer's zone", () => {
    expect(formatDateTime(LOCK)).toMatch(/12:00 UTC$/);
    expect(formatDateTime(LATE)).toMatch(/23:59 UTC$/);
  });
  it("dates agree with them: the UTC date, not the viewer's", () => {
    expect(formatShortDate(LATE)).toMatch(/11/);
    expect(formatShortDate(LATE)).toMatch(/2026/);
    expect(formatShortDate(LOCK)).toMatch(/20/);
  });
});
