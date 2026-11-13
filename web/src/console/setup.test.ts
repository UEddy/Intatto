import { describe, expect, it } from "vitest";
import type { VaultView } from "../contract/abi.gen";
import { hasVaultKey, progress, setupSteps } from "./setup";

const V = "vault.intatto.near";
const vault = (over: Partial<VaultView> = {}) => ({ balance: "0", frozen: false, agent_id: null, policy: {}, recent_spends: [], tokens: [], withdrawals_locked_until: null, ...over }) as unknown as VaultView;
const fc = (receiver_id: string, method_names: string[]) => ({ permission: { FunctionCall: { allowance: "1", receiver_id, method_names } } });

describe("owner setup", () => {
  it("starts at funding, with nothing done", () => {
    const s = setupSteps(null, null, false);
    expect(s.map((x) => x.state)).toEqual(["next", "todo", "todo", "todo", "todo"]);
    expect(progress(s)).toEqual({ done: 0, total: 4 });
  });

  it("moves to the first step not done, and the optional lock is never next", () => {
    const funded = vault({ balance: "1" });
    expect(setupSteps(funded, null, false).find((x) => x.state === "next")?.id).toBe("agent");
    const named = vault({ balance: "1", agent_id: "a.near" });
    expect(setupSteps(named, false, false).find((x) => x.state === "next")?.id).toBe("key");
    const keyed = setupSteps(named, true, false);
    expect(keyed.find((x) => x.state === "next")?.id).toBe("trade");
    const acted = setupSteps(vault({ balance: "1", agent_id: "a.near", recent_spends: [{}] as never }), true, false);
    expect(progress(acted)).toEqual({ done: 4, total: 4 });
    expect(acted.find((x) => x.id === "lock")?.state).toBe("todo");
  });

  it("counts token deposits as funding", () => {
    expect(setupSteps(vault({ tokens: [{ token_id: "wrap.near", balance: "5", on_exchange: "0" }] as never }), null, false)[0]!.state).toBe("done");
  });

  it("accepts only a function-call key on this vault limited to agent methods", () => {
    expect(hasVaultKey(null, V)).toBeNull();
    expect(hasVaultKey([{ permission: "FullAccess" }], V)).toBe(false);
    expect(hasVaultKey([fc(V, [])], V)).toBe(false);
    expect(hasVaultKey([fc(V, ["withdraw"])], V)).toBe(false);
    expect(hasVaultKey([fc("other.near", ["agent_swap"])], V)).toBe(false);
    expect(hasVaultKey([{ permission: "FullAccess" }, fc(V, ["agent_spend", "agent_swap"])], V)).toBe(true);
  });
});
