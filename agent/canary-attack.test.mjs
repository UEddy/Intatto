import assert from "node:assert/strict";
import { test } from "node:test";
import { attacks, classify, protocolAttacks, PUBLISHED_KEY, PUBLISHED_PUBLIC_KEY, VAULT } from "./canary-attack.mjs";
import { keyPair } from "./near-tx.mjs";

const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "intatto", version: "1.0.0", event, data })}`;

test("the published private key derives the published public key", () => {
  assert.equal(keyPair(PUBLISHED_KEY).publicKey, PUBLISHED_PUBLIC_KEY);
});

test("every on-chain attack uses a method the key may call, with no deposit", () => {
  const list = attacks("997610000000000000000000", "attacker.intatto.near");
  assert.ok(list.length >= 10);
  for (const a of list) {
    assert.ok(["agent_spend", "agent_swap"].includes(a.method), a.name);
    assert.ok(a.gas <= 300n);
    assert.ok(a.expect);
  }
  // Swaps that should reach the policy check get the gas the contract asks for.
  assert.equal(list.find((a) => a.expect === "pool_not_allowlisted").gas, 300n);
});

test("every protocol attack is a method or receiver the key's permission forbids", () => {
  for (const a of protocolAttacks("attacker.intatto.near")) {
    assert.ok(a.receiver !== VAULT || !["agent_spend", "agent_swap"].includes(a.method), a.name);
  }
});

test("classify reads the vault's rejection, a plain failure, or a success", () => {
  const rejected = { receipts_outcome: [{ outcome: { executor_id: VAULT, logs: [ev("spend_rejected", { reason: "receiver_not_allowlisted" })], status: { Failure: {} } } }] };
  assert.deepEqual(classify(rejected), { kind: "rejected", reason: "receiver_not_allowlisted" });
  const failed = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Failed to deserialize input" } } } } }, receipts_outcome: [] };
  assert.equal(classify(failed).kind, "failed");
  assert.equal(classify({ status: { SuccessValue: "" }, receipts_outcome: [] }).kind, "succeeded");
});
