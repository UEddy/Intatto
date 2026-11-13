/**
 * The swap the board shows: the AI-decided mainnet swap of 2026-11-13 (scripts/mainnet-ai-swap.sh),
 * from its three real transactions as the archival node returned them. The board must verify all
 * three and show "Verify AI decision" with the receipt recorded in agent_intent_swap's arguments.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/networks";
import { checkSwap } from "../intents/check";
import { parseTxOutcome, type TxOutcome } from "../near/chain";
import signTx from "../test/fixtures/rpc-tx-mainnet-ai-swap.json";
import executeTx from "../test/fixtures/rpc-tx-mainnet-ai-exec.json";
import settleTx from "../test/fixtures/rpc-tx-mainnet-ai-settle.json";
import { AiDecisionLink } from "./IntentsPanel";

const cfg = MAINNET.intents!;
// What the agent logged for this trade (agent/runs, 2026-11-13T07:48:43Z): the hashes of its NEAR AI
// request and response, and the Verification Center link it built from the receipt.
const REQUEST_HASH = "470c39359b5966cfec5807c877b9e87420caef325d54411b88ea0f28cbe126e9";
const RESPONSE_HASH = "351926d9239d9333d6f9cf87a092e4ebd5b00fd6a89d6ecc7fe7efb498c7c41c";
const VERIFY_URL =
  "https://cloud.near.ai/verify?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017#receipt=eyJjb21wbGV0aW9uSWQiOiJjaGF0Y21wbC1jMDdlMGNkZi1lYmQ5LTRiOTAtYTFlOS00MTI4NGRjMTdkNGMiLCJtb2RlbCI6ImRlZXBzZWVrLWFpL0RlZXBTZWVrLVY0LjEtRmxhc2gtMTAxNyIsInNpZ25hdHVyZUtpbmQiOiJwcm92aWRlcl90ZWUiLCJzaWduaW5nQWxnbyI6ImVjZHNhIiwic2lnbmluZ0FkZHJlc3MiOiIweGZlMDA3MTg5NTUwMGE5NzU1YzE4MDQ0OTQ4YWI0ZjRlMWE3ZjMzN2UiLCJzaWduZWRUZXh0IjoiZGVlcHNlZWstYWkvRGVlcFNlZWstVjQuMS1GbGFzaC0xMDE3OjQ3MGMzOTM1OWI1OTY2Y2ZlYzU4MDdjODc3YjllODc0MjBjYWVmMzI1ZDU0NDExYjg4ZWEwZjI4Y2JlMTI2ZTk6MzUxOTI2ZDkyMzlkOTMzM2Q2ZjljZjg3YTA5MmU0ZWJkNWIwMGZkNmE4OWQ2ZWNjN2ZlN2VmYjQ5OGM3YzQxYyIsInNpZ25hdHVyZSI6IjB4OGE3ZjgyYmYyODVlMGEwN2JhZWIxZmRhZGU5ZjVmMWQyMWQ2MDQ3MDcyZmMzOTU5MjVhYmU1NzA3YzcxZTRlNDJhNmQ1NzUzM2UyYjYyNTMzYmZlNDlkYTAzZWY1ZmI5OGVhMDA0MGJjM2U3MzNhMmU2NjZkZjA4N2UyMmI2MjgxYyJ9";
// The intent hash the relay published and intents.near executed (get_status, 2026-11-13).
const INTENT_HASH = "DVgZUxCK98zbf1qMMce8m4caiGmK7sZf6xVqHVFhPpza";

const byHash: Record<string, TxOutcome> = {
  [cfg.swap.signTxHash]: parseTxOutcome(signTx.result),
  [cfg.swap.executeTxHash]: parseTxOutcome(executeTx.result),
  [cfg.swap.settleTxHash]: parseTxOutcome(settleTx.result),
};

describe("the AI-decided swap of 2026-11-13, as the board checks it", () => {
  it("is the swap the mainnet board is configured to show", () => {
    expect(cfg.swap).toMatchObject({ intentId: "1", amountIn: "300000000000000000000000", amountOut: "1052787" });
    for (const [hash, tx] of Object.entries(byHash)) expect(tx.hash).toBe(hash);
  });

  it("verifies all three transactions and finds the receipt the agent recorded", async () => {
    const r = await checkSwap(cfg, async (hash) => byHash[hash] ?? null);
    expect(r).toMatchObject({ sign: { ok: true }, intentHash: INTENT_HASH, execute: { ok: true }, settle: { ok: true } });
    expect(r.aiDecision).toEqual({
      kind: "receipt",
      url: VERIFY_URL,
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      requestHash: REQUEST_HASH,
      responseHash: RESPONSE_HASH,
      signingAddress: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
    });
  });

  it("shows the Verify AI decision link on that trade, to the agent's own link", async () => {
    const r = await checkSwap(cfg, async (hash) => byHash[hash] ?? null);
    render(<AiDecisionLink d={r.aiDecision} />);
    expect(screen.getByRole("link", { name: /Verify AI decision/ }).getAttribute("href")).toBe(VERIFY_URL);
  });
});
