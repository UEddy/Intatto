import { describe, expect, it } from "vitest";
import { verdict } from "./AttemptLog";

describe("attempt verdicts", () => {
  const paid = { kind: "succeeded" } as const;
  const rejected = { kind: "rejected", reason: "receiver_not_allowlisted", message: null } as const;

  it("treat a successful call as an alarm on the canary, which pays nobody", () => {
    expect(verdict(paid, "canary")).toEqual({ label: "Went through", tone: "through" });
  });

  it("treat a successful call as an allowed payment on the demo vault", () => {
    expect(verdict(paid, "demo")).toEqual({ label: "Paid · within policy", tone: "allowed" });
  });

  it("show the vault's reason for a rejection on either log", () => {
    expect(verdict(rejected, "canary").tone).toBe("rejected");
    expect(verdict(rejected, "demo").label).toMatch(/^Rejected · /);
  });
});
