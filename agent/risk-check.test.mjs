import assert from "node:assert/strict";
import { test } from "node:test";
import { assessSwap, gatherSwapFacts, keyScope, priceImpactBps, slippageFloor, soldInWindow, spendsInWindow, WINDOW_NS } from "./risk-check.mjs";

const NOW = 1_800_000_000_000_000_000n;
const VAULT = "vault.intatto.near";
const W = "wrap.near";
const U = "usdt.tether-token.near";

function vault(over = {}) {
  return {
    balance: "0",
    frozen: false,
    agent_id: "agent.intatto.near",
    policy: {
      per_tx_cap: "0",
      daily_cap: "0",
      max_spends_per_24h: 10,
      allowlist: [],
      tokens: [{ token_id: W, per_tx_cap: "1000", daily_cap: "3000" }],
      pools: [{ pool_id: 7, token_ids: [W, U], max_slippage_bps: 100 }],
    },
    recent_spends: [],
    tokens: [{ token_id: W, balance: "5000", on_exchange: "0" }],
    ...over,
  };
}

function facts(over = {}) {
  return {
    vaultId: VAULT,
    ownerId: "owner.near",
    agentId: "agent.intatto.near",
    poolId: 7,
    tokenIn: W,
    tokenOut: U,
    amountIn: "1000",
    minAmountOut: "3980",
    nowNs: NOW,
    vault: vault(),
    quote: "4000",
    probeIn: "10",
    probeQuote: "40",
    agentKeyPermission: { FunctionCall: { receiver_id: VAULT, method_names: ["agent_swap"], allowance: "1" } },
    tokenOutFullAccessKeys: 0,
    ...over,
  };
}

const codes = (r) => r.reasons.map((x) => x.code);

test("slippageFloor matches the contract's arithmetic", () => {
  assert.equal(slippageFloor(4000n, 100), 3960n);
  assert.equal(slippageFloor(12345n, 37), 12299n); // 12345 * 9963 / 10000 = 12299.3
  assert.equal(slippageFloor(9999n, 1), 9998n);
});

test("priceImpactBps compares the full trade's rate with a small probe", () => {
  assert.equal(priceImpactBps(1000n, 4000n, 10n, 40n), 0n);
  assert.equal(priceImpactBps(1000n, 3800n, 10n, 40n), 500n);
  assert.equal(priceImpactBps(1000n, 4000n, 0n, 40n), null);
});

test("window helpers count only the last 24 hours", () => {
  const spends = [
    { timestamp: (NOW - WINDOW_NS).toString(), token_id: W, amount: "900" }, // expired exactly at the edge
    { timestamp: (NOW - 1n).toString(), token_id: W, amount: "100" },
    { timestamp: (NOW - 1n).toString(), token_id: null, amount: "5" },
  ];
  assert.equal(soldInWindow(spends, W, NOW), 100n);
  assert.equal(soldInWindow(spends, null, NOW), 5n);
  assert.equal(spendsInWindow(spends, NOW), 2);
});

test("keyScope tells a vault-only key from a full or wider one", () => {
  assert.equal(keyScope("FullAccess", VAULT), "full");
  assert.equal(keyScope({ FunctionCall: { receiver_id: VAULT, method_names: ["agent_swap"] } }, VAULT), "vault-only");
  assert.equal(keyScope({ FunctionCall: { receiver_id: VAULT, method_names: [] } }, VAULT), "wider");
  assert.equal(keyScope({ FunctionCall: { receiver_id: VAULT, method_names: ["withdraw"] } }, VAULT), "wider");
  assert.equal(keyScope({ FunctionCall: { receiver_id: "x.near", method_names: ["agent_swap"] } }, VAULT), "other");
});

test("a swap inside the policy, with a tight minimum, is allowed", () => {
  const r = assessSwap(facts());
  assert.equal(r.verdict, "allow", JSON.stringify(r.reasons));
  assert.equal(r.floor, "3960");
  assert.equal(r.suggestedMinOut, "3980");
  assert.equal(r.impactBps, "0");
});

test("every contract refusal is a block, with the contract's reason", () => {
  assert.deepEqual(codes(assessSwap(facts({ vault: null }))), ["no_vault"]);
  assert.ok(codes(assessSwap(facts({ vault: vault({ frozen: true }) }))).includes("frozen"));
  assert.ok(codes(assessSwap(facts({ vault: vault({ agent_id: "someone.near" }) }))).includes("not_agent"));
  assert.ok(codes(assessSwap(facts({ poolId: 8 }))).includes("pool_not_allowlisted"));
  assert.ok(codes(assessSwap(facts({ tokenOut: "other.near" }))).includes("pair_mismatch"));
  assert.ok(codes(assessSwap(facts({ tokenIn: U, tokenOut: W }))).includes("token_not_allowed"));
  assert.ok(codes(assessSwap(facts({ amountIn: "1001", quote: "4004", minAmountOut: "3990" }))).includes("over_per_tx_cap"));
  assert.ok(codes(assessSwap(facts({ quote: null }))).includes("quote_failed"));
  assert.ok(codes(assessSwap(facts({ minAmountOut: "3959" }))).includes("slippage_too_loose"));
  assert.ok(codes(assessSwap(facts({ minAmountOut: "0" }))).includes("zero_min_amount_out"));
  assert.ok(codes(assessSwap(facts({ vault: vault({ tokens: [{ token_id: W, balance: "999", on_exchange: "0" }] }) }))).includes("insufficient_balance"));
  for (const code of ["frozen", "pool_not_allowlisted", "slippage_too_loose"]) {
    const v = code === "frozen" ? { vault: vault({ frozen: true }) } : code === "pool_not_allowlisted" ? { poolId: 8 } : { minAmountOut: "1" };
    assert.equal(assessSwap(facts(v)).verdict, "block");
  }
});

