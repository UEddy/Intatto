/**
 * Passkey sign-in (mainnet only, experimental). See THREAT_MODEL.md, "Passkey sign-in".
 *
 * The passkey wallet is a near-connect sandboxed executor (NEAR-DevHub/near-connect-passkey at
 * 798e9e5), served from this site: public/wallets/passkey-executor-798e9e5.js, byte-identical to a
 * rebuild of that commit (vendor/PASSKEY-EXECUTOR.md). The account is a deterministic `0s…` wallet
 * contract; the executor signs each request with WebAuthn and relays it through Trezu's sponsor
 * contract, `helper.trezu.near`, which signs the transaction. So:
 *
 * - A request's promises run concurrently, so the adapter sends a multi-transaction plan one
 *   transaction at a time, each its own passkey prompt, and waits for each to be final.
 * - The transaction is signed by the sponsor, not the owner. Its outcome is looked up with the
 *   sponsor as sender, and checked for a receipt from the owner's account on the receiver
 *   (console/submit.ts).
 */
import type { NearWalletBase, WalletManifest } from "@hot-labs/near-connect";
import type { NetworkConfig } from "../config/networks";
import { toConnectorTransactions, outcomeHash, isRejection } from "./nearConnect";
import { WalletRejectedError, type SubmittedTx, type TxPlan } from "./types";

export const PASSKEY_WALLET_ID = "passkey";
/** NEAR-DevHub/near-connect-passkey commit whose passkey-executor.js this site serves. */
export const PASSKEY_EXECUTOR_COMMIT = "798e9e514d2b92365639927f6bbffd448cb15c60";
/** sha256 (hex) of that file, as committed and as rebuilt from source. */
export const PASSKEY_EXECUTOR_SHA256 = "2d289931d4dcefbbe84ab486616b5002d460cc9dae71f0de99c5aad74fd1a3b9";
/** The account that signs every relayed passkey transaction. */
export const PASSKEY_SPONSOR_ID = "helper.trezu.near";

/** Shown wherever the passkey path is offered or in use. */
export const PASSKEY_EXPERIMENTAL_LABEL = "Experimental: unaudited wallet contract, upgradeable by Trezu; small amounts only.";
export const PASSKEY_LOCK_ADVICE =
  "We recommend locking withdrawals: while a lock is in force, not even a changed wallet contract can take funds out of your vault.";

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23111'/%3E%3Ccircle cx='26' cy='26' r='9' fill='none' stroke='%23eee' stroke-width='3'/%3E%3Cpath d='M33 32l15 15m-6-6l5-5' fill='none' stroke='%23eee' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";

/**
 * The manifest entry, mainnet only. `version` is near-connect's cache key for the executor code
 * (it runs a cached copy first), so it names the commit: a new executor needs a new version.
 * Only this entry has the `webauthn` permission (wallet/manifest.test.ts).
 */
export function passkeyManifestEntry(baseUrl: string): WalletManifest {
  return {
    id: PASSKEY_WALLET_ID,
    name: "Passkey (experimental)",
    icon: ICON,
    description: PASSKEY_EXPERIMENTAL_LABEL,
    website: "https://github.com/NEAR-DevHub/near-connect-passkey",
    version: PASSKEY_EXECUTOR_COMMIT.slice(0, 7),
    // An absolute path: near-connect resolves relative executor URLs against location.origin.
    executor: `${baseUrl}wallets/passkey-executor-${PASSKEY_EXECUTOR_COMMIT.slice(0, 7)}.js`,
    type: "sandbox",
    platform: [],
    features: {
      signMessage: true,
      signTransaction: false,
      signInWithoutAddKey: true,
      signInAndSignMessage: true,
      signInWithFunctionCallKey: false,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
      signDelegateActions: true,
      resolveAuth: true,
      mainnet: true,
      testnet: false,
    },
    permissions: { storage: true, webauthn: true },
  };
}

/** Waits until `hash`, sent by `senderId`, is final on our RPC. */
export type WaitFinal = (hash: string, senderId: string) => Promise<void>;

interface OutcomeLike {
  transaction?: { signer_id?: unknown };
  status?: unknown;
  receipts_outcome?: ReadonlyArray<{ outcome?: { status?: unknown } }>;
}

const failed = (status: unknown) => typeof status === "object" && status !== null && "Failure" in status;

/** Whether the relayed transaction, as the executor reports it, failed anywhere. */
export function outcomeFailed(outcome: unknown): boolean {
  const o = outcome as OutcomeLike | null;
  if (!o) return true;
  return failed(o.status) || (o.receipts_outcome ?? []).some((r) => failed(r.outcome?.status));
}

/**
 * The passkey-specific half of the wallet adapter: how a connected passkey wallet submits plans.
 * NearConnectAdapter hands `submit` to it whenever the connected wallet is the passkey wallet.
 */
export class PasskeyAdapter {
  readonly label = "Passkey (experimental)";
  readonly notice = PASSKEY_EXPERIMENTAL_LABEL;
  /** One prompt per transaction, never several in one approval. */
  readonly capabilities = { batch: false };

  constructor(
    private readonly config: NetworkConfig,
    private readonly waitFinal: WaitFinal,
  ) {
    if (config.networkId !== "mainnet") throw new Error("Passkey sign-in is mainnet only");
  }

  /**
   * Sends `plans` one at a time: each is relayed, checked (signed by the sponsor, no failed
   * receipt) and final before the next is signed. Stops at the first failure: later plans depend on
   * earlier ones (a token registration before a withdrawal), and the review sheet reports what ran.
   */
  async submit(wallet: NearWalletBase, signerId: string, plans: readonly TxPlan[]): Promise<SubmittedTx[]> {
    const submitted: SubmittedTx[] = [];
    for (const [i, plan] of plans.entries()) {
      const [tx] = toConnectorTransactions([plan]);
      let outcome: unknown;
      try {
        outcome = await wallet.signAndSendTransaction({ network: this.config.networkId, signerId, receiverId: tx!.receiverId, actions: tx!.actions as never });
      } catch (e) {
        if (isRejection(e)) {
          if (submitted.length === 0) throw new WalletRejectedError();
          break; // keep what already ran; the sheet shows it
        }
        throw e;
      }
      const hash = outcomeHash(outcome);
      if (!hash) throw new Error(`The passkey wallet did not return a transaction hash for transaction ${i + 1}`);
      const sender = (outcome as OutcomeLike).transaction?.signer_id;
      if (sender !== PASSKEY_SPONSOR_ID) {
        throw new Error(`Transaction ${hash} was signed by ${String(sender)}, not the passkey sponsor ${PASSKEY_SPONSOR_ID}`);
      }
      submitted.push({ hash, receiverId: plan.receiverId, senderId: PASSKEY_SPONSOR_ID });
      if (outcomeFailed(outcome)) break;
      if (i < plans.length - 1) await this.waitFinal(hash, PASSKEY_SPONSOR_ID);
    }
    return submitted;
  }
}
