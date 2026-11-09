// Known-answer test: re-encode a real testnet transaction and get its hash and signature back.
// 25eHak8i… is `freeze` on vault-v1, signed by intatto-dev.testnet (block 276,504,059). RPC
// transaction views omit the block hash a transaction references; CVhKmMTM… (block 276,504,055)
// is the one that reproduces the hash, found by trying the blocks before inclusion.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Decode, base58Encode, keyPair, serializeTransaction, signTransaction, transactionHash, verifyTransaction } from "./near-tx.mjs";

const FREEZE = {
  signerId: "intatto-dev.testnet",
  publicKey: "ed25519:8z6qNmz4fVFHDoDVZiHsVjKt643uP5bpGFQRsdLPAStD",
  nonce: 275870665000021n,
  receiverId: "vault-v1.intatto-dev.testnet",
  blockHash: "CVhKmMTMsh7PwzfXAxxtjoSStNi28s3WrrMgsg1uikXU",
  actions: [{ method: "freeze", argsBytes: Buffer.from("e30=", "base64"), gas: 30_000_000_000_000n, deposit: 0n }],
};
const FREEZE_HASH = "25eHak8ioMzwG1GUw9qbNkFnABAJDMSe7Y2MzAV46KN5";
const FREEZE_SIGNATURE = "ed25519:2g7gvmCVcxheiWEE6kshzNjSwFnruGKqWVhScrSBuVHXNm2eCsFPsuZ2sEKgtsbHVHPrSjDKSFGDE872M2jsaTRc";

test("a real testnet transaction re-encodes to its hash, and its signature verifies", () => {
  const bytes = serializeTransaction(FREEZE);
  assert.equal(transactionHash(bytes), FREEZE_HASH);
  assert.ok(verifyTransaction(bytes, FREEZE.publicKey, FREEZE_SIGNATURE));
  assert.ok(!verifyTransaction(serializeTransaction({ ...FREEZE, nonce: FREEZE.nonce + 1n }), FREEZE.publicKey, FREEZE_SIGNATURE));
});

test("JSON args encode as the bytes NEAR receives", () => {
  const viaJson = serializeTransaction({ ...FREEZE, actions: [{ ...FREEZE.actions[0], argsBytes: undefined, args: {} }] });
  assert.equal(transactionHash(viaJson), FREEZE_HASH);
});

test("base58 round-trips, including leading zeros", () => {
  for (const bytes of [Uint8Array.of(), Uint8Array.of(0, 0, 1), Uint8Array.of(255, 0, 7)]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
});

test("the published canary key signs transactions that verify under its public key", () => {
  // The canary agent's key is published on purpose (CANARY.md); it is only a test vector here.
  const { privateKey, publicKey } = keyPair("ed25519:2VzDYHpnhqxQoNvSxQSVotRJAFphNG3ofF8cm57uTftG4RmfN9K4dDwAaaNCzh4CdQkPp4v48d9gExhTmnbQEr3S");
  assert.equal(publicKey, "ed25519:EHqQpQk85svJoeAWkJugoCGUXGMaVg77hak6pkiteZqr");
  const bytes = serializeTransaction({ ...FREEZE, signerId: "canary-agent.intatto-dev.testnet", publicKey });
  const { hash, signature, signed } = signTransaction(bytes, privateKey);
  assert.equal(hash, transactionHash(bytes));
  assert.ok(verifyTransaction(bytes, publicKey, signature));
  assert.equal(signed.length, bytes.length + 65);
});

test("values that do not fit their Borsh width are refused", () => {
  assert.throws(() => serializeTransaction({ ...FREEZE, nonce: 1n << 64n }), /does not fit/);
  assert.throws(() => serializeTransaction({ ...FREEZE, publicKey: "secp256k1:abc" }), /only ed25519/);
});
