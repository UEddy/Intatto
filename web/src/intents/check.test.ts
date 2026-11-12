import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/networks";
import { parseTxOutcome, type TxOutcome } from "../near/chain";
import signTx from "../test/fixtures/rpc-tx-mainnet-intent-swap.json";
import executeTx from "../test/fixtures/rpc-tx-mainnet-intent-exec.json";
import settleTx from "../test/fixtures/rpc-tx-mainnet-intent-settle.json";
import {
  buildState,
  checkExecuteTx,
  checkSettleTx,
  checkSignTx,
  checkSwap,
  floorFor,
  keyState,
  meetsFloor,
  nep413Hash,
  rateScaled,
} from "./check";

const cfg = MAINNET.intents!;
const sign = parseTxOutcome(signTx.result);
const execute = parseTxOutcome(executeTx.result);
const settle = parseTxOutcome(settleTx.result);
// CHAIN_SIGNATURES.md: the intent hash intents.near executed, recomputed independently.
const INTENT_HASH = "5aGuMWbXy1QM5ocroB2mkvTagtHmYvxze5KY1jLvwmUi";
const NONCE = "Vij2xgAlKBKzAK7Wg2hE8BgAAAAAAAAAAHfXH7YqrrM=";
const KEY = "ed25519:5kYTxFESA4ciqDeFz5j5YqsY2sSC9WN2YN5hBNRpCgWi";

/** The same transaction with every log of one receipt executor rewritten. */
function relog(tx: TxOutcome, executorId: string, f: (log: string) => string): TxOutcome {
  return { ...tx, receipts: tx.receipts.map((r) => (r.executorId === executorId ? { ...r, logs: r.logs.map(f) } : r)) };
}

describe("buildState", () => {
  it("matches only the published build", () => {
    expect(buildState("HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC", cfg.expectedBuild.codeHash)).toBe("matches");
    expect(buildState("3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J", cfg.expectedBuild.codeHash)).toBe("changed");
    expect(buildState(null, cfg.expectedBuild.codeHash)).toBe("changed");
    expect(buildState(undefined, cfg.expectedBuild.codeHash)).toBe("unknown");
  });
});

describe("keyState", () => {
  it("is one-derived only for exactly the derived key", () => {
    expect(keyState([KEY], KEY)).toBe("one-derived");
    expect(keyState([KEY, "ed25519:other"], KEY)).toBe("extra");
    expect(keyState(["ed25519:other"], KEY)).toBe("mismatch");
    expect(keyState([], KEY)).toBe("none");
    expect(keyState(undefined, KEY)).toBe("unknown");
    expect(keyState([KEY], undefined)).toBe("unknown");
  });
});

describe("floor", () => {
  // get_intent_policy(intents-owner.intatto.near) on mainnet, 2026-11-11.
  const policy = { pairs: [{ token_in: "wrap.near", token_out: "usdt.tether-token.near", min_out: "3300000", per_in: "1000000000000000000000000" }] };
  const floor = floorFor(policy, "wrap.near", "usdt.tether-token.near")!;

  it("reads the owner's floor for the pair and direction only", () => {
    expect(floor).toEqual({ minOut: 3300000n, perIn: 10n ** 24n });
    expect(floorFor(policy, "usdt.tether-token.near", "wrap.near")).toBeNull();
    expect(floorFor(null, "wrap.near", "usdt.tether-token.near")).toBeNull();
  });

  it("compares exactly, as the contract does", () => {
    const amountIn = 3n * 10n ** 23n;
    expect(meetsFloor(amountIn, 1130742n, floor)).toBe(true);
    // 0.3 wNEAR at exactly 3.3 is 0.99 USDt; one unit less is refused.
    expect(meetsFloor(amountIn, 990000n, floor)).toBe(true);
    expect(meetsFloor(amountIn, 989999n, floor)).toBe(false);
  });

  it("states the rate rounded down", () => {
    expect(rateScaled(3n * 10n ** 23n, 1130742n, 24, 6, 3)).toBe(3769n);
    expect(rateScaled(floor.perIn, floor.minOut, 24, 6, 3)).toBe(3300n);
  });
});

describe("nep413Hash", () => {
  it("recomputes the intent hash intents.near executed from the vault's signed payload", async () => {
    const message =
      '{"signer_id":"intents.intatto.near","deadline":"2026-11-11T17:51:07Z","intents":[{"intent":"token_diff","diff":{"nep141:wrap.near":"-300000000000000000000000","nep141:usdt.tether-token.near":"1130742"}}]}';
    expect(await nep413Hash(message, NONCE, "intents.near")).toBe(INTENT_HASH);
    // One byte of the message changed is another intent.
    expect(await nep413Hash(message.replace("1130742", "1130743"), NONCE, "intents.near")).not.toBe(INTENT_HASH);
  });
});

