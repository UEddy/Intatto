import { describe, expect, it } from "vitest";
import { Chain } from "../near/chain";
import { RpcClient } from "../near/rpc";
import { fakeFetch, rpcResult, type Step } from "../test/fakeFetch";
import { ftMetadata } from "./views";

const WNEAR = { spec: "ft-1.0.0", name: "Wrapped NEAR fungible token", symbol: "wNEAR", decimals: 24 };
const answer: Step = {
  status: 200,
  body: rpcResult({ block_height: 224334298, block_hash: "F4zbyxWCc3GfmY9Ut25EPW3AnbUEw8AJnhf8z2KYP2Gt", logs: [], result: Array.from(new TextEncoder().encode(JSON.stringify(WNEAR))) }),
};
const chainOf = (steps: Step[]) => {
  const f = fakeFetch(steps);
  return { chain: new Chain(new RpcClient("https://rpc.example/", { attempts: 1, sleep: async () => {}, fetch: f.fetch })), f };
};

describe("ftMetadata", () => {
  // The board read wrap.near's metadata twice per page load on 2026-11-13: once for the intents
  // panel's check and once for the attempt log's token amounts (the canary attack run's swaps).
  it("reads a token once per Chain, however many readers ask, at once or later", async () => {
    const { chain, f } = chainOf([answer]);
    const [a, b] = await Promise.all([ftMetadata(chain, "wrap.near"), ftMetadata(chain, "wrap.near")]);
    const c = await ftMetadata(chain, "wrap.near");
    expect(a.value).toEqual(WNEAR);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(f.calls).toHaveLength(1);
  });

  it("reads each token, and each Chain, on its own", async () => {
    const { chain, f } = chainOf([answer]);
    await ftMetadata(chain, "wrap.near");
    await ftMetadata(chain, "usdt.tether-token.near");
    expect(f.calls).toHaveLength(2);
    const other = chainOf([answer]);
    await ftMetadata(other.chain, "wrap.near");
    expect(other.f.calls).toHaveLength(1);
  });

  it("forgets a failed read, so the next reader asks again", async () => {
    const { chain, f } = chainOf([{ throws: new TypeError("Failed to fetch") }, answer]);
    await expect(ftMetadata(chain, "wrap.near")).rejects.toThrow();
    expect((await ftMetadata(chain, "wrap.near")).value).toEqual(WNEAR);
    expect(f.calls).toHaveLength(2);
  });
});
