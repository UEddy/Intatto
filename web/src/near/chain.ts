/**
 * Typed RPC views. Every value comes back with where it was read: the RPC method, the request,
 * the raw value and the block. Screens show that next to the figure ("every number traceable").
 */
import { z } from "zod";
import { bytesToText, jsonToBase64 } from "./encoding";
import { RpcClient, RpcError, isObject, type RpcErrorAnswer } from "./rpc";

export interface Source {
  readonly rpcMethod: string;
  /** For call_function: the contract and method; otherwise the account or block asked about. */
  readonly target: string;
  readonly method?: string;
  readonly args?: unknown;
  /** The raw value exactly as the node returned it (JSON text for call_function). */
  readonly raw: string;
  readonly blockHeight: number;
  readonly blockHash: string;
}

export interface Sourced<T> {
  readonly value: T;
  readonly source: Source;
}

/** The node answered, and its answer is an error: a contract panic, a missing account, ... */
export class ChainAnswerError extends Error {
  constructor(readonly answer: RpcErrorAnswer) {
    super(`${answer.name}: ${answer.message}`);
    this.name = "ChainAnswerError";
  }
}

/** The node returned something this code does not accept as an answer. */
export class UnexpectedResponseError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "UnexpectedResponseError";
  }
}

export type Finality = "final" | "optimistic";

const blockRef = z.object({ block_height: z.number().int().nonnegative(), block_hash: z.string().min(1) });

const callResult = blockRef.extend({ result: z.array(z.number().int().min(0).max(255)), logs: z.array(z.string()) });

const accountView = blockRef.extend({
  amount: z.string().regex(/^\d+$/),
  locked: z.string().regex(/^\d+$/),
  code_hash: z.string().min(32),
  storage_usage: z.number().int().nonnegative(),
});

const permission = z.union([
  z.literal("FullAccess"),
  z.object({
    FunctionCall: z.object({
      allowance: z.string().regex(/^\d+$/).nullable(),
      receiver_id: z.string(),
      method_names: z.array(z.string()),
    }),
  }),
]);
export type AccessKeyPermission = z.infer<typeof permission>;

const accessKeyView = blockRef.extend({ nonce: z.number().int().nonnegative(), permission });

const blockView = z.object({
  header: z.object({
    height: z.number().int().nonnegative(),
    hash: z.string(),
    timestamp_nanosec: z.string().regex(/^\d+$/),
  }),
});

/** NEAR reports "no code" as the hash of nothing in this form. */
export const NO_CODE_HASH = "11111111111111111111111111111111";

export class Chain {
  constructor(readonly rpc: RpcClient) {}

  private async query(params: Record<string, unknown>): Promise<unknown> {
    const response = await this.rpc.call("query", params);
    if (!response.ok) throw new ChainAnswerError(response.error);
    return response.result;
  }

  private async queryOrMissing(params: Record<string, unknown>, missing: readonly string[]): Promise<unknown | null> {
    try {
      return await this.query(params);
    } catch (e) {
      if (e instanceof ChainAnswerError && missing.includes(e.answer.name)) return null;
      throw e;
    }
  }

