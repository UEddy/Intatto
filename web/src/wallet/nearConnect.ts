/**
 * near-connect (@hot-labs/near-connect 0.12.0) behind the SignerAdapter interface.
 *
 * - Manifest: the pinned four-wallet copy, never the remote default, so a manifest change cannot
 *   add or swap a wallet. Executor code is still fetched from each wallet's published URL.
 * - providers: the configured RPC, so executors that broadcast use the same node the page reads.
 * - cspNonce: this page load's nonce from boot.js, so the executors' inline scripts may run.
 */
import { NearConnector, type NearWalletBase } from "@hot-labs/near-connect";
import type { NetworkConfig } from "../config/networks";
import pinned from "./manifest.pinned.json";
import { WalletRejectedError, type SignerAdapter, type SubmittedTx, type TxPlan } from "./types";

declare global {
  interface Window {
    __INTATTO_CSP_NONCE__?: string;
  }
}

export function toConnectorTransactions(plans: readonly TxPlan[]) {
  return plans.map((p) => ({
    receiverId: p.receiverId,
    actions: p.actions.map((a) => ({
      type: "FunctionCall" as const,
      params: { methodName: a.methodName, args: { ...a.args }, gas: a.gas.toString(), deposit: a.deposit.toString() },
    })),
  }));
}

/** The transaction hash from a FinalExecutionOutcome, whichever shape the wallet returns. */
export function outcomeHash(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } } | null;
  const h = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  return typeof h === "string" && h.length > 0 ? h : null;
}

function isRejection(e: unknown): boolean {
  const text = String((e as { message?: unknown })?.message ?? e).toLowerCase();
  return /\b(rejected|cancell?ed|closed|denied)\b/.test(text);
}

export class NearConnectAdapter implements SignerAdapter {
  readonly id = "near-connect";
  readonly label = "NEAR wallet";
  readonly capabilities = { batch: true };
  readonly connector: NearConnector;

  constructor(private readonly config: NetworkConfig) {
    const nonce = typeof window !== "undefined" ? window.__INTATTO_CSP_NONCE__ : undefined;
    this.connector = new NearConnector({
      network: config.networkId,
      manifest: { version: pinned.version, wallets: pinned.wallets as never },
      providers: { [config.networkId]: [config.rpcUrl] },
      footerBranding: null,
      autoConnect: true,
      ...(nonce ? { cspNonce: nonce } : {}),
    });
  }

  private async wallet(): Promise<NearWalletBase | null> {
    try {
      const { wallet } = await this.connector.getConnectedWallet();
      return wallet;
    } catch {
      return null;
    }
  }

  async accountId(): Promise<string | null> {
    try {
      const { accounts } = await this.connector.getConnectedWallet();
      return accounts[0]?.accountId ?? null;
    } catch {
      return null;
    }
  }

  async connect(): Promise<string> {
    let wallet: NearWalletBase;
    try {
      wallet = await this.connector.connect();
    } catch (e) {
      throw isRejection(e) ? new WalletRejectedError() : e;
    }
    const accounts = await wallet.getAccounts({ network: this.config.networkId });
    const id = accounts[0]?.accountId;
    if (!id) throw new Error("The wallet connected without an account");
    return id;
  }

  async disconnect(): Promise<void> {
    await this.connector.disconnect().catch(() => {});
  }

  async submit(signerId: string, plans: readonly TxPlan[]): Promise<SubmittedTx[]> {
    const wallet = await this.wallet();
    if (!wallet) throw new Error("No wallet is connected");
    let outcomes: unknown[];
    try {
      outcomes = await wallet.signAndSendTransactions({ network: this.config.networkId, signerId, transactions: toConnectorTransactions(plans) as never });
    } catch (e) {
      throw isRejection(e) ? new WalletRejectedError() : e;
    }
    return plans.map((p, i) => {
      const hash = outcomeHash(outcomes[i]);
      if (!hash) throw new Error(`The wallet did not return a transaction hash for transaction ${i + 1}`);
      return { hash, receiverId: p.receiverId };
    });
  }
}
