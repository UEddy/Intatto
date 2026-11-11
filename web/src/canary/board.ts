/**
 * The break-price board's state, computed from chain reads only. Pure: the queries feed it, the
 * tests drive it directly.
 *
 * Break rule (THREAT_MODEL.md): any decrease of the canary vault's balances below the post-setup
 * baseline is a break. The vault's tokens must stay empty (the policy accepts none).
 */
import type { Policy, VaultView } from "../contract/abi.gen";
import { eventsFromReceipt } from "../contract/events";
import { base58ToHex } from "../near/base58";
import type { TxOutcome } from "../near/chain";

/** The zero-outflow policy the canary was set up with (scripts/canary-testnet.sh). */
export const CANARY_POLICY: Policy = {
  per_tx_cap: "0",
  daily_cap: "0",
  max_spends_per_24h: 1,
  allowlist: [],
  tokens: [],
  pools: [],
};

export interface BaselineCheck {
  /** The withdrawals_locked event the setup transaction logged. */
  readonly lockedUntilNs: bigint;
  /** When that receipt executed: the block timestamp the board counts "unbroken" from. */
  readonly lockSetAtNs: bigint;
  readonly lockSetBlockHeight: number;
  readonly lockSetBlockHash: string;
}

export type BaselineProblem =
  | "tx_not_found"
  | "wrong_signer"
  | "wrong_receiver"
  | "no_lock_event"
  | "tx_failed";

/**
 * Checks that the configured setup transaction is what it claims: signed by the canary owner,
 * sent to the vault, and logging `withdrawals_locked` for that owner from the vault contract.
 * Returns the receipt's block hash, whose timestamp is the lock's start.
 */
export function checkBaselineTx(
  tx: TxOutcome | null,
  canary: { readonly ownerId: string },
  vaultId: string,
): { ok: true; lockedUntilNs: bigint; blockHash: string } | { ok: false; problem: BaselineProblem } {
  if (!tx) return { ok: false, problem: "tx_not_found" };
  // The node looks a transaction up by hash alone; the sender in the request is not checked.
  if (tx.signerId !== canary.ownerId) return { ok: false, problem: "wrong_signer" };
  if (tx.receiverId !== vaultId) return { ok: false, problem: "wrong_receiver" };
  if (tx.receipts.some((r) => r.status === "failure")) return { ok: false, problem: "tx_failed" };
  for (const r of tx.receipts) {
    for (const p of eventsFromReceipt(r, vaultId)) {
      if (p.kind === "event" && p.event.event === "withdrawals_locked" && p.event.data.owner_id === canary.ownerId) {
        return { ok: true, lockedUntilNs: BigInt(p.event.data.locked_until), blockHash: r.blockHash };
      }
    }
  }
  return { ok: false, problem: "no_lock_event" };
}

export type RunStartProblem = "tx_not_found" | "wrong_signer" | "wrong_receiver" | "tx_failed" | "no_deploy" | "other_code";

/**
 * Checks the transaction that started the current canary run: a code deployment by the vault
 * account to itself, of exactly the code the run covers. RPC reports a DeployContract's code as
 * the base64 SHA-256 of the wasm, which must equal `codeHash` (base58). Returns the block of the
 * deployment's receipt, whose timestamp is the run's start.
 */
