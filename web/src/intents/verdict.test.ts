/**
 * The panel's four checks end to end through the real RpcClient and Chain: a pass from real
 * mainnet answers, a red fail when the chain contradicts the claim, and "unverified" (never a pass,
 * never a fail) when a read fails with a network error or a 429 after the client's backoff.
 */
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/networks";
import { Chain } from "../near/chain";
import { RpcClient } from "../near/rpc";
import signTx from "../test/fixtures/rpc-tx-mainnet-intent-swap.json";
import executeTx from "../test/fixtures/rpc-tx-mainnet-intent-exec.json";
import settleTx from "../test/fixtures/rpc-tx-mainnet-intent-settle.json";
import { fakeFetch, type Step } from "../test/fakeFetch";
import { Memo, checkBuild, checkCaveat, checkKey, checkSwapAll, type Reads, type Verdict } from "./check";

const cfg = MAINNET.intents!;
const KEY = "ed25519:5kYTxFESA4ciqDeFz5j5YqsY2sSC9WN2YN5hBNRpCgWi";
const FULL = "ed25519:B6J5YQj4MdZz2NYu91ybZnJyrhdKAgJGptZxUcQ4WrcA";
const block = { block_height: 224115640, block_hash: "F4zbyxWCc3GfmY9Ut25EPW3AnbUEw8AJnhf8z2KYP2Gt" };

/** What mainnet answered on 2026-11-11, by request; `edit` changes one answer. */
type Answers = { views: Record<string, unknown>; codeHash: string };
const MAINNET_ANSWERS = (): Answers => ({
  codeHash: "HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC",
  views: {
    "intents.near.public_keys_of": [KEY],
    "v1.signer.derived_public_key": KEY,
    "intents.intatto.near.get_intent_policy": { pairs: [{ token_in: "wrap.near", token_out: "usdt.tether-token.near", min_out: "3300000", per_in: "1000000000000000000000000" }] },
    "wrap.near.ft_metadata": { spec: "ft-1.0.0", name: "Wrapped NEAR fungible token", symbol: "wNEAR", decimals: 24 },
    "usdt.tether-token.near.ft_metadata": { spec: "ft-1.0.0", name: "Tether USD", symbol: "USDt", decimals: 6 },
  },
});
const TXS: Record<string, unknown> = {
  [cfg.swap.signTxHash]: signTx.result,
  [cfg.swap.executeTxHash]: executeTx.result,
  [cfg.swap.settleTxHash]: settleTx.result,
};

function answer(a: Answers) {
  return ({ body }: { body: unknown }) => {
    const { id, method, params } = body as { id: string; method: string; params: Record<string, string> };
    const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
    if (method === "tx") return ok(TXS[params.tx_hash!]);
    if (params.request_type === "view_account") return ok({ ...block, amount: "1", locked: "0", code_hash: a.codeHash, storage_usage: 1 });
    if (params.request_type === "view_access_key_list") return ok({ ...block, keys: [{ public_key: FULL, access_key: { nonce: 1, permission: "FullAccess" } }] });
    const v = a.views[`${params.account_id}.${params.method_name}`];
    return ok({ ...block, logs: [], result: Array.from(new TextEncoder().encode(JSON.stringify(v))) });
  };
}

function reads(step: Step, memo = new Memo()) {
  const f = fakeFetch([step]);
  const rpc = () => new RpcClient("https://rpc.example/", { attempts: 3, sleep: async () => {}, fetch: f.fetch });
  return { r: { chain: new Chain(rpc()), archive: new Chain(rpc()), memo } satisfies Reads, f };
}

const networkError: Step = { throws: new TypeError("Failed to fetch") };
const rateLimited: Step = { status: 429, body: "Too Many Requests" };

const CHECKS: [string, (r: Reads) => Promise<Verdict<unknown>>][] = [
  ["build", (r) => checkBuild(r, cfg)],
  ["key", (r) => checkKey(r, cfg)],
  ["swap", (r) => checkSwapAll(r, cfg)],
  ["caveat", (r) => checkCaveat(r, cfg)],
];

