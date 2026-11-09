import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JS module without types
import { generate } from "../../scripts/gen-abi.mjs";
import abi from "./intatto_abi.json";
import current from "./abi.gen.ts?raw";
import { METHODS, PolicySchema, VaultViewSchema, setAgentArgs } from "./abi.gen";
import devVault from "../test/fixtures/rpc-get-vault-dev.json";

describe("generated ABI types", () => {
  it("are exactly what the ABI generates (no drift from the contract)", () => {
    expect(generate(abi)).toBe(current);
  });

  it("parse a real vault with tokens, a pool and a stale spend", () => {
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(devVault.result.result)));
    const v = VaultViewSchema.parse(raw);
    expect(v.policy.pools[0]).toEqual({ pool_id: 1084, token_ids: ["wrap.testnet", "usdt.itachicara.testnet"], max_slippage_bps: 100 });
    expect(v.recent_spends[0]?.token_id).toBe("wrap.testnet");
    expect(v.withdrawals_locked_until).toBeNull();
  });

  it("fill in serde(default) policy lists the way the contract does", () => {
    expect(PolicySchema.parse({ per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 1, allowlist: [] })).toMatchObject({ tokens: [], pools: [] });
  });

  it("reject what the contract would not produce", () => {
    expect(VaultViewSchema.safeParse({ ...JSON.parse('{"balance":"01","frozen":false,"policy":{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":1,"allowlist":[]},"recent_spends":[],"tokens":[]}') }).success).toBe(false);
    expect(setAgentArgs.safeParse({ agent_id: "Bad Account", policy: { per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 1, allowlist: [] } }).success).toBe(false);
    expect(setAgentArgs.safeParse({ agent_id: "a.testnet", policy: { per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 1, allowlist: [] }, extra: 1 }).success).toBe(false);
  });

  it("know which owner methods need the 1 yoctoNEAR deposit and which do not", () => {
    expect(METHODS.freeze.payable).toBe(false);
    expect(METHODS.unfreeze.payable).toBe(true);
    expect(METHODS.set_agent.payable).toBe(true);
    expect(METHODS.withdraw.payable).toBe(true);
  });
});
