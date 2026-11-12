import { useRef, useState, type ReactNode } from "react";
import { useServices } from "../app/services";
import { boardState, integrityState, runStartOf } from "../canary/board";
import { formatNear } from "../near/units";
import { durationParts, formatDateTime, formatDuration, formatDurationWords, formatInt, formatShortDate, formatUtc, shorten } from "../ui/format";
import { Badge, Icon, RawRow, SectionMark, Skeleton, Traceable, TxLink } from "../ui/primitives";
import { Reveal } from "../ui/Reveal";
import { Tabs } from "../ui/Tabs";
import { Ticker } from "../ui/Ticker";
import { useChainNow } from "../ui/useNow";
import { AgentKeyCard } from "./AgentKeyCard";
import { AttemptLog, canarySubject, demoSubject } from "./AttemptLog";
import { Faq } from "./Faq";
import { HeroStack, SealFace } from "./HeroStack";
import { IntegrityCheck } from "./IntegrityCheck";
import { RulesPanel } from "./RulesPanel";
import { TryItSnippet } from "./TryItSnippet";
import { BOARD_POLL_MS, useBoard } from "./useBoard";
import { WhyItMatters } from "./WhyItMatters";

type TabId = "try" | "key" | "rules";

/** A section's heading: a plain lead and a muted italic continuation, as in the hero. */
function SectionHead({ id, lead, rest }: { id: string; lead: string; rest: string }) {
  return (
    <h2 id={id} className="section-head display">
      {lead} <em>{rest}</em>
    </h2>
  );
}

