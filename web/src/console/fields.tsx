import { useId, type ReactNode } from "react";
import { parseUnits, formatUnits } from "../near/units";

/** An amount input that parses exactly (no floats) and says why it can't. */
export function AmountField({
  label,
  value,
  onChange,
  decimals,
  symbol,
  max,
  maxLabel = "Max",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  decimals: number;
  symbol: string;
  max?: bigint | null;
  maxLabel?: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const parsed = value.trim() === "" ? null : parseUnits(value, decimals);
  const error = parsed && !parsed.ok ? parsed.error : parsed && parsed.ok && max != null && parsed.value > max ? `More than the ${formatUnits(max, decimals)} ${symbol} available` : null;
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className={`amount${error ? " has-error" : ""}`}>
        <input
          id={id}
          className="mono"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={`${id}-hint`}
        />
        <span className="amount-unit">{symbol}</span>
        {max != null && max > 0n && (
          <button type="button" className="amount-max" onClick={() => onChange(formatUnits(max, decimals, { group: false }))}>
            {maxLabel}
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className={`field-hint${error ? " field-hint--error" : ""}`}>
        {error ?? hint}
      </p>
    </div>
  );
}

export function parsedOrZero(value: string, decimals: number): bigint {
  const r = parseUnits(value, decimals);
  return r.ok ? r.value : 0n;
}

export function Panel({ id, mark, title, children, aside }: { id?: string; mark: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card panel" id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="card-head">
        <div>
          <p className="section-mark">
            <span aria-hidden="true">§</span> {mark}
          </p>
          <h2 id={id ? `${id}-title` : undefined} className="card-title">
            {title}
          </h2>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}
