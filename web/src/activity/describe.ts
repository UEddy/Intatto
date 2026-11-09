/**
 * The activity feed's lines, from indexed transactions of the vault account. Pure.
 *
 * - Only events the vault contract itself logged count (eventsFromReceipt checks the executor).
 * - Only events about `ownerId` are kept: the vault account's history holds every owner's.
 * - A rejection is explained with the caps in force at that moment: the policy of the most
 *   recent agent_set before it, replayed in chain order. A later edit cannot rewrite that
 *   history; if that agent_set is older than the loaded history, the cap is not quoted.
 */
import type { Policy } from "../contract/abi.gen";
import { eventOwner, eventsFromReceipt, type VaultEvent } from "../contract/events";
import type { IndexedTx } from "../indexer/types";
import { formatNear, formatUnits } from "../near/units";
import { REASON_TEXT } from "./reasons";

export type FeedTone = "blocked" | "agent" | "owner" | "alert" | "info";

export interface FeedItem {
  readonly key: string;
  readonly hash: string;
  readonly blockHeight: number;
  readonly timestampNs: string;
  readonly tone: FeedTone;
  /** Short label for the stamp: "Blocked", "Swapped", "Frozen". */
  readonly label: string;
  readonly text: string;
}

export type TokenLookup = (tokenId: string) => { symbol: string; decimals: number } | null;

const amountOf = (tokens: TokenLookup, id: string, raw: string) => {
  const t = tokens(id);
  return t ? `${formatUnits(BigInt(raw), t.decimals, { maxFraction: 6 })} ${t.symbol}` : `${raw} units of ${id}`;
};
const symbolOf = (tokens: TokenLookup, id: string) => tokens(id)?.symbol ?? id;
const near = (raw: string) => `${formatNear(BigInt(raw), { maxFraction: 6 })} NEAR`;

function capClause(e: Extract<VaultEvent, { event: "spend_rejected" | "swap_rejected" }>, policy: Policy | null | undefined, tokens: TokenLookup): string {
  const d = e.data;
  const known = policy !== undefined;
  if (e.event === "spend_rejected") {
    switch (d.reason) {
      case "over_per_tx_cap":
        return known ? `your per-payment cap is ${near(policy?.per_tx_cap ?? "0")}` : "it was over your per-payment cap";
      case "over_daily_cap":
        return known ? `your 24-hour cap is ${near(policy?.daily_cap ?? "0")}` : "it would exceed your 24-hour cap";
      case "receiver_not_allowlisted":
        return `${e.data.receiver_id} is not on your list of receivers`;
      case "too_many_spends":
        return known ? `your limit is ${policy?.max_spends_per_24h ?? 0} actions per 24 hours` : REASON_TEXT[d.reason];
      default:
        return REASON_TEXT[d.reason];
    }
  }
  const sw = e.data;
  const tp = policy?.tokens.find((t) => t.token_id === sw.token_in);
  switch (sw.reason) {
    case "over_per_tx_cap":
      return known ? `your per-trade cap is ${tp ? amountOf(tokens, sw.token_in, tp.per_tx_cap) : `0 (${symbolOf(tokens, sw.token_in)} has no caps)`}` : "it was over your per-trade cap";
    case "over_daily_cap":
      return known ? `your 24-hour cap is ${tp ? amountOf(tokens, sw.token_in, tp.daily_cap) : "0"}` : "it would exceed your 24-hour cap";
    case "pool_not_allowlisted":
      return `pool #${sw.pool_id} is not allowed by your policy`;
    case "too_many_spends":
      return known ? `your limit is ${policy?.max_spends_per_24h ?? 0} actions per 24 hours` : REASON_TEXT[sw.reason];
    default:
      return REASON_TEXT[sw.reason];
  }
}

