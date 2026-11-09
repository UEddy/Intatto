/**
 * After the wallet submits: read each transaction's outcome over our own RPC (whatever the
 * wallet reported), and the blocks it was included in and executed in, so the page can say
 * exactly what happened and how long the chain took.
 */
import { failureText } from "../indexer/fastnear";
import type { Chain } from "../near/chain";
import type { SubmittedTx } from "../wallet/types";

export interface TxResult {
  readonly hash: string;
  readonly receiverId: string;
  readonly ok: boolean;
  /** The first failure, as the contract or runtime gave it. */
  readonly failure: string | null;
  readonly included: { readonly height: number; readonly timestampNs: bigint };
  /** The block of the receipt that ran on the receiver: where the action took effect. */
  readonly executed: { readonly height: number; readonly timestampNs: bigint } | null;
}

/**
 * `chain` is the live node; `archive` answers for transactions the live node has already
 * garbage-collected (it keeps a few epochs). Each lookup already retries "not found" a few times,
 * which covers a fresh transaction still propagating.
 */
export async function readOutcomes(chain: Chain, archive: Chain, signerId: string, submitted: readonly SubmittedTx[]): Promise<TxResult[]> {
  const results: TxResult[] = [];
  for (const s of submitted) {
    // wait_until NONE answers at once. (With EXECUTED_OPTIMISTIC, a node that never saw the
    // transaction waits ~11 s and then reports TIMEOUT_ERROR, which is retried, not "not found".)
    let source = chain;
    let outcome = await chain.tx(s.hash, signerId, "NONE").catch(() => null);
    if (!outcome) {
      source = archive;
      outcome = await archive.tx(s.hash, signerId, "NONE");
    }
    if (!outcome) throw new Error(`Transaction ${s.hash} was not found on chain`);
    // The wallet reports after execution, but if a receipt is still pending, wait for it.
    for (let i = 0; i < 20 && outcome.receipts.some((r) => r.status === "pending"); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      outcome = (await source.tx(s.hash, signerId, "NONE")) ?? outcome;
    }
    if (outcome.signerId !== signerId) throw new Error(`Transaction ${s.hash} was signed by ${outcome.signerId}, not ${signerId}`);
    const failed = outcome.receipts.find((r) => r.status === "failure");
    const onReceiver = outcome.receipts.find((r) => r.executorId === s.receiverId);
    const [inc, exe] = await Promise.all([source.block(outcome.txBlockHash), onReceiver ? source.block(onReceiver.blockHash) : Promise.resolve(null)]);
    results.push({
      hash: s.hash,
      receiverId: s.receiverId,
      ok: !failed,
      failure: failed ? failureText(failed.failure) : null,
      included: { height: inc.height, timestampNs: inc.timestampNs },
      executed: exe ? { height: exe.height, timestampNs: exe.timestampNs } : null,
    });
  }
  return results;
}

/** "0.6 s" between inclusion and execution, from block timestamps. */
export function chainSeconds(r: TxResult): string | null {
  if (!r.executed) return null;
  const ms = Number((r.executed.timestampNs - r.included.timestampNs) / 1_000_000n);
  return `${(ms / 1000).toFixed(1)} s`;
}
