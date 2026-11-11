/**
 * near-connect behind the SignerAdapter interface: NEAR-DevHub/near-connect at f2fc970 (the
 * passkeys branch), vendored in web/vendor/near-connect after review (VENDORED.md there).
 *
 * - Manifest: the pinned four-wallet copy, never the remote default, so a manifest change cannot
 *   add or swap a wallet; on mainnet, plus the passkey entry, whose executor this site serves.
 *   The other executors' code is still fetched from each wallet's published URL.
 * - storage: hardened (connectorStorage.ts), so no `debug-wallets` entry can add a wallet.
 * - providers: the configured RPC, so executors that broadcast use the same node the page reads.
 * - cspNonce: this page load's nonce from boot.js, so the executors' inline scripts may run.
 * - A connected passkey wallet submits through PasskeyAdapter (passkey.ts).
 */
import { NearConnector, type NearWalletBase, type WalletManifest } from "@hot-labs/near-connect";
import type { NetworkConfig } from "../config/networks";
import { hardenedStorage } from "./connectorStorage";
import pinned from "./manifest.pinned.json";
import { PASSKEY_WALLET_ID, PasskeyAdapter, passkeyManifestEntry, type WaitFinal } from "./passkey";
import { PLAIN_SESSION, WalletRejectedError, type SignerAdapter, type SubmittedTx, type TxPlan, type WalletSession } from "./types";

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

export function isRejection(e: unknown): boolean {
  const text = String((e as { message?: unknown })?.message ?? e).toLowerCase();
  return /\b(rejected|cancell?ed|closed|denied)\b/.test(text);
}

/**
 * The wallets the site offers on `config`'s network: the pinned four, plus the passkey wallet on
 * mainnet only. `baseUrl` is where the site is served from (import.meta.env.BASE_URL).
 */
export function offeredWallets(config: NetworkConfig, baseUrl: string): WalletManifest[] {
  const wallets = pinned.wallets as unknown as WalletManifest[];
  return config.networkId === "mainnet" ? [...wallets, passkeyManifestEntry(baseUrl)] : wallets;
}

export class NearConnectAdapter implements SignerAdapter {
  readonly id = "near-connect";
  readonly label = "NEAR wallet";
  readonly capabilities = { batch: true };
  readonly connector: NearConnector;
  /** Present on mainnet: how a connected passkey wallet submits. */
  readonly passkey: PasskeyAdapter | null;

  constructor(
    private readonly config: NetworkConfig,
    waitFinal: WaitFinal,
    /** Where the site is served from, ending in "/" (import.meta.env.BASE_URL). */
    baseUrl: string,
  ) {
    const nonce = typeof window !== "undefined" ? window.__INTATTO_CSP_NONCE__ : undefined;
    this.passkey = config.networkId === "mainnet" ? new PasskeyAdapter(config, waitFinal) : null;
    this.connector = new NearConnector({
      network: config.networkId,
      manifest: { version: pinned.version, wallets: offeredWallets(config, baseUrl) },
      providers: { [config.networkId]: [config.rpcUrl] },
      storage: hardenedStorage(),
      footerBranding: null,
      autoConnect: true,
      ...(nonce ? { cspNonce: nonce } : {}),
    });
  }

  /** Whether the connected wallet is the passkey wallet. */
  private isPasskey(wallet: NearWalletBase | null): boolean {
    return this.passkey !== null && wallet?.manifest.id === PASSKEY_WALLET_ID;
  }

  async session(): Promise<WalletSession> {
    const wallet = await this.wallet();
    return this.isPasskey(wallet) ? { notice: this.passkey!.notice, gasSponsored: true } : PLAIN_SESSION;
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
    if (this.isPasskey(wallet)) return this.passkey!.submit(wallet, signerId, plans);
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
