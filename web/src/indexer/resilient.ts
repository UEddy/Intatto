/**
 * The indexer the screens use: FastNEAR first, NearBlocks if FastNEAR fails, each with its own
 * cooldown after an error (doubling from 15 s to 5 min, reset by a success), and the transaction
 * cache in front of both. It reports which source answered so the page can attribute it.
 */
import { isSettled, type TxCache } from "./cache";
import { IndexerError, type ActivitySource, type IndexedTx, type TxPage } from "./types";

export const FIRST_COOLDOWN_MS = 15_000;
export const MAX_COOLDOWN_MS = 5 * 60_000;
/**
 * A request that got no answer at all (a DNS blip, a dropped connection) is tried once more after
 * this delay before the source cools down; otherwise one blip hands the page to the fallback, or
 * to an error, for 15 s or more.
 */
export const TRANSIENT_RETRY_MS = 1_000;

interface SourceState {
  cooldownUntil: number;
  nextCooldownMs: number;
  lastError: string | null;
}

export interface SourceStatus {
  readonly id: ActivitySource["id"];
  readonly coolingDownUntil: number | null;
  readonly lastError: string | null;
}

export class IndexerUnavailableError extends Error {
  constructor(
    readonly retryAt: number,
    readonly errors: readonly string[],
  ) {
    super(`No indexer is available right now (${errors.join("; ") || "all cooling down"})`);
    this.name = "IndexerUnavailableError";
  }
}

export interface ActivityResult {
  /** Newest first. */
  readonly txs: readonly IndexedTx[];
  readonly next: string | null;
  /** Every source whose data is shown: the lister, and the origin of every transaction. */
  readonly sources: ReadonlySet<ActivitySource["id"]>;
}

export class ResilientIndexer {
  private readonly state = new Map<ActivitySource["id"], SourceState>();

  constructor(
    private readonly sources: readonly ActivitySource[],
    private readonly cache: TxCache,
    private readonly network: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    for (const s of sources) this.state.set(s.id, { cooldownUntil: 0, nextCooldownMs: FIRST_COOLDOWN_MS, lastError: null });
  }

  status(): SourceStatus[] {
    const t = this.now();
    return this.sources.map((s) => {
      const st = this.state.get(s.id)!;
      return { id: s.id, coolingDownUntil: st.cooldownUntil > t ? st.cooldownUntil : null, lastError: st.lastError };
    });
  }

  sourceById(id: ActivitySource["id"]): ActivitySource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  /**
   * Runs `run` on the first source that is eligible and not cooling down. A source that is not
   * eligible (it cannot answer this kind of request) is skipped without a cooldown, so other
   * requests still use it.
   */
  private async withSource<T>(
    run: (source: ActivitySource) => Promise<T>,
    options: { prefer?: ActivitySource["id"]; eligible?: (source: ActivitySource) => string | null } = {},
  ): Promise<[T, ActivitySource]> {
    const { prefer, eligible } = options;
    const errors: string[] = [];
    const considered: SourceState[] = [];
    const ordered = prefer ? [...this.sources].sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : 0)) : this.sources;
    for (const source of ordered) {
      const st = this.state.get(source.id)!;
      const unable = eligible?.(source) ?? null;
      if (unable !== null) {
        errors.push(`${source.id} ${unable}`);
        continue;
      }
      considered.push(st);
      if (st.cooldownUntil > this.now()) {
        // Keep the reason: "cooling down" alone hides why no request goes out.
        errors.push(`${source.id} cooling down after: ${st.lastError ?? "an error"}`);
        continue;
      }
      try {
        let value: T;
        try {
          value = await run(source);
        } catch (e) {
          if (!(e instanceof IndexerError && e.transient)) throw e;
          await this.sleep(TRANSIENT_RETRY_MS);
          value = await run(source);
        }
        st.nextCooldownMs = FIRST_COOLDOWN_MS;
        st.lastError = null;
        return [value, source];
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Network errors and 429s back off; so does anything else, since retrying a broken
        // endpoint every poll helps nobody.
        st.cooldownUntil = this.now() + st.nextCooldownMs;
        st.nextCooldownMs = Math.min(st.nextCooldownMs * 2, MAX_COOLDOWN_MS);
        st.lastError = message;
        errors.push(message);
        if (!(e instanceof IndexerError)) throw e;
      }
    }
    const retryAt = considered.length > 0 ? Math.min(...considered.map((s) => s.cooldownUntil)) : this.now();
    throw new IndexerUnavailableError(retryAt, errors);
  }

  /**
   * A page of `accountId`'s transactions with every receipt, newest first. Cached transactions are
   * not fetched again; the rest come from the same source that listed them when it can.
   */
  async activity(
    accountId: string,
    options: { limit: number; cursor?: string | null; signerOnly?: boolean; finalBlockTimestampNs: bigint },
  ): Promise<ActivityResult> {
    const [page, lister] = await this.withSource<TxPage>(
      (s) =>
        s.listTxs(accountId, {
          limit: options.limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.signerOnly ? { signerOnly: true } : {}),
        }),
      { eligible: (s) => (options.signerOnly && !s.listsBySigner ? "cannot list the transactions an account signed" : null) },
    );
    const hashes = page.txs.map((t) => t.hash);
    const cached = await this.cache.get(this.network, hashes);
    const missing = hashes.filter((h) => !cached.has(h));
    const sources = new Set<ActivitySource["id"]>([lister.id]);
    for (const tx of cached.values()) sources.add(tx.source);
    const fetched = new Map<string, IndexedTx>();
    if (missing.length > 0) {
      const [txs, fetcher] = await this.withSource((s) => s.getTxs(missing), { prefer: lister.id });
      sources.add(fetcher.id);
      for (const tx of txs) fetched.set(tx.hash, tx);
      await this.cache.put(
        this.network,
        txs.filter((tx) => isSettled(tx, options.finalBlockTimestampNs)),
      );
    }
    const txs: IndexedTx[] = [];
    for (const ref of page.txs) {
      const tx = cached.get(ref.hash) ?? fetched.get(ref.hash);
      if (tx) txs.push(tx);
    }
    return { txs, next: page.next, sources };
  }
}
