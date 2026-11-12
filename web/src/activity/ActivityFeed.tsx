import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useServices } from "../app/services";
import type { VaultView } from "../contract/abi.gen";
import { ftMetadata } from "../contract/views";
import { IndexerUnavailableError } from "../indexer/resilient";
import type { ActivitySource } from "../indexer/types";
import { formatAgo, formatDateTime, formatInt } from "../ui/format";
import { IndexerDown } from "../ui/IndexerDown";
import { SectionMark, Skeleton, TxLink } from "../ui/primitives";
import { useArrivals } from "../ui/useArrivals";
import { useNow } from "../ui/useNow";
import { describeActivity, type FeedItem, type TokenLookup } from "./describe";

export const FEED_POLL_MS = 20_000;
const PAGE = 50;

/** `readOnly`: someone else's vault, viewed read-only, so the wording says "this", not "your". */
export function ActivityFeed({ ownerId, readOnly = false }: { ownerId: string; vault?: VaultView | null; readOnly?: boolean }) {
  const { chain, config, indexer } = useServices();
  const vaultId = config.vaultId!;
  const now = useNow(15_000);

  const meta = useQueries({ queries: config.tokens.map((t) => ({ queryKey: [config.networkId, "ft_metadata", t.contractId], queryFn: () => ftMetadata(chain, t.contractId), staleTime: Infinity })) });
  const lookup: TokenLookup = (id) => {
    const i = config.tokens.findIndex((t) => t.contractId === id);
    const m = i >= 0 ? meta[i]?.data?.value : undefined;
    return m ? { symbol: m.symbol, decimals: m.decimals } : null;
  };

  const feed = useInfiniteQuery({
    queryKey: [config.networkId, "activity", vaultId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const final = await chain.block("final");
      return indexer.activity(vaultId, { limit: PAGE, cursor: pageParam, finalBlockTimestampNs: final.timestampNs });
    },
    getNextPageParam: (last) => last.next,
    refetchInterval: FEED_POLL_MS,
  });

  const pages = feed.data?.pages ?? [];
  const txs = pages.flatMap((p) => p.txs);
  const items: FeedItem[] = feed.data ? describeActivity(txs, ownerId, vaultId, lookup, readOnly ? "the" : "your") : [];
  const arrivals = useArrivals(feed.data ? items.map((i) => i.key) : undefined);
  const sources = [...new Set(pages.flatMap((p) => [...p.sources]))].map((id) => indexer.sourceById(id)).filter((s): s is ActivitySource => !!s);

  return (
    <section className="card feed" aria-labelledby="feed-title">
      <header className="card-head">
        <div>
          <SectionMark>Activity</SectionMark>
          <h2 id="feed-title" className="card-title">
            Everything that touched {readOnly ? "this" : "your"} vault
          </h2>
        </div>
        <span className="live-dot">{feed.isFetching ? "Checking…" : feed.dataUpdatedAt ? `Updated ${formatAgo(now - feed.dataUpdatedAt)}` : ""}</span>
      </header>

      {feed.isPending ? (
        <ul className="ledger">
          {[0, 1, 2].map((i) => (
            <li key={i} className="entry entry--skeleton">
              <Skeleton size="l" />
            </li>
          ))}
        </ul>
      ) : feed.isError && !feed.data ? (
        feed.error instanceof IndexerUnavailableError ? (
          <IndexerDown error={feed.error} />
        ) : (
          <p className="empty">{`Could not load activity: ${String(feed.error)}`}</p>
        )
      ) : items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing yet.</p>
          <p>Deposits, policy changes, and every call {readOnly ? "this" : "your"} agent makes, allowed or refused, appear here.</p>
        </div>
      ) : (
        <ol className="feed-list">
          {items.map((it) => (
            <li key={it.key} className={`feed-item feed-item--${it.tone}${arrivals.has(it.key) ? " is-new" : ""}`}>
              <span className={`stamp stamp--feed stamp--${it.tone}`}>{it.label}</span>
              <div className="feed-body">
                <p className="feed-text">{it.text}</p>
                <p className="feed-meta mono">
                  {formatDateTime(it.timestampNs)} · block {formatInt(it.blockHeight)} · <TxLink hash={it.hash} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {feed.hasNextPage && (
        <div className="panel-actions">
          <button type="button" className="btn btn--quiet btn--small" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
            {feed.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        </div>
      )}

      <footer className="card-foot">
        <span>
          From the vault's history, filtered to {readOnly ? "this" : "your"} account. Caps quoted are the ones in force at the time.
        </span>
        {sources
          .filter((s) => s.attribution)
          .map((s) => (
            <a key={s.id} href={s.attribution!.url} target="_blank" rel="noopener noreferrer" className="attribution">
              {s.attribution!.text}
            </a>
          ))}
      </footer>
    </section>
  );
}
