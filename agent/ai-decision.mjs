// The agent's trade decision on NEAR AI Cloud, with the completion's TEE signature receipt.
//
// For each trade the agent asks a model served from NEAR AI Cloud's attested TEE whether to take
// the solver's quote. It keeps the completion's signature receipt:
//
//   request_hash   SHA-256 of the exact request body bytes the agent sent
//   response_hash  SHA-256 of the exact response body bytes it received (accept-encoding: identity)
//   receipt        GET /v1/signature/{completion_id}: the signing address and an ECDSA (EIP-191)
//                  signature over `model:request_hash:response_hash` (signature_kind provider_tee)
//
// Before trading, the agent checks the receipt itself: the signed text must be exactly
// `model:request_hash:response_hash` for the hashes it computed, and the signature must recover to
// the receipt's signing address. Anything else refuses the trade. Whether that signing address
// belongs to an attested TEE (model, gateway, NVIDIA GPU, Intel TDX) is what the Verification
// Center link checks: https://cloud.near.ai/verify?model=...#receipt=... (the receipt travels in
// the URL fragment, which the browser never sends to the server).
//
// What this proves, and what not: README.md, "AI decisions".
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
/** A model NEAR AI Cloud serves from its own attested TEE; the saved receipt verifies with it. */
export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const VERIFY_URL = "https://cloud.near.ai/verify";

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/** secp256k1 and keccak from the web workspace's pinned @noble packages (web/package-lock.json). */
async function noble() {
  const base = join(here, "..", "web", "node_modules", "@noble");
  try {
    const { secp256k1 } = await import(pathToFileURL(join(base, "curves", "secp256k1.js")).href);
    const { keccak_256 } = await import(pathToFileURL(join(base, "hashes", "sha3.js")).href);
    return { secp256k1, keccak_256 };
  } catch {
    throw new Error("checking an AI receipt needs @noble/curves and @noble/hashes: run `npm ci` in web/");
  }
}

/** The Ethereum address (0x + 40 hex, lower case) that signed `text` with EIP-191 personal_sign. */
export async function recoverSigner(text, signatureHex) {
  const { secp256k1, keccak_256 } = await noble();
  const sig = Buffer.from(String(signatureHex).replace(/^0x/, ""), "hex");
  if (sig.length !== 65) throw new Error(`signature is ${sig.length} bytes, not 65`);
  const msg = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (v !== 0 && v !== 1) throw new Error(`signature recovery id ${sig[64]} is not 0, 1, 27 or 28`);
  const s = new secp256k1.Signature(BigInt(`0x${sig.subarray(0, 32).toString("hex")}`), BigInt(`0x${sig.subarray(32, 64).toString("hex")}`), v);
  const pub = s.recoverPublicKey(digest).toBytes(false);
  return `0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex")}`;
}

/**
 * Checks a receipt against the hashes the agent computed itself. Returns { ok: true } or
 * { ok: false, reason }. Never throws for a bad receipt.
 */
export async function verifyReceipt(receipt, { requestHash, responseHash }) {
  const r = receipt ?? {};
  if (!HEX64.test(requestHash ?? "") || !HEX64.test(responseHash ?? "")) return { ok: false, reason: "the recorded hashes are not SHA-256 hex" };
  if (r.signature_kind !== "provider_tee") return { ok: false, reason: `signature_kind is ${JSON.stringify(r.signature_kind)}, not "provider_tee"` };
  if (r.signing_algo !== "ecdsa") return { ok: false, reason: `signing_algo is ${JSON.stringify(r.signing_algo)}, not "ecdsa"` };
  if (typeof r.model !== "string" || r.model === "") return { ok: false, reason: "no model" };
  const expected = `${r.model}:${requestHash}:${responseHash}`;
  if (r.signed_text !== expected) return { ok: false, reason: "the signed text is not model:request_hash:response_hash for these hashes" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.signing_address ?? "")) return { ok: false, reason: "the signing address is not an Ethereum address" };
  let signer;
  try {
    signer = await recoverSigner(r.signed_text, r.signature);
  } catch (e) {
    return { ok: false, reason: `the signature does not parse: ${e.message}` };
  }
  if (signer !== r.signing_address.toLowerCase()) return { ok: false, reason: `the signature recovers to ${signer}, not the signing address` };
  return { ok: true };
}

