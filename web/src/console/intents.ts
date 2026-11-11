/**
 * Every owner action as an Intent: the exact transactions, plus the warnings and certain
 * rejections the UI can predict from chain state. Pure functions, unit-tested; screens only
 * collect inputs and show the result on the review sheet.
 *
 * Gas follows the contract's constants (src/lib.rs, src/swap.rs) and the smoke scripts' tested
 * values. Methods that require exactly 1 yoctoNEAR get it; `freeze` deliberately takes none, so
 * any key on the owner's account can hit the brakes.
 */
import type { Policy } from "../contract/abi.gen";
import { formatNear, formatUnits } from "../near/units";
import type { Intent, PlannedFunctionCall, TxPlan } from "../wallet/types";
import { validatePolicy } from "./policy";

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const GAS = {
  owner: 30n * TGAS,
  withdrawToken: 50n * TGAS,
  /** reclaim_from_exchange needs at least RECLAIM_TGAS = 115. */
  reclaim: 150n * TGAS,
  storageDeposit: 20n * TGAS,
  nearDeposit: 20n * TGAS,
  /** The vault's ft_on_transfer plus the token's resolve; the smoke scripts use 100. */
  ftTransferCall: 100n * TGAS,
} as const;

const call = (methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): PlannedFunctionCall => ({
  kind: "FunctionCall",
  methodName,
  args,
  gas,
  deposit,
});

const tx = (receiverId: string, ...actions: PlannedFunctionCall[]): TxPlan => ({ receiverId, actions });

