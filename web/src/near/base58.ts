const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 (Bitcoin alphabet, as NEAR uses for hashes and keys) -> bytes. Throws on bad input. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const char of text) {
    const v = ALPHABET.indexOf(char);
    if (v < 0) throw new Error(`not base58: ${JSON.stringify(char)}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A base58 code hash in the hex form `sha256sum` and near CLI print. */
export function base58ToHex(text: string): string {
  return Array.from(base58Decode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** bytes -> base58, as NEAR prints hashes (the inverse of base58Decode). */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