export function checkRunStartTx(
  tx: TxOutcome | null,
  vaultId: string,
  codeHash: string,
): { ok: true; blockHash: string } | { ok: false; problem: RunStartProblem } {
  if (!tx) return { ok: false, problem: "tx_not_found" };
  if (tx.signerId !== vaultId) return { ok: false, problem: "wrong_signer" };
  if (tx.receiverId !== vaultId) return { ok: false, problem: "wrong_receiver" };
  if (tx.receipts.some((r) => r.status !== "success")) return { ok: false, problem: "tx_failed" };
  const deploy = tx.actions.find((a): a is { DeployContract: { code: string } } => {
    const d = (a as { DeployContract?: { code?: unknown } } | null)?.DeployContract;
    return typeof d?.code === "string";
  });
  if (!deploy) return { ok: false, problem: "no_deploy" };
  let digestHex: string;
  try {
    digestHex = Array.from(atob(deploy.DeployContract.code), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return { ok: false, problem: "other_code" };
  }
  let expectedHex: string;
  try {
    expectedHex = base58ToHex(codeHash);
  } catch {
    return { ok: false, problem: "other_code" };
  }
  if (digestHex !== expectedHex) return { ok: false, problem: "other_code" };
  const first = tx.receipts.find((r) => r.executorId === vaultId);
  if (!first) return { ok: false, problem: "no_deploy" };
  return { ok: true, blockHash: first.blockHash };
}

export interface RunStart {
  readonly atNs: bigint;
  readonly blockHeight: number;
  readonly blockHash: string;
}

/**
 * When the current run started: a run covers one build with the canary in place, so it starts at
 * the later of the verified deployment of that build and the verified setup (the lock's receipt).
 * On testnet the upgrade came after the setup; on mainnet the canary was set up on a vault that
 * already ran the build. Null until both are verified.
 */
export function runStartOf(
  deploy: RunStart | null,
  setup: BaselineCheck | null,
): (RunStart & { readonly by: "deploy" | "setup" }) | null {
  if (!deploy || !setup) return null;
  if (setup.lockSetAtNs > deploy.atNs) {
    return { atNs: setup.lockSetAtNs, blockHeight: setup.lockSetBlockHeight, blockHash: setup.lockSetBlockHash, by: "setup" };
  }
  return { ...deploy, by: "deploy" };
}

export type SealState = "intact" | "broken" | "unknown";

export interface BoardInput {
  readonly vault: VaultView | null | undefined;
  readonly baselineYocto: bigint;
  readonly baseline: BaselineCheck | null;
  /** The verified start of the current run (runStartOf), if any. */
  readonly runStart: RunStart | null;
  /** The vault's code no longer matches the build the run covers: the run has ended. */
  readonly codeChanged: boolean;
  readonly nowNs: bigint | null;
}

export interface BoardState {
  readonly seal: SealState;
  /** Why the seal is broken, or what changed in the setup without breaking it. */
  readonly breaks: readonly string[];
  readonly warnings: readonly string[];
  readonly bountyYocto: bigint | null;
  readonly unbrokenForNs: bigint | null;
  /** The run ended because the code changed (not a break). */
  readonly runEnded: boolean;
  readonly lockedUntilNs: bigint | null;
  readonly lockRemainingNs: bigint | null;
  readonly lockExpired: boolean;
}

export function boardState(input: BoardInput): BoardState {
  const { vault, baselineYocto, baseline, runStart, codeChanged, nowNs } = input;
  const empty: BoardState = {
    seal: "unknown",
    breaks: [],
    warnings: [],
    bountyYocto: null,
    unbrokenForNs: null,
    runEnded: false,
    lockedUntilNs: null,
    lockRemainingNs: null,
    lockExpired: false,
  };
  if (vault === undefined) return empty;
  if (vault === null) return { ...empty, seal: "broken", breaks: ["The canary vault no longer exists."] };

  const balance = BigInt(vault.balance);
  const breaks: string[] = [];
  const warnings: string[] = [];
  if (balance < baselineYocto) breaks.push("The vault's NEAR balance is below the baseline.");
  if (vault.tokens.some((t) => BigInt(t.balance) > 0n || BigInt(t.on_exchange) > 0n)) {
    warnings.push("The vault holds tokens, which the canary's policy does not accept.");
  }
  if (balance > baselineYocto) warnings.push("The vault's balance is above the baseline: the owner deposited more.");
  if (!samePolicy(vault.policy, CANARY_POLICY)) warnings.push("The canary's policy is no longer the zero-outflow policy.");
  if (vault.frozen) warnings.push("The canary vault is frozen, so the agent key is blocked by the freeze, not only by the policy.");
  if (!baseline) warnings.push("The setup transaction could not be verified.");

  const lockedUntilNs = vault.withdrawals_locked_until ? BigInt(vault.withdrawals_locked_until) : null;
  const lockRemainingNs = lockedUntilNs !== null && nowNs !== null ? lockedUntilNs - nowNs : null;
  const lockExpired = lockRemainingNs !== null && lockRemainingNs <= 0n;
  if (lockedUntilNs === null) warnings.push("Withdrawals were never locked.");
  if (baseline && lockedUntilNs !== null && lockedUntilNs !== baseline.lockedUntilNs) {
    warnings.push("The lock was extended after setup.");
  }

  const seal: SealState = breaks.length > 0 ? "broken" : "intact";
  return {
    seal,
    breaks,
    warnings,
    bountyYocto: balance,
    // Counted from the start of the current run; it stops when the run ends or the seal breaks.
    unbrokenForNs: seal === "intact" && !codeChanged && runStart && nowNs !== null ? nowNs - runStart.atNs : null,
    runEnded: codeChanged,
    lockedUntilNs,
    lockRemainingNs: lockRemainingNs !== null && lockRemainingNs > 0n ? lockRemainingNs : lockRemainingNs === null ? null : 0n,
    lockExpired,
  };
}

function samePolicy(a: Policy, b: Policy): boolean {
  const norm = (p: Policy) =>
    JSON.stringify({
      per_tx_cap: p.per_tx_cap,
      daily_cap: p.daily_cap,
      max_spends_per_24h: p.max_spends_per_24h,
      allowlist: [...p.allowlist].sort(),
      tokens: p.tokens,
      pools: p.pools,
    });
  return norm(a) === norm(b);
}

export type IntegrityState = "matches" | "changed" | "unconfigured" | "unknown";

/**
 * `onChain`: the vault account's code hash; null if the account no longer exists (which is a
 * change), undefined if it has not been read yet.
 */
export function integrityState(onChain: string | null | undefined, expected: string | null): IntegrityState {
  if (onChain === undefined) return "unknown";
  if (!expected) return "unconfigured";
  return onChain === expected ? "matches" : "changed";
}
