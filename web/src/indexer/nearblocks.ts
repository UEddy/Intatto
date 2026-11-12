/**
 * NearBlocks API v3 (api-testnet.nearblocks.io / api.nearblocks.io), keyless fallback.
 *
 *   GET /v3/accounts/{id}/receipts?limit=&next=   receipts to or from the account (feed)
 *   GET /v3/txns/{hash}/receipts                  the receipt tree with logs and outcomes
 *
 * The same tree is also the board's second source for the NEAR Intents swap's transactions
 * (NearBlocksTxs, below), when the archival RPC does not answer.
 *
 * Not used: /v3/accounts/{id}/txns, which lists only what the account received (see listsBySigner).
 *
 * Keyless limits, from its source: 6 per minute, 1 per second, 333 per day, 10,000 per month, per
 * IP. Attribution is required wherever its data is shown. Cursors are opaque (meta.next_page).
 */
import { z } from "zod";
import { jsonToBase64 } from "../near/encoding";
import type { ReceiptOutcome, TxOutcome, TxReader } from "../near/chain";
import { getJson, type HttpOptions } from "./http";
import { failureText } from "./fastnear";
import { IndexerError, type ActivitySource, type IndexedReceipt, type IndexedTx, type TxAction, type TxPage } from "./types";

const block = z.object({ block_height: z.string().regex(/^\d+$/), block_timestamp: z.string().regex(/^\d+$/) });

const listResponse = z.object({
  data: z.array(z.object({ transaction_hash: z.string().min(1), block, signer_account_id: z.string().optional() })),
  meta: z.object({ next_page: z.string().nullable().optional() }).optional(),
});

const nbAction = z.object({
  action: z.string(),
  method: z.string().nullable().optional(),
  args: z
    .object({
      gas: z.union([z.number(), z.string()]).optional(),
      deposit: z.string().optional(),
      args_json: z.unknown().optional(),
      method_name: z.string().optional(),
    })
    .nullable()
    .optional(),
});

interface NbReceipt {
  receipt_id: string;
  predecessor_account_id: string;
  receiver_account_id: string;
  public_key?: string | null | undefined;
  actions: z.infer<typeof nbAction>[];
  block: z.infer<typeof block>;
  outcome: { executor_account_id: string; logs: string[]; status: boolean; result?: unknown };
  receipts: NbReceipt[];
}

const receiptTree: z.ZodType<NbReceipt> = z.lazy(() =>
  z.object({
    receipt_id: z.string(),
    predecessor_account_id: z.string(),
    receiver_account_id: z.string(),
    public_key: z.string().nullable().optional(),
    actions: z.array(nbAction),
    block,
    outcome: z.object({
      executor_account_id: z.string(),
      logs: z.array(z.string()),
      status: z.boolean(),
      result: z.unknown().optional(),
    }),
    receipts: z.array(receiptTree),
  }),
);

const treeResponse = z.object({ data: receiptTree });

export class NearBlocksSource implements ActivitySource {
  readonly id = "nearblocks" as const;
  readonly attribution = { text: "Powered by Nearblocks.io APIs", url: "https://nearblocks.io" };
  /**
   * `/v3/accounts/{id}/txns` lists the transactions an account received, and `signer=` only
   * narrows that list: for demo-agent it returned its one ADD_KEY and none of the five
   * agent_spend calls it signed to vault-v2 (2026-11-11). NearBlocks has no list by signer.
   */
  readonly listsBySigner = false;

  constructor(
    readonly baseUrl: string,
    private readonly http: HttpOptions = {},
  ) {}

