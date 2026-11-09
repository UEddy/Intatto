import { useState } from "react";
import { useServices } from "../app/services";
import { SectionMark } from "../ui/primitives";
import { useChainNow } from "../ui/useNow";
import { useWallet } from "../wallet/WalletProvider";
import { ActionProvider } from "./ActionSheet";
import { KillSwitch } from "./KillSwitch";
import { DepositPanel, LockPanel, ReclaimPanel, WithdrawPanel } from "./MoneyPanels";
import { Overview } from "./Overview";
import { PolicyEditor } from "./PolicyEditor";
import { useConsole } from "./useConsole";
import { ActivityFeed } from "../activity/ActivityFeed";

export function ConsolePage() {
  const { config } = useServices();
  const wallet = useWallet();

  if (!config.vaultId) {
    return (
      <main className="page" id="main">
        <SectionMark>Owner console · {config.label}</SectionMark>
        <h1 className="display display--l">The {config.label.toLowerCase()} vault isn't deployed yet.</h1>
      </main>
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
        </div>
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

function ConnectedConsole({ ownerId, vaultId }: { ownerId: string; vaultId: string }) {
  const c = useConsole(ownerId);
  const [tab, setTab] = useState<"vault" | "activity">("vault");
  const nowNs = useChainNow(c.block.data?.timestampNs, c.block.dataUpdatedAt);
  const v = c.vault.data?.value;
  const chainNow = c.block.data?.timestampNs ?? null;
  const lock = { untilNs: v?.withdrawals_locked_until ? BigInt(v.withdrawals_locked_until) : null, nowNs: chainNow ?? 0n };

  return (
    <main className="page console" id="main">
      <header className="console-head">
        <SectionMark>Owner console</SectionMark>
        <h1 className="display display--l">Your vault</h1>
        <p className="mono console-owner">{ownerId}</p>
      </header>

      <div className="console-tabs seg" role="tablist" aria-label="Console sections">
        <button type="button" role="tab" className="seg-btn" aria-selected={tab === "vault"} onClick={() => setTab("vault")}>
          Vault
        </button>
        <button type="button" role="tab" className="seg-btn" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>
          Activity
        </button>
      </div>

      <div className="console-grid" data-tab={tab}>
        <div className="console-main">
          {v && <KillSwitch vaultId={vaultId} vault={v} />}
          <Overview vault={c.vault.data} tokens={c.tokens} nowNs={nowNs} />
          {c.vault.isError && <p className="notice notice--warn">Could not read the vault: {String(c.vault.error)}</p>}
          {c.vault.isSuccess && (
            <>
              <DepositPanel vaultId={vaultId} ownerId={ownerId} vault={v ?? null} tokens={c.tokens} accountNear={c.account.data?.value.amount ?? null} />
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
        </div>
        <aside className="console-feed" aria-label="Activity">
          <ActivityFeed ownerId={ownerId} vault={v ?? null} />
        </aside>
      </div>
    </main>
  );
}
