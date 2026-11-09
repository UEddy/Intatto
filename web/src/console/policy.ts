/**
 * The policy in plain language and on chain. `validatePolicy` mirrors the contract's
 * `Policy::validate` (src/policy.rs) check for check, so the review sheet can refuse what
 * `set_agent` would reject; the contract remains the authority.
 */
import type { Policy } from "../contract/abi.gen";
import { formatNear, formatUnits, NEAR_DECIMALS, parseUnits } from "../near/units";

export const MAX_ALLOWLIST_LEN = 50;
export const MAX_SPENDS_PER_24H_LIMIT = 100;
export const MAX_POLICY_TOKENS = 10;
export const MAX_POLICY_POOLS = 20;
export const MAX_SLIPPAGE_BPS = 1000;

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (s: string) => s.length >= 2 && s.length <= 64 && ACCOUNT.test(s);

export function validatePolicy(p: Policy, vaultId: string): string[] {
  const errors: string[] = [];
  const allow = [...new Set(p.allowlist)];
  if (allow.length > MAX_ALLOWLIST_LEN) errors.push(`At most ${MAX_ALLOWLIST_LEN} payment receivers.`);
  if (allow.includes(vaultId)) errors.push("The vault contract itself cannot be a payment receiver.");
  for (const a of allow) if (!isAccount(a)) errors.push(`"${a}" is not a valid account id.`);
  if (BigInt(p.per_tx_cap) > BigInt(p.daily_cap)) errors.push("The NEAR per-payment cap cannot exceed the 24-hour cap.");
  if (p.max_spends_per_24h < 1 || p.max_spends_per_24h > MAX_SPENDS_PER_24H_LIMIT) errors.push(`Actions per 24 hours must be between 1 and ${MAX_SPENDS_PER_24H_LIMIT}.`);
  if (p.tokens.length > MAX_POLICY_TOKENS) errors.push(`At most ${MAX_POLICY_TOKENS} tokens.`);
  p.tokens.forEach((t, i) => {
    if (p.tokens.slice(0, i).some((o) => o.token_id === t.token_id)) errors.push(`${t.token_id} is listed twice.`);
    if (BigInt(t.per_tx_cap) > BigInt(t.daily_cap)) errors.push(`The per-trade cap of ${t.token_id} cannot exceed its 24-hour cap.`);
  });
  if (p.pools.length > MAX_POLICY_POOLS) errors.push(`At most ${MAX_POLICY_POOLS} pools.`);
  p.pools.forEach((pool, i) => {
    if (p.pools.slice(0, i).some((o) => o.pool_id === pool.pool_id)) errors.push(`Pool ${pool.pool_id} is listed twice.`);
    if (pool.token_ids[0] === pool.token_ids[1]) errors.push(`Pool ${pool.pool_id} must list two different tokens.`);
    if (pool.max_slippage_bps < 1 || pool.max_slippage_bps > MAX_SLIPPAGE_BPS) errors.push(`Maximum slippage must be between 0.01% and ${MAX_SLIPPAGE_BPS / 100}%.`);
    for (const id of pool.token_ids) if (!p.tokens.some((t) => t.token_id === id)) errors.push(`Pool ${pool.pool_id} uses ${id}, which has no caps in the policy.`);
  });
  return errors;
}

/* ---------- the plain-language form ---------- */

