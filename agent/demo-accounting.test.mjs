// The demo's balance accounting, checked against the mainnet compromised run of 2026-11-12
// (4Gam7Ufp...: the vault fell 0.01033 NEAR for a 0.01 NEAR invoice; vault.intatto.near grew 33 bytes).
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountRun, spendRecordBytes } from "./demo-accounting.mjs";

const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n;
const swap = { spend_id: "0", timestamp: "1794419450856257655", token_id: "wrap.near", amount: "500000000000000000000000" };
const payment = { spend_id: "1", timestamp: "1794500000000000000", token_id: null, amount: "10000000000000000000000" };

test("a spend record's borsh size: 33 bytes for NEAR, plus the token id for a swap", () => {
  assert.equal(spendRecordBytes(payment), 33);
  assert.equal(spendRecordBytes(swap), 33 + 4 + "wrap.near".length);
});

test("mainnet, 2026-11-12: the 0.00033 NEAR beyond the invoice is the new record's storage", () => {
  const r = accountRun({
    beforeBalance: (4257n * NEAR) / 100000n,
    afterBalance: (3224n * NEAR) / 100000n,
    beforeSpends: [swap],
    afterSpends: [swap, payment],
    paid: NEAR / 100n,
    byteCost: BYTE,
  });
  assert.equal(r.lost, (1033n * NEAR) / 100000n);
  assert.equal(r.storage, 33n * BYTE);
  assert.equal(r.unexplained, 0n);
});

test("pruning an old record credits its storage back", () => {
  const r = accountRun({ beforeBalance: 100n * BYTE, afterBalance: 100n * BYTE - NEAR / 100n + 13n * BYTE, beforeSpends: [swap], afterSpends: [payment], paid: NEAR / 100n, byteCost: BYTE });
  assert.equal(r.storage, -13n * BYTE);
  assert.equal(r.unexplained, 0n);
});

test("anything else is unexplained", () => {
  const r = accountRun({ beforeBalance: NEAR, afterBalance: NEAR - NEAR / 100n - 1n, beforeSpends: [], afterSpends: [payment], paid: NEAR / 100n, byteCost: BYTE });
  assert.equal(r.unexplained, 1n - 33n * BYTE);
  assert.notEqual(r.unexplained, 0n);
});
