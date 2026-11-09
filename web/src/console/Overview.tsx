import type { VaultView } from "../contract/abi.gen";
import type { Sourced } from "../near/chain";
import { formatNear, formatUnits } from "../near/units";
import { windowUsage } from "../activity/window";
import { formatDateTime, formatDurationWords, formatInt, formatUtc } from "../ui/format";
import { AccountLink, Badge, RawRow, Skeleton, Traceable } from "../ui/primitives";
import type { TokenState } from "./useConsole";

export function Overview({ vault, tokens, nowNs }: { vault: Sourced<VaultView | null> | undefined; tokens: TokenState[]; nowNs: bigint | null }) {
  const v = vault?.value ?? null;
  const source = vault?.source;
  const lockUntil = v?.withdrawals_locked_until ? BigInt(v.withdrawals_locked_until) : null;
  const locked = lockUntil !== null && nowNs !== null && nowNs < lockUntil;
  const usage = v && nowNs !== null ? windowUsage(v.recent_spends, nowNs, null) : null;

  return (
    <section className="overview" aria-label="Vault overview">
      <div className="ledger-figures">
        <div className="lfig lfig--lead">
          <p className="lfig-label">NEAR in vault</p>
          <Traceable source={source} path=".balance" extra={v ? <RawRow label="Raw" value={`${v.balance} yocto`} /> : undefined}>
            <p className="lfig-value">
              {vault === undefined ? <Skeleton /> : formatNear(v ? BigInt(v.balance) : 0n, { maxFraction: 4 })}
              <span className="lfig-unit">NEAR</span>
            </p>
          </Traceable>
        </div>
        {tokens.map((t) => {
          const entry = v?.tokens.find((x) => x.token_id === t.id);
          const bal = entry ? BigInt(entry.balance) : 0n;
          const onEx = entry ? BigInt(entry.on_exchange) : 0n;
          return (
            <div className="lfig" key={t.id}>
              <p className="lfig-label">{t.info?.symbol ?? t.id}</p>
              <Traceable source={source} path={`.tokens[${t.id}].balance`} extra={entry ? <RawRow label="Raw" value={`${entry.balance} (${t.info?.decimals ?? "?"} decimals)`} /> : undefined}>
                <p className="lfig-value">
                  {vault === undefined || !t.info ? <Skeleton /> : formatUnits(bal, t.info.decimals, { maxFraction: 4 })}
                  <span className="lfig-unit">{t.info?.symbol ?? ""}</span>
                </p>
              </Traceable>
              {onEx > 0n && t.info && (
                <p className="lfig-note">
                  + {formatUnits(onEx, t.info.decimals, { maxFraction: 4 })} held on the exchange, reclaimable below
                </p>
              )}
            </div>
          );
        })}
      </div>

      <dl className="status-rows">
        <div>
          <dt>State</dt>
          <dd>{v === null ? <span className="muted">No vault yet</span> : !v ? <Skeleton /> : v.frozen ? <Badge tone="frost">Frozen</Badge> : <Badge tone="ok">Active</Badge>}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{v?.agent_id ? <AccountLink id={v.agent_id} /> : v ? <span className="muted">None: nothing can spend</span> : <Skeleton />}</dd>
        </div>
        <div>
          <dt>Withdrawals</dt>
          <dd>
            {!v ? (
              v === null ? "—" : <Skeleton />
            ) : locked ? (
              <>
                <Badge tone="warn">Locked</Badge> until {formatDateTime(lockUntil!)}, in {formatDurationWords(lockUntil! - nowNs!)}
                <span className="mono status-raw"> ({formatUtc(lockUntil!)})</span>
              </>
            ) : lockUntil !== null ? (
              <>Open (a lock ended {formatDateTime(lockUntil)})</>
            ) : (
              "Open"
            )}
          </dd>
        </div>
        <div>
          <dt>Last 24 hours</dt>
          <dd>
            {usage && v ? (
              <>
                {usage.count} of {v.policy.max_spends_per_24h} agent actions
                {usage.total > 0n ? `, ${formatNear(usage.total)} NEAR paid` : ""}
                {v.recent_spends.length > usage.count ? <span className="muted"> · {v.recent_spends.length - usage.count} older entries no longer count</span> : null}
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      {source && (
        <p className="overview-source mono">
          get_vault at block {formatInt(source.blockHeight)}
          {nowNs !== null ? <> · chain time {formatUtc(nowNs)}</> : null}
        </p>
      )}
    </section>
  );
}
