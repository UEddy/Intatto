/**
 * The one place anything gets signed. Before the wallet is asked, the sheet shows exactly what
 * each transaction does: receiver, method, arguments, deposit and gas. After, it shows what the
 * chain says happened, read over our own RPC.
 */
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useServices } from "../app/services";
import { formatNear, formatTgas } from "../near/units";
import { formatInt } from "../ui/format";
import { Badge, Icon, TxLink } from "../ui/primitives";
import { useWallet } from "../wallet/WalletProvider";
import { WalletRejectedError, type Intent } from "../wallet/types";
import { chainSeconds, readOutcomes, type TxResult } from "./submit";

type Stage =
  | { kind: "review" }
  | { kind: "signing"; startedMs: number }
  | { kind: "reading"; startedMs: number; hashes: string[] }
  | { kind: "done"; startedMs: number; finishedMs: number; results: TxResult[] }
  | { kind: "error"; message: string; cancelled: boolean };

interface Options {
  /** Shown as the headline once every transaction succeeded, e.g. "Frozen". */
  readonly doneVerb?: string;
}

const ActionContext = createContext<((intent: Intent, options?: Options) => void) | null>(null);

export function useAction() {
  const run = useContext(ActionContext);
  if (!run) throw new Error("useAction outside ActionProvider");
  return run;
}

/**
 * Runs owner actions through the review sheet. Read-only (a live vault viewed by anyone): run
 * does nothing, so no sheet opens and nothing can reach the wallet; the controls that would call
 * it are disabled too (ConsolePage).
 */
export function ActionProvider({ children, readOnly = false }: { children: ReactNode; readOnly?: boolean }) {
  const [current, setCurrent] = useState<{ intent: Intent; options: Options } | null>(null);
  const run = useCallback((intent: Intent, options: Options = {}) => (readOnly ? undefined : setCurrent({ intent, options })), [readOnly]);
  return (
    <ActionContext.Provider value={run}>
      {children}
      {current && !readOnly && <ActionSheet key={current.intent.title + current.intent.plans.length} intent={current.intent} options={current.options} onClose={() => setCurrent(null)} />}
    </ActionContext.Provider>
  );
}

