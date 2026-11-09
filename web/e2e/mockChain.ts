/**
 * Deterministic chain and indexer answers for screenshot states the live testnet cannot show
 * (frozen, broken, matches, attempts present). Built from real responses in src/test/fixtures;
 * only the fields a state needs are changed.
 */
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../src/test/fixtures/${name}`, import.meta.url), "utf8"));

const CANARY = "canary.intatto-dev.testnet";
const CANARY_AGENT = "canary-agent.intatto-dev.testnet";
const CANARY_KEY = "ed25519:EHqQpQk85svJoeAWkJugoCGUXGMaVg77hak6pkiteZqr";
export const EXPECTED_HASH = "J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL";
export const DEPLOYED_HASH = "FevckYG3RhhFYhj21xvC2nufv1z5vYmuG6P9nrK3hHCa";
export const BASELINE = "997400000000000000000000";
const LOCK_SET_NS = 1793985194506864730n;

function canaryVault(): Record<string, unknown> {
  const r = fixture("rpc-get-vault-canary.json").result;
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

export interface Scenario {
  vault: Record<string, unknown>;
  codeHash: string;
  /** FastNEAR transactions signed by the canary agent, newest first. Called per poll. */
  attempts: (poll: number) => unknown[];
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** A real rejected swap from testnet, re-signed (in the fixture) as the canary agent's published key. */
function asCanaryAttempt(tx: any, hash: string, tsNs: bigint, height: number): any {
  const t = structuredClone(tx);
  t.transaction.hash = hash;
  t.transaction.signer_id = CANARY_AGENT;
  t.transaction.public_key = CANARY_KEY;
  for (const a of t.transaction.actions) {
    if (a.FunctionCall) {
      const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString("utf8"));
      args.owner_id = CANARY;
      a.FunctionCall.args = b64(args);
    }
  }
  const ts = Number(tsNs);
  t.execution_outcome.block_timestamp = ts;
  t.execution_outcome.block_height = height;
  for (const r of t.receipts) {
    r.execution_outcome.block_timestamp = ts + 600_000_000;
    r.receipt.block_timestamp = ts + 600_000_000;
    r.execution_outcome.outcome.logs = r.execution_outcome.outcome.logs.map((l: string) => l.replaceAll('"intatto-dev.testnet"', `"${CANARY}"`).replaceAll('"agent.intatto-dev.testnet"', `"${CANARY_AGENT}"`));
    if (r.receipt.predecessor_id === "agent.intatto-dev.testnet") r.receipt.predecessor_id = CANARY_AGENT;
  }
  return t;
}

/** An agent_spend of the whole bounty, refused (or, for the broken state, let through). */
function spendAttempt(template: any, hash: string, tsNs: bigint, height: number, outcome: "rejected" | "through"): any {
  const t = asCanaryAttempt(template, hash, tsNs, height);
  const args = { owner_id: CANARY, receiver_id: "mallory.testnet", amount: outcome === "through" ? "500000000000000000000000" : BASELINE };
  t.transaction.actions = [{ FunctionCall: { method_name: "agent_spend", args: b64(args), gas: 30000000000000, deposit: "0" } }];
  const vaultReceipt = t.receipts.find((r: any) => r.execution_outcome.outcome.executor_id === "vault-v1.intatto-dev.testnet");
  if (outcome === "rejected") {
    vaultReceipt.execution_outcome.outcome.logs = [
      `EVENT_JSON:${JSON.stringify({ standard: "intatto", version: "1.0.0", event: "spend_rejected", data: { owner_id: CANARY, caller_id: CANARY_AGENT, receiver_id: "mallory.testnet", amount: BASELINE, reason: "receiver_not_allowlisted" } })}`,
    ];
    vaultReceipt.execution_outcome.outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Receiver mallory.testnet is not on the vault's allowlist" } } } } };
  } else {
    vaultReceipt.execution_outcome.outcome.logs = [
      `EVENT_JSON:${JSON.stringify({ standard: "intatto", version: "1.0.0", event: "spend_initiated", data: { spend_id: "7", owner_id: CANARY, agent_id: CANARY_AGENT, receiver_id: "mallory.testnet", amount: args.amount } })}`,
    ];
    vaultReceipt.execution_outcome.outcome.status = { SuccessValue: "" };
    for (const r of t.receipts) if ("Failure" in r.execution_outcome.outcome.status) r.execution_outcome.outcome.status = { SuccessValue: "" };
  }
  return t;
}

const realTxs: any[] = fixture("fastnear-transactions-vault.json").transactions;
const byPrefix = (p: string) => realTxs.find((t) => t.transaction.hash.startsWith(p));

export function attemptSet(nowNs: bigint, opts: { through?: boolean } = {}): any[] {
  const h = 276_740_000;
  const min = 60_000_000_000n;
  const list = [
    asCanaryAttempt(byPrefix("FXecevsj"), "8vHq1Zr4mnTkFkQd2sXQ3w3Ehq6yK7nWJbzW4gQ9pG1a", nowNs - 41n * min, h + 1200),
    asCanaryAttempt(byPrefix("AyHPvtxV"), "5tYpR9w2Kc1Ys3JmVgXn8dD7qB4fLkHzTa6uE2oWcN3b", nowNs - 26n * min, h + 2700),
    spendAttempt(byPrefix("2Xe4Etgk"), "3kLmN8qPz2RtYv5WcX7bA9dF4gH6jK1sU0eQ2wE4rT6y", nowNs - 9n * min, h + 4400, "rejected"),
  ];
  if (opts.through) list.push(spendAttempt(byPrefix("2Xe4Etgk"), "9aBcDeFgHiJk1mNoPqRsTuVwXyZ2345678abcdefGhJ", nowNs - 2n * min, h + 5100, "through"));
  return list.reverse();
}

export function scenarios(nowNs: bigint): Record<string, Scenario> {
  const vault = canaryVault();
  return {
    "attempts-matches": { vault, codeHash: EXPECTED_HASH, attempts: () => attemptSet(nowNs) },
    frozen: { vault: { ...vault, frozen: true }, codeHash: EXPECTED_HASH, attempts: () => attemptSet(nowNs) },
    broken: { vault: { ...vault, balance: "497400000000000000000000" }, codeHash: DEPLOYED_HASH, attempts: () => attemptSet(nowNs, { through: true }) },
  };
}

export async function mockChain(page: Page, scenario: Scenario, nowNs: bigint): Promise<void> {
  const txs: Record<string, unknown> = {
    "7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA": fixture("rpc-tx-canary-lock.json").result,
    A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc: fixture("rpc-tx-vault-upgrade.json").result,
  };
  const blocks: Record<string, unknown> = {
    "2FZB5PDHQr3BFmqq2F5rRR2mJM4bLRoLLjmM9gLA6QJ2": fixture("rpc-block-lock.json").result,
    "5FmJsiGZnwJLMMXDH6VL2T3uco55swvuBApf2d5tfuk7": fixture("rpc-block-upgrade.json").result,
  };
  const height = 276_750_000;
  const rpc = async (route: Route) => {
    const body = route.request().postDataJSON() as { id: string; method: string; params: any };
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    const ref = { block_height: height, block_hash: "MockFinalBlockHash1111111111111111111111111" };
    if (body.method === "block") {
      if (body.params.finality) return ok({ header: { height, hash: ref.block_hash, timestamp_nanosec: nowNs.toString() } });
      if (body.params.block_id in blocks) return ok(blocks[body.params.block_id]);
    }
    if (body.method === "tx" && body.params.tx_hash in txs) return ok(txs[body.params.tx_hash]);
    if (body.method === "query") {
      const p = body.params;
      if (p.request_type === "view_account") return ok({ ...ref, amount: "3596205061717199300000002", locked: "0", code_hash: scenario.codeHash, storage_usage: 257571, storage_paid_at: 0 });
      if (p.request_type === "view_access_key")
        return ok({ ...ref, nonce: 276514440000000, permission: { FunctionCall: { allowance: "998700000000000000000000", method_names: ["agent_spend", "agent_swap"], receiver_id: "vault-v1.intatto-dev.testnet" } } });
      if (p.request_type === "call_function") {
        const answers: Record<string, unknown> = {
          get_vault: scenario.vault,
          contract_source_metadata: { version: "0.1.0", link: "https://github.com/UEddy/Intatto", standards: [{ standard: "nep330", version: "1.3.0" }], build_info: null },
          ft_metadata: { spec: "ft-1.0.0", name: "Wrapped NEAR fungible token", symbol: "wNEAR", icon: null, reference: null, reference_hash: null, decimals: 24 },
        };
        if (p.method_name in answers) return ok({ ...ref, logs: [], result: [...Buffer.from(JSON.stringify(answers[p.method_name]))] });
      }
    }
    return route.fulfill({ status: 500, body: `unmocked ${body.method}` });
  };
  await page.route("https://test.rpc.fastnear.com/", rpc);
  await page.route("https://archival-rpc.testnet.fastnear.com/", rpc);

  let poll = 0;
  let current: any[] = [];
  await page.route("https://tx.test.fastnear.com/v0/account", async (route) => {
    current = scenario.attempts(poll++);
    const account_txs = current.map((t) => ({
      account_id: CANARY_AGENT,
      transaction_hash: t.transaction.hash,
      tx_block_height: t.execution_outcome.block_height,
      tx_block_timestamp: String(t.execution_outcome.block_timestamp),
      is_signer: true,
    }));
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ account_txs, txs_count: account_txs.length }) });
  });
  await page.route("https://tx.test.fastnear.com/v0/transactions", async (route) => {
    const want: string[] = route.request().postDataJSON().tx_hashes;
    const transactions = current.filter((t) => want.includes(t.transaction.hash));
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ transactions }) });
  });
}

export { LOCK_SET_NS };
