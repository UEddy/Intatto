import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import accountVault from "../test/fixtures/fastnear-account-vault.json";
import txsVault from "../test/fixtures/fastnear-transactions-vault.json";
import nbList from "../test/fixtures/nearblocks-receipts-vault.json";
import nbRejected from "../test/fixtures/nearblocks-tx-swap-rejected.json";
import nbCompleted from "../test/fixtures/nearblocks-tx-swap-completed.json";
import { fakeFetch } from "../test/fakeFetch";
import { IdbTxCache, MemoryTxCache, SETTLE_NS, isSettled } from "./cache";
import { FastNearSource, parseFastNearTransactions } from "./fastnear";
import { NearBlocksSource, parseNearBlocksTree } from "./nearblocks";
import { FIRST_COOLDOWN_MS, IndexerUnavailableError, ResilientIndexer, TRANSIENT_RETRY_MS } from "./resilient";
import { IndexerError, type ActivitySource, type IndexedTx } from "./types";

const FAR_FUTURE = 10n ** 30n;

describe("FastNEAR", () => {
  it("lists an account's transactions and pages with resume_token", async () => {
    const f = fakeFetch([{ status: 200, body: JSON.stringify({ ...accountVault, resume_token: "123" }) }]);
    const s = new FastNearSource("https://tx.test.fastnear.com", { fetch: f.fetch });
    const page = await s.listTxs("vault-v1.intatto-dev.testnet", { limit: 50, cursor: "abc" });
    expect(page.txs).toHaveLength(19);
    expect(page.next).toBe("123");
    expect(f.calls[0]).toMatchObject({ url: "https://tx.test.fastnear.com/v0/account", method: "POST", body: { account_id: "vault-v1.intatto-dev.testnet", limit: 50, resume_token: "abc" } });
  });

  it("normalizes full transactions, including bare-string actions and failures", () => {
    const txs = parseFastNearTransactions(txsVault);
    const create = txs.find((t) => t.hash.startsWith("4apsNPc4"))!;
    expect(create.actions[0]).toEqual({ kind: "Other", type: "CreateAccount" });
    const frozen = txs.find((t) => t.hash.startsWith("2Xe4Etgk"))!;
    const failed = frozen.receipts.find((r) => r.status === "failure")!;
    expect(failed.failureMessage).toBe("Vault is frozen; agent swapping is disabled");
    expect(frozen.actions[0]).toMatchObject({ kind: "FunctionCall", methodName: "agent_swap", args: { pool_id: 1084, owner_id: "intatto-dev.testnet" } });
    expect(frozen.publicKey).toBe("ed25519:DSx3NRF83a34me3RRULscnmf3LfNDAH4q37yY73PUcdF");
  });

  it("splits more than 20 hashes into several requests", async () => {
    const f = fakeFetch([{ status: 200, body: JSON.stringify({ transactions: [] }) }]);
    const s = new FastNearSource("https://x", { fetch: f.fetch });
    await s.getTxs(Array.from({ length: 45 }, (_, i) => `h${i}`));
    expect(f.calls.map((c) => (c.body as { tx_hashes: string[] }).tx_hashes.length)).toEqual([20, 20, 5]);
  });

  it("flags 429 and CORS-less failures as rate limits", async () => {
    const a = new FastNearSource("https://x", { fetch: fakeFetch([{ status: 429, body: "" }]).fetch });
    await expect(a.listTxs("a.testnet", { limit: 1 })).rejects.toMatchObject({ rateLimited: true });
    const b = new FastNearSource("https://x", { fetch: fakeFetch([{ throws: new TypeError("Failed to fetch") }]).fetch });
    await expect(b.listTxs("a.testnet", { limit: 1 })).rejects.toMatchObject({ rateLimited: true });
  });
});

