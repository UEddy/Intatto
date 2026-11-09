import { describe, expect, it } from "vitest";
import { VaultViewSchema } from "../contract/abi.gen";
import { getVault } from "../contract/views";
import canaryVault from "../test/fixtures/rpc-get-vault-canary.json";
import lockTx from "../test/fixtures/rpc-tx-canary-lock.json";
import lockBlock from "../test/fixtures/rpc-block-lock.json";
import { fakeFetch, rpcError, rpcResult } from "../test/fakeFetch";
import { Chain, ChainAnswerError, UnexpectedResponseError, parseTxOutcome } from "./chain";
import { RpcClient } from "./rpc";

function chain(steps: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(steps);
  return { chain: new Chain(new RpcClient("https://rpc.example/", { attempts: 2, sleep: async () => {}, fetch: f.fetch })), f };
}

describe("Chain.view", () => {
  it("decodes get_vault from a real testnet response, with its source", async () => {
    const { chain: c, f } = chain([{ status: 200, body: rpcResult(canaryVault.result) }]);
    const v = await getVault(c, "vault-v1.intatto-dev.testnet", "canary.intatto-dev.testnet");
    expect(v.value?.balance).toBe("997400000000000000000000");
    expect(v.value?.agent_id).toBe("canary-agent.intatto-dev.testnet");
    expect(v.value?.withdrawals_locked_until).toBe("1796577187277683986");
    expect(v.source).toMatchObject({ method: "get_vault", args: { owner_id: "canary.intatto-dev.testnet" }, blockHeight: canaryVault.result.block_height });
    const params = (f.calls[0]!.body as { params: Record<string, string> }).params;
    expect(atob(params.args_base64!)).toBe('{"owner_id":"canary.intatto-dev.testnet"}');
    expect(params.finality).toBe("final");
  });

  it("reports a panicking view (old result.error form) as the node's answer", async () => {
    const { chain: c } = chain([{ status: 200, body: rpcResult({ block_height: 1, block_hash: "h", error: "wasm execution failed", logs: [] }) }]);
    const err = await c.view("x.testnet", "get_vault", {}, VaultViewSchema).catch((e) => e);
    expect(err).toBeInstanceOf(ChainAnswerError);
    expect(err.answer.name).toBe("CONTRACT_EXECUTION_ERROR");
  });

  it("refuses a result that does not match the ABI", async () => {
    const bytes = Array.from(new TextEncoder().encode('{"balance":"1"}'));
    const { chain: c } = chain([{ status: 200, body: rpcResult({ block_height: 1, block_hash: "h", result: bytes, logs: [] }) }]);
    await expect(c.view("x.testnet", "get_vault", {}, VaultViewSchema)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe("Chain.account / accessKey", () => {
  it("returns null for an account that does not exist", async () => {
    const { chain: c } = chain([{ status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_ACCOUNT") }]);
    await expect(c.account("nobody.testnet")).resolves.toBeNull();
  });
  it("returns null for an unknown key, and throws on other answers", async () => {
    const a = chain([{ status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_ACCESS_KEY") }]);
    await expect(a.chain.accessKey("a.testnet", "ed25519:x")).resolves.toBeNull();
    const b = chain([{ status: 200, body: rpcError("HANDLER_ERROR", "NO_CONTRACT_CODE") }]);
    await expect(b.chain.accessKey("a.testnet", "ed25519:x")).rejects.toBeInstanceOf(ChainAnswerError);
  });
  it("parses a function-call key", async () => {
    const { chain: c } = chain([
      {
        status: 200,
        body: rpcResult({
          block_height: 5,
          block_hash: "h",
          nonce: 276514440000000,
          permission: { FunctionCall: { allowance: "1000000000000000000000000", method_names: ["agent_spend", "agent_swap"], receiver_id: "vault-v1.intatto-dev.testnet" } },
        }),
      },
    ]);
    const k = await c.accessKey("canary-agent.intatto-dev.testnet", "ed25519:EHqQ");
    expect(k?.value.permission).toEqual({ FunctionCall: { allowance: "1000000000000000000000000", method_names: ["agent_spend", "agent_swap"], receiver_id: "vault-v1.intatto-dev.testnet" } });
  });
});

describe("Chain.tx / block", () => {
  it("parses the canary's setup transaction", () => {
    const tx = parseTxOutcome(lockTx.result);
    expect(tx.signerId).toBe("canary.intatto-dev.testnet");
    expect(tx.receipts[0]).toMatchObject({ executorId: "vault-v1.intatto-dev.testnet", status: "success", blockHash: "2FZB5PDHQr3BFmqq2F5rRR2mJM4bLRoLLjmM9gLA6QJ2" });
  });
  it("reads a block's exact nanosecond timestamp", async () => {
    const { chain: c } = chain([{ status: 200, body: rpcResult(lockBlock.result) }]);
    await expect(c.block("2FZB5PDHQr3BFmqq2F5rRR2mJM4bLRoLLjmM9gLA6QJ2")).resolves.toEqual({
      height: 276514426,
      hash: "2FZB5PDHQr3BFmqq2F5rRR2mJM4bLRoLLjmM9gLA6QJ2",
      timestampNs: 1793985194506864730n,
    });
  });
  it("returns null for a transaction the node never finds", async () => {
    const { chain: c } = chain([{ status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_TRANSACTION") }]);
    await expect(c.tx("abc", "a.testnet")).resolves.toBeNull();
  });
});
