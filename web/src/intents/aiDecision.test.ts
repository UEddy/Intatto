import { describe, expect, it } from "vitest";
import { parseTxOutcome, type TxOutcome } from "../near/chain";
import signTx from "../test/fixtures/rpc-tx-mainnet-intent-swap.json";
import { aiDecisionOf } from "./aiDecision";

// The real receipt saved on 2026-11-11 (~/.config/intatto/tee-recheck.txt), which the NEAR AI
// Verification Center verifies end to end, and the hashes it signs.
const REQ = "56b9ec0db2ea8772dad81a393d42a913872006984b30e6128b19c9bf3fb614a4";
const RESP = "ef0386e717e78f512761dce998b695e6bc5d7339f7917486dc33ac574b6de61b";
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const RECEIPT = {
  completion_id: "chatcmpl-fc1034b4-d509-4c7c-b76c-c937c46cb8f6",
  model: MODEL,
  signature_kind: "provider_tee",
  signing_algo: "ecdsa",
  signing_address: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
  signed_text: `${MODEL}:${REQ}:${RESP}`,
  signature: "0x1ff2fc8ec79fd3e781d67240c0d071739a7b4dc69b94ad88465bd768e10263363817786cdbd3b66a828221c96bf4b98ddea9523bd066dd412d90f1777c7481861b",
};
// The link saved with it (its informational verifiedAt field left out).
const SAVED = `https://cloud.near.ai/verify?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017#receipt=`;

const real = parseTxOutcome(signTx.result);

/** The real agent_intent_swap with `ai_decision` added to its arguments, as the agent now sends it. */
function withAiDecision(aiDecision: unknown): TxOutcome {
  return {
    ...real,
    actions: real.actions.map((a) => {
      const fc = (a as { FunctionCall: { args: string } }).FunctionCall;
      const args = JSON.parse(atob(fc.args)) as Record<string, unknown>;
      return { FunctionCall: { ...fc, args: btoa(JSON.stringify({ ...args, ai_decision: aiDecision })) } };
    }),
  };
}

describe("aiDecisionOf", () => {
  it("shows no link for a trade without a receipt (the mainnet swap of 2026-11-11)", () => {
    expect(aiDecisionOf(real)).toEqual({ kind: "none" });
  });

  it("links a receipt whose signed text matches the hashes recorded with the trade", () => {
    const d = aiDecisionOf(withAiDecision({ request_hash: REQ, response_hash: RESP, receipt: RECEIPT }));
    expect(d).toMatchObject({ kind: "receipt", model: MODEL, requestHash: REQ, responseHash: RESP, signingAddress: RECEIPT.signing_address });
    if (d.kind !== "receipt") return;
    expect(d.url.startsWith(SAVED)).toBe(true);
    const url = new URL(d.url);
    // The receipt is in the fragment only, never in what the browser sends.
    expect(url.search).toBe("?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017");
    const fragment = url.hash.slice("#receipt=".length).replace(/-/g, "+").replace(/_/g, "/");
    expect(JSON.parse(atob(fragment))).toEqual({
      completionId: RECEIPT.completion_id,
      model: MODEL,
      signatureKind: "provider_tee",
      signingAlgo: "ecdsa",
      signingAddress: RECEIPT.signing_address,
      signedText: RECEIPT.signed_text,
      signature: RECEIPT.signature,
    });
  });

  it("refuses a tampered receipt: no link", () => {
    const other = "0".repeat(64);
    const cases: [unknown, RegExp][] = [
      // Hashes recorded for another request or response than the receipt signs.
      [{ request_hash: other, response_hash: RESP, receipt: RECEIPT }, /does not sign the hashes/],
      [{ request_hash: REQ, response_hash: other, receipt: RECEIPT }, /does not sign the hashes/],
      // The signed text edited, or another model named.
      [{ request_hash: REQ, response_hash: RESP, receipt: { ...RECEIPT, signed_text: `${MODEL}:${other}:${RESP}` } }, /does not sign the hashes/],
      [{ request_hash: REQ, response_hash: RESP, receipt: { ...RECEIPT, model: "other/model" } }, /does not sign the hashes/],
      // Not a TEE ECDSA signature, or not the shape of one.
      [{ request_hash: REQ, response_hash: RESP, receipt: { ...RECEIPT, signature_kind: "gateway" } }, /not a TEE signature/],
      [{ request_hash: REQ, response_hash: RESP, receipt: { ...RECEIPT, signing_algo: "ed25519" } }, /not an ECDSA signature/],
      [{ request_hash: REQ, response_hash: RESP, receipt: { ...RECEIPT, signature: "0x12" } }, /malformed/],
      [{ request_hash: "nope", response_hash: RESP, receipt: RECEIPT }, /malformed/],
      ["not an object", /malformed/],
    ];
    for (const [aiDecision, reason] of cases) {
      const d = aiDecisionOf(withAiDecision(aiDecision));
      expect(d.kind, JSON.stringify(aiDecision)).toBe("refused");
      if (d.kind === "refused") expect(d.reason).toMatch(reason);
    }
  });

  it("reads only the trade's own call, and nothing from undecodable arguments", () => {
    const tx = withAiDecision({ request_hash: REQ, response_hash: RESP, receipt: RECEIPT });
    expect(aiDecisionOf(tx, "settle_intent_swap")).toEqual({ kind: "none" });
    expect(aiDecisionOf({ ...real, actions: [{ FunctionCall: { method_name: "agent_intent_swap", args: "!!!" } }] })).toEqual({ kind: "none" });
  });
});
