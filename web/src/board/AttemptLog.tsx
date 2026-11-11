import type { UseQueryResult } from "@tanstack/react-query";
import { reasonShort, reasonText } from "../activity/reasons";
import type { Attempt } from "../canary/attempts";
import type { CanaryConfig, DemoConfig } from "../config/networks";
import { useServices } from "../app/services";
import { IndexerUnavailableError } from "../indexer/resilient";
import type { ActivitySource } from "../indexer/types";
import { formatNear } from "../near/units";
import { formatAgo, formatDateTime, formatInt } from "../ui/format";
import { SectionMark, Skeleton, TxLink } from "../ui/primitives";
import { IndexerDown } from "../ui/IndexerDown";
import { TokenAmount } from "../ui/TokenAmount";
import { useArrivals } from "../ui/useArrivals";
import { useNow } from "../ui/useNow";

type Data = { attempts: Attempt[]; sources: ReadonlySet<ActivitySource["id"]>; more: boolean };

/**
 * Whose published key a log follows. The canary pays nobody, so any attempt that goes through is
 * an alarm. The demo agent may pay its merchant within the caps, so those payments are expected.
 */
export type LogSubject =
  | { readonly kind: "canary"; readonly ownerId: string; readonly agentId: string }
  | { readonly kind: "demo"; readonly ownerId: string; readonly agentId: string; readonly merchantId: string };

export const canarySubject = (c: CanaryConfig): LogSubject => ({ kind: "canary", ownerId: c.ownerId, agentId: c.agentId });
export const demoSubject = (d: DemoConfig): LogSubject => ({ kind: "demo", ownerId: d.ownerId, agentId: d.agentId, merchantId: d.merchantId });

export function AttemptLog({ query, subject }: { query: UseQueryResult<Data>; subject: LogSubject }) {
  const canary = subject;
  const titleId = `attempts-title-${subject.kind}`;
  const { indexer } = useServices();
  const now = useNow(15_000);
  const data = query.data;
  const arrivals = useArrivals(data?.attempts.map((a) => a.hash));
  const sources = data ? [...data.sources].map((id) => indexer.sourceById(id)).filter((s): s is ActivitySource => !!s) : [];

  return (
    <section className="card attempt-log" aria-labelledby={titleId}>
      <header className="card-head">
        <div>
          <SectionMark>{subject.kind === "demo" ? "Prompt-injection demo" : "Live log"}</SectionMark>
          <h2 id={titleId} className="card-title">
            {subject.kind === "demo" ? "The demo agent's payments and blocked attempts" : "Attempts with the published key"}
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
        query.error instanceof IndexerUnavailableError ? (
          <IndexerDown error={query.error} />
        ) : (
          <p className="empty">{`Could not load attempts: ${String(query.error)}`}</p>
        )
      ) : data && data.attempts.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No attempts yet.</p>
          <p>
            Every transaction signed with <span className="mono">{canary.agentId}</span>'s published key appears here within half a minute, with the reason the vault gave
            for refusing it.
            {subject.kind === "demo" ? <> Run <span className="mono">node agent/injection-demo.mjs --compromised</span> to add some.</> : null}
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

export function verdict(o: Attempt["outcome"], subject: LogSubject["kind"], method: string): { label: string; tone: "rejected" | "failed" | "through" | "allowed" } {
  if (o.kind === "rejected") return { label: `Rejected · ${reasonShort(o.reason, method)}`, tone: "rejected" };
  if (o.kind === "failed") return { label: "Failed · before policy", tone: "failed" };
  return subject === "demo" ? { label: "Paid · within policy", tone: "allowed" } : { label: "Went through", tone: "through" };
}

function LedgerEntry({ attempt, canary, number, fresh }: { attempt: Attempt; canary: LogSubject; number: number | null; fresh: boolean }) {
  const o = attempt.outcome;
  const v = verdict(o, canary.kind, attempt.method);
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
            ? `Refused by the contract: ${reasonText(o.reason, attempt.method)}.`
            : o.kind === "failed"
              ? `Failed before any policy check: ${o.message}`
              : canary.kind === "demo"
                ? `Allowed: ${canary.merchantId} is on the allowlist and the amount is within the caps.`
                : "Every receipt succeeded. Check the vault balance above."}
          {typeof owner === "string" && owner !== canary.ownerId ? <> Aimed at {owner}'s vault, not the {canary.kind}.</> : null}{" "}
          <TxLink hash={attempt.hash} />
        </p>
      </div>
      <div className="entry-verdict">
        <span className={`stamp stamp--${v.tone}`}>{v.label}</span>
      </div>
    </li>
  );
}
