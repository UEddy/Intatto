/**
 * NEP-297 events of the vault contract (src/events.rs), logged as
 * `EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"<name>","data":{...}}`.
 *
 * The ABI does not describe events, so these schemas follow src/events.rs by hand; the unit tests
 * parse real logs from testnet and the shapes the Rust unit tests assert.
 *
 * Only logs from receipts the vault contract itself executed may be parsed: any contract can log
 * text that looks like an intatto event. `eventsFromReceipt` enforces that.
 */
import { z } from "zod";
import { PolicySchema, SwapStepSchema, SwapTicketSchema, accountId, uintString } from "./abi.gen";

export const EVENT_STANDARD = "intatto";
export const EVENT_VERSION = "1.0.0";

export const RejectReasonSchema = z.enum([
  "no_vault",
  "not_agent",
  "zero_amount",
  "zero_min_amount_out",
  "insufficient_gas",
  "frozen",
  "receiver_not_allowlisted",
  "pool_not_allowlisted",
  "pair_mismatch",
  "over_per_tx_cap",
  "too_many_spends",
  "over_daily_cap",
  "insufficient_balance",
  "too_many_tokens",
  "quote_failed",
  "slippage_too_loose",
]);
export type RejectReason = z.infer<typeof RejectReasonSchema>;

const ev = <N extends string, D extends z.ZodRawShape>(event: N, data: D) =>
  z.object({ event: z.literal(event), data: z.object(data) });

export const VaultEventSchema = z.discriminatedUnion("event", [
  ev("deposit", { owner_id: accountId, amount: uintString, storage_cost: uintString }),
  ev("agent_set", { owner_id: accountId, agent_id: accountId, policy: PolicySchema }),
  ev("agent_removed", { owner_id: accountId, agent_id: accountId }),
  ev("frozen", { owner_id: accountId }),
  ev("unfrozen", { owner_id: accountId }),
  ev("withdrawals_locked", { owner_id: accountId, locked_until: uintString }),
  ev("set_agent_rejected", { owner_id: accountId, agent_id: accountId, locked_until: uintString }),
  ev("withdraw", { owner_id: accountId, amount: uintString }),
  ev("withdraw_refunded", { owner_id: accountId, amount: uintString }),
  ev("token_deposit", { owner_id: accountId, token_id: accountId, amount: uintString }),
  ev("token_withdraw", { owner_id: accountId, token_id: accountId, amount: uintString }),
  ev("token_withdraw_refunded", { owner_id: accountId, token_id: accountId, amount: uintString }),
  ev("spend_rejected", {
    owner_id: accountId,
    caller_id: accountId,
    receiver_id: accountId,
    amount: uintString,
    reason: RejectReasonSchema,
  }),
  ev("spend_initiated", { spend_id: uintString, owner_id: accountId, agent_id: accountId, receiver_id: accountId, amount: uintString }),
  ev("spend_completed", { spend_id: uintString, owner_id: accountId, receiver_id: accountId, amount: uintString }),
  ev("spend_refunded", { spend_id: uintString, owner_id: accountId, receiver_id: accountId, amount: uintString }),
  ev("swap_rejected", {
    owner_id: accountId,
    caller_id: accountId,
    pool_id: z.number().int().min(0),
    token_in: accountId,
    token_out: accountId,
    amount_in: uintString,
    min_amount_out: uintString,
    reason: RejectReasonSchema,
  }),
  ev("swap_initiated", { agent_id: accountId, swap: SwapTicketSchema }),
  ev("swap_completed", { swap: SwapTicketSchema, amount_out: uintString, held_on_exchange: z.boolean() }),
  ev("swap_refunded", { swap: SwapTicketSchema, failed_step: SwapStepSchema, held_on_exchange: z.boolean() }),
  ev("exchange_shortfall", { owner_id: accountId, token_id: accountId, expected: uintString, actual: uintString }),
  ev("exchange_ledger_underflow", { token_id: accountId, field: z.string(), value: uintString, decrease: uintString }),
  ev("exchange_reclaim", { owner_id: accountId, token_id: accountId, amount: uintString, succeeded: z.boolean() }),
]);
export type VaultEvent = z.infer<typeof VaultEventSchema>;
export type VaultEventName = VaultEvent["event"];

export type ParsedLog =
  | { readonly kind: "event"; readonly event: VaultEvent }
  /** An intatto event this UI does not know (new version or name, or bad data): shown, not dropped. */
  | { readonly kind: "unrecognised"; readonly event: string; readonly version: string; readonly raw: string }
  | { readonly kind: "other"; readonly raw: string };

const PREFIX = "EVENT_JSON:";

const envelope = z.object({ standard: z.string(), version: z.string(), event: z.string(), data: z.unknown() });

export function parseLog(log: string): ParsedLog {
  if (!log.startsWith(PREFIX)) return { kind: "other", raw: log };
  let json: unknown;
  try {
    json = JSON.parse(log.slice(PREFIX.length));
  } catch {
    return { kind: "other", raw: log };
  }
  const env = envelope.safeParse(json);
  if (!env.success || env.data.standard !== EVENT_STANDARD) return { kind: "other", raw: log };
  if (env.data.version !== EVENT_VERSION) {
    return { kind: "unrecognised", event: env.data.event, version: env.data.version, raw: log };
  }
  const parsed = VaultEventSchema.safeParse({ event: env.data.event, data: env.data.data });
  if (!parsed.success) return { kind: "unrecognised", event: env.data.event, version: env.data.version, raw: log };
  return { kind: "event", event: parsed.data };
}

/** The owner an event is about, so the feed can keep only the connected owner's events. */
export function eventOwner(event: VaultEvent): string | null {
  switch (event.event) {
    case "swap_initiated":
    case "swap_completed":
    case "swap_refunded":
      return event.data.swap.owner_id;
    case "exchange_ledger_underflow":
      return null;
    default:
      return event.data.owner_id;
  }
}

export interface ReceiptLike {
  readonly executorId: string;
  readonly logs: readonly string[];
}

/** Parses a receipt's logs, but only if the vault contract executed it. */
export function eventsFromReceipt(receipt: ReceiptLike, vaultId: string): ParsedLog[] {
  if (receipt.executorId !== vaultId) return [];
  return receipt.logs.map(parseLog).filter((p) => p.kind !== "other");
}