  async listTxs(accountId: string, options: { limit: number; cursor?: string | null; signerOnly?: boolean }): Promise<TxPage> {
    if (options.signerOnly) throw new IndexerError(this.id, "cannot list the transactions an account signed", false);
    const kind = "receipts";
    const params = new URLSearchParams({ limit: String(Math.min(options.limit, 25)) });
    if (options.cursor) params.set("next", options.cursor);
    const url = `${this.baseUrl}/v3/accounts/${encodeURIComponent(accountId)}/${kind}?${params}`;
    const json = await getJson(this.id, url, { method: "GET" }, this.http);
    const parsed = listResponse.safeParse(json);
    if (!parsed.success) throw new IndexerError(this.id, `unexpected /${kind} response`, false, JSON.stringify(json).slice(0, 2000));
    const seen = new Set<string>();
    const txs = [];
    for (const row of parsed.data.data) {
      if (seen.has(row.transaction_hash)) continue;
      seen.add(row.transaction_hash);
      txs.push({ hash: row.transaction_hash, blockHeight: Number(row.block.block_height), blockTimestampNs: row.block.block_timestamp });
    }
    return { txs, next: parsed.data.meta?.next_page ?? null };
  }

  async getTxs(hashes: readonly string[]): Promise<IndexedTx[]> {
    const out: IndexedTx[] = [];
    // One request per transaction, sequentially: the keyless limit is 1 per second.
    for (const hash of hashes) {
      const json = await getJson(this.id, `${this.baseUrl}/v3/txns/${encodeURIComponent(hash)}/receipts`, { method: "GET" }, this.http);
      out.push(parseNearBlocksTree(hash, json));
    }
    return out;
  }
}

export function parseNearBlocksTree(hash: string, json: unknown): IndexedTx {
  const parsed = treeResponse.safeParse(json);
  if (!parsed.success) throw new IndexerError("nearblocks", "unexpected /receipts tree", false, JSON.stringify(json).slice(0, 2000));
  const root = parsed.data.data;
  const receipts: IndexedReceipt[] = [];
  const walk = (r: NbReceipt) => {
    receipts.push({
      receiptId: r.receipt_id,
      predecessorId: r.predecessor_account_id,
      executorId: r.outcome.executor_account_id,
      blockHeight: Number(r.block.block_height),
      blockTimestampNs: r.block.block_timestamp,
      logs: r.outcome.logs,
      status: r.outcome.status ? "success" : "failure",
      failureMessage: r.outcome.status ? null : failureText(r.outcome.result),
    });
    r.receipts.forEach(walk);
  };
  walk(root);
  return {
    source: "nearblocks",
    hash,
    // The first receipt of a transaction comes from its signer, with the signing key.
    signerId: root.predecessor_account_id,
    publicKey: root.public_key ?? "",
    receiverId: root.receiver_account_id,
    // NearBlocks' tree starts at the first receipt, one block after the transaction itself.
    blockHeight: Number(root.block.block_height),
    blockTimestampNs: root.block.block_timestamp,
    actions: root.actions.map(parseNbAction),
    receipts,
  };
}

function parseNbAction(a: z.infer<typeof nbAction>): TxAction {
  if (a.action === "FUNCTION_CALL") {
    return {
      kind: "FunctionCall",
      methodName: a.args?.method_name ?? a.method ?? "",
      args: a.args?.args_json ?? null,
      gas: String(a.args?.gas ?? "0"),
      deposit: a.args?.deposit ?? "0",
    };
  }
  if (a.action === "TRANSFER") return { kind: "Transfer", deposit: a.args?.deposit ?? "0" };
  return { kind: "Other", type: a.action };
}

/* ---------- a transaction as the RPC's `tx` gives it, for the NEAR Intents swap checks ---------- */

interface NbTxReceipt {
  receipt_id: string;
  predecessor_account_id: string;
  receiver_account_id: string;
  public_key?: string | null | undefined;
  actions: { action: string; args?: { gas?: number | string | undefined; deposit?: string | undefined; method_name?: string | undefined; args_json?: unknown; args_base64?: string | null | undefined } | null | undefined }[];
  block: { block_hash: string };
  outcome: { executor_account_id: string; logs: string[]; status: boolean | null; result?: unknown };
  receipts: NbTxReceipt[];
}

