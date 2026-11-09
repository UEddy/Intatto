/**
 * The wallet layer the screens use. Screens turn a user's choice into an Intent (pure functions,
 * src/console/intents.ts) and hand it to whichever SignerAdapter is connected. An adapter only
 * signs and submits, then returns transaction hashes; the app reads every outcome itself over
 * its own RPC. That keeps the screens identical for:
 *
 * - NearConnectAdapter (now): near-connect's signAndSendTransactions.
 * - A passkey adapter (later): signDelegateActions, posted to a relayer, which returns the hash.
 */

export interface PlannedFunctionCall {
  readonly kind: "FunctionCall";
  readonly methodName: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Gas in gas units (1 Tgas = 10^12). */
  readonly gas: bigint;
  /** Attached deposit in yoctoNEAR. */
  readonly deposit: bigint;
}

/** One transaction: every action runs in order, signed by the connected account. */
export interface TxPlan {
  readonly receiverId: string;
  readonly actions: readonly PlannedFunctionCall[];
}

/** What a screen asks for, shown in full on the review sheet before anything is signed. */
export interface Intent {
  /** Short imperative title: "Freeze the vault". */
  readonly title: string;
  /** One or two sentences in plain words: what changes on chain if this succeeds. */
  readonly summary: string;
  readonly plans: readonly TxPlan[];
  /** Things the user should know (e.g. "wNEAR is not in your policy, so the vault will refuse it"). */
  readonly warnings: readonly string[];
  /** Rejections the contract would certainly make; the review sheet refuses to submit these. */
  readonly blockers: readonly string[];
}

export interface SubmittedTx {
  readonly hash: string;
  readonly receiverId: string;
}

export interface AdapterCapabilities {
  /** Several transactions in one approval. */
  readonly batch: boolean;
}

export interface SignerAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: AdapterCapabilities;
  /** The connected account, or null. Never prompts. */
  accountId(): Promise<string | null>;
  /** Prompts the user to connect and returns the account. */
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  /** Signs and submits `plans` in order; resolves with their hashes once submitted. */
  submit(signerId: string, plans: readonly TxPlan[]): Promise<SubmittedTx[]>;
}

/** The user closed or rejected the wallet's prompt. */
export class WalletRejectedError extends Error {
  constructor(message = "The wallet request was cancelled") {
    super(message);
    this.name = "WalletRejectedError";
  }
}
