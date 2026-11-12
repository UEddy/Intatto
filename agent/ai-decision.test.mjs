// The AI decision receipt, offline: the real receipt saved on 2026-11-11 (which the NEAR AI
// Verification Center verifies end to end), tampered copies of it, and a full decideTrade round
// trip against a fake NEAR AI that signs like the real one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "../web/node_modules/@noble/curves/secp256k1.js";
import { keccak_256 } from "../web/node_modules/@noble/hashes/sha3.js";
import { aiDecisionArg, decideTrade, parseDecision, recoverSigner, verifyLink, verifyReceipt } from "./ai-decision.mjs";

// ~/.config/intatto/tee-recheck.txt: a real completion of deepseek-ai/DeepSeek-V4.1-Flash-1017.
const REAL = {
  completion_id: "chatcmpl-fc1034b4-d509-4c7c-b76c-c937c46cb8f6",
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  signature_kind: "provider_tee",
  signing_algo: "ecdsa",
  signing_address: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
  signed_text:
    "deepseek-ai/DeepSeek-V4.1-Flash-1017:56b9ec0db2ea8772dad81a393d42a913872006984b30e6128b19c9bf3fb614a4:ef0386e717e78f512761dce998b695e6bc5d7339f7917486dc33ac574b6de61b",
  signature:
    "0x1ff2fc8ec79fd3e781d67240c0d071739a7b4dc69b94ad88465bd768e10263363817786cdbd3b66a828221c96bf4b98ddea9523bd066dd412d90f1777c7481861b",
};
const HASHES = {
  requestHash: "56b9ec0db2ea8772dad81a393d42a913872006984b30e6128b19c9bf3fb614a4",
  responseHash: "ef0386e717e78f512761dce998b695e6bc5d7339f7917486dc33ac574b6de61b",
};
// The link saved with it, minus its informational verifiedAt field.
const SAVED_LINK_PREFIX = "https://cloud.near.ai/verify?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017#receipt=";

test("the real receipt verifies: its signed text is model:request_hash:response_hash and it recovers to the signing address", async () => {
  assert.equal(await recoverSigner(REAL.signed_text, REAL.signature), REAL.signing_address);
  assert.deepEqual(await verifyReceipt(REAL, HASHES), { ok: true });
});

test("a tampered receipt is refused", async () => {
  const flip = (hex, i) => hex.slice(0, i) + (hex[i] === "0" ? "1" : "0") + hex.slice(i + 1);
  const cases = [
    // Hashes recorded for another request or response.
    [REAL, { ...HASHES, requestHash: flip(HASHES.requestHash, 5) }, /signed text is not/],
    [REAL, { ...HASHES, responseHash: flip(HASHES.responseHash, 63) }, /signed text is not/],
    // The signed text edited to match other hashes: the signature no longer recovers to the signer.
    [{ ...REAL, signed_text: `${REAL.model}:${flip(HASHES.requestHash, 5)}:${HASHES.responseHash}` }, { ...HASHES, requestHash: flip(HASHES.requestHash, 5) }, /recovers to 0x/],
    // Another model named.
    [{ ...REAL, model: "other/model" }, HASHES, /signed text is not/],
    // The signature or the signer changed.
    [{ ...REAL, signature: flip(REAL.signature, 10) }, HASHES, /recovers to 0x|does not parse/],
    [{ ...REAL, signing_address: "0x0000000000000000000000000000000000000001" }, HASHES, /recovers to 0x/],
    [{ ...REAL, signature: "0x1234" }, HASHES, /does not parse/],
    // Not a TEE signature, or not ECDSA.
    [{ ...REAL, signature_kind: "gateway" }, HASHES, /signature_kind/],
    [{ ...REAL, signing_algo: "ed25519" }, HASHES, /signing_algo/],
    [REAL, { requestHash: "nope", responseHash: HASHES.responseHash }, /not SHA-256 hex/],
    [undefined, HASHES, /signature_kind/],
  ];
  for (const [receipt, hashes, reason] of cases) {
    const r = await verifyReceipt(receipt, hashes);
    assert.equal(r.ok, false, JSON.stringify({ receipt, hashes }));
    assert.match(r.reason, reason);
  }
});

test("the verify link carries the receipt in the fragment, in the Verification Center's format", () => {
  const link = verifyLink(REAL);
  assert.ok(link.startsWith(SAVED_LINK_PREFIX), link);
  const url = new URL(link);
  assert.equal(url.search, "?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017");
  const receipt = JSON.parse(Buffer.from(url.hash.slice("#receipt=".length), "base64url").toString("utf8"));
  assert.deepEqual(receipt, {
    completionId: REAL.completion_id,
    model: REAL.model,
    signatureKind: "provider_tee",
    signingAlgo: "ecdsa",
    signingAddress: REAL.signing_address,
    signedText: REAL.signed_text,
    signature: REAL.signature,
  });
});

