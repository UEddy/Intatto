import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface Tab {
  readonly id: string;
  readonly title: string;
  readonly panel: ReactNode;
}

/**
 * WAI-ARIA tabs with automatic activation: arrow keys (and Home, End) move between tabs and show
 * their panel. Every panel stays mounted, hidden when not selected, so nothing reloads on switch.
 */
export function Tabs({ label, tabs, active, onChange }: { label: string; tabs: readonly Tab[]; active: string; onChange: (id: string) => void }) {
  const base = useId().replace(/:/g, "");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, tabs.findIndex((t) => t.id === active));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = tabs.length - 1;
    const to = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    onChange(tabs[to]!.id);
    refs.current[to]?.focus();
  };

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-controls={`${base}-panel-${t.id}`}
            aria-selected={i === index}
            tabIndex={i === index ? 0 : -1}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.title}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={i !== index} className="tab-panel" tabIndex={0}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