describe.each(CHECKS)("the %s check", (_name, run) => {
  it("passes on mainnet's real answers", async () => {
    expect((await run(reads({ status: 200, body: answer(MAINNET_ANSWERS()) }).r)).verdict).toBe("pass");
  });

  it("is unverified, not a pass, after network errors outlast the backoff", async () => {
    const { r, f } = reads(networkError);
    const v = await run(r);
    expect(v.verdict).toBe("unverified");
    if (v.verdict === "unverified") expect(v.reason).toMatch(/network error/);
    // Retried first: the client's backoff ran out before the check gave up.
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("is unverified, not a pass, after 429s outlast the backoff", async () => {
    const v = await run(reads(rateLimited).r);
    expect(v.verdict).toBe("unverified");
    if (v.verdict === "unverified") expect(v.reason).toMatch(/rate limited \(HTTP 429\)/);
  });
});

describe("a contradiction is a red fail, distinct from unverified", () => {
  const ok = (edit: (a: Answers) => void) => {
    const a = MAINNET_ANSWERS();
    edit(a);
    return reads({ status: 200, body: answer(a) }).r;
  };
  it("build: other code", async () => {
    expect((await checkBuild(ok((a) => (a.codeHash = "3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J")), cfg)).verdict).toBe("fail");
  });
  it("key: a second key on intents.near, or another derived key", async () => {
    const extra = await checkKey(ok((a) => (a.views["intents.near.public_keys_of"] = [KEY, "ed25519:Other"])), cfg);
    expect(extra).toMatchObject({ verdict: "fail", value: { state: "extra" } });
    const other = await checkKey(ok((a) => (a.views["v1.signer.derived_public_key"] = "ed25519:Other")), cfg);
    expect(other).toMatchObject({ verdict: "fail", value: { state: "mismatch" } });
  });
  it("swap: a transaction that does not match the claimed amounts", async () => {
    const r = reads({ status: 200, body: answer(MAINNET_ANSWERS()) }).r;
    const v = await checkSwapAll(r, { ...cfg, swap: { ...cfg.swap, amountOut: "1130743" } });
    expect(v).toMatchObject({ verdict: "fail", value: { swap: { sign: { ok: false, problem: "wrong_amounts" } } } });
  });
  it("swap: a final transaction the node does not know is unverified, not a fail", async () => {
    const base = answer(MAINNET_ANSWERS());
    const r = reads({
      status: 200,
      body: (req) => {
        const b = req.body as { id: string; method: string };
        return b.method === "tx" ? JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, data: "" } }) : base(req);
      },
    }).r;
    expect((await checkSwapAll(r, cfg)).verdict).toBe("unverified");
  });
});

describe("identical requests within the page load", () => {
  it("reads the transactions, metadata and derived key once; a re-run re-reads only live state", async () => {
    const memo = new Memo();
    const { r, f } = reads({ status: 200, body: answer(MAINNET_ANSWERS()) }, memo);
    await Promise.all([checkSwapAll(r, cfg), checkKey(r, cfg)]);
    const first = f.calls.length;
    // 3 txs + 2 ft_metadata + policy + public_keys_of + derived key
    expect(first).toBe(8);
    await Promise.all([checkSwapAll(r, cfg), checkKey(r, cfg)]);
    const again = f.calls.slice(first).map((c) => (c.body as { params: { method_name?: string } }).params.method_name);
    expect(again.sort()).toEqual(["get_intent_policy", "public_keys_of"]);
  });

  it("forgets a failed read, so a retry asks again", async () => {
    const memo = new Memo();
    expect((await checkSwapAll(reads(networkError, memo).r, cfg)).verdict).toBe("unverified");
    expect((await checkSwapAll(reads({ status: 200, body: answer(MAINNET_ANSWERS()) }, memo).r, cfg)).verdict).toBe("pass");
  });
});
