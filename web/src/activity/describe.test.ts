import { describe, expect, it } from "vitest";
import { parseFastNearTransactions } from "../indexer/fastnear";
import txsVault from "../test/fixtures/fastnear-transactions-vault.json";
import { describeActivity, type TokenLookup } from "./describe";

const VAULT = "vault-v1.intatto-dev.testnet";
const tokens: TokenLookup = (id) => (id === "wrap.testnet" ? { symbol: "wNEAR", decimals: 24 } : id === "usdt.itachicara.testnet" ? { symbol: "USDT", decimals: 24 } : null);
const txs = parseFastNearTransactions(txsVault);

describe("activity feed lines", () => {
  const feed = describeActivity(txs, "intatto-dev.testnet", VAULT, tokens);

  it("keeps only this owner's events, newest first", () => {
    expect(feed.length).toBeGreaterThan(5);
    expect(feed.every((f, i) => i === 0 || BigInt(feed[i - 1]!.blockHeight) >= BigInt(f.blockHeight))).toBe(true);
    expect(feed.some((f) => /canary/.test(f.text))).toBe(false);
    expect(describeActivity(txs, "canary.intatto-dev.testnet", VAULT, tokens).map((f) => f.label)).toEqual(["Locked", "Policy", "Deposit"]);
  });

  it("explains a rejection with the caps in force at that moment", () => {
    const over = feed.find((f) => /per-trade cap/.test(f.text))!;
    expect(over.text).toBe("Blocked: agent.intatto-dev.testnet tried to swap 0.2 wNEAR for USDT; your per-trade cap is 0.1 wNEAR.");
    expect(feed.find((f) => /frozen/.test(f.text) && f.label === "Blocked")!.text).toMatch(/tried to swap 0\.1 wNEAR for USDT; the vault is frozen\.$/);
    expect(feed.find((f) => /pool #0/.test(f.text))!.text).toMatch(/pool #0 is not allowed by your policy/);
  });

  it("describes the completed swap with the exact amounts the vault credited", () => {
    const swap = feed.find((f) => f.label === "Swapped")!;
    expect(swap.text).toMatch(/^Agent swapped 0\.1 wNEAR for 0\.124161… USDT in pool #1084\.$/);
  });

  it("shows the gross output, the owner's net and the protocol fee from swap_completed 1.1.0 on", () => {
    // The real 5KeU… swap, its swap_completed log rewritten as the fee build logs it.
    const gross = 124161233475233043857166n;
    const fee = (gross * 10n) / 10000n;
    const withFee = txs.map((tx) => ({
      ...tx,
      receipts: tx.receipts.map((r) => ({
        ...r,
        logs: r.logs.map((l) => {
          if (!l.includes('"event":"swap_completed"')) return l;
          const e = JSON.parse(l.slice("EVENT_JSON:".length));
          e.version = "1.1.0";
          e.data.fee = fee.toString();
          e.data.net = (gross - fee).toString();
          return `EVENT_JSON:${JSON.stringify(e)}`;
        }),
      })),
    }));
    const swap = describeActivity(withFee, "intatto-dev.testnet", VAULT, tokens).find((f) => f.label === "Swapped")!;
    expect(swap.text).toMatch(/^Agent swapped 0\.1 wNEAR for 0\.124161… USDT in pool #1084: 0\.124037… USDT to the vault, 0\.000124… USDT protocol fee\.$/);
  });

  it("does not quote caps it has not seen", () => {
    // Without the agent_set transaction in the loaded history, no cap is invented.
    const withoutSetAgent = txs.filter((t) => !t.actions.some((a) => a.kind === "FunctionCall" && a.methodName === "set_agent"));
    const f = describeActivity(withoutSetAgent, "intatto-dev.testnet", VAULT, tokens).find((x) => /per-trade/.test(x.text))!;
    expect(f.text).toMatch(/it was over your per-trade cap\.$/);
  });
});

describe("the voice of the feed", () => {
  it("says \"the\" for someone else's vault, read-only, and \"your\" for the owner", () => {
    const owner = describeActivity(txs, "intatto-dev.testnet", VAULT, tokens);
    const visitor = describeActivity(txs, "intatto-dev.testnet", VAULT, tokens, "the");
    expect(owner.some((f) => /\byour\b/.test(f.text)), "the fixture has a refusal that names a limit").toBe(true);
    expect(visitor.filter((f) => /\byour\b/i.test(f.text)).map((f) => f.text)).toEqual([]);
    expect(visitor.map((f) => f.label)).toEqual(owner.map((f) => f.label));
  });
});