function line(e: VaultEvent, policy: Policy | null | undefined, tokens: TokenLookup): { tone: FeedTone; label: string; text: string } | null {
  switch (e.event) {
    case "deposit":
      return { tone: "owner", label: "Deposit", text: `Deposited ${near(e.data.amount)}${BigInt(e.data.storage_cost) > 0n ? ` (${near(e.data.storage_cost)} kept for the vault's storage)` : ""}.` };
    case "token_deposit":
      return { tone: "owner", label: "Deposit", text: `Deposited ${amountOf(tokens, e.data.token_id, e.data.amount)}.` };
    case "agent_set":
      return { tone: "owner", label: "Policy", text: `Set ${e.data.agent_id} as the agent, with a new policy.` };
    case "agent_removed":
      return { tone: "owner", label: "Agent", text: `Removed ${e.data.agent_id} as the agent. Nothing can spend now.` };
    case "frozen":
      return { tone: "alert", label: "Frozen", text: "Froze the vault: every agent call is refused." };
    case "unfrozen":
      return { tone: "owner", label: "Unfrozen", text: "Unfroze the vault." };
    case "withdrawals_locked":
      return { tone: "owner", label: "Locked", text: `Locked withdrawals until block time ${new Date(Number(BigInt(e.data.locked_until) / 1_000_000n)).toISOString().replace(".000Z", "Z")}.` };
    case "set_agent_rejected":
      return { tone: "blocked", label: "Refused", text: `Refused a policy change to ${e.data.agent_id}: withdrawals are locked.` };
    case "withdraw":
      return { tone: "owner", label: "Withdraw", text: `Withdrew ${near(e.data.amount)}.` };
    case "withdraw_refunded":
      return { tone: "alert", label: "Returned", text: `A withdrawal of ${near(e.data.amount)} failed; it is back in the vault.` };
    case "token_withdraw":
      return { tone: "owner", label: "Withdraw", text: `Withdrew ${amountOf(tokens, e.data.token_id, e.data.amount)}.` };
    case "token_withdraw_refunded":
      return { tone: "alert", label: "Returned", text: `A withdrawal of ${amountOf(tokens, e.data.token_id, e.data.amount)} failed; it is back in the vault.` };
    case "spend_rejected":
      return { tone: "blocked", label: "Blocked", text: `Blocked: ${e.data.caller_id} tried to send ${near(e.data.amount)} to ${e.data.receiver_id}; ${capClause(e, policy, tokens)}.` };
    case "spend_initiated":
      return { tone: "agent", label: "Paid", text: `Agent sent ${near(e.data.amount)} to ${e.data.receiver_id}.` };
    case "spend_completed":
      return null; // spend_initiated already says it; a failure shows as spend_refunded
    case "spend_refunded":
      return { tone: "alert", label: "Returned", text: `A payment of ${near(e.data.amount)} to ${e.data.receiver_id} failed; it is back in the vault.` };
    case "swap_rejected":
      return {
        tone: "blocked",
        label: "Blocked",
        text: `Blocked: ${e.data.caller_id} tried to swap ${amountOf(tokens, e.data.token_in, e.data.amount_in)} for ${symbolOf(tokens, e.data.token_out)}; ${capClause(e, policy, tokens)}.`,
      };
    case "swap_initiated":
      return null; // swap_completed or swap_refunded follows
    case "swap_completed": {
      const out = (raw: string) => amountOf(tokens, e.data.swap.token_out, raw);
      const swapped = `Agent swapped ${amountOf(tokens, e.data.swap.token_in, e.data.swap.amount_in)} for ${out(e.data.amount_out)} in pool #${e.data.swap.pool_id}`;
      // From swap_completed 1.1.0 on: gross output, the protocol fee, and what the owner got.
      const split =
        e.data.fee !== undefined && e.data.net !== undefined && !e.data.held_on_exchange
          ? `: ${out(e.data.net)} to the vault, ${out(e.data.fee)} protocol fee`
          : "";
      const held = e.data.held_on_exchange ? " The output is still on the exchange; reclaim it." : "";
      return { tone: "agent", label: "Swapped", text: `${swapped}${split}.${held}` };
    }
    case "swap_refunded":
      return { tone: "alert", label: "Returned", text: `A swap of ${amountOf(tokens, e.data.swap.token_in, e.data.swap.amount_in)} failed at its ${e.data.failed_step} step; ${e.data.held_on_exchange ? "it is on the exchange, reclaimable" : "it is back in the vault"}.` };
    case "exchange_shortfall":
      return { tone: "alert", label: "Refused", text: `Reclaim refused: the exchange holds less ${symbolOf(tokens, e.data.token_id)} than owners are owed.` };
    case "exchange_reclaim":
      return e.data.succeeded
        ? { tone: "owner", label: "Reclaimed", text: `Reclaimed ${amountOf(tokens, e.data.token_id, e.data.amount)} from the exchange.` }
        : { tone: "alert", label: "Returned", text: `Reclaiming ${amountOf(tokens, e.data.token_id, e.data.amount)} failed; it stays on the exchange.` };
    case "exchange_ledger_underflow":
    case "fees_withdrawn":
    case "fees_withdraw_refunded":
      return null; // not about an owner's vault
  }
}

/** Feed lines for `ownerId`, newest first. `txs` may come in any order. */
export function describeActivity(txs: readonly IndexedTx[], ownerId: string, vaultId: string, tokens: TokenLookup): FeedItem[] {
  const receipts = txs
    .flatMap((tx) => tx.receipts.map((r, i) => ({ tx, r, i })))
    .sort((a, b) => a.r.blockHeight - b.r.blockHeight || a.i - b.i);
  // undefined: no agent_set seen yet in the loaded history, so caps are unknown.
  let policy: Policy | null | undefined = undefined;
  const items: FeedItem[] = [];
  for (const { tx, r } of receipts) {
    eventsFromReceipt(r, vaultId).forEach((p, j) => {
      if (p.kind === "unrecognised") {
        items.push({ key: `${r.receiptId}:${j}`, hash: tx.hash, blockHeight: r.blockHeight, timestampNs: r.blockTimestampNs, tone: "info", label: "Event", text: `The vault logged an event this page does not know: ${p.event} (version ${p.version}).` });
        return;
      }
      if (p.kind !== "event" || eventOwner(p.event) !== ownerId) return;
      const e = p.event;
      const l = line(e, policy, tokens);
      if (e.event === "agent_set") policy = e.data.policy;
      if (e.event === "agent_removed") policy = null;
      if (l) items.push({ key: `${r.receiptId}:${j}`, hash: tx.hash, blockHeight: r.blockHeight, timestampNs: r.blockTimestampNs, ...l });
    });
  }
  return items.reverse();
}
