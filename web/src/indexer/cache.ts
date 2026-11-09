/**
 * IndexedDB cache of indexed transactions. A transaction's receipts never change once they have
 * all executed, so each is fetched once. Only transactions comfortably older than the final
 * block are stored (see `isSettled`), so one caught mid-execution is fetched again.
 *
 * Every read and write is best-effort: private windows and blocked storage make IndexedDB throw,
 * and then the cache simply misses.
 */
import type { IndexedTx } from "./types";

const DB_NAME = "intatto";
const DB_VERSION = 1;
const STORE = "txs";

/** Older than this (chain time) and every receipt of an ordinary transaction has executed. */
export const SETTLE_NS = 10n * 60n * 1_000_000_000n;

export function isSettled(tx: IndexedTx, finalBlockTimestampNs: bigint): boolean {
  return BigInt(tx.blockTimestampNs) + SETTLE_NS < finalBlockTimestampNs;
}

export interface TxCache {
  get(network: string, hashes: readonly string[]): Promise<Map<string, IndexedTx>>;
  put(network: string, txs: readonly IndexedTx[]): Promise<void>;
}

export class MemoryTxCache implements TxCache {
  private readonly map = new Map<string, IndexedTx>();
  async get(network: string, hashes: readonly string[]) {
    const out = new Map<string, IndexedTx>();
    for (const h of hashes) {
      const v = this.map.get(`${network}:${h}`);
      if (v) out.set(h, v);
    }
    return out;
  }
  async put(network: string, txs: readonly IndexedTx[]) {
    for (const tx of txs) this.map.set(`${network}:${tx.hash}`, tx);
  }
}

export class IdbTxCache implements TxCache {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private readonly fallback = new MemoryTxCache();

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private db(): Promise<IDBDatabase | null> {
    this.dbPromise ??= new Promise((resolve) => {
      try {
        if (!this.factory) return resolve(null);
        const req = this.factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async get(network: string, hashes: readonly string[]): Promise<Map<string, IndexedTx>> {
    const db = await this.db();
    if (!db) return this.fallback.get(network, hashes);
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const entries = await Promise.all(
        hashes.map(
          (h) =>
            new Promise<[string, IndexedTx | undefined]>((resolve) => {
              const req = store.get(`${network}:${h}`);
              req.onsuccess = () => resolve([h, req.result as IndexedTx | undefined]);
              req.onerror = () => resolve([h, undefined]);
            }),
        ),
      );
      const out = new Map<string, IndexedTx>();
      for (const [h, v] of entries) if (v && v.hash === h) out.set(h, v);
      return out;
    } catch {
      return this.fallback.get(network, hashes);
    }
  }

  async put(network: string, txs: readonly IndexedTx[]): Promise<void> {
    if (txs.length === 0) return;
    const db = await this.db();
    if (!db) return this.fallback.put(network, txs);
    try {
      await new Promise<void>((resolve) => {
        const t = db.transaction(STORE, "readwrite");
        const store = t.objectStore(STORE);
        for (const tx of txs) store.put(tx, `${network}:${tx.hash}`);
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
        t.onabort = () => resolve();
      });
    } catch {
      await this.fallback.put(network, txs);
    }
  }
}
