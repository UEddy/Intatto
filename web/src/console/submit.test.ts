import { describe, expect, it } from "vitest";
import { Chain } from "../near/chain";
import { RpcClient } from "../near/rpc";
import relayedOk from "../test/fixtures/rpc-tx-status-relayed-5DfbUUeE.json";
import relayedFailed from "../test/fixtures/rpc-tx-status-relayed-5WqPivF3.json";
import { fakeFetch, rpcResult } from "../test/fakeFetch";
import { PASSKEY_SPONSOR_ID } from "../wallet/passkey";
import { readOutcomes } from "./submit";

const WALLET = "0s640d667971eb2a50c512be2e893cbe7851c1fcf9";

/** A node that answers tx and EXPERIMENTAL_tx_status with `fixture`, and any block. */
function chainWith(fixture: { result: unknown }) {
  const f = fakeFetch([
    {
      status: 200,
      body: ({ body }) => {
        const call = body as { method: string; params: { sender_account_id?: string } };
        if (call.method === "block") return rpcResult({ header: { height: 1, hash: "B", timestamp_nanosec: "1000" } })({ body });
        if (call.method === "tx" || call.method === "EXPERIMENTAL_tx_status") return rpcResult(fixture.result)({ body });
        throw new Error(`unexpected ${call.method}`);
      },
    },
  ]);
  return { chain: new Chain(new RpcClient("https://rpc.example/", { attempts: 1, sleep: async () => {}, fetch: f.fetch })), f };
}

describe("reading relayed (passkey) outcomes", () => {
  it("looks the transaction up with the sponsor as sender and finds the user's call on the receiver", async () => {
    const { chain, f } = chainWith(relayedOk);
    const [r] = await readOutcomes(chain, chain, WALLET, [{ hash: relayedOk.result.transaction.hash, receiverId: "wrap.near", senderId: PASSKEY_SPONSOR_ID }]);
    expect(r!.ok).toBe(true);
    expect(r!.executed).not.toBeNull();
    const lookups = f.calls.map((c) => c.body as { method: string; params: { sender_account_id?: string } }).filter((b) => b.method !== "block");
    expect(lookups.map((b) => [b.method, b.params.sender_account_id])).toEqual([
      ["tx", PASSKEY_SPONSOR_ID],
      ["EXPERIMENTAL_tx_status", PASSKEY_SPONSOR_ID],
    ]);
  });

  it("refuses a successful relay that never called the receiver from the user's account", async () => {
    const { chain } = chainWith(relayedOk);
    await expect(readOutcomes(chain, chain, "someone-else.near", [{ hash: "h", receiverId: "wrap.near", senderId: PASSKEY_SPONSOR_ID }])).rejects.toThrow(/without a call from someone-else\.near to wrap\.near/);
  });

  it("reports a failed relay as a failure, even though wrap.near was reached through another account", async () => {
    const { chain } = chainWith(relayedFailed);
    const [r] = await readOutcomes(chain, chain, WALLET, [{ hash: "h", receiverId: "wrap.near", senderId: PASSKEY_SPONSOR_ID }]);
    expect(r!.ok).toBe(false);
    expect(r!.failure).not.toBeNull();
    // The receipt on wrap.near came from nearanja.near, not from the wallet: no execution is credited.
    expect(r!.executed).toBeNull();
  });

  it("refuses a transaction signed by someone other than the expected sender", async () => {
    const { chain } = chainWith(relayedOk);
    await expect(readOutcomes(chain, chain, WALLET, [{ hash: "h", receiverId: "wrap.near", senderId: "other-relayer.near" }])).rejects.toThrow(/signed by helper\.trezu\.near, not other-relayer\.near/);
  });
});