test("the decision is read from the model's JSON, or refused", () => {
  assert.deepEqual(parseDecision('{"decision":"trade","reason":"meets the floor"}'), { decision: "trade", reason: "meets the floor" });
  assert.deepEqual(parseDecision('Sure.\n```json\n{"decision": "skip", "reason": "below"}\n```'), { decision: "skip", reason: "below" });
  assert.equal(parseDecision('{"decision":"buy"}'), null);
  assert.equal(parseDecision("trade"), null);
});

/** A fake NEAR AI Cloud: answers the completion and signs model:sha256(req):sha256(resp) as a TEE would. */
function fakeNearAi({ reply, tamper = (s) => s, signer = secp256k1.utils.randomSecretKey() }) {
  const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(signer, false).subarray(1))).subarray(12).toString("hex")}`;
  let reqHash = null;
  let respHash = null;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
      reqHash = createHash("sha256").update(init.body).digest("hex");
      const bytes = Buffer.from(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ message: { role: "assistant", content: reply } }] }));
      respHash = createHash("sha256").update(bytes).digest("hex");
      return new Response(bytes, { status: 200 });
    }
    const model = new URL(url).searchParams.get("model");
    const text = `${model}:${reqHash}:${respHash}`;
    const msg = Buffer.from(text, "utf8");
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
    const rec = secp256k1.sign(digest, signer, { prehash: false, format: "recovered" });
    const sig = `0x${Buffer.from(rec.subarray(1)).toString("hex")}${(27 + rec[0]).toString(16)}`;
    return new Response(JSON.stringify(tamper({ text, signature: sig, signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" })), { status: 200 });
  };
  return { fetchImpl, calls, address };
}

const FACTS = { amountIn: "0.3", symbolIn: "wNEAR", tokenIn: "wrap.near", amountOut: "1.13", symbolOut: "USDt", tokenOut: "usdt.tether-token.near", rate: "3.766", floor: "3.3" };

test("decideTrade keeps a verified receipt whose hashes are the exact bytes sent and received", async () => {
  const ai = fakeNearAi({ reply: '{"decision":"trade","reason":"3.766 is above the 3.3 floor"}' });
  const d = await decideTrade({ facts: FACTS, apiKey: "test-key-123", baseUrl: "https://ai.example/v1", fetchImpl: ai.fetchImpl });
  assert.equal(d.decision, "trade");
  assert.equal(d.receipt.signing_address, ai.address);
  assert.equal(d.receipt.signed_text, `${d.receipt.model}:${d.request_hash}:${d.response_hash}`);
  assert.deepEqual(await verifyReceipt(d.receipt, { requestHash: d.request_hash, responseHash: d.response_hash }), { ok: true });
  // The body is hashed as sent: identity encoding asked for, and nothing aliased.
  assert.equal(ai.calls[0].headers["accept-encoding"], "identity");
  assert.equal(ai.calls[0].headers["x-no-aliasing"], "true");
  // What goes on chain: the hashes and the receipt only, no prompt and no reply.
  assert.deepEqual(Object.keys(aiDecisionArg(d)).sort(), ["receipt", "request_hash", "response_hash"]);
  assert.ok(!JSON.stringify(aiDecisionArg(d)).includes("floor"));
});

test("decideTrade refuses a receipt that does not match what was sent and received", async () => {
  const wrongText = fakeNearAi({ reply: '{"decision":"trade","reason":"ok"}', tamper: (s) => ({ ...s, text: s.text.replace(/:[0-9a-f]{64}$/, `:${"0".repeat(64)}`) }) });
  await assert.rejects(decideTrade({ facts: FACTS, apiKey: "test-key-123", baseUrl: "https://ai.example/v1", fetchImpl: wrongText.fetchImpl }), /does not verify: the signed text/);
  const otherSigner = fakeNearAi({ reply: '{"decision":"trade","reason":"ok"}', tamper: (s) => ({ ...s, signing_address: "0x00000000000000000000000000000000000000aa" }) });
  await assert.rejects(decideTrade({ facts: FACTS, apiKey: "test-key-123", baseUrl: "https://ai.example/v1", fetchImpl: otherSigner.fetchImpl }), /does not verify: the signature recovers/);
  const notTee = fakeNearAi({ reply: '{"decision":"trade","reason":"ok"}', tamper: (s) => ({ ...s, signature_kind: undefined, text: s.text.split(":").slice(1).join(":") }) });
  await assert.rejects(decideTrade({ facts: FACTS, apiKey: "test-key-123", baseUrl: "https://ai.example/v1", fetchImpl: notTee.fetchImpl }), /signature_kind/);
});

test("decideTrade refuses a reply that is not a decision, and needs a key", async () => {
  const ai = fakeNearAi({ reply: "I would rather not say." });
  await assert.rejects(decideTrade({ facts: FACTS, apiKey: "test-key-123", baseUrl: "https://ai.example/v1", fetchImpl: ai.fetchImpl }), /not a trade\/skip decision/);
  await assert.rejects(decideTrade({ facts: FACTS, apiKey: "", fetchImpl: ai.fetchImpl }), /NEAR_AI_API_KEY is not set/);
});
