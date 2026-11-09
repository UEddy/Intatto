import { useState } from "react";
import type { VaultView } from "../contract/abi.gen";
import type { ExchangeLedger } from "../contract/abi.gen";
import { formatNear, formatUnits, NEAR_DECIMALS } from "../near/units";
import { formatDateTime, formatUtc } from "../ui/format";
import { useAction } from "./ActionSheet";
import { AmountField, Panel, parsedOrZero } from "./fields";
import * as I from "./intents";
import type { TokenState } from "./useConsole";

/** Leave this much NEAR in the owner's account for gas when offering "Max". */
const GAS_RESERVE = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

type Asset = "near" | string;

function AssetTabs({ value, onChange, tokens, label }: { value: Asset; onChange: (a: Asset) => void; tokens: TokenState[]; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      <button type="button" role="tab" aria-selected={value === "near"} className="seg-btn" onClick={() => onChange("near")}>
        NEAR
      </button>
      {tokens.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className="seg-btn" onClick={() => onChange(t.id)} disabled={!t.info}>
          {t.info?.symbol ?? "…"}
        </button>
      ))}
    </div>
  );
}

export function DepositPanel({ vaultId, ownerId, vault, tokens, accountNear }: { vaultId: string; ownerId: string; vault: VaultView | null; tokens: TokenState[]; accountNear: bigint | null }) {
  const run = useAction();
  const [asset, setAsset] = useState<Asset>("near");
  const [amount, setAmount] = useState("");
  const token = tokens.find((t) => t.id === asset);
  const spendable = accountNear !== null ? (accountNear > GAS_RESERVE ? accountNear - GAS_RESERVE : 0n) : null;
  const inPolicy = (id: string) => !!vault?.policy.tokens.some((t) => t.token_id === id);

  const review = () => {
    if (asset === "near") return run(I.depositNear({ vaultId, amount: parsedOrZero(amount, NEAR_DECIMALS), vaultExists: vault !== null }));
    if (!token?.info) return;
    if (token.role === "wnear") {
      return run(
        I.wrapAndDeposit({
          vaultId,
          ownerId,
          wnear: token.info,
          amount: parsedOrZero(amount, token.info.decimals),
          ownerRegistered: token.ownerRegistered ?? false,
          vaultRegistered: token.vaultRegistered ?? false,
          storageMin: token.storageMin ?? 0n,
          tokenInPolicy: inPolicy(token.id),
          vaultExists: vault !== null,
        }),
      );
    }
    run(
      I.depositToken({
        vaultId,
        token: token.info,
        amount: parsedOrZero(amount, token.info.decimals),
        held: token.held ?? 0n,
        vaultRegistered: token.vaultRegistered ?? false,
        tokenInPolicy: inPolicy(token.id),
        vaultExists: vault !== null,
      }),
    );
  };

  return (
    <Panel id="deposit" mark="Deposit" title={vault ? "Add funds" : "Open your vault"}>
      {!vault && <p className="panel-lede">Your first NEAR deposit creates the vault. A small part of it pays for the vault's storage on chain.</p>}
      <AssetTabs value={asset} onChange={(a) => (setAsset(a), setAmount(""))} tokens={tokens} label="Asset to deposit" />
      {asset === "near" ? (
        <AmountField label="Amount" value={amount} onChange={setAmount} decimals={NEAR_DECIMALS} symbol="NEAR" max={spendable} maxLabel="Max" hint={accountNear !== null ? `Your account holds ${formatNear(accountNear, { maxFraction: 4 })} NEAR; Max keeps 0.05 for gas.` : undefined} />
      ) : token?.info && token.role === "wnear" ? (
        <AmountField
          label="NEAR to wrap and deposit"
          value={amount}
          onChange={setAmount}
          decimals={token.info.decimals}
          symbol={token.info.symbol}
          max={spendable}
          hint={`Wraps NEAR from your account into ${token.info.symbol} and deposits it, in one approval.${inPolicy(token.id) ? "" : ` ${token.info.symbol} is not in your policy yet, so the vault would refuse it.`}`}
        />
      ) : token?.info ? (
        <AmountField
          label="Amount"
          value={amount}
          onChange={setAmount}
          decimals={token.info.decimals}
          symbol={token.info.symbol}
          max={token.held}
          hint={`You hold ${formatUnits(token.held ?? 0n, token.info.decimals, { maxFraction: 4 })} ${token.info.symbol}.${inPolicy(token.id) ? "" : " Not in your policy yet, so the vault would refuse it."}`}
        />
      ) : null}
      <div className="panel-actions">
        <button type="button" className="btn btn--ink" onClick={review} disabled={amount.trim() === ""}>
          Review deposit
        </button>
      </div>
    </Panel>
  );
}

export function WithdrawPanel({ vaultId, ownerId, vault, tokens, lock }: { vaultId: string; ownerId: string; vault: VaultView; tokens: TokenState[]; lock: I.LockInfo }) {
  const run = useAction();
  const [asset, setAsset] = useState<Asset>("near");
  const [amount, setAmount] = useState("");
  const locked = I.lockActive(lock);
  const token = tokens.find((t) => t.id === asset);
  const tokenBalance = (id: string) => BigInt(vault.tokens.find((t) => t.token_id === id)?.balance ?? "0");

  const review = () => {
    if (asset === "near") return run(I.withdrawNear({ vaultId, amount: parsedOrZero(amount, NEAR_DECIMALS), balance: BigInt(vault.balance), lock }));
    if (!token?.info) return;
    run(
      I.withdrawToken({
        vaultId,
        ownerId,
        token: token.info,
        amount: parsedOrZero(amount, token.info.decimals),
        balance: tokenBalance(token.id),
        ownerRegistered: token.ownerRegistered ?? false,
        storageMin: token.storageMin ?? 0n,
        lock,
      }),
    );
  };

  return (
    <Panel id="withdraw" mark="Withdraw" title="Take funds out">
      {locked && (
        <p className="panel-blocked" role="note">
          Withdrawals are locked until {formatDateTime(lock.untilNs!)} <span className="mono">({formatUtc(lock.untilNs!)})</span>. The contract refuses every withdrawal until then.
        </p>
      )}
      <fieldset disabled={locked} className="panel-fields">
        <AssetTabs value={asset} onChange={(a) => (setAsset(a), setAmount(""))} tokens={tokens} label="Asset to withdraw" />
        {asset === "near" ? (
          <AmountField label="Amount" value={amount} onChange={setAmount} decimals={NEAR_DECIMALS} symbol="NEAR" max={BigInt(vault.balance)} hint="Works while frozen. Goes to your own account." />
        ) : token?.info ? (
          <AmountField label="Amount" value={amount} onChange={setAmount} decimals={token.info.decimals} symbol={token.info.symbol} max={tokenBalance(token.id)} hint="Works while frozen. Goes to your own account." />
        ) : null}
        <div className="panel-actions">
          <button type="button" className="btn btn--ink" onClick={review} disabled={amount.trim() === ""}>
            Review withdrawal
          </button>
        </div>
      </fieldset>
    </Panel>
  );
}

export function LockPanel({ vaultId, lock }: { vaultId: string; lock: I.LockInfo }) {
  const run = useAction();
  const [days, setDays] = useState("30");
  const n = Number(days);
  const valid = /^\d+$/.test(days.trim()) && n >= 1 && n <= 3650;
  const from = lock.untilNs !== null && lock.untilNs > lock.nowNs ? lock.untilNs : lock.nowNs;
  const untilNs = valid ? from + BigInt(n) * 86_400n * 1_000_000_000n : null;
  return (
    <Panel id="lock" mark="Lock" title="Lock withdrawals">
      <p className="panel-lede">
        A lock is a promise you cannot break: until it ends, nobody, not even you, can withdraw or change the agent or policy. Your agent keeps acting within its current
        policy, and you can still freeze.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="lock-days">
          {lock.untilNs !== null && lock.untilNs > lock.nowNs ? "Extend by (days)" : "Lock for (days)"}
        </label>
        <input id="lock-days" className="mono lock-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        <p className="field-hint">{untilNs ? `Until ${formatDateTime(untilNs)} (${formatUtc(untilNs)}). Locks can only be extended.` : "From 1 to 3650 days."}</p>
      </div>
      <div className="panel-actions">
        <button type="button" className="btn btn--ink" disabled={!untilNs} onClick={() => untilNs && run(I.lockWithdrawals({ vaultId, untilNs, lock }))}>
          Review lock
        </button>
      </div>
    </Panel>
  );
}

export function ReclaimPanel({ vaultId, vault, tokens, ledgerOf }: { vaultId: string; vault: VaultView; tokens: TokenState[]; ledgerOf: (id: string) => ExchangeLedger | null }) {
  const run = useAction();
  const stuck = vault.tokens.filter((t) => BigInt(t.on_exchange) > 0n);
  if (stuck.length === 0) return null;
  return (
    <Panel id="reclaim" mark="Reclaim" title="Tokens left on the exchange">
      <p className="panel-lede">An earlier withdrawal from the exchange failed, so these stayed in the vault's exchange account. Reclaiming retries it; it works while frozen or locked.</p>
      <ul className="reclaim-list">
        {stuck.map((s) => {
          const t = tokens.find((x) => x.id === s.token_id)?.info ?? { id: s.token_id, symbol: s.token_id, decimals: 0 };
          const ledger = ledgerOf(s.token_id);
          return (
            <li key={s.token_id}>
              <span className="mono">
                {formatUnits(BigInt(s.on_exchange), t.decimals, { maxFraction: 6 })} {t.symbol}
              </span>
              <button type="button" className="btn btn--quiet btn--small" onClick={() => run(I.reclaim({ vaultId, token: t, onExchange: BigInt(s.on_exchange), inFlight: ledger?.in_flight ?? 0 }))}>
                Review reclaim
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
