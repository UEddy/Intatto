/**
 * The Chain Signatures vault's panel, computed from chain reads only. Pure, apart from the
 * NEP-413 hash (WebCrypto SHA-256): the queries feed it, the tests drive it with real mainnet
 * responses.
 *
 * What is checked, and against what (CHAIN_SIGNATURES.md, THREAT_MODEL.md invariants 15 to 18):
 * - the vault's code hash against the published build;
 * - the vault's keys on the Verifier against v1.signer's derived key: exactly one, and equal;
 * - the swap's three transactions against each other: the payload the vault logged as signed is
 *   the intent the Verifier executed (same NEP-413 hash, recomputed here), with exactly the signed
 *   token_diff, and settlement credited exactly that amount.
 */
import { z } from "zod";
import type { IntentsConfig } from "../config/networks";
import { base58Encode } from "../near/base58";
import type { ReceiptOutcome, TxOutcome } from "../near/chain";

/* ---------- build ---------- */

export type BuildState = "matches" | "changed" | "unknown";

/** `onChain`: the code hash; null if the account is gone (a change); undefined if not read yet. */
export function buildState(onChain: string | null | undefined, expected: string): BuildState {
  if (onChain === undefined) return "unknown";
  return onChain === expected ? "matches" : "changed";
}

/* ---------- key ---------- */

export type KeyState =
  /** Exactly one key on the Verifier, and it is v1.signer's derived key. */
  | "one-derived"
  /** The derived key and others: whoever holds another key can sign intents for the vault. */
  | "extra"
  /** Keys, but not the derived one. */
  | "mismatch"
  | "none"
  | "unknown";

export function keyState(onVerifier: readonly string[] | undefined, derived: string | undefined): KeyState {
  if (onVerifier === undefined || derived === undefined) return "unknown";
  if (onVerifier.length === 0) return "none";
  if (!onVerifier.includes(derived)) return "mismatch";
  return onVerifier.length === 1 ? "one-derived" : "extra";
}

/* ---------- policy floor ---------- */

export const IntentPolicySchema = z
  .object({
    pairs: z.array(
      z.object({
        token_in: z.string(),
        token_out: z.string(),
        min_out: z.string().regex(/^\d+$/),
        per_in: z.string().regex(/^[1-9]\d*$/),
      }),
    ),
  })
  .nullable();
export type IntentPolicy = z.infer<typeof IntentPolicySchema>;

/** The owner's floor for one pair: at least `minOut` of token_out for every `perIn` of token_in. */
export interface Floor {
  readonly minOut: bigint;
  readonly perIn: bigint;
}

export function floorFor(policy: IntentPolicy, tokenIn: string, tokenOut: string): Floor | null {
  const pair = policy?.pairs.find((p) => p.token_in === tokenIn && p.token_out === tokenOut);
  return pair ? { minOut: BigInt(pair.min_out), perIn: BigInt(pair.per_in) } : null;
}

/** As the contract compares it (invariant 17): amount_out / amount_in >= min_out / per_in, exactly. */
export function meetsFloor(amountIn: bigint, amountOut: bigint, floor: Floor): boolean {
  return amountOut * floor.perIn >= floor.minOut * amountIn;
}

/**
 * token_out per whole token_in, in token_out's smallest unit times 10^`places`, rounded down.
 * 1130742 (6 dp) for 3e23 (24 dp), 3 places -> 3769: 3.769 per token_in.
 */
export function rateScaled(amountIn: bigint, amountOut: bigint, decimalsIn: number, decimalsOut: number, places: number): bigint {
  return (amountOut * 10n ** BigInt(decimalsIn + places)) / (amountIn * 10n ** BigInt(decimalsOut));
}

/* ---------- the swap's transactions ---------- */

const PREFIX = "EVENT_JSON:";

function eventsOf(receipts: readonly ReceiptOutcome[], executorId: string, standard: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const r of receipts) {
    // Only the contract itself can log its events; anything else can print look-alike text.
    if (r.executorId !== executorId) continue;
    for (const log of r.logs) {
      if (!log.startsWith(PREFIX)) continue;
      try {
        const j = JSON.parse(log.slice(PREFIX.length)) as { standard?: unknown; event?: unknown; data?: unknown };
        if (j.standard === standard && typeof j.event === "string") out.push({ event: j.event, data: j.data });
      } catch {
        // Not JSON: not an event.
      }
    }
  }
  return out;
}

function methodsOf(tx: TxOutcome): string[] {
  return tx.actions.flatMap((a) => {
    const m = (a as { FunctionCall?: { method_name?: unknown } } | null)?.FunctionCall?.method_name;
    return typeof m === "string" ? [m] : [];
  });
}

const diffSchema = z.record(z.string(), z.string().regex(/^-?\d+$/));

