// Pre-trade risk check for an agent swap through an Intatto vault: allow, warn or block, with
// reasons.
//
// The vault contract is the hard limit: it refuses every swap outside the owner's policy whatever
// this file says. This check runs before the agent signs, so that:
//   - a swap the contract would refuse is never sent (no wasted gas, no noise on the board), and
//     the agent gets the same reason the contract would give, in words;
//   - risks the contract does not judge are flagged before they cost anything: a thin or
//     manipulated pool (price impact), a token whose contract a single key can replace, a key
//     that can do more than call the vault, and caps nearly used up.
//
// `assessSwap` is pure: it takes facts and returns a verdict, so every rule is unit-tested.
// `gatherSwapFacts` reads those facts from the chain over RPC (view calls only; it signs nothing).
//
// The block rules mirror the contract's checks in src/swap.rs (agent_swap, on_swap_quoted) and
// src/policy.rs. They use the same 24-hour window and the same slippage floor arithmetic
// (`slippage_floor`). They read state that can change before the swap lands, so a swap this check
// allows can still be refused by the contract; the reverse should not happen.

/** The contract's 24-hour window for caps and counts (src/spend.rs WINDOW_NS). */
export const WINDOW_NS = 24n * 60n * 60n * 1_000_000_000n;
const BPS = 10_000n;

/** Price impact (bps) above which the check warns, and above which it blocks. */
export const IMPACT_WARN_BPS = 100n; // 1%
export const IMPACT_BLOCK_BPS = 500n; // 5%
/** Share of a cap or count already used above which the check warns. */
export const NEAR_LIMIT_SHARE_BPS = 8_000n; // 80%
/** The agent methods a vault key needs; anything wider is reported. */
export const AGENT_METHODS = ["agent_spend", "agent_swap", "agent_intent_swap", "settle_intent_swap"];

/** The contract's slippage floor: quote * (10000 - bps) / 10000, rounded down (src/swap.rs). */
export function slippageFloor(quote, maxSlippageBps) {
  const q = BigInt(quote);
  const keep = BPS - BigInt(maxSlippageBps);
  return (q / BPS) * keep + ((q % BPS) * keep) / BPS;
}

/**
 * Price impact of the full trade, in bps: how much worse the rate for `amountIn` is than the rate
 * for a small `probeIn`. The pool's fee is in both rates, so it cancels. Null if not computable.
 */
export function priceImpactBps(amountIn, quote, probeIn, probeQuote) {
  const a = BigInt(amountIn);
  const q = BigInt(quote);
  const p = BigInt(probeIn);
  const pq = BigInt(probeQuote);
  if (a <= 0n || p <= 0n || pq <= 0n) return null;
  // rate(full) / rate(probe) = (q / a) / (pq / p) = q * p / (pq * a)
  const ratioBps = (q * p * BPS) / (pq * a);
  return ratioBps >= BPS ? 0n : BPS - ratioBps;
}

function counts(spend, nowNs) {
  return BigInt(spend.timestamp) + WINDOW_NS > nowNs;
}

/** How much of `tokenId` the vault's agent sold in the last 24 hours (or NEAR sent, for null). */
export function soldInWindow(recentSpends, tokenId, nowNs) {
  let total = 0n;
  for (const s of recentSpends ?? []) {
    if ((s.token_id ?? null) === tokenId && counts(s, nowNs)) total += BigInt(s.amount);
  }
  return total;
}

/** Agent spends and swaps in the last 24 hours, the count `max_spends_per_24h` limits. */
export function spendsInWindow(recentSpends, nowNs) {
  return (recentSpends ?? []).filter((s) => counts(s, nowNs)).length;
}

/** Describes an access key's permission: "full", "vault-only" (exactly agent methods), "wider" or "other". */
export function keyScope(permission, vaultId) {
  if (permission === "FullAccess" || permission?.FullAccess !== undefined) return "full";
  const call = permission?.FunctionCall;
  if (!call || call.receiver_id !== vaultId) return "other";
  const methods = call.method_names ?? [];
  if (methods.length === 0) return "wider"; // an empty list allows every method of the receiver
  return methods.every((m) => AGENT_METHODS.includes(m)) ? "vault-only" : "wider";
}

/**
 * The verdict for one planned `agent_swap`.
 *
 * facts: {
 *   vaultId, ownerId, agentId, poolId (number), tokenIn, tokenOut,
 *   amountIn, minAmountOut (strings or bigints, smallest units),
 *   nowNs (bigint, chain time),
 *   vault: get_vault result or null,
 *   quote: exchange get_return for amountIn, or null if it failed,
 *   probeIn, probeQuote: a small trade's input and quote, for price impact (optional),
 *   agentKeyPermission: the signing key's permission from view_access_key (optional),
 *   tokenOutFullAccessKeys: number of full-access keys on tokenOut's account (optional),
 * }
 * returns { verdict: "allow" | "warn" | "block", reasons: [{ level, code, message }], quote, floor, suggestedMinOut, impactBps }
 */
