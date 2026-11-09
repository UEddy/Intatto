/**
 * FastNEAR Transactions API (tx.test.fastnear.com / tx.main.fastnear.com), keyless.
 *
 *   POST /v0/account       {account_id, limit, resume_token?} -> {account_txs[], resume_token?, txs_count}
 *   POST /v0/transactions  {tx_hashes: string[] (at most 20)} -> {transactions[]}
 *
 * Shapes checked against live responses on 2026-11-08 (fixtures in src/test/fixtures).
 */
import { z } from "zod";
import { decodeArgs } from "../near/encoding";
import { getJson, type HttpOptions } from "./http";
import { IndexerError, type ActivitySource, type IndexedReceipt, type IndexedTx, type TxAction, type TxPage } from "./types";

export const FASTNEAR_MAX_HASHES = 20;
export const FASTNEAR_MAX_LIMIT = 200;

const accountResponse = z.object({
  account_txs: z.array(
    z.object({
      transaction_hash: z.string().min(1),
      tx_block_height: z.number().int().nonnegative(),
      tx_block_timestamp: z.string().regex(/^\d+$/),
      is_signer: z.boolean(),
    }),
  ),
  resume_token: z.string().optional(),
});

const status = z.record(z.string(), z.unknown());

const outcome = z.object({
  block_height: z.number().int().nonnegative(),
  block_timestamp: z.number(),
  id: z.string(),
  outcome: z.object({
    logs: z.array(z.string()),
    executor_id: z.string(),
    status,
  }),
});

const action = z.union([z.string(), z.record(z.string(), z.unknown())]);

const txsResponse = z.object({
  transactions: z.array(
    z.object({
      transaction: z.object({
        hash: z.string(),
        signer_id: z.string(),
        public_key: z.string(),
        receiver_id: z.string(),
        actions: z.array(action),
      }),
      execution_outcome: outcome,
      receipts: z.array(
        z.object({
          execution_outcome: outcome,
          receipt: z.object({
            predecessor_id: z.string(),
            receiver_id: z.string(),
            receipt_id: z.string(),
            block_timestamp: z.number(),
          }),
        }),
      ),
    }),
  ),
});

export class FastNearSource implements ActivitySource {
  readonly id = "fastnear" as const;
  readonly attribution = null;

  constructor(
    readonly baseUrl: string,
    private readonly http: HttpOptions = {},
  ) {}

  async listTxs(accountId: string, options: { limit: number; cursor?: string | null; signerOnly?: boolean }): Promise<TxPage> {
    const body: Record<string, unknown> = { account_id: accountId, limit: Math.min(options.limit, FASTNEAR_MAX_LIMIT) };
    if (options.cursor) body.resume_token = options.cursor;
    const json = await getJson(this.id, `${this.baseUrl}/v0/account`, { method: "POST", body }, this.http);
    const parsed = accountResponse.safeParse(json);
    if (!parsed.success) throw new IndexerError(this.id, "unexpected /v0/account response", false, JSON.stringify(json).slice(0, 2000));
    const rows = options.signerOnly ? parsed.data.account_txs.filter((t) => t.is_signer) : parsed.data.account_txs;
    return {
      txs: rows.map((t) => ({ hash: t.transaction_hash, blockHeight: t.tx_block_height, blockTimestampNs: t.tx_block_timestamp })),
      next: parsed.data.resume_token ?? null,
    };
  }

  async getTxs(hashes: readonly string[]): Promise<IndexedTx[]> {
    const out: IndexedTx[] = [];
    for (let i = 0; i < hashes.length; i += FASTNEAR_MAX_HASHES) {
      const chunk = hashes.slice(i, i + FASTNEAR_MAX_HASHES);
      const json = await getJson(this.id, `${this.baseUrl}/v0/transactions`, { method: "POST", body: { tx_hashes: chunk } }, this.http);
      out.push(...parseFastNearTransactions(json));
    }
    return out;
  }
}

export function parseFastNearTransactions(json: unknown): IndexedTx[] {
  const parsed = txsResponse.safeParse(json);
  if (!parsed.success) throw new IndexerError("fastnear", "unexpected /v0/transactions response", false, JSON.stringify(json).slice(0, 2000));
  return parsed.data.transactions.map((t) => ({
    source: "fastnear" as const,
    hash: t.transaction.hash,
    signerId: t.transaction.signer_id,
    publicKey: t.transaction.public_key,
    receiverId: t.transaction.receiver_id,
    blockHeight: t.execution_outcome.block_height,
    // FastNEAR sends block timestamps as JSON numbers (ns, beyond 2^53), so the last few hundred
    // ns are lost in parsing. Only display uses them; policy windows use the vault's own exact
    // `recent_spends` timestamps from RPC.
    blockTimestampNs: nsText(t.execution_outcome.block_timestamp),
    actions: t.transaction.actions.map(parseAction),
    receipts: t.receipts.map(
      (r): IndexedReceipt => ({
        receiptId: r.receipt.receipt_id,
        predecessorId: r.receipt.predecessor_id,
        executorId: r.execution_outcome.outcome.executor_id,
        blockHeight: r.execution_outcome.block_height,
        blockTimestampNs: nsText(r.execution_outcome.block_timestamp),
        logs: r.execution_outcome.outcome.logs,
        ...statusOf(r.execution_outcome.outcome.status),
      }),
    ),
  }));
}

/** Nanosecond timestamps beyond 2^53 lose their last digits as JSON numbers; ms precision stays. */
function nsText(n: number): string {
  return BigInt(Math.round(n)).toString();
}

function parseAction(a: string | Record<string, unknown>): TxAction {
  if (typeof a === "string") return { kind: "Other", type: a };
  const fc = a.FunctionCall;
  if (fc && typeof fc === "object") {
    const f = fc as Record<string, unknown>;
    return {
      kind: "FunctionCall",
      methodName: String(f.method_name ?? ""),
      args: typeof f.args === "string" ? decodeArgs(f.args) : null,
      gas: String(f.gas ?? "0"),
      deposit: String(f.deposit ?? "0"),
    };
  }
  const tr = a.Transfer;
  if (tr && typeof tr === "object") return { kind: "Transfer", deposit: String((tr as Record<string, unknown>).deposit ?? "0") };
  return { kind: "Other", type: Object.keys(a)[0] ?? "Unknown" };
}

export function statusOf(s: Record<string, unknown>): { status: "success" | "failure"; failureMessage: string | null } {
  if ("Failure" in s) return { status: "failure", failureMessage: failureText(s.Failure) };
  return { status: "success", failureMessage: null };
}

/** The panic message inside an ActionError, or the error as JSON. */
export function failureText(failure: unknown): string {
  const found = findKey(failure, "ExecutionError");
  if (typeof found === "string") return found.replace(/^Smart contract panicked: /, "");
  return JSON.stringify(failure);
}

function findKey(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object") return undefined;
  if (key in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[key];
  for (const child of Object.values(v as Record<string, unknown>)) {
    const f = findKey(child, key);
    if (f !== undefined) return f;
  }
  return undefined;
}
