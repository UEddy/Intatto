// Minimal NEAR transaction signing for the demo agent, with no dependencies: base58, the Borsh
// layout of a V0 transaction with FunctionCall actions, and ed25519 through node:crypto.
//
// Layout (nearcore near-primitives, Transaction::V0, SignedTransaction):
//   signer_id: string, public_key: PublicKey, nonce: u64, receiver_id: string,
//   block_hash: [u8; 32], actions: Vec<Action>
//   PublicKey = u8 key type (0 = ed25519) + 32 bytes
//   Action::FunctionCall = u8 2 + method_name: string, args: Vec<u8>, gas: u64, deposit: u128
//   SignedTransaction = transaction + Signature (u8 key type + 64 bytes)
// The transaction hash, and what the key signs, is sha256 of the Borsh-serialized transaction.
// near-tx.test.mjs checks all of this against a real testnet transaction.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** `ed25519:<base58>` -> bytes, checking the prefix and length. */
function keyBytes(text, length) {
  if (!text.startsWith("ed25519:")) throw new Error("only ed25519 keys are supported");
  const bytes = base58Decode(text.slice("ed25519:".length));
  if (bytes.length !== length) throw new Error(`expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    this.parts.push(Uint8Array.of(v));
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
  }
  uint(v, bytes) {
    let n = BigInt(v);
    if (n < 0n || n >= 1n << BigInt(bytes * 8)) throw new Error(`${v} does not fit in u${bytes * 8}`);
    const b = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      b[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    this.parts.push(b);
  }
  fixed(bytes) {
    this.parts.push(Uint8Array.from(bytes));
  }
  bytes(bytes) {
    this.u32(bytes.length);
    this.fixed(bytes);
  }
  string(s) {
    this.bytes(new TextEncoder().encode(s));
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

/**
 * Borsh of a V0 transaction whose actions are all FunctionCall:
 * `{ method, args (object, sent as JSON) or argsBytes, gas (bigint), deposit (bigint) }`.
 */
export function serializeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer();
  w.string(signerId);
  w.u8(0);
  w.fixed(keyBytes(publicKey, 32));
  w.uint(nonce, 8);
  w.string(receiverId);
  const hash = typeof blockHash === "string" ? base58Decode(blockHash) : blockHash;
  if (hash.length !== 32) throw new Error("block hash must be 32 bytes");
  w.fixed(hash);
  w.u32(actions.length);
  for (const a of actions) {
    w.u8(2); // Action::FunctionCall
    w.string(a.method);
    w.bytes(a.argsBytes ?? new TextEncoder().encode(JSON.stringify(a.args)));
    w.uint(a.gas, 8);
    w.uint(a.deposit, 16);
  }
  return w.done();
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

/** The transaction hash as NEAR reports it (base58 sha256). */
export const transactionHash = (txBytes) => base58Encode(sha256(txBytes));

/**
 * node:crypto key objects from a NEAR `ed25519:<base58 64 bytes>` secret key (32-byte seed
 * followed by the 32-byte public key). Checks that the two halves belong together.
 */
export function keyPair(secretKey) {
  const raw = keyBytes(secretKey, 64);
  const seed = raw.subarray(0, 32);
  const pub = raw.subarray(32);
  const b64 = (b) => Buffer.from(b).toString("base64url");
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64(seed), x: b64(pub) }, format: "jwk" });
  const derived = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (!derived.equals(Buffer.from(pub))) throw new Error("secret key's public half does not match its seed");
  return { privateKey, publicKey: `ed25519:${base58Encode(pub)}` };
}

/** Signs a serialized transaction; returns the Borsh SignedTransaction and its hash. */
export function signTransaction(txBytes, privateKey) {
  const signature = edSign(null, sha256(txBytes), privateKey);
  const w = new Writer();
  w.fixed(txBytes);
  w.u8(0);
  w.fixed(signature);
  return { signed: w.done(), hash: transactionHash(txBytes), signature: `ed25519:${base58Encode(signature)}` };
}

/** Verifies a NEAR ed25519 signature over a serialized transaction. */
export function verifyTransaction(txBytes, publicKey, signature) {
  const x = Buffer.from(keyBytes(publicKey, 32)).toString("base64url");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return edVerify(null, sha256(txBytes), key, keyBytes(signature, 64));
}