function ActionSheet({ intent, options, onClose }: { intent: Intent; options: Options; onClose: () => void }) {
  const { chain, archive, config } = useServices();
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "review" });

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const busy = stage.kind === "signing" || stage.kind === "reading";
  const close = () => {
    if (busy) return;
    ref.current?.close();
    onClose();
  };

  const sign = async () => {
    if (!wallet.accountId) return;
    const startedMs = performance.now();
    setStage({ kind: "signing", startedMs });
    try {
      const submitted = await wallet.adapter.submit(wallet.accountId, intent.plans);
      setStage({ kind: "reading", startedMs, hashes: submitted.map((s) => s.hash) });
      const results = await readOutcomes(chain, archive, wallet.accountId, submitted);
      setStage({ kind: "done", startedMs, finishedMs: performance.now(), results });
    } catch (e) {
      setStage({ kind: "error", message: e instanceof Error ? e.message : String(e), cancelled: e instanceof WalletRejectedError });
    } finally {
      void queryClient.invalidateQueries({ queryKey: [config.networkId] });
    }
  };

  const allOk = stage.kind === "done" && stage.results.every((r) => r.ok);
  const last = stage.kind === "done" ? stage.results[stage.results.length - 1] : undefined;

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="sheet-title" onCancel={(e) => (busy ? e.preventDefault() : onClose())}>
      <div className="sheet-inner">
        <header className="sheet-head">
          <p className="section-mark">{stage.kind === "review" ? "Review before signing" : "Transaction"}</p>
          <h2 id="sheet-title" className="sheet-title">
            {stage.kind === "done" && allOk && options.doneVerb ? options.doneVerb : intent.title}
          </h2>
          <button type="button" className="icon-btn sheet-close" onClick={close} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>

        {stage.kind === "review" && (
          <>
            <p className="sheet-summary">{intent.summary}</p>
            <ol className="plan">
              {intent.plans.map((p, i) => (
                <li key={i} className="plan-tx">
                  <p className="plan-tx-head">
                    <span className="plan-tx-n">
                      Transaction {i + 1}
                      {intent.plans.length > 1 ? ` of ${intent.plans.length}` : ""}
                    </span>
                    <span>
                      to <span className="mono">{p.receiverId}</span>
                    </span>
                  </p>
                  <ol className="plan-actions">
                    {p.actions.map((a, j) => (
                      <li key={j} className="plan-action">
                        <p className="mono plan-method">{a.methodName}</p>
                        <pre className="mono plan-args">{JSON.stringify(a.args, null, 2)}</pre>
                        <dl className="plan-meta">
                          <div>
                            <dt>Deposit</dt>
                            <dd className="mono">
                              {a.deposit === 0n ? "none" : a.deposit === 1n ? "1 yoctoNEAR (proves a full-access key)" : `${formatNear(a.deposit)} NEAR`}
                              {a.deposit > 1n && <span className="plan-raw"> = {a.deposit.toString()} yocto</span>}
                            </dd>
                          </div>
                          <div>
                            <dt>Gas</dt>
                            <dd className="mono">{formatTgas(a.gas)} Tgas</dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
            {intent.warnings.length > 0 && (
              <ul className="sheet-notes sheet-notes--warn">
                {intent.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {intent.blockers.length > 0 && (
              <ul className="sheet-notes sheet-notes--block" role="alert">
                {intent.blockers.map((b) => (
                  <li key={b}>
                    <strong>The contract would refuse this.</strong> {b}
                  </li>
                ))}
              </ul>
            )}
            <p className="sheet-fine">
              <Icon name="shield" size={14} /> Your wallet shows the same transaction{intent.plans.length > 1 ? "s" : ""} for approval. The vault contract enforces its
              rules whatever this page says.
            </p>
            <div className="sheet-actions">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn--ink" onClick={() => void sign()} disabled={intent.blockers.length > 0 || !wallet.accountId}>
                {wallet.accountId ? "Sign with wallet" : "Connect a wallet first"}
              </button>
            </div>
          </>
        )}

        {(stage.kind === "signing" || stage.kind === "reading") && (
          <ol className="progress" aria-live="polite">
            <li className={stage.kind === "signing" ? "is-active" : "is-done"}>Approve in your wallet</li>
            <li className={stage.kind === "reading" ? "is-active" : ""}>
              Submitted{stage.kind === "reading" ? ": " : ""}
              {stage.kind === "reading" && stage.hashes.map((h) => <TxLink key={h} hash={h} />)}
            </li>
            <li>Executed on chain</li>
          </ol>
        )}

        {stage.kind === "done" && (
          <div className="result" aria-live="polite">
            {last && allOk && options.doneVerb && last.executed && (
              <p className="result-headline">
                {options.doneVerb} on chain {chainSeconds(last)} after the transaction was included <span className="mono">(block {formatInt(last.executed.height)})</span>.
              </p>
            )}
            <ul className="result-list">
              {stage.results.map((r) => (
                <li key={r.hash}>
                  {r.ok ? <Badge tone="ok">Done</Badge> : <Badge tone="alert">Failed</Badge>}
                  <span>
                    {r.ok ? "Executed" : `Refused: ${r.failure}`} · included in block <span className="mono">{formatInt(r.included.height)}</span>
                    {r.executed && r.executed.height !== r.included.height ? (
                      <>
                        , ran in <span className="mono">{formatInt(r.executed.height)}</span>
                      </>
                    ) : null}{" "}
                    <TxLink hash={r.hash} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              From your click to confirmed on chain: {((stage.finishedMs - stage.startedMs) / 1000).toFixed(1)} s, including your wallet approval.
            </p>
            <div className="sheet-actions">
              <button type="button" className="btn btn--ink" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="result" role="alert">
            <p>{stage.cancelled ? "Cancelled in the wallet. Nothing was sent." : `Something went wrong: ${stage.message}`}</p>
            <div className="sheet-actions">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Close
              </button>
              <button type="button" className="btn btn--ink" onClick={() => setStage({ kind: "review" })}>
                Back to review
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