  /** A view call whose JSON result is checked against `schema`. */
  async view<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    finality: Finality = "final",
  ): Promise<Sourced<T>> {
    const result = await this.query({
      request_type: "call_function",
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: jsonToBase64(args),
    });
    // Older nodes report a panicking view as a result with an `error` field instead of an error.
    if (isObject(result) && typeof result.error === "string") {
      throw new ChainAnswerError({ kind: "HANDLER_ERROR", name: "CONTRACT_EXECUTION_ERROR", info: result, message: result.error });
    }
    const parsed = parseWith(callResult, result, `${contractId}.${method} response`);
    const raw = bytesToText(parsed.result);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UnexpectedResponseError(`${contractId}.${method} did not return JSON`, raw);
    }
    const value = parseWith(schema, json, `${contractId}.${method} result`);
    return {
      value,
      source: {
        rpcMethod: "query/call_function",
        target: contractId,
        method,
        args,
        raw,
        blockHeight: parsed.block_height,
        blockHash: parsed.block_hash,
      },
    };
  }

  /** The account's balance and code hash, or null if the account does not exist. */
  async account(accountId: string): Promise<Sourced<{ amount: bigint; locked: bigint; codeHash: string; storageUsage: number }> | null> {
    const result = await this.queryOrMissing({ request_type: "view_account", finality: "final", account_id: accountId }, ["UNKNOWN_ACCOUNT"]);
    if (result === null) return null;
    const a = parseWith(accountView, result, `view_account ${accountId}`);
    return {
      value: { amount: BigInt(a.amount), locked: BigInt(a.locked), codeHash: a.code_hash, storageUsage: a.storage_usage },
      source: { rpcMethod: "query/view_account", target: accountId, raw: JSON.stringify(result), blockHeight: a.block_height, blockHash: a.block_hash },
    };
  }

  /** One access key's permission, or null if the account has no such key (or does not exist). */
  async accessKey(accountId: string, publicKey: string): Promise<Sourced<{ nonce: number; permission: AccessKeyPermission }> | null> {
    const result = await this.queryOrMissing(
      { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      ["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"],
    );
    if (result === null) return null;
    const k = parseWith(accessKeyView, result, `view_access_key ${accountId}`);
    return {
      value: { nonce: k.nonce, permission: k.permission },
      source: { rpcMethod: "query/view_access_key", target: `${accountId} ${publicKey}`, raw: JSON.stringify(result), blockHeight: k.block_height, blockHash: k.block_hash },
    };
  }

  /** A block's height, hash and timestamp. `ref` is "final", a height or a hash. */
  async block(ref: "final" | number | string): Promise<{ height: number; hash: string; timestampNs: bigint }> {
    const params = ref === "final" ? { finality: "final" } : typeof ref === "number" ? { block_id: ref } : { block_id: ref };
    const response = await this.rpc.call("block", params);
    if (!response.ok) throw new ChainAnswerError(response.error);
    const b = parseWith(blockView, response.result, "block");
    return { height: b.header.height, hash: b.header.hash, timestampNs: BigInt(b.header.timestamp_nanosec) };
  }

  /**
   * A transaction's outcome and the outcome of every receipt it produced, or null if the node
   * does not know it (after the client's retries). `wait_until: NONE` returns what is executed now.
   */
  async tx(hash: string, senderId: string, waitUntil: "NONE" | "EXECUTED_OPTIMISTIC" | "FINAL" = "NONE"): Promise<TxOutcome | null> {
    const response = await this.rpc.call("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: waitUntil });
    if (!response.ok) {
      if (response.error.name === "UNKNOWN_TRANSACTION") return null;
      throw new ChainAnswerError(response.error);
    }
    return parseTxOutcome(response.result);
  }
}

const outcomeStatus = z.union([
  z.object({ SuccessValue: z.string() }),
  z.object({ SuccessReceiptId: z.string() }),
  z.object({ Failure: z.unknown() }),
  z.literal("Unknown"),
  z.object({ Unknown: z.unknown() }),
]);

const executionOutcome = z.object({
  id: z.string(),
  block_hash: z.string(),
  outcome: z.object({
    logs: z.array(z.string()),
    receipt_ids: z.array(z.string()),
    executor_id: z.string(),
    status: outcomeStatus,
  }),
});

const txResponse = z.object({
  final_execution_status: z.string().optional(),
  status: z.unknown(),
  transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string(), public_key: z.string(), actions: z.array(z.unknown()) }),
  transaction_outcome: executionOutcome,
  receipts_outcome: z.array(executionOutcome),
});

export interface ReceiptOutcome {
  readonly id: string;
  readonly blockHash: string;
  readonly executorId: string;
  readonly logs: readonly string[];
  readonly status: "success" | "failure" | "pending";
  readonly failure: unknown;
}

export interface TxOutcome {
  readonly hash: string;
  readonly signerId: string;
  readonly receiverId: string;
  readonly publicKey: string;
  /** The transaction's actions as the node reports them (e.g. `{DeployContract: {code: <base64 sha256>}}`). */
  readonly actions: readonly unknown[];
  readonly finalExecutionStatus: string | null;
  readonly txBlockHash: string;
  readonly receipts: readonly ReceiptOutcome[];
}

export function parseTxOutcome(raw: unknown): TxOutcome {
  const t = parseWith(txResponse, raw, "tx response");
  return {
    hash: t.transaction.hash,
    signerId: t.transaction.signer_id,
    receiverId: t.transaction.receiver_id,
    publicKey: t.transaction.public_key,
    actions: t.transaction.actions,
    finalExecutionStatus: t.final_execution_status ?? null,
    txBlockHash: t.transaction_outcome.block_hash,
    receipts: t.receipts_outcome.map((r) => {
      const s = r.outcome.status;
      const status = typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s) ? "success" : typeof s === "object" && "Failure" in s ? "failure" : "pending";
      return {
        id: r.id,
        blockHash: r.block_hash,
        executorId: r.outcome.executor_id,
        logs: r.outcome.logs,
        status,
        failure: typeof s === "object" && "Failure" in s ? s.Failure : null,
      };
    }),
  };
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UnexpectedResponseError(`${what} has an unexpected shape: ${z.prettifyError(result.error)}`, value);
  }
  return result.data;
}

export { RpcError };
