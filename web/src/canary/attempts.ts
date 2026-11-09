/**
 * The board's attempt log: every transaction signed with the published agent key, and what the
 * vault did with it. With the canary's zero-outflow policy every attempt should be rejected; an
 * attempt that went through is shown as such, prominently, instead of being hidden.
 */
import { eventsFromReceipt, type RejectReason } from "../contract/events";
import type { IndexedTx } from "../indexer/types";

export type AttemptOutcome =
  /** The vault logged a spend_rejected / swap_rejected event with a reason. */
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly message: string | null }
  /** It failed without a rejection event (e.g. bad arguments, or out of gas). */
  | { readonly kind: "failed"; readonly message: string }
  /** Every receipt succeeded. With the canary's policy this should never happen. */
  | { readonly kind: "succeeded" };

export interface Attempt {
  readonly hash: string;
  readonly blockHeight: number;
  readonly blockTimestampNs: string;
  readonly method: string;
  readonly args: unknown;
  readonly outcome: AttemptOutcome;
}

export function attemptsFrom(
  txs: readonly IndexedTx[],
  canary: { readonly agentId: string; readonly agentPublicKey: string },
  vaultId: string,
): Attempt[] {
  const out: Attempt[] = [];
  for (const tx of txs) {
    if (tx.signerId !== canary.agentId || tx.publicKey !== canary.agentPublicKey) continue;
    const call = tx.actions.find((a) => a.kind === "FunctionCall");
    const failure = tx.receipts.find((r) => r.status === "failure");
    let outcome: AttemptOutcome = failure ? { kind: "failed", message: failure.failureMessage ?? "failed" } : { kind: "succeeded" };
    for (const r of tx.receipts) {
      for (const parsed of eventsFromReceipt(r, vaultId)) {
        if (parsed.kind !== "event") continue;
        const e = parsed.event;
        if (e.event === "spend_rejected" || e.event === "swap_rejected") {
          outcome = { kind: "rejected", reason: e.data.reason, message: r.failureMessage };
        }
      }
    }
    out.push({
      hash: tx.hash,
      blockHeight: tx.blockHeight,
      blockTimestampNs: tx.blockTimestampNs,
      method: call?.kind === "FunctionCall" ? call.methodName : tx.actions[0]?.kind ?? "?",
      args: call?.kind === "FunctionCall" ? call.args : null,
      outcome,
    });
  }
  return out;
}