function Section({ id, lead, rest, children, className }: { id: string; lead: string; rest: string; children: ReactNode; className?: string }) {
  return (
    <Reveal as="section" className={`board-section${className ? ` ${className}` : ""}`} aria-labelledby={id}>
      <SectionHead id={id} lead={lead} rest={rest} />
      <div className="frame">{children}</div>
    </Reveal>
  );
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function BoardPage() {
  const { config } = useServices();
  const b = useBoard();
  const nowNs = useChainNow(b.block.data?.timestampNs, b.block.dataUpdatedAt);
  const [tab, setTab] = useState<TabId>("try");
  const tryRef = useRef<HTMLDivElement>(null);

  if (!b.enabled || !b.canary || !b.vaultId) {
    return (
      <main className="page board board--empty" id="main">
        <SectionMark>Break-price board · {config.label}</SectionMark>
        <h1 className="display display--l">The {config.label.toLowerCase()} canary isn't live yet.</h1>
        <p className="lede">
          When it is, this page will show its vault, its published agent key and every attempt to break it. The testnet canary is running now.
        </p>
      </main>
    );
  }

  const canary = b.canary;
  const baseline = b.baseline.data?.ok ? b.baseline.data.check : null;
  // The later of the verified deployment and the verified setup (runStartOf).
  const runStart = runStartOf(b.run.data?.ok ? b.run.data.start : null, baseline);
  const runTxHash = runStart?.by === "setup" ? canary.baseline.txHash : canary.run?.deployTxHash;
  const startProblem = b.run.data && !b.run.data.ok ? `The run's start transaction failed its check (${b.run.data.problem}).` : b.baseline.data && !b.baseline.data.ok ? `The setup transaction failed its check (${b.baseline.data.problem}).` : null;
  const integrity = integrityState(b.code.isSuccess ? (b.code.data?.value.codeHash ?? null) : undefined, config.expectedBuild?.codeHash ?? null);
  const codeChanged = canary.run !== null && b.code.isSuccess && b.code.data?.value.codeHash !== canary.run.codeHash;
  const state = boardState({
    vault: b.vault.data?.value,
    baselineYocto: BigInt(canary.baseline.balanceYocto),
    baseline,
    runStart,
    codeChanged,
    nowNs: b.block.data?.timestampNs ?? null,
  });
  const frozen = b.vault.data?.value?.frozen === true;
  const baselineYocto = BigInt(canary.baseline.balanceYocto);
  const sealVariant = state.seal === "unknown" ? "unknown" : state.seal === "broken" ? "broken" : frozen ? "frozen" : "intact";
  const missingYocto = state.seal === "broken" ? baselineYocto - (state.bountyYocto ?? 0n) : null;
  // Ticks between polls from the chain time of the last read; boardState decides whether it counts.
  const unbrokenNs = state.unbrokenForNs !== null && runStart && nowNs !== null ? nowNs - runStart.atNs : null;
  // The bounty and baseline headline figures: rounded down to 4 decimals, no ellipsis; the exact
  // amounts are in the source row and the baseline's note.
  const FIGURE = { maxFraction: 4, mark: false } as const;
  const lockLeftNs = state.lockedUntilNs !== null && nowNs !== null ? state.lockedUntilNs - nowNs : null;
  const attempts = b.attempts.data?.attempts;
  const vaultSource = b.vault.data?.source;
  const bountyText = state.bountyYocto !== null ? formatNear(state.bountyYocto, FIGURE) : null;
  const keyPerm = b.agentKey.data?.value.permission;
  const keyFc = keyPerm && keyPerm !== "FullAccess" ? keyPerm.FunctionCall : null;
  const keyScoped = keyFc !== null && keyFc.receiver_id === b.vaultId && keyFc.method_names.every((m) => m === "agent_spend" || m === "agent_swap");

  const openTry = () => {
    setTab("try");
    tryRef.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  };

  const tickerItems: ReactNode[] = [
    <>
      <span className={`ticker-dot ticker-dot--${state.seal === "broken" ? "broken" : "live"}`} aria-hidden="true" />
      {config.label} canary {state.seal === "broken" ? "broken" : "live"}
    </>,
    <>
      Bounty <strong className="mono">{bountyText ?? "…"}</strong> NEAR
    </>,
    state.seal === "broken" ? (
      <>Seal broken: below the baseline</>
    ) : state.runEnded ? (
      <>Run ended: the code changed</>
    ) : (
      <>
        Intact for <strong className="mono">{unbrokenNs !== null ? formatDuration(unbrokenNs) : "…"}</strong>
      </>
    ),
    <>
      <strong className="mono">{attempts ? formatInt(attempts.length) + (b.attempts.data?.more ? "+" : "") : "…"}</strong> attempts with the published key
    </>,
    state.lockedUntilNs !== null ? (
      <>
        Withdrawals locked until <strong>{formatShortDate(state.lockedUntilNs)}</strong>
      </>
    ) : (
      <>Withdrawals not locked</>
    ),
    integrity === "matches" ? <>Code matches the published build</> : integrity === "changed" ? <strong>Code changed</strong> : <>Checking the code hash…</>,
    <>Every rule enforced on chain</>,
  ];

  return (
    <main className="page board" id="main">
      <Ticker label={`${config.label} canary, live`} items={tickerItems} />

      <section className="board-hero" aria-labelledby="board-title">
        <div className="board-hero-text">
          <SectionMark>Break-price board · {config.label} canary</SectionMark>
          <h1 id="board-title" className="display display--hero">
            The key is public.
            <br />
            <em>{state.seal === "broken" ? "The seal is broken." : "The money is still here."}</em>
          </h1>
          <p className="lede">
            This vault's agent key is published. Anyone can sign with it. The vault contract's policy lets that key move nothing, and this page shows, live from the
            chain, whether that is still true.
          </p>
          <div className="hero-status" aria-live="polite">
            {state.seal === "unknown" ? (
              <Skeleton size="l" />
            ) : state.seal === "broken" ? (
              <>
                <Badge tone="alert">Broken</Badge>
                <span>{state.breaks.join(" ")}</span>
              </>
            ) : (
              <>
                {frozen ? <Badge tone="frost">Frozen</Badge> : <Badge tone="ok">Intact</Badge>}
                <span>
                  {frozen ? "Frozen by its owner. " : ""}Balance at or above the {formatNear(baselineYocto, FIGURE)} NEAR baseline
                  {vaultSource ? <> as of block <span className="mono">{formatInt(vaultSource.blockHeight)}</span></> : null}.
                </span>
              </>
            )}
          </div>
          <div className="hero-actions">
            <button type="button" className="btn btn--ink" onClick={openTry}>
              Try to break it <Icon name="arrow" size={16} />
            </button>
            <a className="btn btn--quiet" href={`${config.repoUrl}/blob/master/THREAT_MODEL.md`} target="_blank" rel="noopener noreferrer">
              Threat model <Icon name="external" size={14} />
            </a>
          </div>
        </div>
        <div className="board-hero-stack">
          <HeroStack
            label="The canary at a glance"
            cards={[
              { id: "seal", name: "the seal", body: <SealFace variant={sealVariant} ownerId={canary.ownerId} vaultId={b.vaultId} /> },
              {
                id: "bounty",
                name: "the bounty",
                body: (
                  <div className="stack-face stack-face--figure">
                    <p className="stack-label">Bounty</p>
                    <p className="stack-value">
                      {bountyText ?? "…"}
                      <span className="stack-unit">NEAR</span>
                    </p>
                    <p className="stack-note">Everything in the canary vault. Take it and it's yours.</p>
                  </div>
                ),
              },
              {
                id: "key",
                name: "the published key",
                body: (
                  <div className="stack-face stack-face--key">
                    <p className="stack-label">
                      <Icon name="key" size={14} /> Published agent key
                    </p>
                    <p className="stack-key mono">{shorten(canary.agentPublicKey, 18, 8)}</p>
                    <p className="stack-note">
                      {b.agentKey.isPending ? (
                        "Reading its permission…"
                      ) : keyScoped ? (
                        <>
                          <Badge tone="ok">Scoped</Badge> Calls <span className="mono">agent_spend</span> and <span className="mono">agent_swap</span> on the vault, nothing else.
                        </>
                      ) : (
                        <>
                          <Badge tone="warn">Changed</Badge> Its permission is not what was published. See the key below.
                        </>
                      )}
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </section>

      {state.warnings.length > 0 && (
        <aside className="notice notice--warn" role="note">
          <strong>Setup changed.</strong> {state.warnings.join(" ")}
        </aside>
      )}

      <Section id="figures-title" lead="The bounty, read from the chain." rest="Every figure shows the call that produced it.">
        <div className="headline-figures">
          <article className="hfig">
            <h3 className="hfig-label">Bounty</h3>
            <Traceable source={vaultSource} path=".balance" extra={<RawRow label="Raw" value={`${b.vault.data?.value?.balance ?? "…"} yocto`} />}>
              <p className="hfig-value">
                {bountyText ?? <Skeleton />}
                <span className="hfig-unit">NEAR</span>
              </p>
            </Traceable>
            <p className="hfig-note">Everything in the canary vault. Take it and it's yours.</p>
          </article>

          {missingYocto !== null ? (
            <article className="hfig hfig--alert">
              <h3 className="hfig-label">Missing</h3>
              <Traceable source={vaultSource} path=".balance" extra={<RawRow label="Baseline" value={`${canary.baseline.balanceYocto} yocto`} />}>
                <p className="hfig-value">
                  {formatNear(missingYocto, { maxFraction: 4 })}
                  <span className="hfig-unit">NEAR</span>
                </p>
              </Traceable>
              <p className="hfig-note">Below the baseline set at setup. See the log for the transaction that took it.</p>
            </article>
          ) : (
            <article className="hfig">
              <h3 className="hfig-label">Intact for</h3>
              <Traceable
                source={runStart ? { rpcMethod: "block", target: runStart.blockHash, raw: runStart.atNs.toString(), blockHeight: runStart.blockHeight, blockHash: runStart.blockHash } : undefined}
                extra={runStart && runTxHash ? <RawRow label="Run tx" value={<TxLink hash={runTxHash} />} /> : undefined}
              >
                <p className="hfig-value" aria-label={unbrokenNs !== null ? formatDuration(unbrokenNs) : undefined}>
                  {unbrokenNs !== null ? (
                    durationParts(unbrokenNs).map(([n, u]) => (
                      <span key={u} className="dur">
                        {n}
                        <span className="dur-unit">{u}</span>
                      </span>
                    ))
                  ) : state.runEnded ? (
                    "Ended"
                  ) : startProblem ? (
                    "Unverified"
                  ) : (
                    <Skeleton />
                  )}
                </p>
              </Traceable>
              <p className="hfig-note">
                {state.runEnded ? (
                  "This run ended: the vault's code changed after it started. That is not a break; a new run starts from the next verified build."
                ) : runStart ? (
                  runStart.by === "setup" ? (
                    <>Since the canary was set up on the published build, {formatDateTime(runStart.atNs)}.</>
                  ) : (
                    <>Since this run started with the upgrade to the published build, {formatDateTime(runStart.atNs)}.</>
                  )
                ) : startProblem ? (
                  startProblem
                ) : (
                  "Counting from the start of this run."
                )}
              </p>
            </article>
          )}
        </div>

        <div className="minor-figures" aria-label="Lock, attempts and baseline">
          <article className="mfig">
            <h3 className="mfig-label">Lock expires</h3>
            <Traceable source={vaultSource} path=".withdrawals_locked_until" extra={state.lockedUntilNs !== null ? <RawRow label="UTC" value={formatUtc(state.lockedUntilNs)} /> : undefined}>
              <p className="mfig-value">{state.lockedUntilNs !== null ? formatShortDate(state.lockedUntilNs) : b.vault.isSuccess ? "Never locked" : <Skeleton />}</p>
            </Traceable>
            <p className="mfig-note">
              {lockLeftNs === null ? "" : lockLeftNs > 0n ? `In ${formatDurationWords(lockLeftNs)}. Until then not even the owner can withdraw.` : "Expired; the owner can withdraw again."}
            </p>
          </article>
          <article className="mfig">
            <h3 className="mfig-label">Attempts</h3>
            <p className="mfig-value">{attempts ? formatInt(attempts.length) + (b.attempts.data?.more ? "+" : "") : b.attempts.isError ? "Unavailable" : <Skeleton size="s" />}</p>
            <p className="mfig-note">
              {attempts === undefined
                ? "Signed with the published key."
                : attempts.length === 0
                  ? "Nobody has tried yet."
                  : attempts.every((a) => a.outcome.kind !== "succeeded")
                    ? "Every one refused by the contract."
                    : "Some went through. See the log."}
            </p>
          </article>
          <article className="mfig">
            <h3 className="mfig-label">Baseline</h3>
            <p className="mfig-value">
              {formatNear(baselineYocto, FIGURE)} <span className="mfig-unit">NEAR</span>
            </p>
            <p className="mfig-note">
              Exactly <span className="mono">{canary.baseline.balanceYocto}</span> yocto, set by <TxLink hash={canary.baseline.txHash} />, the last setup transaction.
            </p>
          </article>
        </div>
      </Section>

      <Section id="attempts-section-title" lead="Every attempt, live." rest="Signed with the published key, judged by the contract.">
        <div className="frame-stack">
          <AttemptLog query={b.attempts} subject={canarySubject(canary)} />
          {b.demo && <AttemptLog query={b.demoAttempts} subject={demoSubject(b.demo)} />}
        </div>
      </Section>

      <Reveal as="section" className="board-section" aria-labelledby="try-section-title">
        <SectionHead id="try-section-title" lead="Try to break it." rest="Or read the rules first." />
        <div className="frame frame--tabs" ref={tryRef}>
          <Tabs
            label="Try it, the key, the rules"
            active={tab}
            onChange={(id) => setTab(id as TabId)}
            tabs={[
              { id: "try", title: "Try it", panel: <TryItSnippet canary={canary} vaultId={b.vaultId} amountYocto={b.vault.data?.value?.balance ?? canary.baseline.balanceYocto} /> },
              { id: "key", title: "The key", panel: <AgentKeyCard query={b.agentKey} canary={canary} vaultId={b.vaultId} /> },
              { id: "rules", title: "The rules", panel: <RulesPanel canary={canary} rulesUrl={canary.privateKeyUrl} networkId={config.networkId} /> },
            ]}
          />
        </div>
      </Reveal>

      <Section id="integrity-section-title" lead="Judge the code, not the claim." rest={`Its hash is checked every ${BOARD_POLL_MS / 1000} seconds.`}>
        <IntegrityCheck state={integrity} code={b.code} sourceMeta={b.sourceMeta} />
        <div className="statement">
          <Icon name="key" size={22} />
          <div>
            <h3 className="statement-title">The deployer keeps the upgrade key.</h3>
            <p>
              So the funds in this hackathon deployment stay recoverable if something goes wrong. It also means the contract's code can change. If it does, its code hash
              changes, and the integrity check above shows <strong>CODE CHANGED</strong> within {BOARD_POLL_MS / 1000} seconds. Judge the vault by the code that is
              running, not by what anyone says.
            </p>
          </div>
        </div>
      </Section>

      <Section id="why-title" lead="Why it matters." rest="Most trading bots hold your key.">
        <WhyItMatters />
      </Section>

      <Section id="faq-title" lead="Questions." rest="Before you try.">
        <Faq
          networkId={config.networkId}
          baselineNear={formatNear(baselineYocto)}
          lockText={state.lockedUntilNs !== null && (lockLeftNs === null || lockLeftNs > 0n) ? formatShortDate(state.lockedUntilNs) : null}
          rpcHost={new URL(config.rpcUrl).host}
          rulesUrl={canary.privateKeyUrl}
        />
      </Section>

      <Reveal as="section" className="board-cta" aria-labelledby="cta-title">
        <h2 id="cta-title" className="display display--l">
          The key is public. <em>Take the money if you can.</em>
        </h2>
        <div className="hero-actions">
          <button type="button" className="btn btn--ink" onClick={openTry}>
            Try to break it <Icon name="arrow" size={16} />
          </button>
          {canary.privateKeyUrl && (
            <a className="btn btn--quiet" href={canary.privateKeyUrl} target="_blank" rel="noopener noreferrer">
              Read CANARY.md <Icon name="external" size={14} />
            </a>
          )}
        </div>
      </Reveal>

      {b.block.data && (
        <p className="board-footnote mono">
          Chain time {formatUtc(b.block.data.timestampNs)} · final block {formatInt(b.block.data.height)}
        </p>
      )}
    </main>
  );
}