/** The Verification Center link: the receipt in the fragment, which is never sent to the server. */
export function verifyLink(receipt) {
  const body = {
    completionId: receipt.completion_id,
    model: receipt.model,
    signatureKind: receipt.signature_kind,
    signingAlgo: receipt.signing_algo,
    signingAddress: receipt.signing_address,
    signedText: receipt.signed_text,
    signature: receipt.signature,
  };
  return `${VERIFY_URL}?model=${encodeURIComponent(receipt.model)}#receipt=${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
}

export const SYSTEM_PROMPT =
  "You review one trade for an autonomous agent that holds an owner's tokens. You see the solver's quote and the owner's rules. " +
  'Answer with one JSON object and nothing else: {"decision": "trade" | "skip", "reason": "<one sentence>"}. ' +
  "Choose trade only if the quote meets the owner's floor; otherwise choose skip.";

/** The facts the model decides on, as one plain message. */
export function decisionPrompt(f) {
  return [
    `Sell exactly ${f.amountIn} ${f.symbolIn} (${f.tokenIn}) for ${f.symbolOut} (${f.tokenOut}).`,
    `Best solver quote: ${f.amountOut} ${f.symbolOut}, that is ${f.rate} ${f.symbolOut} per ${f.symbolIn}.`,
    `The owner's floor: at least ${f.floor} ${f.symbolOut} per ${f.symbolIn}.`,
    `The vault enforces the floor and the caps on its own; your answer decides whether the agent submits this trade.`,
  ].join("\n");
}

/** The model's answer: { decision, reason } from the first JSON object in its reply, or null. */
export function parseDecision(content) {
  const m = /\{[\s\S]*\}/.exec(String(content ?? ""));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j.decision !== "trade" && j.decision !== "skip") return null;
    return { decision: j.decision, reason: typeof j.reason === "string" ? j.reason.slice(0, 300) : "" };
  } catch {
    return null;
  }
}

/**
 * One decision: the completion, its hashes and its verified receipt. Throws if NEAR AI does not
 * answer, if there is no receipt, or if the receipt does not verify; the caller then does not trade.
 */
export async function decideTrade({ facts, apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, fetchImpl = fetch, signatureRetries = 5, retryDelayMs = 2000 }) {
  if (!apiKey) throw new Error("NEAR_AI_API_KEY is not set");
  const requestBytes = Buffer.from(
    JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: decisionPrompt(facts) },
      ],
      temperature: 0,
    }),
    "utf8",
  );
  const auth = { authorization: `Bearer ${apiKey}` };
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    // Hash exactly these bytes, and get the response body exactly as the TEE signed it.
    headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "x-no-aliasing": "true", ...auth },
    body: requestBytes,
  });
  const responseBytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`NEAR AI chat/completions: HTTP ${res.status}: ${responseBytes.toString("utf8").slice(0, 300)}`);
  const completion = JSON.parse(responseBytes.toString("utf8"));
  const requestHash = sha256hex(requestBytes);
  const responseHash = sha256hex(responseBytes);

  let sig = null;
  for (let attempt = 1; attempt <= signatureRetries && !sig; attempt++) {
    const q = new URLSearchParams({ model, signing_algo: "ecdsa" });
    const s = await fetchImpl(`${baseUrl}/signature/${encodeURIComponent(completion.id)}?${q}`, { headers: { accept: "application/json", ...auth } });
    const text = await s.text();
    // The signature can take a moment to be stored: 404 is retried, as NEAR AI's docs allow.
    if (s.status === 404 && attempt < signatureRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    if (!s.ok) throw new Error(`NEAR AI signature: HTTP ${s.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    if (body.error_code) throw new Error(`NEAR AI signature unavailable: ${body.error_code}`);
    sig = body;
  }
  if (!sig) throw new Error("NEAR AI returned no signature for the completion");

  const receipt = {
    completion_id: completion.id,
    model,
    signature_kind: sig.signature_kind,
    signing_algo: sig.signing_algo,
    signing_address: sig.signing_address,
    signed_text: sig.text,
    signature: sig.signature,
  };
  const check = await verifyReceipt(receipt, { requestHash, responseHash });
  if (!check.ok) throw new Error(`the AI receipt does not verify: ${check.reason}`);
  const answer = parseDecision(completion.choices?.[0]?.message?.content);
  if (!answer) throw new Error("the model's reply is not a trade/skip decision");
  return { ...answer, request_hash: requestHash, response_hash: responseHash, receipt, verify_url: verifyLink(receipt) };
}

/** What goes into agent_intent_swap's arguments: the hashes and the receipt, nothing else. */
export function aiDecisionArg(d) {
  return { request_hash: d.request_hash, response_hash: d.response_hash, receipt: d.receipt };
}