export interface TokenInfo {
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface LockInfo {
  /** withdrawals_locked_until, or null if never locked. */
  readonly untilNs: bigint | null;
  /** Chain time (final block). */
  readonly nowNs: bigint;
}

export const lockActive = (l: LockInfo) => l.untilNs !== null && l.nowNs < l.untilNs;

const lockMessage = (what: string, l: LockInfo) => `${what} is refused while withdrawals are locked (until block time ${l.untilNs}).`;

/* ---------- deposits ---------- */

/** What the connected account can pay with, for the funding check. */
export interface Funding {
  readonly accountId: string;
  /** The account's NEAR balance, or null if unknown (still loading, or no such account yet). */
  readonly accountNear: bigint | null;
  /** Gas is paid by a relayer (the passkey wallet), so the account needs only what it sends. */
  readonly gasSponsored: boolean;
}

/** Gas kept back for a wallet that pays its own: the console's Max also keeps 0.05 NEAR. */
export const OWN_GAS_RESERVE = 50_000_000_000_000_000_000_000n;

/** A blocker if the account cannot pay `needed` NEAR (attached deposits) plus its own gas. */
export function fundingBlocker(needed: bigint, funding: Funding | undefined): string | null {
  if (!funding || funding.accountNear === null || needed <= 0n) return null;
  const total = needed + (funding.gasSponsored ? 0n : OWN_GAS_RESERVE);
  if (funding.accountNear >= total) return null;
  const has = `${formatNear(funding.accountNear)} NEAR`;
  if (funding.gasSponsored) {
    return `Your passkey account ${funding.accountId} holds ${has}, less than the ${formatNear(needed)} NEAR this sends. Send NEAR to ${funding.accountId} from an exchange or another wallet first: the sponsor pays the gas, but the deposit comes from your account's own balance.`;
  }
  return `Your account holds ${has}; this needs ${formatNear(needed)} NEAR plus gas (${formatNear(OWN_GAS_RESERVE)} NEAR kept back).`;
}

export function depositNear(o: { vaultId: string; amount: bigint; vaultExists: boolean; funding?: Funding }): Intent {
  const blockers: string[] = [];
  if (o.amount <= 0n) blockers.push("Enter an amount greater than zero.");
  const short = fundingBlocker(o.amount, o.funding);
  if (short) blockers.push(short);
  return {
    title: "Deposit NEAR",
    summary: `Moves ${formatNear(o.amount)} NEAR from your account into your vault.${o.vaultExists ? "" : " This first deposit creates the vault; a small part pays for its storage."}`,
    plans: [tx(o.vaultId, call("deposit", {}, GAS.owner, o.amount))],
    warnings: [],
    blockers,
  };
}

/**
 * Wrap NEAR into wNEAR and deposit it, in one transaction to the wNEAR contract: register the
 * owner and the vault with it if needed, `near_deposit`, then `ft_transfer_call` to the vault.
 */
export function wrapAndDeposit(o: {
  vaultId: string;
  ownerId: string;
  wnear: TokenInfo;
  amount: bigint;
  ownerRegistered: boolean;
  vaultRegistered: boolean;
  /** storage_balance_bounds().min of the wNEAR contract. */
  storageMin: bigint;
  tokenInPolicy: boolean;
  vaultExists: boolean;
  funding?: Funding;
}): Intent {
  const actions: PlannedFunctionCall[] = [];
  if (!o.ownerRegistered) actions.push(call("storage_deposit", { account_id: o.ownerId, registration_only: true }, GAS.storageDeposit, o.storageMin));
  if (!o.vaultRegistered) actions.push(call("storage_deposit", { account_id: o.vaultId, registration_only: true }, GAS.storageDeposit, o.storageMin));
  actions.push(call("near_deposit", {}, GAS.nearDeposit, o.amount));
  actions.push(call("ft_transfer_call", { receiver_id: o.vaultId, amount: o.amount.toString(), msg: "" }, GAS.ftTransferCall, ONE_YOCTO));
  const blockers: string[] = [];
  if (o.amount <= 0n) blockers.push("Enter an amount greater than zero.");
  if (!o.vaultExists) blockers.push("Deposit some NEAR first: the vault must exist, and it pays for this token's storage from its NEAR balance.");
  if (!o.tokenInPolicy) blockers.push(`${o.wnear.symbol} is not in your policy, so the vault would refuse it. Add it in the policy first.`);
  const registrations = (o.ownerRegistered ? 0 : 1) + (o.vaultRegistered ? 0 : 1);
  const short = fundingBlocker(o.amount + BigInt(registrations) * o.storageMin + 1n, o.funding);
  if (short) blockers.push(short);
  return {
    title: `Wrap and deposit ${o.wnear.symbol}`,
    summary: `Wraps ${formatUnits(o.amount, o.wnear.decimals)} NEAR into ${o.wnear.symbol} and deposits it into your vault, in one transaction.`,
    plans: [tx(o.wnear.id, ...actions)],
    warnings: registrations > 0 ? [`Includes ${registrations} storage registration${registrations > 1 ? "s" : ""} with ${o.wnear.symbol} (${formatNear(o.storageMin)} NEAR each).`] : [],
    blockers,
  };
}

/** A token the owner already holds, sent with ft_transfer_call. */
export function depositToken(o: { vaultId: string; token: TokenInfo; amount: bigint; held: bigint; vaultRegistered: boolean; tokenInPolicy: boolean; vaultExists: boolean }): Intent {
  const blockers: string[] = [];
  if (o.amount <= 0n) blockers.push("Enter an amount greater than zero.");
  if (o.amount > o.held) blockers.push(`You hold ${formatUnits(o.held, o.token.decimals)} ${o.token.symbol}.`);
  if (!o.vaultExists) blockers.push("Deposit some NEAR first: the vault must exist.");
  if (!o.tokenInPolicy) blockers.push(`${o.token.symbol} is not in your policy, so the vault would refuse it. Add it in the policy first.`);
  if (!o.vaultRegistered) blockers.push(`The vault is not registered with ${o.token.symbol}, so the transfer would fail.`);
  return {
    title: `Deposit ${o.token.symbol}`,
    summary: `Sends ${formatUnits(o.amount, o.token.decimals)} ${o.token.symbol} from your account into your vault.`,
    plans: [tx(o.token.id, call("ft_transfer_call", { receiver_id: o.vaultId, amount: o.amount.toString(), msg: "" }, GAS.ftTransferCall, ONE_YOCTO))],
    warnings: [],
    blockers,
  };
}

/* ---------- agent and policy ---------- */

export function setAgent(o: { vaultId: string; agentId: string; policy: Policy; current: { agentId: string | null; policy: Policy } | null; lock: LockInfo; vaultBalance: bigint }): Intent {
  const blockers = [...validatePolicy(o.policy, o.vaultId)];
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(o.agentId) || o.agentId.length < 2 || o.agentId.length > 64) blockers.push("The agent must be a valid NEAR account id.");
  if (lockActive(o.lock)) blockers.push(lockMessage("Changing the agent or policy", o.lock));
  const warnings: string[] = [];
  if (o.current?.agentId && o.current.agentId !== o.agentId) warnings.push(`This replaces your current agent, ${o.current.agentId}. It can no longer act for this vault.`);
  if (o.vaultBalance === 0n) warnings.push("The policy's storage is paid from the vault's NEAR balance, which is empty: deposit NEAR first or the call fails.");
  return {
    title: o.current?.agentId ? "Update agent and policy" : "Set agent and policy",
    summary: `Lets ${o.agentId} act for your vault, only within the policy below. The contract checks every agent call against it.`,
    plans: [tx(o.vaultId, call("set_agent", { agent_id: o.agentId, policy: o.policy }, GAS.owner, ONE_YOCTO))],
    warnings,
    blockers,
  };
}

export function removeAgent(o: { vaultId: string; agentId: string | null }): Intent {
  return {
    title: "Remove the agent",
    summary: `Removes ${o.agentId ?? "the agent"} and clears the policy. Nobody can spend or swap from the vault until you set a new agent.`,
    plans: [tx(o.vaultId, call("remove_agent", {}, GAS.owner, ONE_YOCTO))],
    warnings: [],
    blockers: o.agentId ? [] : ["There is no agent to remove."],
  };
}

/* ---------- brakes ---------- */

