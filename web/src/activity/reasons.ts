import type { RejectReason } from "../contract/events";

/** Why the contract refused an agent call, in plain words. */
export const REASON_TEXT: Record<RejectReason, string> = {
  no_vault: "there is no vault for that owner",
  not_agent: "the caller is not this vault's agent",
  zero_amount: "the amount was zero",
  zero_min_amount_out: "it asked for a minimum output of zero",
  insufficient_gas: "it attached too little gas",
  frozen: "the vault is frozen",
  receiver_not_allowlisted: "the receiver is not on the allowlist",
  pool_not_allowlisted: "the pool is not allowed",
  pair_mismatch: "the tokens don't match the pool's declared pair",
  over_per_tx_cap: "it was over the per-trade cap",
  too_many_spends: "the 24-hour action limit was reached",
  over_daily_cap: "it would exceed the 24-hour cap",
  insufficient_balance: "the vault balance is too low",
  too_many_tokens: "the vault already holds the maximum number of tokens",
  quote_failed: "the exchange could not quote the swap",
  slippage_too_loose: "its minimum output allowed more slippage than the policy",
};

/** The same reasons in two or three words, for the stamped verdict ("REJECTED · frozen"). */
export const REASON_SHORT: Record<RejectReason, string> = {
  no_vault: "no vault",
  not_agent: "not the agent",
  zero_amount: "zero amount",
  zero_min_amount_out: "zero minimum out",
  insufficient_gas: "too little gas",
  frozen: "frozen",
  receiver_not_allowlisted: "receiver not allowed",
  pool_not_allowlisted: "pool not allowed",
  pair_mismatch: "pair mismatch",
  over_per_tx_cap: "over per-trade cap",
  too_many_spends: "action limit",
  over_daily_cap: "over 24h cap",
  insufficient_balance: "balance too low",
  too_many_tokens: "too many tokens",
  quote_failed: "no quote",
  slippage_too_loose: "slippage too loose",
};

/**
 * `over_per_tx_cap` is the cap of whichever call hit it: the NEAR per-payment cap for
 * `agent_spend`, a token's per-trade cap for `agent_swap`. The tables above say "per-trade".
 */
const PER_PAYMENT = { text: "it was over the per-payment cap", short: "over per-payment cap" } as const;

export const reasonText = (reason: RejectReason, method: string): string =>
  reason === "over_per_tx_cap" && method === "agent_spend" ? PER_PAYMENT.text : REASON_TEXT[reason];

export const reasonShort = (reason: RejectReason, method: string): string =>
  reason === "over_per_tx_cap" && method === "agent_spend" ? PER_PAYMENT.short : REASON_SHORT[reason];
