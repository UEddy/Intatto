import { describe, expect, it } from "vitest";
import type { Policy } from "../contract/abi.gen";
import * as I from "./intents";
import { diffPolicy, emptyForm, formToPolicy, policyToForm, validatePolicy } from "./policy";

const VAULT = "vault-v1.intatto-dev.testnet";
const OWNER = "alice.testnet";
const WNEAR = { id: "wrap.testnet", symbol: "wNEAR", decimals: 24 };
const USDT = { id: "usdt.itachicara.testnet", symbol: "USDT", decimals: 24 };
const USDT6 = { id: "usdt.tether-token.near", symbol: "USDt", decimals: 6 };
const POOL = { id: 1084, tokenIds: ["usdt.itachicara.testnet", "wrap.testnet"] as const };
const NOW = 1_800_000_000_000_000_000n;
const UNLOCKED = { untilNs: null, nowNs: NOW };
const LOCKED = { untilNs: NOW + 1n, nowNs: NOW };
const fc = (i: { plans: readonly { actions: readonly unknown[] }[] }, p = 0, a = 0) => i.plans[p]!.actions[a] as I.TokenInfo & { methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint };

describe("owner intents", () => {
  it("freeze needs no deposit, so any key can hit the brakes; unfreeze needs 1 yocto", () => {
    expect(fc(I.freeze({ vaultId: VAULT, frozen: false }))).toMatchObject({ methodName: "freeze", deposit: 0n, args: {} });
    expect(fc(I.unfreeze({ vaultId: VAULT, frozen: true }))).toMatchObject({ methodName: "unfreeze", deposit: 1n });
  });

  it("wrap and deposit is one transaction to wNEAR, registering only who needs it", () => {
    const i = I.wrapAndDeposit({ vaultId: VAULT, ownerId: OWNER, wnear: WNEAR, amount: 5n, ownerRegistered: false, vaultRegistered: true, storageMin: 125n, tokenInPolicy: true, vaultExists: true });
    expect(i.plans).toHaveLength(1);
    expect(i.plans[0]!.receiverId).toBe("wrap.testnet");
    expect(i.plans[0]!.actions.map((a) => a.methodName)).toEqual(["storage_deposit", "near_deposit", "ft_transfer_call"]);
    expect(fc(i, 0, 0)).toMatchObject({ args: { account_id: OWNER, registration_only: true }, deposit: 125n });
    expect(fc(i, 0, 1)).toMatchObject({ deposit: 5n });
    expect(fc(i, 0, 2)).toMatchObject({ args: { receiver_id: VAULT, amount: "5", msg: "" }, deposit: 1n, gas: 100n * I.TGAS });
    expect(i.blockers).toEqual([]);
  });

  it("refuses token deposits the vault would refund", () => {
    const i = I.wrapAndDeposit({ vaultId: VAULT, ownerId: OWNER, wnear: WNEAR, amount: 5n, ownerRegistered: true, vaultRegistered: true, storageMin: 1n, tokenInPolicy: false, vaultExists: true });
    expect(i.blockers.join(" ")).toMatch(/not in your policy/);
    expect(I.depositToken({ vaultId: VAULT, token: USDT6, amount: 2_000_000n, held: 1_000_000n, vaultRegistered: true, tokenInPolicy: true, vaultExists: true }).blockers.join(" ")).toMatch(/You hold 1 USDt/);
  });

  it("predicts the lock's rejections", () => {
    expect(I.withdrawNear({ vaultId: VAULT, amount: 1n, balance: 5n, lock: LOCKED }).blockers.join(" ")).toMatch(/locked/);
    expect(I.withdrawNear({ vaultId: VAULT, amount: 1n, balance: 5n, lock: UNLOCKED }).blockers).toEqual([]);
    const policy: Policy = { per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 1, allowlist: [], tokens: [], pools: [] };
    expect(I.setAgent({ vaultId: VAULT, agentId: "bot.testnet", policy, current: null, lock: LOCKED, vaultBalance: 10n }).blockers.join(" ")).toMatch(/locked/);
    expect(I.lockWithdrawals({ vaultId: VAULT, untilNs: NOW, lock: { untilNs: NOW + 10n, nowNs: NOW - 100n } }).blockers.join(" ")).toMatch(/only be extended/);
    // an expired lock can still only be extended
    expect(I.lockWithdrawals({ vaultId: VAULT, untilNs: NOW + 5n, lock: { untilNs: NOW + 10n, nowNs: NOW + 20n } }).blockers.join(" ")).toMatch(/only be extended/);
  });

  it("registers the owner with a token before withdrawing it, as a separate transaction", () => {
    const i = I.withdrawToken({ vaultId: VAULT, ownerId: OWNER, token: USDT, amount: 3n, balance: 3n, ownerRegistered: false, storageMin: 9n, lock: UNLOCKED });
    expect(i.plans.map((p) => p.receiverId)).toEqual([USDT.id, VAULT]);
    expect(fc(i, 1)).toMatchObject({ methodName: "withdraw_token", args: { token_id: USDT.id, amount: "3" }, deposit: 1n });
  });

  it("gives reclaim the gas the contract requires, and waits for in-flight swaps", () => {
    const i = I.reclaim({ vaultId: VAULT, token: WNEAR, onExchange: 7n, inFlight: 1 });
    expect(fc(i).gas).toBeGreaterThanOrEqual(115n * I.TGAS);
    expect(i.blockers.join(" ")).toMatch(/in flight/);
  });
});

