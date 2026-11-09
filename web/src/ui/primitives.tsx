import { useState, type ReactNode } from "react";
import { useServices } from "../app/services";
import type { Source } from "../near/chain";
import { formatInt, shorten } from "./format";

/* ---------- icons (inline, currentColor) ---------- */

const paths = {
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "m5 12 4.5 4.5L19 7",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7Z",
  shield: "M12 3 4 6v6c0 4.4 3.4 8.4 8 9 4.6-.6 8-4.6 8-9V6l-8-3Z",
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className="icon">
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

/* ---------- links ---------- */

export function TxLink({ hash, children, className }: { hash: string; children?: ReactNode; className?: string }) {
  const { config } = useServices();
  return (
    <a href={config.explorer.txUrl(hash)} target="_blank" rel="noopener noreferrer" className={`txlink mono${className ? ` ${className}` : ""}`} title={`Open ${hash} in ${config.explorer.name}`}>
      {children ?? shorten(hash, 8, 6)}
      <Icon name="external" size={12} />
    </a>
  );
}

export function AccountLink({ id, short = false }: { id: string; short?: boolean }) {
  const { config } = useServices();
  return (
    <a href={config.explorer.accountUrl(id)} target="_blank" rel="noopener noreferrer" className="acct mono" title={id}>
      {short ? shorten(id, 14, 8) : id}
    </a>
  );
}

/* ---------- copy ---------- */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--quiet btn--small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      aria-live="polite"
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

/* ---------- traceability ---------- */

/** Where a figure was read: method, arguments, raw value, block. */
export function SourceNote({ source, path, extra }: { source: Source; path?: string; extra?: ReactNode }) {
  const argValues = source.args && typeof source.args === "object" ? Object.values(source.args as Record<string, unknown>).map((v) => (typeof v === "string" ? v : JSON.stringify(v))) : [];
  const call = source.method ? `${source.method}(${argValues.join(", ")})` : source.rpcMethod;
  return (
    <dl className="source">
      <div>
        <dt>Read</dt>
        <dd className="mono">
          {call}
          {path ? <span className="source-path">{path}</span> : null}
        </dd>
      </div>
      {source.method ? (
        <div>
          <dt>On</dt>
          <dd className="mono">{source.target}</dd>
        </div>
      ) : null}
      <div>
        <dt>Block</dt>
        <dd className="mono">{formatInt(source.blockHeight)}</dd>
      </div>
      {extra}
    </dl>
  );
}

/**
 * A figure with its source. On wide screens the source sits beside it as marginalia; on narrow
 * ones it sits behind a "Source" disclosure.
 */
export function Traceable({ source, path, extra, children }: { source: Source | undefined; path?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="traceable">
      <div className="traceable-value">{children}</div>
      {source && (
        <>
          <div className="traceable-margin" aria-hidden="true">
            <SourceNote source={source} {...(path ? { path } : {})} extra={extra} />
          </div>
          <details className="traceable-drawer">
            <summary>Source</summary>
            <SourceNote source={source} {...(path ? { path } : {})} extra={extra} />
          </details>
        </>
      )}
    </div>
  );
}

export function RawRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

/* ---------- status ---------- */

export type Tone = "ok" | "alert" | "frost" | "warn" | "neutral";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function SectionMark({ n, children }: { n?: string; children: ReactNode }) {
  return (
    <p className="section-mark">
      <span aria-hidden="true">§{n ? ` ${n}` : ""}</span> {children}
    </p>
  );
}

export function Skeleton({ size = "m" }: { size?: "s" | "m" | "l" }) {
  return <span className={`skeleton skeleton--${size}`} role="status" aria-label="Loading" />;
}