const txTree: z.ZodType<NbTxReceipt> = z.lazy(() =>
  z.object({
    receipt_id: z.string().min(1),
    predecessor_account_id: z.string().min(1),
    receiver_account_id: z.string().min(1),
    public_key: z.string().nullable().optional(),
    actions: z.array(
      z.object({
        action: z.string(),
        args: z
          .object({
            gas: z.union([z.number(), z.string()]).optional(),
            deposit: z.string().optional(),
            method_name: z.string().optional(),
            args_json: z.unknown().optional(),
            args_base64: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
    block: z.object({ block_hash: z.string().min(1) }),
    outcome: z.object({ executor_account_id: z.string().min(1), logs: z.array(z.string()), status: z.boolean().nullable(), result: z.unknown().optional() }),
    receipts: z.array(txTree),
  }),
);

const txTreeResponse = z.object({ data: txTree.nullable() });

/**
 * NearBlocks' receipt tree for `hash`, in the shape the RPC's `tx` gives (chain.ts TxOutcome), so
 * the swap checks run on it unchanged; null when NearBlocks does not know the hash
 * (`{"data":null}`).
 *
 * Compared with archival-rpc.mainnet.fastnear.com for the swap's three transactions (2026-11-12):
 * the same receipt ids, executors, statuses, execution block hashes and logs, byte for byte. The
 * tree starts at the transaction's first receipt, which comes from the signer to the receiver
 * with the transaction's actions. Two differences: function-call arguments come parsed
 * (`args_json`), and NearBlocks adds backslashes before quotes inside string values there, so
 * they are re-encoded here and only good for what has no quotes (the AI decision's hashes and
 * receipt); the checks read logs, never these. And the response does not repeat the hash.
 */
export function nearBlocksTxOutcome(hash: string, json: unknown): TxOutcome | null {
  const parsed = txTreeResponse.safeParse(json);
  if (!parsed.success) throw new IndexerError("nearblocks", "unexpected /receipts tree", false, JSON.stringify(json).slice(0, 2000));
  const root = parsed.data.data;
  if (!root) return null;
  const receipts: ReceiptOutcome[] = [];
  const walk = (r: NbTxReceipt) => {
    const s = r.outcome.status;
    receipts.push({
      id: r.receipt_id,
      blockHash: r.block.block_hash,
      executorId: r.outcome.executor_account_id,
      logs: r.outcome.logs,
      status: s === true ? "success" : s === false ? "failure" : "pending",
      failure: s === false ? (r.outcome.result ?? null) : null,
    });
    r.receipts.forEach(walk);
  };
  walk(root);
  return {
    hash,
    signerId: root.predecessor_account_id,
    receiverId: root.receiver_account_id,
    publicKey: root.public_key ?? "",
    actions: root.actions.map((a) =>
      a.action === "FUNCTION_CALL"
        ? {
            FunctionCall: {
              method_name: a.args?.method_name ?? "",
              args: a.args?.args_base64 ?? (a.args?.args_json === undefined || a.args.args_json === null ? "" : jsonToBase64(a.args.args_json)),
              gas: Number(a.args?.gas ?? 0),
              deposit: a.args?.deposit ?? "0",
            },
          }
        : { [a.action]: a.args ?? {} },
    ),
    finalExecutionStatus: null,
    // The first receipt's block, one after the transaction's own (not read by the swap checks).
    txBlockHash: root.block.block_hash,
    receipts,
  };
}

/** The swap's transactions from NearBlocks: one keyless GET each, no retries here. */
export class NearBlocksTxs implements TxReader {
  readonly name = "NearBlocks";
  readonly attribution = { text: "Powered by Nearblocks.io APIs", url: "https://nearblocks.io" };

  constructor(
    readonly baseUrl: string,
    private readonly http: HttpOptions = {},
  ) {}

  async tx(hash: string): Promise<TxOutcome | null> {
    const json = await getJson("nearblocks", `${this.baseUrl}/v3/txns/${encodeURIComponent(hash)}/receipts`, { method: "GET" }, this.http);
    return nearBlocksTxOutcome(hash, json);
  }
}
