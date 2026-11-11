import { describe, expect, it } from "vitest";
import { verdict } from "./AttemptLog";

describe("attempt verdicts", () => {
  const paid = { kind: "succeeded" } as const;
  const rejected = { kind: "rejected", reason: "receiver_not_allowlisted", message: null } as const;

  it("treat a successful call as an alarm on the canary, which pays nobody", () => {
    expect(verdict(paid, "canary", "agent_spend")).toEqual({ label: "Went through", tone: "through" });
  });

  it("treat a successful call as an allowed payment on the demo vault", () => {
    expect(verdict(paid, "demo", "agent_spend")).toEqual({ label: "Paid · within policy", tone: "allowed" });
  });

  it("show the vault's reason for a rejection on either log", () => {
    expect(verdict(rejected, "canary", "agent_spend").tone).toBe("rejected");
    expect(verdict(rejected, "demo", "agent_spend").label).toMatch(/^Rejected · /);
  });

  it("call the cap a payment hit per-payment, and the one a swap hit per-trade", () => {
    const overCap = { kind: "rejected", reason: "over_per_tx_cap", message: null } as const;
    expect(verdict(overCap, "demo", "agent_spend").label).toBe("Rejected · over per-payment cap");
    expect(verdict(overCap, "canary", "agent_swap").label).toBe("Rejected · over per-trade cap");
  });
});
