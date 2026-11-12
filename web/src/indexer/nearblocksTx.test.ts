/**
 * NearBlocks' receipt tree as a transaction for the NEAR Intents swap checks: for the swap's three
 * mainnet transactions it gives what archival-rpc.mainnet.fastnear.com gives, field for field,
 * wherever the checks read (the RPC fixtures saved 2026-11-11, NearBlocks' trees fetched 2026-11-12).
 */
import { describe, expect, it } from "vitest";
import { parseTxOutcome } from "../near/chain";
import { decodeArgs } from "../near/encoding";
import rpcSign from "../test/fixtures/rpc-tx-mainnet-intent-swap.json";
import rpcExecute from "../test/fixtures/rpc-tx-mainnet-intent-exec.json";
import rpcSettle from "../test/fixtures/rpc-tx-mainnet-intent-settle.json";
import nbSign from "../test/fixtures/nearblocks-v3-tree-mainnet-intent-swap.json";
import nbExecute from "../test/fixtures/nearblocks-v3-tree-mainnet-intent-exec.json";
import nbSettle from "../test/fixtures/nearblocks-v3-tree-mainnet-intent-settle.json";
import { nearBlocksTxOutcome } from "./nearblocks";

const PAIRS = [
  ["agent_intent_swap", rpcSign, nbSign],
  ["execute_intents", rpcExecute, nbExecute],
  ["settle_intent_swap", rpcSettle, nbSettle],
] as const;

const method = (a: unknown) => (a as { FunctionCall: { method_name: string } }).FunctionCall.method_name;

describe.each(PAIRS)("%s from NearBlocks", (name, rpcJson, nbJson) => {
  const rpc = parseTxOutcome(rpcJson.result);
  const nb = nearBlocksTxOutcome(rpc.hash, nbJson)!;

  it("has the RPC's signer, receiver and method", () => {
    expect([nb.hash, nb.signerId, nb.receiverId]).toEqual([rpc.hash, rpc.signerId, rpc.receiverId]);
    expect(nb.actions.map(method)).toEqual([name]);
    expect(rpc.actions.map(method)).toEqual([name]);
  });

  it("has the RPC's receipts: ids, executors, statuses, execution blocks and logs, byte for byte", () => {
    const pick = (t: typeof rpc) => t.receipts.map((r) => ({ id: r.id, executorId: r.executorId, status: r.status, blockHash: r.blockHash, logs: r.logs })).sort((a, b) => a.id.localeCompare(b.id));
    expect(pick(nb)).toEqual(pick(rpc));
    expect(nb.receipts.flatMap((r) => r.logs).length).toBeGreaterThan(0);
  });
});

it("re-encodes parsed arguments: equal for the sign transaction, whose strings have no quotes", () => {
  const rpc = parseTxOutcome(rpcSign.result);
  const nb = nearBlocksTxOutcome(rpc.hash, nbSign)!;
  const args = (t: typeof rpc) => decodeArgs((t.actions[0] as { FunctionCall: { args: string } }).FunctionCall.args);
  expect(args(nb)).toEqual(args(rpc));
});

it("a hash NearBlocks does not know is null; anything else unexpected throws", () => {
  expect(nearBlocksTxOutcome("x", { data: null })).toBeNull();
  expect(() => nearBlocksTxOutcome("x", {})).toThrow(/unexpected \/receipts tree/);
  expect(() => nearBlocksTxOutcome("x", { data: { receipt_id: "r" } })).toThrow(/unexpected \/receipts tree/);
});