describe("policy form", () => {
  const tokens = [WNEAR, USDT];

  it("turns plain language into the exact on-chain policy, and back", () => {
    const form = {
      ...emptyForm(tokens),
      agentId: "bot.testnet",
      maxActions: "5",
      tokens: [
        { id: WNEAR.id, accepted: true, perTrade: "0.1", perDay: "0.3" },
        { id: USDT.id, accepted: true, perTrade: "0", perDay: "0" },
      ],
      pool: { enabled: true, slippagePercent: "1" },
      payments: { perPayment: "0", perDay: "0", receivers: "" },
    };
    const r = formToPolicy(form, tokens, POOL);
    expect(r).toEqual({
      ok: true,
      policy: {
        per_tx_cap: "0",
        daily_cap: "0",
        max_spends_per_24h: 5,
        allowlist: [],
        tokens: [
          { token_id: WNEAR.id, per_tx_cap: "100000000000000000000000", daily_cap: "300000000000000000000000" },
          { token_id: USDT.id, per_tx_cap: "0", daily_cap: "0" },
        ],
        pools: [{ pool_id: 1084, token_ids: ["usdt.itachicara.testnet", "wrap.testnet"], max_slippage_bps: 100 }],
      },
    });
    if (r.ok) expect(policyToForm("bot.testnet", r.policy, tokens, 1084)).toEqual(form);
  });

  it("mirrors the contract's validation", () => {
    const bad = formToPolicy({ ...emptyForm(tokens), maxActions: "0", tokens: [{ id: WNEAR.id, accepted: true, perTrade: "2", perDay: "1" }, { id: USDT.id, accepted: false, perTrade: "0", perDay: "0" }], pool: { enabled: true, slippagePercent: "20" } }, tokens, POOL);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["maxActions", "pool.slippage", `token.${USDT.id}.accepted`, `token.${WNEAR.id}.perTrade`].sort());
    }
    expect(validatePolicy({ per_tx_cap: "2", daily_cap: "1", max_spends_per_24h: 101, allowlist: [VAULT], tokens: [], pools: [] }, VAULT)).toHaveLength(3);
  });

  it("decimals always come from token metadata: 6 for mainnet USDt", () => {
    const r = formToPolicy({ ...emptyForm([USDT6]), tokens: [{ id: USDT6.id, accepted: true, perTrade: "1.5", perDay: "10" }] }, [USDT6], { id: 3879, tokenIds: ["wrap.near", USDT6.id] });
    expect(r.ok && r.policy.tokens[0]).toEqual({ token_id: USDT6.id, per_tx_cap: "1500000", daily_cap: "10000000" });
  });

  it("describes changes in plain words", () => {
    const before: Policy = { per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 5, allowlist: [], tokens: [{ token_id: WNEAR.id, per_tx_cap: "100000000000000000000000", daily_cap: "300000000000000000000000" }], pools: [] };
    const after: Policy = { ...before, tokens: [{ token_id: WNEAR.id, per_tx_cap: "200000000000000000000000", daily_cap: "300000000000000000000000" }] };
    expect(diffPolicy(before, after, tokens)).toEqual([{ what: "wNEAR per trade", before: "0.1 wNEAR", after: "0.2 wNEAR" }]);
  });
});
