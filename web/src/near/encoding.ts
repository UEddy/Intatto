/** UTF-8 JSON <-> base64, as RPC `call_function` takes args and returns results. */

export function jsonToBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** `call_function` returns its result as an array of byte values. */
export function bytesToText(bytes: unknown): string {
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("call_function result is not a byte array");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes as number[]));
}

/** Decodes a function call's base64 args as JSON, or null if they are not UTF-8 JSON. */
export function decodeArgs(b64: string): unknown {
  try {
    return JSON.parse(base64ToText(b64));
  } catch {
    return null;
  }
}
