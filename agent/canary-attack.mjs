#!/usr/bin/env node
// Attacks the mainnet canary with its own published key, the way an attacker who found the key
// would, and reports what the chain did with each attempt.
//
//   node agent/canary-attack.mjs            dry run: reads the chain, lists the attacks, sends nothing
//   node agent/canary-attack.mjs --send     signs and sends them, one after another
//
// The key is the canary agent's published function-call key (CANARY.md, "Mainnet"); the script
// checks on chain that it is still that key and still limited to agent_spend and agent_swap on the
// vault before it signs anything. It never asks for, reads or uses any other key, and it cannot
// attach a deposit. Gas is paid from the key's own allowance, not from your account.
//
// Two kinds of attack:
//   on chain   calls the key is allowed to make (agent_spend, agent_swap), each aimed at a
//              different way out: drain to an attacker, pay the owner or the contract, other
//              owners' vaults, zero and maximum amounts, malformed arguments, swaps through pools
//              the policy does not list, with too little gas, with no minimum. The vault must
//              refuse each one; every one appears on the board's attempt log with its reason.
//   protocol   calls the key is not allowed to make (owner methods, other contracts). NEAR refuses
//              these before they reach the chain, so they cost nothing and leave no record.
//
// After the run it reads the canary's vault again and checks the balance did not move.
//
// Environment (optional): NEAR_RPC (default https://rpc.mainnet.fastnear.com/), ATTACKER (the
// receiver the drains aim at; default attacker.intatto.near, the injection demo's attacker).
import { fileURLToPath } from "node:url";
import { Chain, vaultEvents } from "./intent-swap.mjs";
import { keyPair } from "./near-tx.mjs";

export const VAULT = "vault.intatto.near";
export const OWNER = "canary.intatto.near";
export const AGENT = "canary-agent.intatto.near";
// Published in CANARY.md, "Mainnet". Public on purpose: anyone may sign with it.
export const PUBLISHED_KEY = "ed25519:53VWGubUsKbFUjDDCRf8ngaju79BpTDsfnCGqroK26rh3FSep12CqzbeVV5uWSNDmLcVaPqdus3wmDJgCXjQJvVA";
export const PUBLISHED_PUBLIC_KEY = "ed25519:GWvo8kPMuTxj9yLvTnsFJ5jxB4D3CNrbcMsLn2WTAEig";
const U128_MAX = "340282366920938463463374607431768211455";
const TGAS = 1_000_000_000_000n;
const SWAP_TGAS = 300n; // the contract needs AGENT_SWAP_TGAS = 255 Tgas before it looks at the policy
const SPEND_TGAS = 30n;