/** The token_diff the swap is: exactly -amount_in of token_in and +amount_out of token_out. */
export function expectedDiff(swap: IntentsConfig["swap"]): Record<string, string> {
  return { [`nep141:${swap.tokenIn}`]: `-${swap.amountIn}`, [`nep141:${swap.tokenOut}`]: swap.amountOut };
}

function sameDiff(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && BigInt(a[k]!) === BigInt(b[k]!));
}

export type TxProblem =
  | "tx_not_found"
  | "wrong_signer"
  | "wrong_receiver"
  | "wrong_method"
  | "tx_failed"
  | "no_event"
  | "wrong_payload"
  | "wrong_amounts";

type Checked<T> = ({ ok: true } & T) | { ok: false; problem: TxProblem };

function basics(tx: TxOutcome | null, signerId: string | null, receiverId: string, method: string): TxProblem | null {
  if (!tx) return "tx_not_found";
  // The node looks a transaction up by hash; the sender in the request is not checked.
  if (signerId !== null && tx.signerId !== signerId) return "wrong_signer";
  if (tx.receiverId !== receiverId) return "wrong_receiver";
  if (!methodsOf(tx).includes(method)) return "wrong_method";
  if (tx.receipts.some((r) => r.status !== "success")) return "tx_failed";
  return null;
}

const signedEvent = z.object({
  intent_id: z.string(),
  owner_id: z.string(),
  signed_data: z.object({
    standard: z.literal("nep413"),
    payload: z.object({ message: z.string(), nonce: z.string(), recipient: z.string() }),
    public_key: z.string(),
    signature: z.string(),
  }),
});

const messageSchema = z.object({
  signer_id: z.string(),
  deadline: z.string(),
  intents: z.array(z.object({ intent: z.string(), diff: diffSchema.optional() })),
});

export interface SignedSwap {
  /** The NEP-413 payload exactly as the vault logged it. */
  readonly message: string;
  readonly nonce: string;
  readonly recipient: string;
  readonly deadline: string;
  readonly publicKey: string;
  readonly blockHash: string;
}

/**
 * agent_intent_swap: signed by the agent, to the vault, and the vault logged `intent_swap_signed`
 * for this intent and owner, with a payload that is one token_diff of exactly the swap's amounts,
 * for the vault, addressed to the Verifier.
 */
export function checkSignTx(tx: TxOutcome | null, cfg: IntentsConfig): Checked<{ signed: SignedSwap }> {
  const bad = basics(tx, cfg.agentId, cfg.vaultId, "agent_intent_swap");
  if (bad || !tx) return { ok: false, problem: bad ?? "tx_not_found" };
  for (const r of tx.receipts) {
    for (const e of eventsOf([r], cfg.vaultId, "intatto")) {
      if (e.event !== "intent_swap_signed") continue;
      const p = signedEvent.safeParse(e.data);
      if (!p.success || p.data.intent_id !== cfg.swap.intentId || p.data.owner_id !== cfg.ownerId) continue;
      const pl = p.data.signed_data.payload;
      let msg: z.infer<typeof messageSchema>;
      try {
        msg = messageSchema.parse(JSON.parse(pl.message));
      } catch {
        return { ok: false, problem: "wrong_payload" };
      }
      if (msg.signer_id !== cfg.vaultId || pl.recipient !== cfg.verifierId || msg.intents.length !== 1 || msg.intents[0]!.intent !== "token_diff") {
        return { ok: false, problem: "wrong_payload" };
      }
      if (!sameDiff(msg.intents[0]!.diff ?? {}, expectedDiff(cfg.swap))) return { ok: false, problem: "wrong_amounts" };
      return {
        ok: true,
        signed: { message: pl.message, nonce: pl.nonce, recipient: pl.recipient, deadline: msg.deadline, publicKey: p.data.signed_data.public_key, blockHash: r.blockHash },
      };
    }
  }
  return { ok: false, problem: "no_event" };
}

/**
 * The NEP-413 hash of a signed payload: SHA-256 of its Borsh encoding (tag 2^31 + 413, message,
 * 32-byte nonce, recipient, no callback_url), in base58. intents.near reports it as the intent hash.
 */
