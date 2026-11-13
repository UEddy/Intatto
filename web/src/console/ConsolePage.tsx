import { useState } from "react";
import { useSearchParams } from "react-router";
import { useServices } from "../app/services";
import { SectionMark } from "../ui/primitives";
import { useChainNow } from "../ui/useNow";
import { useWallet } from "../wallet/WalletProvider";
import { ActionProvider } from "./ActionSheet";
import { ReadOnlyContext } from "./readOnly";
import { KillSwitch } from "./KillSwitch";
import { NextSteps } from "./NextSteps";
import { SetupProgress } from "./SetupProgress";
import { PASSKEY_LOCK_ADVICE } from "../wallet/passkey";
import { DepositPanel, LockPanel, ReclaimPanel, WithdrawPanel } from "./MoneyPanels";
import { Overview } from "./Overview";
import { PolicyEditor } from "./PolicyEditor";
import { useConsole } from "./useConsole";
import { ActivityFeed } from "../activity/ActivityFeed";

export function ConsolePage() {
  const { config } = useServices();
  const wallet = useWallet();
  const [params] = useSearchParams();
  const live = config.liveVaultOwner;

  if (!config.vaultId) {
    return (
      <main className="page" id="main">
        <SectionMark>Owner console · {config.label}</SectionMark>
        <h1 className="display display--l">The {config.label.toLowerCase()} vault isn't deployed yet.</h1>
      </main>
    );
  }
  // "See a live vault": anyone may view this owner's console, read-only. It signs nothing.
  if (live && params.get("view") === "live") {
    return (
      <ReadOnlyContext.Provider value={true}>
        <ActionProvider readOnly>
          <ConnectedConsole ownerId={live} vaultId={config.vaultId} readOnly />
        </ActionProvider>
      </ReadOnlyContext.Provider>
    );
  }
  if (wallet.status !== "connected" || !wallet.accountId) {
    return (
      <main className="page console-intro" id="main">
        <SectionMark>Owner console · {config.label}</SectionMark>
        <h1 className="display display--l">Your vault, your rules.</h1>
        <p className="lede">
          Connect the account that owns the vault. You can deposit, set what your agent may do, freeze it in one click, and see every attempt it made, allowed or not. The
          rules are enforced by the vault contract on chain; this page only reads and asks your wallet to sign.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn--ink" onClick={() => void wallet.connect()} disabled={wallet.status === "connecting" || wallet.status === "restoring"}>
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
          {live && (
            <a className="btn btn--quiet" href="#/vault?view=live">
              See a live vault
            </a>
          )}
        </div>
        {live && (
          <p className="muted small console-intro-note">
            A live vault opens <span className="mono">{live}</span> on {config.label.toLowerCase()} read-only: its balances, its policy and every agent call, allowed or
            refused. It signs nothing.
          </p>
        )}
        {wallet.error && <p className="field-hint field-hint--error">{wallet.error}</p>}
      </main>
    );
  }
  return (
    <ActionProvider>
      <ConnectedConsole ownerId={wallet.accountId} vaultId={config.vaultId} />
    </ActionProvider>
  );
}

