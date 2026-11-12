import { useMemo, useState } from "react";
import { useServices } from "../app/services";
import type { VaultView } from "../contract/abi.gen";
import { formatDateTime } from "../ui/format";
import { useAction } from "./ActionSheet";
import { Panel } from "./fields";
import * as I from "./intents";
import { diffPolicy, emptyForm, formToPolicy, policyToForm, type PolicyForm, type TokenMeta } from "./policy";
import type { TokenState } from "./useConsole";

export function PolicyEditor({ vaultId, vault, tokens, lock }: { vaultId: string; vault: VaultView; tokens: TokenState[]; lock: I.LockInfo }) {
  const { config } = useServices();
  const run = useAction();
  const metas: TokenMeta[] = tokens.filter((t) => t.info).map((t) => t.info!);
  const initial = useMemo(
    () => (vault.agent_id ? policyToForm(vault.agent_id, vault.policy, metas, config.pool.id) : emptyForm(metas)),
    // Reset the form only when the on-chain policy or agent changes.
    [vault.agent_id, JSON.stringify(vault.policy), metas.length],
  );
  const [form, setForm] = useState<PolicyForm>(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setForm(initial);
  }
  const locked = I.lockActive(lock);
  const result = formToPolicy(form, metas, config.pool);
  const err = (k: string) => (!result.ok ? result.errors[k] : undefined);
  const changes = result.ok ? diffPolicy(vault.agent_id ? vault.policy : null, result.policy, metas) : [];
  const agentChanged = form.agentId.trim() !== (vault.agent_id ?? "");
  const set = (patch: Partial<PolicyForm>) => setForm((f) => ({ ...f, ...patch }));
  const setToken = (id: string, patch: Partial<PolicyForm["tokens"][number]>) => set({ tokens: form.tokens.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const poolSymbols = config.pool.tokenIds.map((id) => metas.find((m) => m.id === id)?.symbol ?? id).join(" / ");

  return (
    <Panel id="policy" mark="Agent and policy" title="What your agent may do">
      <p className="panel-lede">The contract checks every agent call against these rules. Anything outside them is refused and logged, whatever the agent tries.</p>
      {locked && (
        <p className="panel-blocked" role="note">
          Withdrawals are locked until {formatDateTime(lock.untilNs!)}, and the contract refuses any change of agent or policy until then.
        </p>
      )}
      <fieldset disabled={locked} className="panel-fields policy-form">
        <div className="field">
          <label className="field-label" htmlFor="agent-id">
            Agent account
          </label>
          <input id="agent-id" className="mono" value={form.agentId} onChange={(e) => set({ agentId: e.target.value.trim().toLowerCase() })} placeholder="my-agent.testnet" spellCheck={false} autoComplete="off" />
          <p className="field-hint">The only account allowed to spend or swap for this vault.</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="max-actions">
            Actions per 24 hours
          </label>
          <input id="max-actions" className="mono field-short" inputMode="numeric" value={form.maxActions} onChange={(e) => set({ maxActions: e.target.value })} aria-invalid={!!err("maxActions")} />
          <p className={`field-hint${err("maxActions") ? " field-hint--error" : ""}`}>{err("maxActions") ?? "Spends and swaps together, counted over any 24-hour window."}</p>
        </div>

        <div className="policy-tokens">
          <p className="field-label">Tokens the vault accepts, and how much the agent may sell</p>
          {form.tokens.map((row) => {
            const meta = metas.find((m) => m.id === row.id);
            if (!meta) return null;
            const e1 = err(`token.${row.id}.perTrade`);
            const e2 = err(`token.${row.id}.perDay`);
            const e3 = err(`token.${row.id}.accepted`);
            return (
              <div key={row.id} className="token-row">
                <label className="check">
                  <input type="checkbox" checked={row.accepted} onChange={(e) => setToken(row.id, { accepted: e.target.checked })} />
                  <span>
                    {meta.symbol} <span className="mono muted small">{meta.id}</span>
                  </span>
                </label>
                {row.accepted && (
                  <div className="token-caps">
                    <label>
                      <span>Per trade</span>
                      <input className="mono" inputMode="decimal" value={row.perTrade} onChange={(e) => setToken(row.id, { perTrade: e.target.value })} aria-invalid={!!e1} />
                    </label>
                    <label>
                      <span>Per 24 hours</span>
                      <input className="mono" inputMode="decimal" value={row.perDay} onChange={(e) => setToken(row.id, { perDay: e.target.value })} aria-invalid={!!e2} />
                    </label>
                  </div>
                )}
                {(e1 || e2 || e3) && <p className="field-hint field-hint--error">{e1 ?? e2 ?? e3}</p>}
              </div>
            );
          })}
          <p className="field-hint">A cap of 0 accepts deposits of the token but forbids the agent to sell it.</p>
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={form.pool.enabled} onChange={(e) => set({ pool: { ...form.pool, enabled: e.target.checked } })} />
            <span>
              Allow swaps in pool #{config.pool.id} ({poolSymbols}) on <span className="mono">{config.exchangeId}</span>
            </span>
          </label>
          {form.pool.enabled && (
            <div className="inline-field">
              <label htmlFor="slippage">Max slippage below the exchange's quote</label>
              <input id="slippage" className="mono field-short" inputMode="decimal" value={form.pool.slippagePercent} onChange={(e) => set({ pool: { ...form.pool, slippagePercent: e.target.value } })} aria-invalid={!!err("pool.slippage")} />
              <span>%</span>
            </div>
          )}
          {err("pool.slippage") && <p className="field-hint field-hint--error">{err("pool.slippage")}</p>}
        </div>

        <details className="payments">
          <summary>Payments in NEAR</summary>
          <div className="payments-body">
            <div className="token-caps">
              <label>
                <span>Per payment (NEAR)</span>
                <input className="mono" inputMode="decimal" value={form.payments.perPayment} onChange={(e) => set({ payments: { ...form.payments, perPayment: e.target.value } })} aria-invalid={!!err("payments.perPayment")} />
              </label>
              <label>
                <span>Per 24 hours (NEAR)</span>
                <input className="mono" inputMode="decimal" value={form.payments.perDay} onChange={(e) => set({ payments: { ...form.payments, perDay: e.target.value } })} aria-invalid={!!err("payments.perDay")} />
              </label>
            </div>
            <label className="field-label" htmlFor="receivers">
              Who it may pay (one account per line)
            </label>
            <textarea id="receivers" className="mono" rows={3} value={form.payments.receivers} onChange={(e) => set({ payments: { ...form.payments, receivers: e.target.value } })} spellCheck={false} />
            {(err("payments.perPayment") || err("payments.perDay") || err("payments.receivers")) && (
              <p className="field-hint field-hint--error">{err("payments.perPayment") ?? err("payments.perDay") ?? err("payments.receivers")}</p>
            )}
          </div>
        </details>
      </fieldset>

      <div className="policy-raw">
        <div>
          <p className="field-label">Changes</p>
          {!result.ok ? (
            <p className="muted small">Fix the fields above to see the changes.</p>
          ) : changes.length === 0 && !agentChanged ? (
            <p className="muted small">Nothing changed.</p>
          ) : (
            <ul className="changes">
              {agentChanged && (
                <li>
                  <span>Agent</span> <s>{vault.agent_id ?? "none"}</s> → <strong className="mono">{form.agentId || "No agent set"}</strong>
                </li>
              )}
              {changes.map((c) => (
                <li key={c.what}>
                  <span>{c.what}</span> <s>{c.before}</s> → <strong>{c.after}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
        <details>
          <summary>On-chain values</summary>
          <div className="raw-pair">
            <div>
              <p className="field-label">Now (get_vault.policy)</p>
              <pre className="mono">{JSON.stringify(vault.policy, null, 2)}</pre>
            </div>
            <div>
              <p className="field-label">After (set_agent.policy)</p>
              <pre className="mono">{result.ok ? JSON.stringify(result.policy, null, 2) : "Invalid policy"}</pre>
            </div>
          </div>
        </details>
      </div>

      <div className="panel-actions">
        <button
          type="button"
          className="btn btn--ink"
          disabled={locked || !result.ok || (changes.length === 0 && !agentChanged)}
          onClick={() =>
            result.ok &&
            run(
              I.setAgent({
                vaultId,
                agentId: form.agentId,
                policy: result.policy,
                current: vault.agent_id ? { agentId: vault.agent_id, policy: vault.policy } : null,
                lock,
                vaultBalance: BigInt(vault.balance),
              }),
            )
          }
        >
          Review policy
        </button>
        {vault.agent_id && (
          <button type="button" className="btn btn--quiet" onClick={() => run(I.removeAgent({ vaultId, agentId: vault.agent_id ?? null }))}>
            Remove agent
          </button>
        )}
      </div>
    </Panel>
  );
}