export async function nep413Hash(message: string, nonceB64: string, recipient: string): Promise<string> {
  const enc = new TextEncoder();
  const nonce = Uint8Array.from(atob(nonceB64), (c) => c.charCodeAt(0));
  if (nonce.length !== 32) throw new Error(`NEP-413 nonce is ${nonce.length} bytes, not 32`);
  const msg = enc.encode(message);
  const rec = enc.encode(recipient);
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const parts = [u32(2 ** 31 + 413), u32(msg.length), msg, nonce, u32(rec.length), rec, new Uint8Array([0])];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return base58Encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

const tokenDiffEvent = z.array(z.object({ intent_hash: z.string(), account_id: z.string(), diff: diffSchema }));
const executedEvent = z.array(z.object({ intent_hash: z.string(), account_id: z.string(), nonce: z.string() }));

/**
 * execute_intents on the Verifier: it logged, from its own receipt, the intent with this hash as
 * executed for the vault with this nonce, and a token_diff for the vault of exactly the swap.
 * Anyone may relay it, so the signer is not checked.
 */
export function checkExecuteTx(tx: TxOutcome | null, cfg: IntentsConfig, intentHash: string, nonce: string): Checked<Record<never, never>> {
  const bad = basics(tx, null, cfg.verifierId, "execute_intents");
  if (bad || !tx) return { ok: false, problem: bad ?? "tx_not_found" };
  const events = eventsOf(tx.receipts, cfg.verifierId, "dip4");
  const executed = events.some((e) => e.event === "intents_executed" && executedEvent.safeParse(e.data).data?.some((x) => x.intent_hash === intentHash && x.account_id === cfg.vaultId && x.nonce === nonce));
  if (!executed) return { ok: false, problem: "no_event" };
  const diffs = events.flatMap((e) => (e.event === "token_diff" ? (tokenDiffEvent.safeParse(e.data).data ?? []) : [])).filter((d) => d.intent_hash === intentHash && d.account_id === cfg.vaultId);
  if (diffs.length !== 1) return { ok: false, problem: "no_event" };
  if (!sameDiff(diffs[0]!.diff, expectedDiff(cfg.swap))) return { ok: false, problem: "wrong_amounts" };
  return { ok: true };
}

const settledEvent = z.object({
  intent_id: z.string(),
  owner_id: z.string(),
  token_in: z.string(),
  amount_in: z.string(),
  token_out: z.string(),
  amount_out: z.string(),
});

/** settle_intent_swap: the vault logged `intent_swap_settled` crediting the owner exactly amount_out. */
export function checkSettleTx(tx: TxOutcome | null, cfg: IntentsConfig): Checked<Record<never, never>> {
  // Anyone may settle; the vault decides from intents.near's answer, not from who asked.
  const bad = basics(tx, null, cfg.vaultId, "settle_intent_swap");
  if (bad || !tx) return { ok: false, problem: bad ?? "tx_not_found" };
  for (const e of eventsOf(tx.receipts, cfg.vaultId, "intatto")) {
    if (e.event !== "intent_swap_settled") continue;
    const p = settledEvent.safeParse(e.data);
    if (!p.success || p.data.intent_id !== cfg.swap.intentId || p.data.owner_id !== cfg.ownerId) continue;
    const s = cfg.swap;
    const same = p.data.token_in === s.tokenIn && p.data.token_out === s.tokenOut && p.data.amount_in === s.amountIn && p.data.amount_out === s.amountOut;
    return same ? { ok: true } : { ok: false, problem: "wrong_amounts" };
  }
  return { ok: false, problem: "no_event" };
}

export const TX_PROBLEM: Record<TxProblem, string> = {
  tx_not_found: "the node does not know this transaction",
  wrong_signer: "it was signed by another account",
  wrong_receiver: "it went to another contract",
  wrong_method: "it called another method",
  tx_failed: "a receipt failed",
  no_event: "the contract did not log this swap",
  wrong_payload: "the signed payload is not the vault's swap intent",
  wrong_amounts: "the amounts are not the swap's",
};

/** The whole swap, checked step by step; a later step is only checked if the earlier ones hold. */
export interface SwapCheck {
  readonly sign: Checked<{ signed: SignedSwap }>;
  /** Recomputed from the signed payload; null if signing did not check out. */
  readonly intentHash: string | null;
  readonly execute: Checked<Record<never, never>> | null;
  readonly settle: Checked<Record<never, never>> | null;
}

export async function checkSwap(
  cfg: IntentsConfig,
  tx: (hash: string, senderId: string) => Promise<TxOutcome | null>,
): Promise<SwapCheck> {
  // One after another: the archival node rate-limits bursts.
  const sign = checkSignTx(await tx(cfg.swap.signTxHash, cfg.agentId), cfg);
  if (!sign.ok) return { sign, intentHash: null, execute: null, settle: null };
  const intentHash = await nep413Hash(sign.signed.message, sign.signed.nonce, sign.signed.recipient);
  const execute = checkExecuteTx(await tx(cfg.swap.executeTxHash, cfg.verifierId), cfg, intentHash, sign.signed.nonce);
  const settle = checkSettleTx(await tx(cfg.swap.settleTxHash, cfg.agentId), cfg);
  return { sign, intentHash, execute, settle };
}