export function freeze(o: { vaultId: string; frozen: boolean }): Intent {
  return {
    title: "Freeze the vault",
    summary: "Blocks every agent spend and swap from the next agent call on. Your funds stay in the vault, and you can still withdraw them.",
    plans: [tx(o.vaultId, call("freeze", {}, GAS.owner, 0n))],
    warnings: o.frozen ? ["The vault is already frozen."] : [],
    blockers: [],
  };
}

export function unfreeze(o: { vaultId: string; frozen: boolean }): Intent {
  return {
    title: "Unfreeze the vault",
    summary: "Lets the agent spend and swap again, within the policy.",
    plans: [tx(o.vaultId, call("unfreeze", {}, GAS.owner, ONE_YOCTO))],
    warnings: o.frozen ? [] : ["The vault is not frozen."],
    blockers: [],
  };
}

/* ---------- withdrawals and the lock ---------- */

export function withdrawNear(o: { vaultId: string; amount: bigint; balance: bigint; lock: LockInfo }): Intent {
  const blockers: string[] = [];
  if (o.amount <= 0n) blockers.push("Enter an amount greater than zero.");
  if (o.amount > o.balance) blockers.push(`The vault holds ${formatNear(o.balance)} NEAR.`);
  if (lockActive(o.lock)) blockers.push(lockMessage("Withdrawing", o.lock));
  return {
    title: "Withdraw NEAR",
    summary: `Sends ${formatNear(o.amount)} NEAR from your vault back to your account.`,
    plans: [tx(o.vaultId, call("withdraw", { amount: o.amount.toString() }, GAS.owner, ONE_YOCTO))],
    warnings: [],
    blockers,
  };
}

/** If the owner is not registered with the token, registration goes first, as its own transaction. */
export function withdrawToken(o: { vaultId: string; ownerId: string; token: TokenInfo; amount: bigint; balance: bigint; ownerRegistered: boolean; storageMin: bigint; lock: LockInfo }): Intent {
  const blockers: string[] = [];
  if (o.amount <= 0n) blockers.push("Enter an amount greater than zero.");
  if (o.amount > o.balance) blockers.push(`The vault holds ${formatUnits(o.balance, o.token.decimals)} ${o.token.symbol}.`);
  if (lockActive(o.lock)) blockers.push(lockMessage("Withdrawing", o.lock));
  const plans: TxPlan[] = [];
  if (!o.ownerRegistered) plans.push(tx(o.token.id, call("storage_deposit", { account_id: o.ownerId, registration_only: true }, GAS.storageDeposit, o.storageMin)));
  plans.push(tx(o.vaultId, call("withdraw_token", { token_id: o.token.id, amount: o.amount.toString() }, GAS.withdrawToken, ONE_YOCTO)));
  return {
    title: `Withdraw ${o.token.symbol}`,
    summary: `Sends ${formatUnits(o.amount, o.token.decimals)} ${o.token.symbol} from your vault back to your account.`,
    plans,
    warnings: o.ownerRegistered ? [] : [`Your account is not registered with ${o.token.symbol}; the first transaction registers it (${formatNear(o.storageMin)} NEAR).`],
    blockers,
  };
}

export function lockWithdrawals(o: { vaultId: string; untilNs: bigint; lock: LockInfo }): Intent {
  const blockers: string[] = [];
  if (o.lock.untilNs !== null && o.untilNs < o.lock.untilNs) blockers.push("A lock can only be extended, never shortened, even after it has expired.");
  if (o.untilNs <= o.lock.nowNs) blockers.push("Pick a time in the future.");
  return {
    title: "Lock withdrawals",
    summary: "Blocks withdrawals and any change of agent or policy until the time below. Your agent keeps acting within its current policy, and you can still freeze.",
    plans: [tx(o.vaultId, call("lock_withdrawals_until", { timestamp_ns: o.untilNs.toString() }, GAS.owner, ONE_YOCTO))],
    warnings: [
      "Not even you can withdraw or change the policy until then. There is no way to undo or shorten it.",
      "Your current agent and policy stay in force: the lock protects the vault only as far as that policy does.",
    ],
    blockers,
  };
}

export function reclaim(o: { vaultId: string; token: TokenInfo; onExchange: bigint; inFlight: number }): Intent {
  const blockers: string[] = [];
  if (o.onExchange <= 0n) blockers.push(`Nothing of ${o.token.symbol} is left on the exchange.`);
  if (o.inFlight > 0) blockers.push(`A swap or reclaim of ${o.token.symbol} is in flight; the contract refuses until it settles.`);
  return {
    title: `Reclaim ${o.token.symbol} from the exchange`,
    summary: `Retries withdrawing your ${formatUnits(o.onExchange, o.token.decimals)} ${o.token.symbol} left in the vault's exchange account after an earlier withdrawal failed. The contract first checks the exchange holds everything owners are owed.`,
    plans: [tx(o.vaultId, call("reclaim_from_exchange", { token_id: o.token.id }, GAS.reclaim, ONE_YOCTO))],
    warnings: [],
    blockers,
  };
}
