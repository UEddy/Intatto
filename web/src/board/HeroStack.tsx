import { useEffect, useState, type ReactNode } from "react";
import { Seal, type SealVariant } from "../ui/Seal";

export type StackCardId = "seal" | "bounty" | "key";

export interface StackCard {
  readonly id: StackCardId;
  /** Name of the card for its control ("Show the seal"). */
  readonly name: string;
  readonly body: ReactNode;
}

const CYCLE_MS = 5200;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The hero's stack of cards, one in front and the others fanned out behind it. Every few seconds
 * the front card moves to the back. It pauses while the reader points at or focuses the stack, or
 * the tab is hidden; with prefers-reduced-motion it never moves on its own. A card is brought
 * forward by clicking it, or by its control below the stack (the keyboard path).
 */
export function HeroStack({ cards, label }: { cards: readonly StackCard[]; label: string }) {
  const [order, setOrder] = useState<StackCardId[]>(() => cards.map((c) => c.id));
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || prefersReducedMotion()) return;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      setOrder((o) => [...o.slice(1), o[0]!]);
    }, CYCLE_MS);
    return () => window.clearInterval(t);
  }, [paused]);

  const front = (id: StackCardId) => setOrder((o) => [id, ...o.filter((x) => x !== id)]);
  const byId = new Map(cards.map((c) => [c.id, c]));

  return (
    <div
      className="stack-wrap"
      role="group"
      aria-label={label}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="stack">
        {cards.map((c) => {
          const depth = order.indexOf(c.id);
          return (
            <div
              key={c.id}
              className={`stack-card stack-card--${c.id}`}
              data-depth={depth}
              aria-hidden={depth !== 0 || undefined}
              onClick={depth === 0 ? undefined : () => front(c.id)}
            >
              {c.body}
            </div>
          );
        })}
      </div>
      <div className="stack-controls">
        {order.length > 1 &&
          cards.map((c) => (
            <button key={c.id} type="button" className="stack-dot" aria-pressed={order[0] === c.id} aria-label={`Show ${byId.get(c.id)!.name}`} onClick={() => front(c.id)} />
          ))}
      </div>
    </div>
  );
}

/** The seal card's face: the wax seal over the vault it guards. */
export function SealFace({ variant, ownerId, vaultId }: { variant: SealVariant; ownerId: string; vaultId: string }) {
  return (
    <div className="stack-face stack-face--seal">
      <Seal variant={variant} size={248} className="seal--hero" />
      <p className="seal-caption mono">
        {ownerId}
        <br />
        on {vaultId}
      </p>
    </div>
  );
}
