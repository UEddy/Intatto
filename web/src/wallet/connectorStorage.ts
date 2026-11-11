/**
 * The storage near-connect keeps its state in, hardened.
 *
 * near-connect reads `debug-wallets` from its storage on load and registers every wallet it finds
 * there as a sandboxed wallet, with whatever executor URL and permissions the entry claims,
 * `webauthn` included (vendor/near-connect/VENDORED.md, "Findings"). Anything that can write this
 * origin's localStorage once could plant a wallet that asks for passkey signatures. This storage
 * never returns that key and never writes it, so only the wallets in our pinned manifest exist.
 *
 * It also namespaces every key, so near-connect's `selected-wallet` cannot collide with anything
 * else on the origin.
 */
export interface ConnectorStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Keys near-connect may never read or write through this storage. */
export const REFUSED_KEYS: ReadonlySet<string> = new Set(["debug-wallets"]);
export const STORAGE_PREFIX = "intatto:near-connect:";

export function hardenedStorage(backing: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeLocalStorage()): ConnectorStorage {
  const key = (k: string) => STORAGE_PREFIX + k;
  return {
    async get(k) {
      if (REFUSED_KEYS.has(k) || !backing) return null;
      try {
        return backing.getItem(key(k));
      } catch {
        return null;
      }
    },
    async set(k, value) {
      if (REFUSED_KEYS.has(k) || !backing) return;
      try {
        backing.setItem(key(k), value);
      } catch {
        // Storage can be full or blocked (private mode); the wallet just won't be remembered.
      }
    },
    async remove(k) {
      if (!backing) return;
      try {
        backing.removeItem(key(k));
      } catch {
        // as above
      }
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
