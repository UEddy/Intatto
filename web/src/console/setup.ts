import type { VaultView } from "../contract/abi.gen";
import type { AccessKeyPermission } from "../near/chain";

/** The vault methods an agent key may call; a key limited to these cannot move the owner's money out. */
export const AGENT_METHODS = ["agent_spend", "agent_swap", "agent_intent_swap", "settle_intent_swap"];

export type StepState = "done" | "next" | "todo";

export interface SetupStep {
  readonly id: "fund" | "agent" | "key" | "trade" | "lock";
  readonly title: string;
  readonly detail: string;
  /** The console section that does this step. */
  readonly target: "deposit" | "policy" | "next" | "lock";
  readonly state: StepState;
  readonly optional?: boolean;
}

/** Whether one of the agent's keys is a function-call key on this vault, limited to agent methods. */
export function hasVaultKey(keys: readonly { permission: AccessKeyPermission }[] | null | undefined, vaultId: string): boolean | null {
  if (keys == null) return null;
  return keys.some((k) => {
    if (k.permission === "FullAccess") return false;
    const call = k.permission.FunctionCall;
    return call.receiver_id === vaultId && call.method_names.length > 0 && call.method_names.every((m) => AGENT_METHODS.includes(m));
  });
}

/**
 * The owner's setup, derived from chain state only: fund the vault, name the agent with its
 * limits (set_agent sets both), give the agent a vault-only key, see it act. Locking withdrawals
 * is optional. The first step not done is "next".
 */
export function setupSteps(vault: VaultView | null, agentHasVaultKey: boolean | null, lockActive: boolean): SetupStep[] {
  const funded = !!vault && (BigInt(vault.balance) > 0n || vault.tokens.some((t) => BigInt(t.balance) > 0n));
  const agent = !!vault?.agent_id;
  const acted = !!vault && vault.recent_spends.length > 0;
  const raw: Omit<SetupStep, "state">[] = [
    { id: "fund", title: "Fund the vault", detail: "Deposit NEAR or tokens. Only you can withdraw them.", target: "deposit" },
    { id: "agent", title: "Name the agent and its limits", detail: "Caps, tokens, pools and slippage, checked by the contract on every call.", target: "policy" },
    { id: "key", title: "Give the agent a vault-only key", detail: "A function-call key for the agent methods only. It cannot withdraw.", target: "next" },
    { id: "trade", title: "Connect the agent", detail: "Any agent that signs NEAR transactions, or any MCP client. Its calls show up here.", target: "next" },
    { id: "lock", title: "Lock withdrawals", detail: "Optional: proves to others you cannot pull the funds before a date.", target: "lock", optional: true },
  ];
  const done: Record<SetupStep["id"], boolean> = { fund: funded, agent, key: agentHasVaultKey === true, trade: acted, lock: lockActive };
  let nextGiven = false;
  return raw.map((s) => {
    if (done[s.id]) return { ...s, state: "done" as const };
    if (!nextGiven && !s.optional) {
      nextGiven = true;
      return { ...s, state: "next" as const };
    }
    return { ...s, state: "todo" as const };
  });
}

/** Required steps done, and how many there are. */
export function progress(steps: readonly SetupStep[]): { done: number; total: number } {
  const required = steps.filter((s) => !s.optional);
  return { done: required.filter((s) => s.state === "done").length, total: required.length };
}