function ConnectedConsole({ ownerId, vaultId, readOnly = false }: { ownerId: string; vaultId: string; readOnly?: boolean }) {
  const c = useConsole(ownerId);
  const wallet = useWallet();
  const { session } = wallet;
  const { config } = useServices();
  const [tab, setTab] = useState<"vault" | "activity">("vault");
  const nowNs = useChainNow(c.block.data?.timestampNs, c.block.dataUpdatedAt);
  const v = c.vault.data?.value;
  const chainNow = c.block.data?.timestampNs ?? null;
  const lock = { untilNs: v?.withdrawals_locked_until ? BigInt(v.withdrawals_locked_until) : null, nowNs: chainNow ?? 0n };

  return (
    <main className="page console" id="main">
      <header className="console-head">
        <SectionMark>{readOnly ? `A live vault · ${config.label}` : "Owner console"}</SectionMark>
        <h1 className="display display--l">{readOnly ? "A live vault, read-only" : "Your vault"}</h1>
        <p className="mono console-owner">{ownerId}</p>
      </header>
      {readOnly && (
        <aside className="notice readonly-note" id="readonly-note" role="note">
          <p>
            <strong>Read-only.</strong> This is <span className="mono">{ownerId}</span>'s vault, read live from {config.label.toLowerCase()}: its balances, its policy and
            every agent call, allowed or refused. Owner actions are shown but disabled. Connect the owner's wallet to change this. This view signs nothing and holds
            no keys.
          </p>
          <div className="hero-actions">
            <a className="btn btn--quiet btn--small" href="#/vault">
              Back
            </a>
          </div>
        </aside>
      )}
      {!readOnly && session.notice && (
        <aside className="notice notice--warn" role="note" aria-label="Passkey wallet">
          <strong>{session.notice}</strong> {PASSKEY_LOCK_ADVICE} <a href="#lock">Lock withdrawals</a>.
        </aside>
      )}

      {/* The owner's setup checklist, read from the chain; gone once the required steps are done. */}
      {!readOnly && c.vault.isSuccess && (
        <SetupProgress vault={v ?? null} vaultId={vaultId} lockActive={lock.untilNs !== null && chainNow !== null && lock.untilNs > chainNow} />
      )}

      {/* What happens next: always on a live vault viewed read-only; for the owner, once the vault
          exists and until its agent has been set and has acted. Outside the owner controls, so its
          copy button works read-only too. It signs nothing. */}
      {v && (readOnly || v.agent_id == null || v.recent_spends.length === 0) && (
        <NextSteps vault={v} vaultId={vaultId} network={config.networkId} repoUrl={config.repoUrl} readOnly={readOnly} ownerId={ownerId} />
      )}

      <div className="console-tabs seg" role="tablist" aria-label="Console sections">
        <button type="button" role="tab" className="seg-btn" aria-selected={tab === "vault"} onClick={() => setTab("vault")}>
          Vault
        </button>
        <button type="button" role="tab" className="seg-btn" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>
          Activity
        </button>
      </div>

      <div className="console-grid" data-tab={tab}>
        {/* Read-only: a disabled fieldset disables every owner control inside it, natively. */}
        <fieldset className="console-main console-fieldset" disabled={readOnly} aria-describedby={readOnly ? "readonly-note" : undefined}>
          {v && <KillSwitch vaultId={vaultId} vault={v} />}
          <Overview vault={c.vault.data} tokens={c.tokens} nowNs={nowNs} />
          {c.vault.isError && <p className="notice notice--warn">Could not read the vault: {String(c.vault.error)}</p>}
          {c.vault.isSuccess && (
            <>
              <DepositPanel vaultId={vaultId} ownerId={ownerId} vault={v ?? null} tokens={c.tokens} accountNear={c.account.data?.value.amount ?? null} gasSponsored={session.gasSponsored} />
              {v && chainNow !== null && (
                <>
                  {/* Every configured token's metadata first: a missing row would silently drop that token's caps. */}
                  {c.tokens.every((t) => t.info) ? (
                    <PolicyEditor vaultId={vaultId} vault={v} tokens={c.tokens} lock={lock} />
                  ) : (
                    <p className="notice">Loading token details (decimals and symbols) before the policy can be edited…</p>
                  )}
                  <WithdrawPanel vaultId={vaultId} ownerId={ownerId} vault={v} tokens={c.tokens} lock={lock} />
                  <ReclaimPanel vaultId={vaultId} vault={v} tokens={c.tokens} ledgerOf={c.ledgerOf} />
                  <LockPanel vaultId={vaultId} lock={lock} />
                </>
              )}
            </>
          )}
        </fieldset>
        <aside className="console-feed" aria-label="Activity">
          <ActivityFeed ownerId={ownerId} vault={v ?? null} readOnly={readOnly} />
        </aside>
      </div>
    </main>
  );
}
