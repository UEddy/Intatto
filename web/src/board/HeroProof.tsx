import type { ReactNode } from "react";
import type { IntegrityState } from "../canary/board";
import { durationParts, formatInt } from "../ui/format";
import { Badge, Icon, Skeleton } from "../ui/primitives";

export type ProofTarget = "figures-title" | "attempts-section-title" | "integrity-section-title";

export interface HeroProofProps {
  readonly seal: "intact" | "frozen" | "broken" | "unknown";
  /** The vault balance, already formatted ("0.9976"), or null while it loads. */
  readonly bountyText: string | null;
  /** The status line under the figure: the baseline it is held against, or what broke. */
  readonly status: ReactNode;
  /** Chain time since the run started, null while unknown. */
  readonly intactNs: bigint | null;
  readonly runEnded: boolean;
  /** How much is below the baseline, formatted, when the seal is broken. */
  readonly missingText: string | null;
  /** Attempts signed with the published key: count, whether more exist, and how many went through. */
  readonly attempts: { readonly count: number; readonly more: boolean; readonly through: number } | null;
  readonly attemptsFailed: boolean;
  readonly integrity: IntegrityState;
  readonly onJump: (target: ProofTarget) => void;
}

/**
 * The four facts a first-time visitor needs, above the fold and always visible (the card stack
 * beside it rotates): how much is at stake, how long it has held, how many have tried, and
 * whether the running code is the published code. Each cell jumps to the section that proves it.
 */
export function HeroProof(p: HeroProofProps) {
  const intactParts = p.intactNs !== null ? durationParts(p.intactNs).slice(0, 2) : null;
  const a = p.attempts;
  return (
    <div className={`proof proof--${p.seal}`} aria-label="The canary, live from the chain">
      <button type="button" className="proof-bounty" onClick={() => p.onJump("figures-title")}>
        <span className="proof-head">
          <span className="proof-label">Bounty</span>
          <span className="hero-status" aria-live="polite">
            {p.seal === "unknown" ? (
              <Skeleton size="s" />
            ) : p.seal === "broken" ? (
              <Badge tone="alert">Broken</Badge>
            ) : p.seal === "frozen" ? (
              <Badge tone="frost">Frozen</Badge>
            ) : (
              <Badge tone="ok">Intact</Badge>
            )}
          </span>
        </span>
        <span className="proof-figure">
          {p.bountyText ?? <Skeleton size="l" />}
          <span className="proof-unit">NEAR</span>
        </span>
        <span className="proof-note">{p.status}</span>
      </button>

      <div className="proof-minor">
        <button type="button" className="proof-cell" onClick={() => p.onJump("figures-title")}>
          <span className="proof-label">{p.seal === "broken" ? "Missing" : "Intact for"}</span>
          <span className="proof-value">
            {p.seal === "broken" && p.missingText !== null ? (
              <>
                {p.missingText}
                <span className="proof-small"> NEAR</span>
              </>
            ) : intactParts ? (
              intactParts.map(([n, u]) => (
                <span key={u} className="dur">
                  {n}
                  <span className="proof-small">{u}</span>
                </span>
              ))
            ) : p.runEnded ? (
              "Ended"
            ) : (
              <Skeleton size="s" />
            )}
          </span>
          <span className="proof-sub">{p.seal === "broken" ? "Below the baseline" : p.runEnded ? "Code changed" : intactParts ? "Nothing has left" : " "}</span>
        </button>

        <button type="button" className="proof-cell" onClick={() => p.onJump("attempts-section-title")}>
          <span className="proof-label">Attempts</span>
          <span className="proof-value">{a ? formatInt(a.count) + (a.more ? "+" : "") : p.attemptsFailed ? "?" : <Skeleton size="s" />}</span>
          <span className="proof-sub">{a === null ? " " : a.count === 0 ? "None yet" : a.through === 0 ? "All refused" : `${formatInt(a.through)} got through`}</span>
        </button>

        <button type="button" className="proof-cell" onClick={() => p.onJump("integrity-section-title")}>
          <span className="proof-label">Code</span>
          <span className={`proof-value proof-code proof-code--${p.integrity}`}>
            {p.integrity === "matches" ? (
              <>
                <Icon name="check" size={20} /> Verified
              </>
            ) : p.integrity === "changed" ? (
              "Changed"
            ) : p.integrity === "unconfigured" ? (
              "No build"
            ) : (
              <Skeleton size="s" />
            )}
          </span>
          <span className="proof-sub">{p.integrity === "matches" ? "Matches published build" : p.integrity === "changed" ? "Not the published build" : " "}</span>
        </button>
      </div>
    </div>
  );
}