/** The attacks, in order. `expect` is what the vault should say: a reject reason, or "failed". */
export function attacks(balance, attacker) {
  const spend = (owner, receiver, amount) => ({ owner_id: owner, receiver_id: receiver, amount });
  const swap = (pool, tin, tout, amountIn, minOut) => ({ owner_id: OWNER, pool_id: pool, token_in: tin, token_out: tout, amount_in: amountIn, min_amount_out: minOut });
  return [
    { name: "Drain the whole vault to an attacker", method: "agent_spend", args: spend(OWNER, attacker, balance), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Take 1 yoctoNEAR, the smallest unit", method: "agent_spend", args: spend(OWNER, attacker, "1"), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Send the maximum u128 amount (overflow attempt)", method: "agent_spend", args: spend(OWNER, attacker, U128_MAX), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Pay the agent's own account", method: "agent_spend", args: spend(OWNER, AGENT, balance), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Pay the owner (looks harmless, moves funds out of the vault)", method: "agent_spend", args: spend(OWNER, OWNER, balance), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Pay the vault contract itself", method: "agent_spend", args: spend(OWNER, VAULT, balance), gas: SPEND_TGAS, expect: "receiver_not_allowlisted" },
    { name: "Spend zero (edge case)", method: "agent_spend", args: spend(OWNER, attacker, "0"), gas: SPEND_TGAS, expect: "zero_amount" },
    { name: "Spend from another owner's vault", method: "agent_spend", args: spend("demo.intatto.near", attacker, "1"), gas: SPEND_TGAS, expect: ["not_agent", "no_vault"] },
    { name: "Spend from a vault that does not exist", method: "agent_spend", args: spend("no-such-owner-intatto.near", attacker, "1"), gas: SPEND_TGAS, expect: "no_vault" },
    { name: "Malformed amount (negative number)", method: "agent_spend", args: spend(OWNER, attacker, "-1"), gas: SPEND_TGAS, expect: "failed" },
    { name: "Swap with no minimum output (sandwich bait)", method: "agent_swap", args: swap(0, "wrap.near", "usdt.tether-token.near", "1", "0"), gas: SPEND_TGAS, expect: "zero_min_amount_out" },
    { name: "Swap with too little gas to finish", method: "agent_swap", args: swap(0, "wrap.near", "usdt.tether-token.near", "1", "1"), gas: SPEND_TGAS, expect: "insufficient_gas" },
    { name: "Swap the vault through a pool the policy does not list", method: "agent_swap", args: swap(0, "wrap.near", "usdt.tether-token.near", balance, "1"), gas: SWAP_TGAS, expect: "pool_not_allowlisted" },
  ];
}

/** Calls the key's permission forbids. NEAR refuses them before execution; nothing is recorded. */
export function protocolAttacks(attacker) {
  return [
    { name: "Withdraw as the owner (owner method)", receiver: VAULT, method: "withdraw", args: { amount: "1" } },
    { name: "Replace the agent and its policy (owner method)", receiver: VAULT, method: "set_agent", args: { agent_id: AGENT, policy: { per_tx_cap: U128_MAX, daily_cap: U128_MAX, max_spends_per_24h: 1000, allowlist: [attacker], tokens: [], pools: [] } } },
    { name: "Unfreeze or change the lock (owner methods)", receiver: VAULT, method: "unfreeze", args: {} },
    { name: "Trade through NEAR Intents (not granted to this key)", receiver: VAULT, method: "agent_intent_swap", args: {} },
    { name: "Call the vault's swap callback directly (callback spoof)", receiver: VAULT, method: "on_swap_quoted", args: {} },
    { name: "Call another contract with the key", receiver: "wrap.near", method: "ft_transfer", args: { receiver_id: attacker, amount: "1" } },
  ];
}

/** What the chain did with one sent transaction. */
export function classify(outcome) {
  const rejected = vaultEvents(outcome, VAULT).find((e) => e.event === "spend_rejected" || e.event === "swap_rejected");
  if (rejected) return { kind: "rejected", reason: rejected.data?.reason ?? "?" };
  const failure = [outcome?.status, outcome?.transaction_outcome?.outcome?.status, ...(outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status)].find((s) => s && s.Failure);
  if (failure) return { kind: "failed", message: JSON.stringify(failure.Failure).slice(0, 240) };
  return { kind: "succeeded" };
}

async function vaultBalance(chain) {
  const v = await chain.view(VAULT, "get_vault", { owner_id: OWNER });
  if (!v) throw new Error(`${OWNER} has no vault on ${VAULT}`);
  return { balance: v.balance, tokens: v.tokens };
}

async function main() {
  const send = process.argv.includes("--send");
  const rpc = process.env.NEAR_RPC ?? "https://rpc.mainnet.fastnear.com/";
  const attacker = process.env.ATTACKER ?? "attacker.intatto.near";
  const chain = new Chain(rpc);
  const keys = keyPair(PUBLISHED_KEY);
  if (keys.publicKey !== PUBLISHED_PUBLIC_KEY) throw new Error("the published private key does not derive the published public key");

  console.log(`== Preflight (${send ? "send" : "dry run"}), RPC ${rpc}`);
  const access = await chain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: AGENT, public_key: keys.publicKey });
  const call = access.permission?.FunctionCall;
  if (!call || call.receiver_id !== VAULT || call.method_names.some((m) => !["agent_spend", "agent_swap"].includes(m))) {
    throw new Error(`the key's permission is not the published one: ${JSON.stringify(access.permission)}`);
  }
  const allowance = BigInt(call.allowance ?? 0);
  const block = await chain.rpc("block", { finality: "final" });
  const gasPrice = BigInt(block.header.gas_price);
  const list = attacks((await vaultBalance(chain)).balance, attacker);
  const before = await vaultBalance(chain);
  // Upper bound of what the allowance is charged: all prepaid gas at twice the current price.
  const needed = list.reduce((sum, a) => sum + a.gas * TGAS * gasPrice * 2n, 0n);
  const near = (y) => (Number(y) / 1e24).toFixed(5);
  console.log(`    key:       ${keys.publicKey} on ${AGENT}, agent_spend and agent_swap on ${VAULT} only`);
  console.log(`    allowance: ${near(allowance)} NEAR left; this run needs at most ${near(needed)} NEAR of it`);
  console.log(`    canary:    ${near(before.balance)} NEAR in ${OWNER}'s vault, ${before.tokens.length} token(s); attacker ${attacker}`);
  if (allowance < needed) throw new Error("not enough allowance left on the published key for every attack; nothing sent");

  console.log(`\n== ${list.length} attacks the vault must refuse on chain`);
  list.forEach((a, i) => console.log(`  ${String(i + 1).padStart(2)}. ${a.name}  (${a.method}, expect ${[a.expect].flat().join(" or ")})`));
  const proto = protocolAttacks(attacker);
  console.log(`\n== ${proto.length} attacks the key itself cannot make (refused by NEAR, nothing recorded)`);
  proto.forEach((a, i) => console.log(`  ${String(i + 1).padStart(2)}. ${a.name}  (${a.receiver}.${a.method})`));
  if (!send) {
    console.log("\nDry run: nothing was signed. Run again with --send to make the attempts.");
    return;
  }

  let unexpected = 0;
  console.log("\n== On chain");
  for (const [i, a] of list.entries()) {
    let line;
    try {
      const outcome = await chain.call({ signerId: AGENT, keys, receiverId: VAULT, method: a.method, args: a.args, gas: a.gas * TGAS });
      const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
      const c = classify(outcome);
      const got = c.kind === "rejected" ? c.reason : c.kind;
      const ok = [a.expect].flat().includes(got);
      if (!ok) unexpected++;
      line = `${ok ? "refused" : "UNEXPECTED"}  ${c.kind === "rejected" ? `rejected: ${c.reason}` : c.kind === "failed" ? `failed: ${c.message}` : "SUCCEEDED"}\n      https://nearblocks.io/txns/${hash}`;
    } catch (err) {
      unexpected++;
      line = `UNEXPECTED  error: ${String(err?.message ?? err).slice(0, 240)}`;
    }
    console.log(`  ${String(i + 1).padStart(2)}. ${a.name}\n      ${line}`);
  }

  console.log("\n== Refused by NEAR before execution");
  for (const [i, a] of proto.entries()) {
    try {
      await chain.call({ signerId: AGENT, keys, receiverId: a.receiver, method: a.method, args: a.args, gas: SPEND_TGAS * TGAS });
      unexpected++;
      console.log(`  ${String(i + 1).padStart(2)}. ${a.name}\n      UNEXPECTED  the transaction was accepted`);
    } catch (err) {
      const text = JSON.stringify(err?.cause ?? err?.message ?? err);
      const why = text.match(/MethodNameMismatch|ReceiverMismatch|InvalidAccessKeyError|RequiresFullAccess|NotEnoughAllowance/)?.[0] ?? "refused";
      console.log(`  ${String(i + 1).padStart(2)}. ${a.name}\n      refused     ${why}`);
    }
  }

  const after = await vaultBalance(chain);
  const held = BigInt(after.balance) >= BigInt(before.balance) && after.tokens.length >= before.tokens.length;
  console.log(`\n== Canary: ${near(before.balance)} NEAR before, ${near(after.balance)} NEAR after: ${held ? "INTACT" : "CHANGED, check the board"}`);
  console.log(`   Attempt log: https://intatto.pages.dev/?network=mainnet   Agent account: https://nearblocks.io/address/${AGENT}`);
  if (unexpected > 0 || !held) {
    console.log(`\n${unexpected} attempt(s) did not end as expected. Paste this output.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`canary-attack: ${err?.message ?? err}`);
    process.exit(1);
  });
}