describe("checkSignTx", () => {
  it("accepts the real agent_intent_swap and returns the payload the vault logged as signed", () => {
    const r = checkSignTx(sign, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signed.publicKey).toBe(KEY);
    expect(r.signed.recipient).toBe("intents.near");
    expect(r.signed.nonce).toBe(NONCE);
    expect(r.signed.deadline).toBe("2026-11-11T17:51:07Z");
  });

  it("refuses another signer, another receiver, or a missing transaction", () => {
    expect(checkSignTx(null, cfg)).toEqual({ ok: false, problem: "tx_not_found" });
    expect(checkSignTx({ ...sign, signerId: "someone.near" }, cfg)).toEqual({ ok: false, problem: "wrong_signer" });
    expect(checkSignTx(sign, { ...cfg, vaultId: "vault.intatto.near" })).toEqual({ ok: false, problem: "wrong_receiver" });
    expect(checkSignTx(execute, { ...cfg, agentId: "intents.near", vaultId: "intents.near" })).toEqual({ ok: false, problem: "wrong_method" });
  });

  it("refuses a payload with other amounts, or an event logged by another contract", () => {
    expect(checkSignTx(sign, { ...cfg, swap: { ...cfg.swap, amountOut: "1130743" } })).toEqual({ ok: false, problem: "wrong_amounts" });
    const moved = { ...sign, receipts: sign.receipts.map((r) => (r.executorId === cfg.vaultId ? { ...r, executorId: "v1.signer" } : r)) };
    expect(checkSignTx(moved, cfg)).toEqual({ ok: false, problem: "no_event" });
  });

  it("refuses a failed receipt", () => {
    const failed = { ...sign, receipts: sign.receipts.map((r, i) => (i === 1 ? { ...r, status: "failure" as const } : r)) };
    expect(checkSignTx(failed, cfg)).toEqual({ ok: false, problem: "tx_failed" });
  });
});

describe("checkExecuteTx", () => {
  it("finds the vault's intent executed with exactly the signed diff", () => {
    expect(checkExecuteTx(execute, cfg, INTENT_HASH, NONCE)).toEqual({ ok: true });
  });

  it("refuses another intent hash or nonce", () => {
    expect(checkExecuteTx(execute, cfg, "4N12BfiRaLwTXQ7SLy357ZR75kKdL3e9KHeakvi7ZNCb", NONCE)).toEqual({ ok: false, problem: "no_event" });
    expect(checkExecuteTx(execute, cfg, INTENT_HASH, "AAAA")).toEqual({ ok: false, problem: "no_event" });
  });

  it("refuses a token_diff that is not the signed one", () => {
    const tampered = relog(execute, "intents.near", (l) => l.replace('"nep141:usdt.tether-token.near":"1130742"', '"nep141:usdt.tether-token.near":"1"'));
    expect(checkExecuteTx(tampered, cfg, INTENT_HASH, NONCE)).toEqual({ ok: false, problem: "wrong_amounts" });
  });
});

describe("checkSettleTx", () => {
  it("finds the owner credited exactly amount_out", () => {
    expect(checkSettleTx(settle, cfg)).toEqual({ ok: true });
    expect(checkSettleTx(settle, { ...cfg, swap: { ...cfg.swap, amountOut: "1130743" } })).toEqual({ ok: false, problem: "wrong_amounts" });
    expect(checkSettleTx(settle, { ...cfg, ownerId: "someone.near" })).toEqual({ ok: false, problem: "no_event" });
  });
});

describe("checkSwap", () => {
  it("checks the three transactions in order, one at a time", async () => {
    const asked: string[] = [];
    const byHash: Record<string, TxOutcome> = { [cfg.swap.signTxHash]: sign, [cfg.swap.executeTxHash]: execute, [cfg.swap.settleTxHash]: settle };
    let inFlight = 0;
    const r = await checkSwap(cfg, async (hash) => {
      inFlight++;
      expect(inFlight).toBe(1);
      asked.push(hash);
      await Promise.resolve();
      inFlight--;
      return byHash[hash] ?? null;
    });
    expect(asked).toEqual([cfg.swap.signTxHash, cfg.swap.executeTxHash, cfg.swap.settleTxHash]);
    expect(r).toMatchObject({ sign: { ok: true }, intentHash: INTENT_HASH, execute: { ok: true }, settle: { ok: true } });
    // The swap of 2026-11-11 was made before the agent asked NEAR AI: no receipt, so no link.
    expect(r.aiDecision).toEqual({ kind: "none" });
  });

  it("stops at a signing step that does not check out", async () => {
    const r = await checkSwap(cfg, async () => null);
    expect(r).toEqual({ sign: { ok: false, problem: "tx_not_found" }, aiDecision: { kind: "none" }, intentHash: null, execute: null, settle: null });
  });
});