test("daily cap and spend count follow the 24-hour window", () => {
  const recent = [
    { spend_id: "1", timestamp: (NOW - 10n).toString(), token_id: W, amount: "1000" },
    { spend_id: "2", timestamp: (NOW - 10n).toString(), token_id: W, amount: "1000" },
  ];
  assert.ok(codes(assessSwap(facts({ vault: vault({ recent_spends: recent }) }))).includes("near_daily_cap"));
  const full = [...recent, { spend_id: "3", timestamp: (NOW - 10n).toString(), token_id: W, amount: "500" }];
  assert.ok(codes(assessSwap(facts({ vault: vault({ recent_spends: full }) }))).includes("over_daily_cap"));
  const old = recent.map((s) => ({ ...s, timestamp: (NOW - WINDOW_NS - 1n).toString() }));
  assert.equal(assessSwap(facts({ vault: vault({ recent_spends: old }) })).verdict, "allow");
  const many = Array.from({ length: 10 }, (_, i) => ({ spend_id: String(i), timestamp: (NOW - 1n).toString(), token_id: null, amount: "1" }));
  assert.ok(codes(assessSwap(facts({ vault: vault({ recent_spends: many }) }))).includes("too_many_spends"));
});

test("risks the contract does not judge are flagged", () => {
  assert.ok(codes(assessSwap(facts({ quote: "3900", minAmountOut: "3870" }))).includes("price_impact"));
  const thin = assessSwap(facts({ quote: "3000", minAmountOut: "2980" }));
  assert.equal(thin.verdict, "block");
  assert.ok(codes(thin).includes("price_impact"));
  assert.ok(codes(assessSwap(facts({ minAmountOut: "3961" }))).includes("loose_min_out"));
  assert.ok(codes(assessSwap(facts({ minAmountOut: "4100" }))).includes("min_out_above_quote"));
  assert.ok(codes(assessSwap(facts({ tokenOutFullAccessKeys: 2 }))).includes("token_out_upgradeable"));
});

test("the signing key must be a function-call key on the vault", () => {
  assert.ok(codes(assessSwap(facts({ agentKeyPermission: "FullAccess" }))).includes("agent_key_full_access"));
  assert.ok(codes(assessSwap(facts({ agentKeyPermission: { Missing: true } }))).includes("agent_key_missing"));
  assert.ok(codes(assessSwap(facts({ agentKeyPermission: { FunctionCall: { receiver_id: "x.near", method_names: [] } } }))).includes("agent_key_wrong_receiver"));
  assert.equal(assessSwap(facts({ agentKeyPermission: { FunctionCall: { receiver_id: VAULT, method_names: [] } } })).verdict, "warn");
});

test("gatherSwapFacts reads view calls only and quotes the full trade and a 1% probe", async () => {
  const calls = [];
  const chain = {
    rpc: async (method, params) => {
      calls.push(method + ":" + (params.request_type ?? ""));
      if (method === "block") return { header: { timestamp_nanosec: NOW.toString() } };
      if (params.request_type === "view_access_key") return { permission: { FunctionCall: { receiver_id: VAULT, method_names: ["agent_swap"] } } };
      if (params.request_type === "view_access_key_list") return { keys: [{ access_key: { permission: "FullAccess" } }] };
      throw new Error("unexpected " + method);
    },
    view: async (account, method, args) => {
      calls.push(`view:${account}.${method}`);
      if (method === "get_vault") return vault();
      if (method === "get_exchange_id") return "v2.ref-finance.near";
      if (method === "get_return") return String(BigInt(args.amount_in) * 4n);
      throw new Error("unexpected " + method);
    },
  };
  const f = await gatherSwapFacts(chain, { vaultId: VAULT, ownerId: "owner.near", agentId: "agent.intatto.near", agentPublicKey: "ed25519:x", poolId: 7, tokenIn: W, tokenOut: U, amountIn: "1000", minAmountOut: "3980" });
  assert.equal(f.quote, "4000");
  assert.equal(f.probeIn, "10");
  assert.equal(f.probeQuote, "40");
  assert.equal(f.tokenOutFullAccessKeys, 1);
  assert.ok(calls.every((c) => !c.startsWith("send_tx") && !c.startsWith("broadcast")));
  const r = assessSwap(f);
  assert.equal(r.verdict, "warn"); // the token's full-access key
  assert.deepEqual(codes(r), ["token_out_upgradeable"]);
});