describe("NearBlocks", () => {
  it("lists receipts as unique transactions, with the opaque next cursor", async () => {
    const f = fakeFetch([{ status: 200, body: JSON.stringify(nbList) }]);
    const s = new NearBlocksSource("https://api-testnet.nearblocks.io", { fetch: f.fetch });
    const page = await s.listTxs("vault-v1.intatto-dev.testnet", { limit: 25 });
    expect(new Set(page.txs.map((t) => t.hash)).size).toBe(page.txs.length);
    expect(page.next).toBe(nbList.meta.next_page);
    expect(f.calls[0]!.url).toBe("https://api-testnet.nearblocks.io/v3/accounts/vault-v1.intatto-dev.testnet/receipts?limit=25");
    expect(f.calls[0]!.headers).not.toHaveProperty("Content-Type");
  });

  it("flattens the receipt tree into the same shape as FastNEAR", () => {
    const nb = parseNearBlocksTree("2Xe4EtgkgWyS8ocDhHw4PKVKEcS4Caw7uXaFs3zeP3rP", nbRejected);
    const fast = parseFastNearTransactions(txsVault).find((t) => t.hash === nb.hash)!;
    expect(nb.signerId).toBe(fast.signerId);
    expect(nb.publicKey).toBe(fast.publicKey);
    expect(nb.actions[0]).toMatchObject({ kind: "FunctionCall", methodName: "agent_swap", args: (fast.actions[0] as { args: unknown }).args });
    const strip = (t: IndexedTx) => t.receipts.map((r) => ({ id: r.receiptId, ex: r.executorId, logs: r.logs, st: r.status, msg: r.failureMessage })).sort((a, b) => a.id.localeCompare(b.id));
    expect(strip(nb)).toEqual(strip(fast));
  });

  it("reads a completed swap's whole receipt chain", () => {
    const nb = parseNearBlocksTree("5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt", nbCompleted);
    const fast = parseFastNearTransactions(txsVault).find((t) => t.hash === nb.hash)!;
    expect(nb.receipts.flatMap((r) => r.logs).sort()).toEqual(fast.receipts.flatMap((r) => r.logs).sort());
  });
});

describe("cache", () => {
  const tx = parseFastNearTransactions(txsVault)[0]!;

  it("stores only settled transactions' worth, and reads them back from IndexedDB", async () => {
    expect(isSettled(tx, BigInt(tx.blockTimestampNs) + SETTLE_NS + 1n)).toBe(true);
    expect(isSettled(tx, BigInt(tx.blockTimestampNs))).toBe(false);
    const c = new IdbTxCache();
    await c.put("testnet", [tx]);
    const got = await new IdbTxCache().get("testnet", [tx.hash, "missing"]);
    expect(got.get(tx.hash)).toEqual(tx);
    expect(got.has("missing")).toBe(false);
    expect((await c.get("mainnet", [tx.hash])).size).toBe(0);
  });

  it("falls back to memory when IndexedDB is unavailable", async () => {
    const c = new IdbTxCache(undefined);
    await c.put("testnet", [tx]);
    expect((await c.get("testnet", [tx.hash])).get(tx.hash)).toEqual(tx);
  });
});