export function assessSwap(f) {
  const reasons = [];
  const block = (code, message) => reasons.push({ level: "block", code, message });
  const warn = (code, message) => reasons.push({ level: "warn", code, message });
  const amountIn = BigInt(f.amountIn ?? 0);
  const minOut = BigInt(f.minAmountOut ?? 0);
  const nowNs = BigInt(f.nowNs ?? 0);
  const out = { quote: f.quote ?? null, floor: null, suggestedMinOut: null, impactBps: null };

  if (amountIn <= 0n) block("zero_amount", "amount_in must be greater than zero.");
  if (minOut <= 0n) block("zero_min_amount_out", "min_amount_out must be greater than zero; the contract refuses an unbounded swap.");

  // The signing key. A full-access key is what Intatto exists to replace.
  if (f.agentKeyPermission?.Missing) {
    block("agent_key_missing", `The signing key is not an access key of ${f.agentId}.`);
  } else if (f.agentKeyPermission !== undefined) {
    const scope = keyScope(f.agentKeyPermission, f.vaultId);
    if (scope === "full") block("agent_key_full_access", `The signing key is a full-access key on ${f.agentId}. Use a function-call key limited to the vault's agent methods.`);
    else if (scope === "other") block("agent_key_wrong_receiver", `The signing key cannot call ${f.vaultId}.`);
    else if (scope === "wider") warn("agent_key_wider", `The signing key can call vault methods beyond the agent methods (${AGENT_METHODS.join(", ")}).`);
  }

  const v = f.vault;
  if (!v) {
    block("no_vault", `${f.ownerId} has no vault on ${f.vaultId}.`);
    return finish(reasons, out);
  }
  if (v.agent_id !== f.agentId) block("not_agent", `${f.agentId} is not this vault's agent (the agent is ${v.agent_id ?? "nobody"}).`);
  if (v.frozen) block("frozen", "The owner froze this vault; every agent call is refused until they unfreeze it.");

  const policy = v.policy ?? {};
  const pool = (policy.pools ?? []).find((p) => Number(p.pool_id) === Number(f.poolId));
  if (!pool) block("pool_not_allowlisted", `Pool ${f.poolId} is not in the owner's policy.`);
  else {
    const pair = pool.token_ids ?? [];
    if (!(pair.includes(f.tokenIn) && pair.includes(f.tokenOut) && f.tokenIn !== f.tokenOut)) {
      block("pair_mismatch", `Pool ${f.poolId} is declared for ${pair.join(" / ")}, not ${f.tokenIn} -> ${f.tokenOut}.`);
    }
  }

  const tokenPolicy = (policy.tokens ?? []).find((t) => t.token_id === f.tokenIn);
  if (!tokenPolicy) block("token_not_allowed", `${f.tokenIn} is not in the owner's token policy, so the agent may not sell it.`);
  else {
    const perTx = BigInt(tokenPolicy.per_tx_cap);
    const daily = BigInt(tokenPolicy.daily_cap);
    const sold = soldInWindow(v.recent_spends, f.tokenIn, nowNs);
    if (amountIn > perTx) block("over_per_tx_cap", `amount_in ${amountIn} is over the per-swap cap of ${perTx}.`);
    if (sold + amountIn > daily) block("over_daily_cap", `${sold} already sold in the last 24 hours; ${amountIn} more is over the daily cap of ${daily}.`);
    else if (daily > 0n && ((sold + amountIn) * BPS) / daily > NEAR_LIMIT_SHARE_BPS) {
      warn("near_daily_cap", `After this swap ${sold + amountIn} of the ${daily} daily cap is used.`);
    }
  }

  const maxSpends = BigInt(policy.max_spends_per_24h ?? 0);
  const used = BigInt(spendsInWindow(v.recent_spends, nowNs));
  if (used + 1n > maxSpends) block("too_many_spends", `${used} agent calls in the last 24 hours; the policy allows ${maxSpends}.`);
  else if (maxSpends > 0n && ((used + 1n) * BPS) / maxSpends > NEAR_LIMIT_SHARE_BPS) {
    warn("near_spend_count", `This is agent call ${used + 1n} of ${maxSpends} allowed in 24 hours.`);
  }

  const held = BigInt((v.tokens ?? []).find((t) => t.token_id === f.tokenIn)?.balance ?? 0);
  if (amountIn > held) block("insufficient_balance", `The vault holds ${held} of ${f.tokenIn}, less than amount_in ${amountIn}.`);

  // Against the exchange's own quote, as on_swap_quoted checks it.
  if (f.quote === null || f.quote === undefined) {
    block("quote_failed", `The exchange returned no quote for pool ${f.poolId}; the contract would refuse the swap.`);
  } else if (pool) {
    const quote = BigInt(f.quote);
    const floor = slippageFloor(quote, pool.max_slippage_bps);
    out.floor = floor.toString();
    // A tighter suggestion than the policy's loosest: at most 0.5% below the quote.
    const tight = slippageFloor(quote, Math.min(Number(pool.max_slippage_bps), 50));
    out.suggestedMinOut = tight.toString();
    if (minOut < floor) {
      block("slippage_too_loose", `min_amount_out ${minOut} is below the policy floor ${floor} (${pool.max_slippage_bps} bps under the quote ${quote}).`);
    } else if (quote > 0n && minOut > quote) {
      warn("min_out_above_quote", `min_amount_out ${minOut} is above the current quote ${quote}; the exchange will refuse the swap unless the price moves.`);
    } else if (quote > 0n && ((quote - minOut) * BPS) / quote > BigInt(pool.max_slippage_bps) / 2n) {
      warn("loose_min_out", `min_amount_out leaves ${((quote - minOut) * BPS) / quote} bps under the quote, over half of what the policy allows. Suggested: ${tight}.`);
    }
    if (f.probeQuote !== undefined && f.probeQuote !== null && f.probeIn) {
      const impact = priceImpactBps(amountIn, quote, f.probeIn, f.probeQuote);
      out.impactBps = impact === null ? null : impact.toString();
      if (impact !== null && impact > IMPACT_BLOCK_BPS) {
        block("price_impact", `Price impact ${impact} bps: the pool is too thin for this size, or its price was moved. Trade less or wait.`);
      } else if (impact !== null && impact > IMPACT_WARN_BPS) {
        warn("price_impact", `Price impact ${impact} bps for this size.`);
      }
    }
  }

  if (typeof f.tokenOutFullAccessKeys === "number" && f.tokenOutFullAccessKeys > 0) {
    warn("token_out_upgradeable", `${f.tokenOut} has ${f.tokenOutFullAccessKeys} full-access key(s): whoever holds one can replace the token's code.`);
  }

  return finish(reasons, out);
}

