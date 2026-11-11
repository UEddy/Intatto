import { useServices } from "../app/services";
import { boardState, integrityState, runStartOf } from "../canary/board";
import { formatNear } from "../near/units";
import { durationParts, formatDateTime, formatDuration, formatDurationWords, formatInt, formatShortDate, formatUtc } from "../ui/format";
import { Badge, Icon, RawRow, SectionMark, Skeleton, Traceable, TxLink } from "../ui/primitives";
import { Seal } from "../ui/Seal";
import { useChainNow } from "../ui/useNow";
import { AgentKeyCard } from "./AgentKeyCard";
import { AttemptLog, canarySubject, demoSubject } from "./AttemptLog";
import { IntegrityCheck } from "./IntegrityCheck";
import { RulesPanel } from "./RulesPanel";
import { TryItSnippet } from "./TryItSnippet";
import { BOARD_POLL_MS, useBoard } from "./useBoard";

export function BoardPage() {
  const { config } = useServices();
  const b = useBoard();
  const nowNs = useChainNow(b.block.data?.timestampNs, b.block.dataUpdatedAt);

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
  const lockLeftNs = state.lockedUntilNs !== null && nowNs !== null ? state.lockedUntilNs - nowNs : null;
  const attempts = b.attempts.data?.attempts;
  const vaultSource = b.vault.data?.source;

  return (
    <main className="page board" id="main">
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
                  {frozen ? "Frozen by its owner. " : ""}Balance at or above the {formatNear(baselineYocto, { maxFraction: 4 })} NEAR baseline
                  {vaultSource ? <> as of block <span className="mono">{formatInt(vaultSource.blockHeight)}</span></> : null}.
                </span>
              </>
            )}
          </div>
          <div className="hero-actions">
            <a className="btn btn--ink" href="#try-it">
              Try to break it <Icon name="arrow" size={16} />
            </a>
            <a className="btn btn--quiet" href={`${config.repoUrl}/blob/master/THREAT_MODEL.md`} target="_blank" rel="noopener noreferrer">
              Threat model <Icon name="external" size={14} />
            </a>
          </div>
        </div>
        <div className="board-hero-seal">
          <Seal variant={sealVariant} size={360} className="seal--hero" />
          <p className="seal-caption mono">
            {canary.ownerId}
            <br />
            on {b.vaultId}
          </p>
        </div>
      </section>

      {state.warnings.length > 0 && (
        <aside className="notice notice--warn" role="note">
          <strong>Setup changed.</strong> {state.warnings.join(" ")}
        </aside>
      )}

      <section className="headline-figures" aria-label="The bounty and how long it has held">
        <article className="hfig">
          <h2 className="hfig-label">Bounty</h2>
          <Traceable source={vaultSource} path=".balance" extra={<RawRow label="Raw" value={`${b.vault.data?.value?.balance ?? "…"} yocto`} />}>
            <p className="hfig-value">
              {state.bountyYocto !== null ? formatNear(state.bountyYocto, { maxFraction: 4 }) : <Skeleton />}
              <span className="hfig-unit">NEAR</span>
            </p>
          </Traceable>
          <p className="hfig-note">Everything in the canary vault. Take it and it's yours.</p>
        </article>

        {missingYocto !== null ? (
          <article className="hfig hfig--alert">
            <h2 className="hfig-label">Missing</h2>
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
            <h2 className="hfig-label">Intact for</h2>
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
                ) : state.runEnded || startProblem ? (
                  "—"
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
      </section>

      <section className="minor-figures" aria-label="Lock, attempts and baseline">
        <article className="mfig">
          <h2 className="mfig-label">Lock expires</h2>
          <Traceable source={vaultSource} path=".withdrawals_locked_until" extra={state.lockedUntilNs !== null ? <RawRow label="UTC" value={formatUtc(state.lockedUntilNs)} /> : undefined}>
            <p className="mfig-value">{state.lockedUntilNs !== null ? formatShortDate(state.lockedUntilNs) : b.vault.isSuccess ? "Never locked" : <Skeleton />}</p>
          </Traceable>
          <p className="mfig-note">
            {lockLeftNs === null ? "" : lockLeftNs > 0n ? `In ${formatDurationWords(lockLeftNs)}. Until then not even the owner can withdraw.` : "Expired; the owner can withdraw again."}
          </p>
        </article>
        <article className="mfig">
          <h2 className="mfig-label">Attempts</h2>
          <p className="mfig-value">{attempts ? formatInt(attempts.length) + (b.attempts.data?.more ? "+" : "") : b.attempts.isError ? "—" : <Skeleton size="s" />}</p>
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
          <h2 className="mfig-label">Baseline</h2>
          <p className="mfig-value">
            {formatNear(baselineYocto, { maxFraction: 4 })} <span className="mfig-unit">NEAR</span>
          </p>
          <p className="mfig-note">
            Set by <TxLink hash={canary.baseline.txHash} />, the last setup transaction.
          </p>
        </article>
      </section>

      <div className="board-grid">
        <div className="board-main">
          <AttemptLog query={b.attempts} subject={canarySubject(canary)} />
          {b.demo && <AttemptLog query={b.demoAttempts} subject={demoSubject(b.demo)} />}
          {attempts !== undefined && attempts.length === 0 && <RulesPanel canary={canary} rulesUrl={canary.privateKeyUrl} networkId={config.networkId} />}
        </div>
        <div className="board-side">
          <AgentKeyCard query={b.agentKey} canary={canary} vaultId={b.vaultId} />
          <TryItSnippet canary={canary} vaultId={b.vaultId} amountYocto={b.vault.data?.value?.balance ?? canary.baseline.balanceYocto} />
        </div>
      </div>

      <IntegrityCheck state={integrity} code={b.code} sourceMeta={b.sourceMeta} />

      <section className="statement" aria-labelledby="upgrade-key">
        <Icon name="key" size={22} />
        <div>
          <h2 id="upgrade-key" className="statement-title">
            The deployer keeps the upgrade key.
          </h2>
          <p>
            So the funds in this hackathon deployment stay recoverable if something goes wrong. It also means the contract's code can change. If it does, its code hash
            changes, and the integrity check above shows <strong>CODE CHANGED</strong> within {BOARD_POLL_MS / 1000} seconds. Judge the vault by the code that is running, not by
            what anyone says.
          </p>
        </div>
      </section>

      {b.block.data && (
        <p className="board-footnote mono">
          Chain time {formatUtc(b.block.data.timestampNs)} · final block {formatInt(b.block.data.height)}
        </p>
      )}
    </main>
  );
}
