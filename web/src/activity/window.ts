/**
 * The contract's 24-hour sliding window (src/spend.rs). `recent_spends` keeps entries older than
 * 24 hours until the next agent call prunes them, so the UI filters them the same way the
 * contract counts them: a spend counts while `now < timestamp + WINDOW_NS`, where `now` is chain
 * time (the final block's timestamp), never the device clock.
 */
import type { Spend } from "../contract/abi.gen";

export const WINDOW_NS = 24n * 60n * 60n * 1_000_000_000n;

export function countsAt(spend: Pick<Spend, "timestamp">, nowNs: bigint): boolean {
  return nowNs < BigInt(spend.timestamp) + WINDOW_NS;
}

export interface WindowUsage {
  /** Spends and swaps still counting toward `max_spends_per_24h`. */
  readonly count: number;
  /** Total of `tokenId` (null: NEAR) among them, in smallest units. */
  readonly total: bigint;
  /** When the oldest counting entry stops counting, or null if none count. */
  readonly nextExpiryNs: bigint | null;
}

export function windowUsage(spends: readonly Spend[], nowNs: bigint, tokenId: string | null): WindowUsage {
  let count = 0;
  let total = 0n;
  let nextExpiryNs: bigint | null = null;
  for (const s of spends) {
    if (!countsAt(s, nowNs)) continue;
    count++;
    if ((s.token_id ?? null) === tokenId) total += BigInt(s.amount);
    const expiry = BigInt(s.timestamp) + WINDOW_NS;
    if (nextExpiryNs === null || expiry < nextExpiryNs) nextExpiryNs = expiry;
  }
  return { count, total, nextExpiryNs };
}

/** The entries that still count, oldest first (the stale ones are dropped, as the contract will). */
export function liveSpends(spends: readonly Spend[], nowNs: bigint): Spend[] {
  return spends.filter((s) => countsAt(s, nowNs));
}
