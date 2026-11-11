import { describe, expect, it } from "vitest";
import { VaultViewSchema, type VaultView } from "../contract/abi.gen";
import { windowUsage, liveSpends, WINDOW_NS } from "../activity/window";
import { parseFastNearTransactions } from "../indexer/fastnear";
import { parseTxOutcome } from "../near/chain";
import canaryVault from "../test/fixtures/rpc-get-vault-canary.json";
import devVault from "../test/fixtures/rpc-get-vault-dev.json";
import lockTx from "../test/fixtures/rpc-tx-canary-lock.json";
import txsVault from "../test/fixtures/fastnear-transactions-vault.json";
import { attemptsFrom } from "./attempts";
import upgradeTx from "../test/fixtures/rpc-tx-vault-upgrade.json";
import mainnetDeployTx from "../test/fixtures/rpc-tx-mainnet-deploy.json";
import mainnetLockTx from "../test/fixtures/rpc-tx-mainnet-canary-lock.json";
import { boardState, checkBaselineTx, checkRunStartTx, integrityState, runStartOf } from "./board";

const VAULT = "vault-v1.intatto-dev.testnet";
const decode = (r: { result: { result: number[] } }): VaultView => VaultViewSchema.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result.result))));
const canary = decode(canaryVault);
const BASELINE = 997400000000000000000000n;
const LOCK_SET = 1793985194506864730n;
const baseline = { lockedUntilNs: 1796577187277683986n, lockSetAtNs: LOCK_SET, lockSetBlockHeight: 276514426, lockSetBlockHash: "2FZB" };
// The run started one day after the lock was set.
const RUN_AT = LOCK_SET + 86_400n * 10n ** 9n;
const RUN = { runStart: { atNs: RUN_AT, blockHeight: 276779119, blockHash: "5FmJ" }, codeChanged: false };

describe("checkBaselineTx", () => {
  const tx = parseTxOutcome(lockTx.result);
  it("accepts the real setup transaction and finds its lock", () => {
    expect(checkBaselineTx(tx, { ownerId: "canary.intatto-dev.testnet" }, VAULT)).toEqual({
      ok: true,
      lockedUntilNs: 1796577187277683986n,
      blockHash: "2FZB5PDHQr3BFmqq2F5rRR2mJM4bLRoLLjmM9gLA6QJ2",
    });
  });
  it("refuses a transaction from anyone else, or one the vault did not log", () => {
    expect(checkBaselineTx(tx, { ownerId: "someone.testnet" }, VAULT)).toEqual({ ok: false, problem: "wrong_signer" });
    expect(checkBaselineTx(tx, { ownerId: "canary.intatto-dev.testnet" }, "other-vault.testnet")).toEqual({ ok: false, problem: "wrong_receiver" });
    expect(checkBaselineTx(null, { ownerId: "x" }, VAULT)).toEqual({ ok: false, problem: "tx_not_found" });
  });
});

describe("boardState", () => {
  const now = LOCK_SET + 3n * 86_400n * 10n ** 9n;

  it("is intact for today's canary, counting from the lock", () => {
    const s = boardState({ vault: canary, baselineYocto: BASELINE, baseline, nowNs: now, ...RUN });
    expect(s.seal).toBe("intact");
    expect(s.breaks).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.bountyYocto).toBe(BASELINE);
    // Counted from the start of the run, not from the lock.
    expect(s.unbrokenForNs).toBe(2n * 86_400n * 10n ** 9n);
    expect(s.lockRemainingNs).toBe(1796577187277683986n - now);
    expect(s.lockExpired).toBe(false);
  });

  it("breaks on any decrease below the baseline, or if the vault is gone", () => {
    const drained = { ...canary, balance: (BASELINE - 1n).toString() };
    expect(boardState({ vault: drained, baselineYocto: BASELINE, baseline, nowNs: now, ...RUN })).toMatchObject({ seal: "broken", unbrokenForNs: null });
    expect(boardState({ vault: null, baselineYocto: BASELINE, baseline, nowNs: now, ...RUN }).seal).toBe("broken");
  });

  it("warns about setup changes that are not breaks", () => {
    const changed = { ...canary, frozen: true, policy: { ...canary.policy, max_spends_per_24h: 2 }, withdrawals_locked_until: "1796577187277683987" };
    const s = boardState({ vault: changed, baselineYocto: BASELINE, baseline, nowNs: now, ...RUN });
    expect(s.seal).toBe("intact");
    expect(s.warnings).toHaveLength(3);
  });

  it("reports an expired lock", () => {
    const s = boardState({ vault: canary, baselineYocto: BASELINE, baseline, nowNs: 1796577187277683986n, ...RUN });
    expect(s).toMatchObject({ lockExpired: true, lockRemainingNs: 0n });
  });

  it("is unknown until the vault has been read", () => {
    expect(boardState({ vault: undefined, baselineYocto: BASELINE, baseline: null, nowNs: null, ...RUN }).seal).toBe("unknown");
  });
});

