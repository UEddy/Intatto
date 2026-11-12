import type { ReactNode } from "react";

/**
 * A band of live facts that drifts sideways. The list is rendered twice so the loop is seamless;
 * the copy is hidden from assistive technology, which reads the list once. It pauses while hovered
 * or focused, and with prefers-reduced-motion it stands still and wraps (ticker.css).
 */
export function Ticker({ label, items }: { label: string; items: readonly ReactNode[] }) {
  const list = (hidden: boolean) => (
    <ul className="ticker-list" aria-hidden={hidden || undefined}>
      {items.map((item, i) => (
        <li key={i} className="ticker-item">
          {item}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="ticker" role="region" aria-label={label} tabIndex={0}>
      <div className="ticker-track">
        {list(false)}
        {list(true)}
      </div>
    </div>
  );
}
