/**
 * The NEAR AI decision behind a trade, read from the trade's own transaction.
 *
 * The agent (agent/ai-decision.mjs) puts `ai_decision` into agent_intent_swap's arguments: the
 * SHA-256 of the exact request and response bytes of its NEAR AI Cloud completion, and the
 * completion's signature receipt. The vault ignores the field; it is there to be on chain with the
 * trade. This reads it back and builds the NEAR AI Verification Center link, which checks the
 * signature and the TEE attestation of the signing address (model, gateway, NVIDIA GPU, Intel TDX).
 *
 * The board checks only what it can without the network: that the receipt's signed text is
 * exactly `model:request_hash:response_hash` for the hashes recorded in the transaction. A receipt
 * that does not match is refused (no link); a trade without one shows nothing.
 */
import { z } from "zod";
import type { TxOutcome } from "../near/chain";

export const VERIFY_URL = "https://cloud.near.ai/verify";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const AiDecisionSchema = z.object({
  request_hash: hex64,
  response_hash: hex64,
  receipt: z.object({
    completion_id: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    signature_kind: z.string(),
    signing_algo: z.string(),
    signing_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    signed_text: z.string().max(600),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }),
});

export type AiDecision =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "receipt"; readonly url: string; readonly model: string; readonly requestHash: string; readonly responseHash: string; readonly signingAddress: string };

/** The function-call arguments of `method` in a transaction, decoded as JSON, or null. */
function argsOf(tx: TxOutcome, method: string): Record<string, unknown> | null {
  for (const a of tx.actions) {
    const fc = (a as { FunctionCall?: { method_name?: unknown; args?: unknown } } | null)?.FunctionCall;
    if (fc?.method_name !== method || typeof fc.args !== "string") continue;
    try {
      const bytes = Uint8Array.from(atob(fc.args), (c) => c.charCodeAt(0));
      const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** base64url of UTF-8 text, as the Verification Center reads its `#receipt=` fragment. */
function base64url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function aiDecisionOf(tx: TxOutcome, method = "agent_intent_swap"): AiDecision {
  const args = argsOf(tx, method);
  if (!args || !("ai_decision" in args)) return { kind: "none" };
  const parsed = AiDecisionSchema.safeParse(args.ai_decision);
  if (!parsed.success) return { kind: "refused", reason: "the receipt is malformed" };
  const { request_hash: req, response_hash: resp, receipt: r } = parsed.data;
  if (r.signature_kind !== "provider_tee") return { kind: "refused", reason: "the receipt is not a TEE signature" };
  if (r.signing_algo !== "ecdsa") return { kind: "refused", reason: "the receipt is not an ECDSA signature" };
  if (r.signed_text !== `${r.model}:${req}:${resp}`) return { kind: "refused", reason: "the receipt does not sign the hashes recorded with this trade" };
  const receipt = {
    completionId: r.completion_id,
    model: r.model,
    signatureKind: r.signature_kind,
    signingAlgo: r.signing_algo,
    signingAddress: r.signing_address,
    signedText: r.signed_text,
    signature: r.signature,
  };
  // The receipt goes in the fragment: the browser never sends it to cloud.near.ai.
  const url = `${VERIFY_URL}?model=${encodeURIComponent(r.model)}#receipt=${base64url(JSON.stringify(receipt))}`;
  return { kind: "receipt", url, model: r.model, requestHash: req, responseHash: resp, signingAddress: r.signing_address };
}
