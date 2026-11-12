// The Chain Signatures agent pieces, offline: the key loader, the Message Bus client (against a
// fake relay) and reading the vault's events out of a transaction outcome.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { Chain, intentSwapResult, keyAllows, rate, units, vaultEvents } from "./intent-swap.mjs";
import { jwtClaims, loadIntentsJwt } from "./intents-env.mjs";
import { MessageBus, meetsFloor, selectQuotes } from "./message-bus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// A JWT-shaped test value (header.payload.signature); its payload says key_type distribution_channel.
const payload = Buffer.from(JSON.stringify({ v: 1, key_type: "distribution_channel", exp: 1826000000 })).toString("base64url");
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLW5vdC1yZWFs`;

function keyFile(contents, mode = 0o600) {
  mkdirSync(join(here, "runs"), { recursive: true });
  const dir = mkdtempSync(join(here, "runs", "test-"));
  const file = join(dir, "intents.env");
  writeFileSync(file, contents);
  chmodSync(file, mode);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the key loads only from a mode-600 file of ours holding exactly NEAR_INTENTS_JWT", () => {
  const uid = userInfo().uid;
  const ok = keyFile(`NEAR_INTENTS_JWT=${FAKE_JWT}\n`);
  try {
    assert.equal(loadIntentsJwt(ok.file, uid), FAKE_JWT);
    assert.deepEqual(jwtClaims(FAKE_JWT), { key_type: "distribution_channel", expires: "2027-11-12T06:13:20.000Z" });
  } finally {
    ok.cleanup();
  }
  const cases = [
    [`NEAR_INTENTS_JWT=${FAKE_JWT}\n`, 0o644, /mode 644, not 600/],
    [`NEAR_INTENTS_JWT=${FAKE_JWT}\nOTHER=1\n`, 0o600, /unexpected variables OTHER/],
    ["NEAR_INTENTS_JWT=not-a-jwt\n", 0o600, /looks like a JWT/],
  ];
  for (const [contents, mode, expected] of cases) {
    const bad = keyFile(contents, mode);
    try {
      assert.throws(() => loadIntentsJwt(bad.file, uid), (err) => expected.test(err.message) && !err.message.includes(FAKE_JWT));
    } finally {
      bad.cleanup();
    }
  }
  const mine = keyFile(`NEAR_INTENTS_JWT=${FAKE_JWT}\n`);
  try {
    assert.throws(() => loadIntentsJwt(mine.file, uid + 1), /not owned by this user/);
  } finally {
    mine.cleanup();
  }
  assert.throws(() => loadIntentsJwt(join(here, "runs", "no-such-dir", "intents.env"), uid), /is missing/);
});

/** A relay that records each request and answers from `answers[method]`. */
function fakeRelay(answers) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[body.method] }), { status: 200 });
  };
  return { requests, fetchImpl };
}

const QUOTE = (amountOut, hash, over = {}) => ({
  defuse_asset_identifier_in: "nep141:usdt.tether-token.near",
  defuse_asset_identifier_out: "nep141:wrap.near",
  amount_in: "1000000",
  amount_out: amountOut,
  expiration_time: "2026-11-11T15:33:08.002Z",
  quote_hash: hash,
  ...over,
});

test("quote sends the documented request with the key in X-API-Key, and keeps only matching quotes, best first", async () => {
  const relay = fakeRelay({
    quote: [
      QUOTE("269100785581405317543500", "low"),
      QUOTE("269200000000000000000000", "best"),
      QUOTE("999999999999999999999999", "other-amount", { amount_in: "2000000" }),
      QUOTE("999999999999999999999999", "other-asset", { defuse_asset_identifier_out: "nep141:evil.near" }),
      QUOTE("-5", "negative"),
    ],
  });
  const bus = new MessageBus({ jwt: FAKE_JWT, fetchImpl: relay.fetchImpl });
  const quotes = await bus.quote({ tokenIn: "usdt.tether-token.near", tokenOut: "wrap.near", amountIn: "1000000" });
  assert.deepEqual(quotes.map((q) => q.quote_hash), ["best", "low"]);
  const [request] = relay.requests;
  assert.equal(request.url, "https://solver-relay-v2.chaindefuser.com/rpc");
  assert.equal(request.headers["X-API-Key"], FAKE_JWT);
  assert.deepEqual(request.body, {
    id: 1,
    jsonrpc: "2.0",
    method: "quote",
    params: [{
      defuse_asset_identifier_in: "nep141:usdt.tether-token.near",
      defuse_asset_identifier_out: "nep141:wrap.near",
      exact_amount_in: "1000000",
      min_deadline_ms: 120000,
    }],
  });
  assert.ok(!JSON.stringify(request.body).includes(FAKE_JWT), "the key is never in the body");
  assert.deepEqual(selectQuotes(null, { assetIn: "a", assetOut: "b", amountIn: "1" }), []);
});

test("publish_intent sends the quote hash and the vault's nep413 payload as documented", async () => {
  const relay = fakeRelay({ publish_intent: { status: "OK", intent_hash: "H" }, get_status: { status: "SETTLED" } });
  const bus = new MessageBus({ jwt: FAKE_JWT, fetchImpl: relay.fetchImpl });
  const signedData = {
    standard: "nep413",
    payload: { message: "{}", nonce: "AAAA", recipient: "intents.near" },
    public_key: "ed25519:x",
    signature: "ed25519:y",
  };
  assert.deepEqual(await bus.publishIntent({ quoteHash: "Q", signedData }), { status: "OK", intent_hash: "H" });
  assert.deepEqual(relay.requests[0].body.params, [{ quote_hashes: ["Q"], signed_data: signedData }]);
  assert.deepEqual(await bus.getStatus("H"), { status: "SETTLED" });
  assert.deepEqual(relay.requests[1].body.params, [{ intent_hash: "H" }]);
  await assert.rejects(bus.publishIntent({ quoteHash: "Q", signedData: { ...signedData, standard: "erc191" } }), /only the vault's nep413/);
});

test("the floor check matches the vault's: amount_out / amount_in >= min_out / per_in, exactly", () => {
  // 1 USDT (6 decimals) for 0.2691 wNEAR (24 decimals), floor 0.25 wNEAR per USDT.
  assert.ok(meetsFloor("1000000", "269100785581405317543500", "250000000000000000000000", "1000000"));
  assert.ok(meetsFloor("1000000", "250000000000000000000000", "250000000000000000000000", "1000000"));
  assert.ok(!meetsFloor("1000000", "249999999999999999999999", "250000000000000000000000", "1000000"));
});

const event = (name, data) => `EVENT_JSON:${JSON.stringify({ standard: "intatto", version: "1.0.0", event: name, data })}`;

test("only events the vault itself logged count", () => {
  const signed = { intent_id: "7", deadline: "1797033900000000000", signed_data: { standard: "nep413" } };
  const outcome = {
    receipts_outcome: [
      { outcome: { executor_id: "evil.near", logs: [event("intent_swap_signed", { ...signed, intent_id: "666" })] } },
      { outcome: { executor_id: "vault.near", logs: ["mock sign", event("intent_swap_initiated", {}), event("intent_swap_signed", signed)] } },
    ],
  };
  assert.equal(vaultEvents(outcome, "vault.near").length, 2);
  assert.deepEqual(intentSwapResult(outcome, "vault.near"), {
    kind: "signed",
    intentId: "7",
    deadline: "1797033900000000000",
    signedData: { standard: "nep413" },
  });
  const refunded = { receipts_outcome: [{ outcome: { executor_id: "vault.near", logs: [event("intent_swap_refunded", { intent_id: "8", reason: "sign_failed" })] } }] };
  assert.deepEqual(intentSwapResult(refunded, "vault.near"), { kind: "refunded", intentId: "8", reason: "sign_failed" });
  assert.deepEqual(intentSwapResult({ receipts_outcome: [] }, "vault.near"), { kind: "unknown" });
});

test("the agent key must be a function-call key for this vault allowing both methods", () => {
  const fc = (receiver_id, method_names) => ({ FunctionCall: { allowance: "1", receiver_id, method_names } });
  const both = ["agent_intent_swap", "settle_intent_swap"];
  assert.ok(keyAllows(fc("vault.near", ["agent_spend", ...both]), "vault.near", both));
  assert.ok(!keyAllows(fc("vault.near", ["agent_intent_swap"]), "vault.near", both));
  assert.ok(!keyAllows(fc("other.near", both), "vault.near", both));
  // An empty method list means "any method", which this agent should not hold.
  assert.ok(!keyAllows(fc("vault.near", []), "vault.near", both));
  assert.ok(!keyAllows("FullAccess", "vault.near", both));
});

test("a transaction outlasting the RPC wait is followed with `tx` until it finishes", async () => {
  // A throwaway key (seed 1..32), only for signing in this test.
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
  const { base58Encode } = await import("./near-tx.mjs");
  const secret = `ed25519:${base58Encode(Buffer.concat([seed, Buffer.from(pub, "base64url")]))}`;
  const { keyPair } = await import("./near-tx.mjs");
  const keys = keyPair(secret);

  const calls = [];
  let txPolls = 0;
  const outcome = { status: { SuccessValue: "dHJ1ZQ==" }, transaction: { hash: "H" }, receipts_outcome: [] };
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    const reply = (body) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", ...body }), { status: 200 });
    if (method === "query") return reply({ result: { nonce: 41, permission: "FullAccess" } });
    if (method === "block") return reply({ result: { header: { hash: "11111111111111111111111111111111" } } });
    if (method === "send_tx") return reply({ error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } });
    if (method === "tx") {
      txPolls += 1;
      assert.equal(params.sender_account_id, "agent.near");
      return txPolls < 3 ? reply({ error: { cause: { name: "TIMEOUT_ERROR" } } }) : reply({ result: outcome });
    }
    throw new Error(`unexpected ${method}`);
  };
  const chain = new Chain("http://rpc.invalid", fetchImpl, 0);
  const result = await chain.call({ signerId: "agent.near", keys, receiverId: "vault.near", method: "agent_intent_swap", args: {}, gas: 1n });
  assert.deepEqual(result, outcome);
  assert.deepEqual(calls, ["query", "block", "send_tx", "tx", "tx", "tx"]);
});

test("the agent key comes from INTENT_AGENT_KEY or a near CLI key file, never printed in errors", async () => {
  const { agentSecret } = await import("./intent-swap.mjs");
  const secret = "ed25519:" + "1".repeat(80);
  assert.equal(agentSecret({ INTENT_AGENT_KEY: secret }), secret);
  const good = keyFile(JSON.stringify({ account_id: "a.near", public_key: "ed25519:x", private_key: secret }));
  const bad = keyFile(JSON.stringify({ private_key: "secp256k1:nope" }));
  try {
    assert.equal(agentSecret({ INTENT_AGENT_KEY_FILE: good.file }), secret);
    assert.throws(() => agentSecret({ INTENT_AGENT_KEY_FILE: bad.file }), (err) => /no ed25519 private_key/.test(err.message) && !err.message.includes("nope"));
    assert.equal(agentSecret({}), undefined);
  } finally {
    good.cleanup();
    bad.cleanup();
  }
});

test("the decision's facts are stated exactly: amounts unscaled, rates rounded down", () => {
  assert.equal(units("300000000000000000000000", 24), "0.3");
  assert.equal(units("1130742", 6), "1.130742");
  assert.equal(units("0", 6), "0");
  // The mainnet swap of 2026-11-11 and the owner's floor.
  assert.equal(rate("300000000000000000000000", "1130742", 24, 6), "3.769");
  assert.equal(rate("1000000000000000000000000", "3300000", 24, 6), "3.3");
});