function finish(reasons, out) {
  const verdict = reasons.some((r) => r.level === "block") ? "block" : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  return { verdict, reasons, ...out, quote: out.quote === null ? null : String(out.quote) };
}

/**
 * Reads the facts `assessSwap` needs. `chain` is agent/intent-swap.mjs's Chain (rpc, view).
 * `agentPublicKey` is optional; without it the key check is skipped.
 */
export async function gatherSwapFacts(chain, p) {
  const block = await chain.rpc("block", { finality: "final" });
  const nowNs = BigInt(block.header.timestamp_nanosec ?? block.header.timestamp);
  const vault = await chain.view(p.vaultId, "get_vault", { owner_id: p.ownerId });
  const exchangeId = p.exchangeId ?? (await chain.view(p.vaultId, "get_exchange_id", {}));
  const amountIn = BigInt(p.amountIn);
  const quoteFor = async (amount) => {
    try {
      return await chain.view(exchangeId, "get_return", { pool_id: Number(p.poolId), token_in: p.tokenIn, amount_in: amount.toString(), token_out: p.tokenOut });
    } catch {
      return null;
    }
  };
  const quote = amountIn > 0n ? await quoteFor(amountIn) : null;
  const probeIn = amountIn / 100n > 0n ? amountIn / 100n : null;
  const probeQuote = probeIn ? await quoteFor(probeIn) : null;

  let agentKeyPermission;
  if (p.agentPublicKey) {
    try {
      const key = await chain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: p.agentId, public_key: p.agentPublicKey });
      agentKeyPermission = key.permission;
    } catch {
      agentKeyPermission = { Missing: true };
    }
  }
  let tokenOutFullAccessKeys;
  try {
    const list = await chain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: p.tokenOut });
    tokenOutFullAccessKeys = (list.keys ?? []).filter((k) => keyScope(k.access_key?.permission, "") === "full").length;
  } catch {
    tokenOutFullAccessKeys = undefined;
  }
  return {
    ...p,
    exchangeId,
    nowNs,
    vault,
    quote: quote === null ? null : String(quote),
    probeIn: probeIn ? probeIn.toString() : undefined,
    probeQuote: probeQuote === null ? null : String(probeQuote),
    agentKeyPermission,
    tokenOutFullAccessKeys,
  };
}