describe("checkRunStartTx", () => {
  const tx = parseTxOutcome(upgradeTx.result);
  const J5MO = "J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL";
  it("accepts the real upgrade: vault-v1 deploying exactly the published build", () => {
    expect(checkRunStartTx(tx, VAULT, J5MO)).toEqual({ ok: true, blockHash: "5FmJsiGZnwJLMMXDH6VL2T3uco55swvuBApf2d5tfuk7" });
  });
  it("refuses a deployment of other code, by anyone else, or no deployment at all", () => {
    expect(checkRunStartTx(tx, VAULT, "FevckYG3RhhFYhj21xvC2nufv1z5vYmuG6P9nrK3hHCa")).toEqual({ ok: false, problem: "other_code" });
    expect(checkRunStartTx(tx, "other-vault.testnet", J5MO)).toEqual({ ok: false, problem: "wrong_signer" });
    expect(checkRunStartTx(parseTxOutcome(lockTx.result), "canary.intatto-dev.testnet", J5MO)).toMatchObject({ ok: false });
    expect(checkRunStartTx({ ...tx, actions: [{ Transfer: { deposit: "1" } }] }, VAULT, J5MO)).toEqual({ ok: false, problem: "no_deploy" });
    expect(checkRunStartTx(null, VAULT, J5MO)).toEqual({ ok: false, problem: "tx_not_found" });
  });
  it("ends the run, without a break, when the code changes", () => {
    const s = boardState({ vault: canary, baselineYocto: BASELINE, baseline, nowNs: RUN_AT + 1000n, runStart: RUN.runStart, codeChanged: true });
    expect(s).toMatchObject({ seal: "intact", runEnded: true, unbrokenForNs: null });
  });
});

describe("mainnet canary", () => {
  const MAINNET_VAULT = "vault.intatto.near";
  const Z1W = "3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J";
  it("verifies the real deployment of the published build and the real lock", () => {
    expect(checkRunStartTx(parseTxOutcome(mainnetDeployTx.result), MAINNET_VAULT, Z1W)).toEqual({ ok: true, blockHash: "BNfP7pqayfF1t2XT4F1vikyq3w8XEznx7Wakj2g5nKPV" });
    expect(checkBaselineTx(parseTxOutcome(mainnetLockTx.result), { ownerId: "canary.intatto.near" }, MAINNET_VAULT)).toEqual({
      ok: true,
      lockedUntilNs: 1795176000000000000n,
      blockHash: "88p8kiptmeKLyDoYCLqwCS9fjByQkPNWMvDpo5vuvFZK",
    });
  });
});

describe("runStartOf", () => {
  // Mainnet: deployed at block 224,086,630, canary locked at 224,088,066.
  const deploy = { atNs: 1794412705795534224n, blockHeight: 224086630, blockHash: "BNfP" };
  const setup = { lockedUntilNs: 1795176000000000000n, lockSetAtNs: 1794413530328250785n, lockSetBlockHeight: 224088066, lockSetBlockHash: "88p8" };
  it("starts at the setup when the canary was set up on a vault already running the build", () => {
    expect(runStartOf(deploy, setup)).toEqual({ atNs: 1794413530328250785n, blockHeight: 224088066, blockHash: "88p8", by: "setup" });
  });
  it("starts at the deployment when the build was deployed under an existing canary", () => {
    expect(runStartOf(RUN.runStart, baseline)).toEqual({ ...RUN.runStart, by: "deploy" });
  });
  it("waits until both are verified", () => {
    expect(runStartOf(null, setup)).toBeNull();
    expect(runStartOf(deploy, null)).toBeNull();
  });
});

describe("integrityState", () => {
  it("compares the on-chain hash with the published build", () => {
    expect(integrityState("A", "A")).toBe("matches");
    expect(integrityState("A", "B")).toBe("changed");
    expect(integrityState(null, "B")).toBe("changed");
    expect(integrityState(undefined, "B")).toBe("unknown");
    expect(integrityState("A", null)).toBe("unconfigured");
  });
});

describe("attemptsFrom", () => {
  const txs = parseFastNearTransactions(txsVault);
  const agent = { agentId: "agent.intatto-dev.testnet", agentPublicKey: "ed25519:DSx3NRF83a34me3RRULscnmf3LfNDAH4q37yY73PUcdF" };

  it("lists only calls signed with the published key, with the vault's reason", () => {
    const attempts = attemptsFrom(txs, agent, VAULT);
    const byHash = Object.fromEntries(attempts.map((a) => [a.hash.slice(0, 8), a.outcome]));
    expect(byHash["2Xe4Etgk"]).toMatchObject({ kind: "rejected", reason: "frozen", message: "Vault is frozen; agent swapping is disabled" });
    expect(byHash["AyHPvtxV"]).toMatchObject({ kind: "rejected", reason: "over_per_tx_cap" });
    expect(byHash["FXecevsj"]).toMatchObject({ kind: "rejected", reason: "pool_not_allowlisted" });
    // the one swap that went through is shown as such
    expect(byHash["5KeUAq3h"]).toEqual({ kind: "succeeded" });
    expect(attempts.every((a) => a.method === "agent_swap")).toBe(true);
    expect(attemptsFrom(txs, { ...agent, agentPublicKey: "ed25519:other" }, VAULT)).toEqual([]);
  });
});

describe("24-hour window", () => {
  const dev = decode(devVault);
  const spend = dev.recent_spends[0]!;
  const t = BigInt(spend.timestamp);

  it("counts a spend until exactly 24 hours after it, by chain time", () => {
    expect(windowUsage(dev.recent_spends, t + WINDOW_NS - 1n, "wrap.testnet")).toEqual({ count: 1, total: 100000000000000000000000n, nextExpiryNs: t + WINDOW_NS });
    expect(windowUsage(dev.recent_spends, t + WINDOW_NS, "wrap.testnet")).toEqual({ count: 0, total: 0n, nextExpiryNs: null });
  });

  it("drops stale entries the contract has not pruned yet", () => {
    expect(liveSpends(dev.recent_spends, t + WINDOW_NS)).toEqual([]);
  });

  it("totals per token: a wNEAR swap does not count against NEAR", () => {
    expect(windowUsage(dev.recent_spends, t, null)).toMatchObject({ count: 1, total: 0n });
  });
});
