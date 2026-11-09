import type { UseQueryResult } from "@tanstack/react-query";
import { REASON_SHORT, REASON_TEXT } from "../activity/reasons";
import type { Attempt } from "../canary/attempts";
import type { CanaryConfig } from "../config/networks";
import { useServices } from "../app/services";
import { IndexerUnavailableError } from "../indexer/resilient";
import type { ActivitySource } from "../indexer/types";
import { formatNear } from "../near/units";
import { formatAgo, formatDateTime, formatInt } from "../ui/format";
import { SectionMark, Skeleton, TxLink } from "../ui/primitives";
import { TokenAmount } from "../ui/TokenAmount";
import { useArrivals } from "../ui/useArrivals";
import { useNow } from "../ui/useNow";

type Data = { attempts: Attempt[]; sources: ReadonlySet<ActivitySource["id"]>; more: boolean };

export function AttemptLog({ query, canary }: { query: UseQueryResult<Data>; canary: CanaryConfig }) {
  const { indexer } = useServices();
  const now = useNow(15_000);
  const data = query.data;
  const arrivals = useArrivals(data?.attempts.map((a) => a.hash));
  const sources = data ? [...data.sources].map((id) => indexer.sourceById(id)).filter((s): s is ActivitySource => !!s) : [];

  return (
    <section className="card attempt-log" aria-labelledby="attempts-title">
      <header className="card-head">
        <div>
          <SectionMark>Live log</SectionMark>
          <h2 id="attempts-title" className="card-title">
            Attempts with the published key
          </h2>
        </div>
        <span className="live-dot" aria-hidden={!query.isFetching}>
          {query.isFetching ? "Checking…" : query.dataUpdatedAt ? `Updated ${formatAgo(now - query.dataUpdatedAt)}` : ""}
        </span>
      </header>

      {query.isPending && !query.isError ? (
        <ul className="ledger">
          {[0, 1, 2].map((i) => (
            <li key={i} className="entry entry--skeleton">
              <Skeleton size="l" />
            </li>
          ))}
        </ul>
      ) : query.isError && !data ? (
        <p className="empty">
          {query.error instanceof IndexerUnavailableError
            ? "The transaction indexers are not answering right now. The page keeps retrying, backing off between tries."
            : `Could not load attempts: ${String(query.error)}`}
        </p>
      ) : data && data.attempts.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No attempts yet.</p>
          <p>
            Every transaction signed with <span className="mono">{canary.agentId}</span>'s published key appears here within half a minute, with the reason the vault gave
            for refusing it.
          </p>
        </div>
      ) : (
        <ol className="ledger" reversed>
          {data!.attempts.map((a, i) => (
            <LedgerEntry key={a.hash} attempt={a} canary={canary} number={data!.more ? null : data!.attempts.length - i} fresh={arrivals.has(a.hash)} />
          ))}
        </ol>
      )}

      <footer className="card-foot">
        <span>Only transactions signed by {canary.agentId} with the published key.</span>
        {sources.some((s) => s.attribution) &&
          sources
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

/** The attacker's call as sent: method and raw arguments, with readable amounts alongside. */
function Call({ attempt }: { attempt: Attempt }) {
  const args = attempt.args && typeof attempt.args === "object" ? (attempt.args as Record<string, unknown>) : null;
  if (!args) return <code className="entry-call">{attempt.method}(…)</code>;
  const entries = Object.entries(args);
  return (
    <code className="entry-call">
      <span className="call-method">{attempt.method}</span>(
      {entries.map(([k, v], i) => (
        <span key={k} className="call-arg">
          <span className="call-key">{k}</span>=<span className="call-val">{typeof v === "string" ? v : JSON.stringify(v)}</span>
          {k === "amount" && attempt.method === "agent_spend" && typeof v === "string" && /^\d+$/.test(v) ? (
            <span className="call-note"> ({formatNear(BigInt(v), { maxFraction: 4 })} NEAR)</span>
          ) : k === "amount_in" && typeof v === "string" && /^\d+$/.test(v) && typeof args.token_in === "string" ? (
            <span className="call-note">
              {" "}
              (<TokenAmount tokenId={args.token_in} raw={v} />)
            </span>
          ) : null}
          {i < entries.length - 1 ? ", " : ""}
        </span>
      ))}
      )
    </code>
  );
}

function verdict(o: Attempt["outcome"]): { label: string; tone: "rejected" | "failed" | "through" } {
  if (o.kind === "rejected") return { label: `Rejected · ${REASON_SHORT[o.reason]}`, tone: "rejected" };
  if (o.kind === "failed") return { label: "Failed · before policy", tone: "failed" };
  return { label: "Went through", tone: "through" };
}

function LedgerEntry({ attempt, canary, number, fresh }: { attempt: Attempt; canary: CanaryConfig; number: number | null; fresh: boolean }) {
  const o = attempt.outcome;
  const v = verdict(o);
  const owner = attempt.args && typeof attempt.args === "object" ? (attempt.args as Record<string, unknown>).owner_id : null;
  return (
    <li className={`entry entry--${v.tone}${fresh ? " is-new" : ""}`}>
      <div className="entry-no" aria-label={number !== null ? `Entry ${number}` : undefined}>
        <span className="entry-no-label">No.</span>
        <span className="entry-no-value">{number !== null ? String(number).padStart(4, "0") : "····"}</span>
      </div>
      <div className="entry-body">
        <p className="entry-time mono">
          <time dateTime={new Date(Number(BigInt(attempt.blockTimestampNs) / 1_000_000n)).toISOString()}>{formatDateTime(attempt.blockTimestampNs)}</time>
          <span aria-hidden="true"> · </span>block {formatInt(attempt.blockHeight)}
        </p>
        <Call attempt={attempt} />
        <p className="entry-why">
          {o.kind === "rejected"
            ? `Refused by the contract: ${REASON_TEXT[o.reason]}.`
            : o.kind === "failed"
              ? `Failed before any policy check: ${o.message}`
              : "Every receipt succeeded. Check the vault balance above."}
          {typeof owner === "string" && owner !== canary.ownerId ? <> Aimed at {owner}'s vault, not the canary.</> : null}{" "}
          <TxLink hash={attempt.hash} />
        </p>
      </div>
      <div className="entry-verdict">
        <span className={`stamp stamp--${v.tone}`}>{v.label}</span>
      </div>
    </li>
  );
}