export interface TokenMeta {
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface PolicyForm {
  readonly agentId: string;
  readonly maxActions: string;
  /** One row per configured token: accepted by the vault, and how much of it the agent may sell. */
  readonly tokens: readonly { readonly id: string; readonly accepted: boolean; readonly perTrade: string; readonly perDay: string }[];
  readonly pool: { readonly enabled: boolean; readonly slippagePercent: string };
  readonly payments: { readonly perPayment: string; readonly perDay: string; readonly receivers: string };
}

export function emptyForm(tokens: readonly TokenMeta[]): PolicyForm {
  return {
    agentId: "",
    maxActions: "10",
    tokens: tokens.map((t) => ({ id: t.id, accepted: true, perTrade: "0", perDay: "0" })),
    pool: { enabled: false, slippagePercent: "1" },
    payments: { perPayment: "0", perDay: "0", receivers: "" },
  };
}

export function policyToForm(agentId: string | null, p: Policy, tokens: readonly TokenMeta[], poolId: number): PolicyForm {
  const pool = p.pools.find((x) => x.pool_id === poolId);
  return {
    agentId: agentId ?? "",
    maxActions: String(p.max_spends_per_24h),
    tokens: tokens.map((t) => {
      const tp = p.tokens.find((x) => x.token_id === t.id);
      return {
        id: t.id,
        accepted: tp !== undefined,
        perTrade: tp ? formatUnits(BigInt(tp.per_tx_cap), t.decimals, { group: false }) : "0",
        perDay: tp ? formatUnits(BigInt(tp.daily_cap), t.decimals, { group: false }) : "0",
      };
    }),
    pool: { enabled: pool !== undefined, slippagePercent: pool ? String(pool.max_slippage_bps / 100) : "1" },
    payments: {
      perPayment: formatNear(BigInt(p.per_tx_cap), { group: false }),
      perDay: formatNear(BigInt(p.daily_cap), { group: false }),
      receivers: p.allowlist.join("\n"),
    },
  };
}

export type FormResult = { ok: true; policy: Policy } | { ok: false; errors: Record<string, string> };

/** Percent text with at most two decimals ("0.5" -> 50 bps). */
export function percentToBps(text: string): number | null {
  const r = parseUnits(text, 2);
  if (!r.ok || r.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(r.value);
}

export function formToPolicy(f: PolicyForm, tokens: readonly TokenMeta[], pool: { id: number; tokenIds: readonly [string, string] }): FormResult {
  const errors: Record<string, string> = {};
  const n = Number(f.maxActions);
  if (!/^\d+$/.test(f.maxActions.trim()) || n < 1 || n > MAX_SPENDS_PER_24H_LIMIT) errors.maxActions = `A whole number from 1 to ${MAX_SPENDS_PER_24H_LIMIT}.`;

  const tokenPolicies: Policy["tokens"] = [];
  for (const row of f.tokens) {
    if (!row.accepted) continue;
    const meta = tokens.find((t) => t.id === row.id);
    if (!meta) continue;
    const per = parseUnits(row.perTrade, meta.decimals);
    const day = parseUnits(row.perDay, meta.decimals);
    if (!per.ok) errors[`token.${row.id}.perTrade`] = per.error;
    if (!day.ok) errors[`token.${row.id}.perDay`] = day.error;
    if (per.ok && day.ok) {
      if (per.value > day.value) errors[`token.${row.id}.perTrade`] = "Cannot exceed the 24-hour cap.";
      tokenPolicies.push({ token_id: row.id, per_tx_cap: per.value.toString(), daily_cap: day.value.toString() });
    }
  }

  const pools: Policy["pools"] = [];
  if (f.pool.enabled) {
    const bps = percentToBps(f.pool.slippagePercent);
    if (bps === null || bps < 1 || bps > MAX_SLIPPAGE_BPS) errors["pool.slippage"] = `From 0.01% to ${MAX_SLIPPAGE_BPS / 100}%.`;
    for (const id of pool.tokenIds) {
      if (!tokenPolicies.some((t) => t.token_id === id)) errors[`token.${id}.accepted`] = "Swaps through the pool need both of its tokens in the policy (a cap of 0 forbids selling it).";
    }
    if (bps !== null) pools.push({ pool_id: pool.id, token_ids: [pool.tokenIds[0], pool.tokenIds[1]], max_slippage_bps: bps });
  }

  const per = parseUnits(f.payments.perPayment, NEAR_DECIMALS);
  const day = parseUnits(f.payments.perDay, NEAR_DECIMALS);
  if (!per.ok) errors["payments.perPayment"] = per.error;
  if (!day.ok) errors["payments.perDay"] = day.error;
  if (per.ok && day.ok && per.value > day.value) errors["payments.perPayment"] = "Cannot exceed the 24-hour cap.";
  const receivers = [
    ...new Set(
      f.payments.receivers
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
  const bad = receivers.filter((r) => !isAccount(r));
  if (bad.length) errors["payments.receivers"] = `Not account ids: ${bad.join(", ")}`;
  if (receivers.length > MAX_ALLOWLIST_LEN) errors["payments.receivers"] = `At most ${MAX_ALLOWLIST_LEN} receivers.`;

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      per_tx_cap: per.ok ? per.value.toString() : "0",
      daily_cap: day.ok ? day.value.toString() : "0",
      max_spends_per_24h: n,
      allowlist: receivers,
      tokens: tokenPolicies,
      pools,
    },
  };
}

/* ---------- before and after ---------- */

export interface PolicyChange {
  readonly what: string;
  readonly before: string;
  readonly after: string;
}

export function diffPolicy(before: Policy | null, after: Policy, tokens: readonly TokenMeta[]): PolicyChange[] {
  const b: Policy = before ?? { per_tx_cap: "0", daily_cap: "0", max_spends_per_24h: 0, allowlist: [], tokens: [], pools: [] };
  const out: PolicyChange[] = [];
  const push = (what: string, x: string, y: string) => x !== y && out.push({ what, before: x, after: y });
  const sym = (id: string) => tokens.find((t) => t.id === id)?.symbol ?? id;
  const amt = (id: string, raw: string | undefined) => {
    if (raw === undefined) return "not accepted";
    const t = tokens.find((x) => x.id === id);
    return t ? `${formatUnits(BigInt(raw), t.decimals)} ${t.symbol}` : `${raw} (raw)`;
  };
  push("Actions per 24 hours", before ? String(b.max_spends_per_24h) : "none", String(after.max_spends_per_24h));
  const ids = [...new Set([...b.tokens, ...after.tokens].map((t) => t.token_id))];
  for (const id of ids) {
    const x = b.tokens.find((t) => t.token_id === id);
    const y = after.tokens.find((t) => t.token_id === id);
    push(`${sym(id)} per trade`, amt(id, x?.per_tx_cap), amt(id, y?.per_tx_cap));
    push(`${sym(id)} per 24 hours`, amt(id, x?.daily_cap), amt(id, y?.daily_cap));
  }
  const poolIds = [...new Set([...b.pools, ...after.pools].map((p) => p.pool_id))];
  for (const id of poolIds) {
    const x = b.pools.find((p) => p.pool_id === id);
    const y = after.pools.find((p) => p.pool_id === id);
    push(`Pool #${id}`, x ? `allowed, max slippage ${x.max_slippage_bps / 100}%` : "not allowed", y ? `allowed, max slippage ${y.max_slippage_bps / 100}%` : "not allowed");
  }
  push("NEAR per payment", `${formatNear(BigInt(b.per_tx_cap))} NEAR`, `${formatNear(BigInt(after.per_tx_cap))} NEAR`);
  push("NEAR per 24 hours", `${formatNear(BigInt(b.daily_cap))} NEAR`, `${formatNear(BigInt(after.daily_cap))} NEAR`);
  push("Payment receivers", [...b.allowlist].sort().join(", ") || "none", [...after.allowlist].sort().join(", ") || "none");
  return out;
}
