import { describe, expect, it } from "vitest";
import { fakeFetch, rpcError, rpcResult } from "../test/fakeFetch";
import { RpcClient, RpcError } from "./rpc";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

function client(steps: Parameters<typeof fakeFetch>[0], attempts = 3) {
  const f = fakeFetch(steps);
  const delays: number[] = [];
  const c = new RpcClient("https://rpc.example/", { ...noSleep, attempts, fetch: f.fetch, onRetry: (i) => delays.push(i.delayMs) });
  return { c, f, delays };
}

describe("RpcClient", () => {
  it("returns a result that answers this request", async () => {
    const { c, f } = client([{ status: 200, body: rpcResult({ ok: 1 }) }]);
    await expect(c.call("block", { finality: "final" })).resolves.toEqual({ ok: true, result: { ok: 1 } });
    expect(f.calls[0]!.body).toMatchObject({ jsonrpc: "2.0", method: "block", params: { finality: "final" } });
    expect(f.calls[0]!.method).toBe("POST");
  });

  it("retries a response whose id does not match", async () => {
    const { c, f } = client([
      { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "someone-else", result: 1 }) },
      { status: 200, body: rpcResult(2) },
    ]);
    await expect(c.call("block", {})).resolves.toEqual({ ok: true, result: 2 });
    expect(f.calls).toHaveLength(2);
  });

  it("never parses two bodies run together (the curl --retry bug)", async () => {
    const { c } = client([
      { status: 200, body: ({ body }) => `Rate limit exceeded{"jsonrpc":"2.0","id":"${(body as { id: string }).id}","result":1}` },
      { status: 200, body: ({ body }) => `{"jsonrpc":"2.0","id":"${(body as { id: string }).id}","result":1}{"jsonrpc":"2.0"}` },
    ], 2);
    const err = await c.call("block", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.fatal).toBe(false);
    expect(err.reason).toMatch(/not one JSON value/);
  });

  it("backs off longer on rate limits, including CORS-less network errors", async () => {
    const { c, delays } = client([{ status: 429, body: "Too Many Requests" }, { throws: new TypeError("Failed to fetch") }, { status: 200, body: rpcResult(1) }]);
    await expect(c.call("block", {})).resolves.toEqual({ ok: true, result: 1 });
    // first delay 1000 ms, but a rate limit waits at least 4x that
    expect(delays).toEqual([4000, 4000]);
  });

  it("retries transient node errors and returns definitive ones as answers", async () => {
    const { c } = client([{ status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_BLOCK") }, { status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_ACCOUNT", "acc does not exist") }]);
    const r = await c.call("query", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: "HANDLER_ERROR", name: "UNKNOWN_ACCOUNT", message: "acc does not exist" });
  });

  it("accepts UNKNOWN_TRANSACTION only after every attempt says so", async () => {
    const { c, f } = client([{ status: 200, body: rpcError("HANDLER_ERROR", "UNKNOWN_TRANSACTION") }], 3);
    const r = await c.call("tx", {});
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(3);
  });

  it("stops at once on a request the node rejects as invalid", async () => {
    const { c, f } = client([{ status: 200, body: rpcError("REQUEST_VALIDATION_ERROR", "PARSE_ERROR") }]);
    const err = await c.call("query", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.fatal).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("does not guess on an error it does not know", async () => {
    const { c } = client([{ status: 200, body: rpcError("HANDLER_ERROR", "SOMETHING_NEW") }]);
    await expect(c.call("query", {})).rejects.toMatchObject({ fatal: true, reason: "unrecognised error HANDLER_ERROR/SOMETHING_NEW" });
  });

  it("treats a rate-limit message inside a JSON-RPC error as a rate limit", async () => {
    const { c } = client([{ status: 200, body: rpcError("HANDLER_ERROR", "X", "rate limit exceeded") }, { status: 200, body: rpcResult(1) }]);
    await expect(c.call("query", {})).resolves.toEqual({ ok: true, result: 1 });
  });

  it("rejects bodies with both or neither of result and error", async () => {
    const { c } = client([{ status: 200, body: ({ body }) => JSON.stringify({ jsonrpc: "2.0", id: (body as { id: string }).id }) }], 1);
    await expect(c.call("block", {})).rejects.toMatchObject({ reason: "response has neither or both of result and error", attempts: 1 });
  });

  it("retries 5xx and fails fatally on other 4xx", async () => {
    const a = client([{ status: 503, body: "" }, { status: 200, body: rpcResult(1) }]);
    await expect(a.c.call("block", {})).resolves.toEqual({ ok: true, result: 1 });
    const b = client([{ status: 403, body: "forbidden" }]);
    await expect(b.c.call("block", {})).rejects.toMatchObject({ fatal: true, reason: "HTTP 403" });
  });
});