describe("ResilientIndexer", () => {
  const all = parseFastNearTransactions(txsVault);
  const refs = all.map((t) => ({ hash: t.hash, blockHeight: t.blockHeight, blockTimestampNs: t.blockTimestampNs }));

  function source(
    id: ActivitySource["id"],
    behaviour: { fail?: boolean; transientFailures?: number; listsBySigner?: boolean },
  ): ActivitySource & { calls: string[] } {
    const calls: string[] = [];
    let transientLeft = behaviour.transientFailures ?? 0;
    return {
      id,
      attribution: id === "nearblocks" ? { text: "Powered by Nearblocks.io APIs", url: "https://nearblocks.io" } : null,
      listsBySigner: behaviour.listsBySigner ?? id === "fastnear",
      calls,
      async listTxs() {
        calls.push("list");
        if (transientLeft > 0) {
          transientLeft--;
          throw new IndexerError(id, "network error (TypeError: Failed to fetch); possibly rate limited", true, "", true);
        }
        if (behaviour.fail) throw new IndexerError(id, "down", true);
        return { txs: refs, next: null };
      },
      async getTxs(hashes) {
        calls.push(`get:${hashes.length}`);
        if (behaviour.fail) throw new IndexerError(id, "down", true);
        return all.filter((t) => hashes.includes(t.hash)).map((t) => ({ ...t, source: id }));
      },
    };
  }

  it("falls back to NearBlocks, cools FastNEAR down, and attributes the data", async () => {
    let now = 1_000_000;
    const fast = source("fastnear", { fail: true });
    const nb = source("nearblocks", {});
    const idx = new ResilientIndexer([fast, nb], new MemoryTxCache(), "testnet", () => now);
    const r = await idx.activity("vault-v1.intatto-dev.testnet", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    expect(r.txs).toHaveLength(19);
    expect([...r.sources]).toEqual(["nearblocks"]);
    expect(idx.status()[0]!.coolingDownUntil).toBe(now + FIRST_COOLDOWN_MS);
    // while cooling down FastNEAR is not asked again
    await idx.activity("vault-v1.intatto-dev.testnet", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    expect(fast.calls).toEqual(["list"]);
    now += FIRST_COOLDOWN_MS + 1;
    await idx.activity("vault-v1.intatto-dev.testnet", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    expect(fast.calls).toEqual(["list", "list"]);
    // the second failure doubles the cooldown
    expect(idx.status()[0]!.coolingDownUntil).toBe(now + 2 * FIRST_COOLDOWN_MS);
  });

  it("fetches each settled transaction once, and keeps listing order", async () => {
    const fast = source("fastnear", {});
    const idx = new ResilientIndexer([fast], new MemoryTxCache(), "testnet");
    const first = await idx.activity("v", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    const second = await idx.activity("v", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    expect(fast.calls).toEqual(["list", "get:19", "list"]);
    expect(second.txs.map((t) => t.hash)).toEqual(refs.map((r) => r.hash));
    expect(first.txs).toEqual(second.txs);
  });

  it("does not cache transactions that may still be executing", async () => {
    const fast = source("fastnear", {});
    const idx = new ResilientIndexer([fast], new MemoryTxCache(), "testnet");
    await idx.activity("v", { limit: 50, finalBlockTimestampNs: 0n });
    await idx.activity("v", { limit: 50, finalBlockTimestampNs: 0n });
    expect(fast.calls).toEqual(["list", "get:19", "list", "get:19"]);
  });

  it("says when nothing is available", async () => {
    const idx = new ResilientIndexer([source("fastnear", { fail: true }), source("nearblocks", { fail: true })], new MemoryTxCache(), "testnet", () => 5);
    const err = await idx.activity("v", { limit: 1, finalBlockTimestampNs: 0n }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerUnavailableError);
    expect(err.retryAt).toBe(5 + FIRST_COOLDOWN_MS);
  });

  it("never lists signed transactions from a source that cannot, and does not cool it down for that", async () => {
    // The board's attempt log: NearBlocks would answer with a partial list, shown as "no attempts".
    const fast = source("fastnear", { fail: true });
    const nb = source("nearblocks", {});
    const idx = new ResilientIndexer([fast, nb], new MemoryTxCache(), "testnet", () => 5, async () => {});
    const err = await idx.activity("canary-agent.intatto-dev.testnet", { limit: 50, signerOnly: true, finalBlockTimestampNs: 0n }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerUnavailableError);
    expect(nb.calls).toEqual([]);
    expect(err.errors).toEqual(["fastnear: down", "nearblocks cannot list the transactions an account signed"]);
    expect(idx.status()[1]!.coolingDownUntil).toBeNull();
    // NearBlocks still serves the feed, which lists receipts.
    const feed = await idx.activity("vault-v1.intatto-dev.testnet", { limit: 50, finalBlockTimestampNs: FAR_FUTURE });
    expect([...feed.sources]).toEqual(["nearblocks"]);
  });

  it("tries a source once more after a request that got no answer, before cooling it down", async () => {
    const waits: number[] = [];
    const fast = source("fastnear", { transientFailures: 1 });
    const idx = new ResilientIndexer([fast], new MemoryTxCache(), "testnet", () => 5, async (ms) => void waits.push(ms));
    const r = await idx.activity("v", { limit: 50, signerOnly: true, finalBlockTimestampNs: FAR_FUTURE });
    expect(r.txs).toHaveLength(19);
    expect(fast.calls).toEqual(["list", "list", "get:19"]);
    expect(waits).toEqual([TRANSIENT_RETRY_MS]);
    expect(idx.status()[0]!.coolingDownUntil).toBeNull();
  });

  it("retries a transient failure only once, and does not retry other errors", async () => {
    const twice = source("fastnear", { transientFailures: 2 });
    const a = new ResilientIndexer([twice], new MemoryTxCache(), "testnet", () => 5, async () => {});
    await expect(a.activity("v", { limit: 1, finalBlockTimestampNs: 0n })).rejects.toBeInstanceOf(IndexerUnavailableError);
    expect(twice.calls).toEqual(["list", "list"]);
    const down = source("fastnear", { fail: true });
    const b = new ResilientIndexer([down], new MemoryTxCache(), "testnet", () => 5, async () => {});
    await expect(b.activity("v", { limit: 1, finalBlockTimestampNs: 0n })).rejects.toBeInstanceOf(IndexerUnavailableError);
    expect(down.calls).toEqual(["list"]);
  });

  it("keeps the last error while a source cools down, so the page can say why nothing is asked", async () => {
    const idx = new ResilientIndexer([source("fastnear", { fail: true })], new MemoryTxCache(), "testnet", () => 5, async () => {});
    await idx.activity("v", { limit: 1, finalBlockTimestampNs: 0n }).catch(() => {});
    const err = await idx.activity("v", { limit: 1, finalBlockTimestampNs: 0n }).catch((e) => e);
    expect(err.errors).toEqual(["fastnear cooling down after: fastnear: down"]);
  });
});

describe("signed-transaction lists", () => {
  it("FastNEAR asks the server for signed transactions only", async () => {
    const f = fakeFetch([{ status: 200, body: JSON.stringify({ account_txs: [], txs_count: 0 }) }]);
    await new FastNearSource("https://x", { fetch: f.fetch }).listTxs("demo-agent.intatto-dev.testnet", { limit: 50, signerOnly: true });
    expect(f.calls[0]!.body).toEqual({ account_id: "demo-agent.intatto-dev.testnet", limit: 50, is_signer: true });
  });

  it("NearBlocks refuses without a request: /txns lists what an account received", async () => {
    const f = fakeFetch([{ status: 200, body: "{}" }]);
    const nb = new NearBlocksSource("https://api-testnet.nearblocks.io", { fetch: f.fetch });
    expect(nb.listsBySigner).toBe(false);
    await expect(nb.listTxs("demo-agent.intatto-dev.testnet", { limit: 25, signerOnly: true })).rejects.toBeInstanceOf(IndexerError);
    expect(f.calls).toEqual([]);
  });

  it("a network failure is transient; an HTTP error is not", async () => {
    const net = new FastNearSource("https://x", { fetch: fakeFetch([{ throws: new TypeError("Failed to fetch") }]).fetch });
    await expect(net.listTxs("a.testnet", { limit: 1 })).rejects.toMatchObject({ transient: true });
    const http = new FastNearSource("https://x", { fetch: fakeFetch([{ status: 503, body: "" }]).fetch });
    await expect(http.listTxs("a.testnet", { limit: 1 })).rejects.toMatchObject({ transient: false });
  });
});
