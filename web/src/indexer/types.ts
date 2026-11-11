/**
 * What the activity feed and the board's attempt log need from an indexer, independent of which
 * one answered. Both implementations normalize to these shapes; screens never see provider JSON.
 */

export type TxAction =
  | {
      readonly kind: "FunctionCall";
      readonly methodName: string;
      /** Decoded JSON args, or null if they are not UTF-8 JSON. */
      readonly args: unknown;
      readonly gas: string;
      readonly deposit: string;
    }
  | { readonly kind: "Transfer"; readonly deposit: string }
  | { readonly kind: "Other"; readonly type: string };

export interface IndexedReceipt {
  readonly receiptId: string;
  readonly predecessorId: string;
  readonly executorId: string;
  readonly blockHeight: number;
  readonly blockTimestampNs: string;
  readonly logs: readonly string[];
  readonly status: "success" | "failure";
  /** The panic or action error, as text, for failed receipts. */
  readonly failureMessage: string | null;
}

export interface IndexedTx {
  /** Which provider this record came from (kept in the cache, for attribution). */
  readonly source: "fastnear" | "nearblocks";
  readonly hash: string;
  readonly signerId: string;
  readonly publicKey: string;
  readonly receiverId: string;
  readonly blockHeight: number;
  readonly blockTimestampNs: string;
  readonly actions: readonly TxAction[];
  readonly receipts: readonly IndexedReceipt[];
}

export interface TxRef {
  readonly hash: string;
  readonly blockHeight: number;
  readonly blockTimestampNs: string;
}

export interface TxPage {
  /** Newest first. */
  readonly txs: readonly TxRef[];
  /** Opaque cursor for the next (older) page, or null at the end. */
  readonly next: string | null;
}

export interface ActivitySource {
  readonly id: "fastnear" | "nearblocks";
  /** Shown wherever this source's data is shown, when the provider's terms require it. */
  readonly attribution: { readonly text: string; readonly url: string } | null;
  /**
   * Whether `listTxs` can answer `signerOnly` completely. A source that cannot is never asked:
   * a partial list of what a key signed reads as "no attempts" on the board, a false all-clear.
   */
  readonly listsBySigner: boolean;
  /**
   * Transactions that touched `accountId`, newest first. With `signerOnly`, only those it signed
   * (the board's attempt log); otherwise every transaction with a receipt to or from it (the feed,
   * which must include receipt-only ones such as an ft_transfer_call deposit).
   */
  listTxs(
    accountId: string,
    options: { readonly limit: number; readonly cursor?: string | null; readonly signerOnly?: boolean },
  ): Promise<TxPage>;
  /** Full transactions with every receipt's logs. Unknown hashes are left out. */
  getTxs(hashes: readonly string[]): Promise<IndexedTx[]>;
}

/** The provider answered with something this code does not accept, or not at all. */
export class IndexerError extends Error {
  constructor(
    readonly source: ActivitySource["id"],
    message: string,
    /** True if this looks like rate limiting (429, or a CORS-less network failure). */
    readonly rateLimited: boolean,
    readonly raw: string = "",
    /** No answer at all (network error, DNS failure, timeout): worth one quick retry. */
    readonly transient: boolean = false,
  ) {
    super(`${source}: ${message}`);
    this.name = "IndexerError";
  }
}
