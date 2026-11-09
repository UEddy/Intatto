/**
 * Read-only NEAR JSON-RPC client. The same rules as scripts/lib/near_rpc.py:
 *
 * A response reaches the caller only if it is one complete JSON-RPC 2.0 object answering this
 * request (matching id), holding either a result or an error that is a definitive answer
 * (UNKNOWN_ACCOUNT, NO_CONTRACT_CODE, ...). Rate limiting, HTTP and network errors, bodies that
 * are not exactly one JSON object, and errors the node reports as transient are retried with
 * exponential backoff. After that, or for an error this client does not know, it throws an
 * RpcError carrying the reason and the raw response. It never turns an unusable response into
 * an answer.
 *
 * In a browser a 429 often arrives without CORS headers and so looks like a network error;
 * network errors are therefore always treated as a possible rate limit and backed off.
 *
 * Error names: near-jsonrpc-primitives 0.37.3. `error.name` is HANDLER_ERROR,
 * REQUEST_VALIDATION_ERROR or INTERNAL_ERROR; `error.cause.name` is the specific error.
 */

export const DEFINITIVE = new Set([
  "UNKNOWN_ACCOUNT",
  "INVALID_ACCOUNT",
  "NO_CONTRACT_CODE",
  "NO_GLOBAL_CONTRACT_CODE",
  "UNKNOWN_ACCESS_KEY",
  "UNKNOWN_GAS_KEY",
  "CONTRACT_EXECUTION_ERROR",
  "TOO_LARGE_CONTRACT_STATE",
  "GARBAGE_COLLECTED_BLOCK",
  "INVALID_TRANSACTION",
]);

export const TRANSIENT = new Set([
  "INTERNAL_ERROR",
  "NO_SYNCED_BLOCKS",
  "NOT_SYNCED_YET",
  "UNAVAILABLE_SHARD",
  "DOES_NOT_TRACK_SHARD",
  "UNKNOWN_BLOCK",
  "TIMEOUT_ERROR",
  "REQUEST_ROUTED",
]);

/** May simply not have reached the node yet: retried, accepted as "not found" only at the end. */
export const SETTLES = new Set(["UNKNOWN_TRANSACTION"]);

const RATE_LIMIT_MARKERS = ["rate limit", "rate-limit", "ratelimit", "too many requests"];

export function isRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => lower.includes(m));
}

/** A definitive error the node gave as its answer. */
export interface RpcErrorAnswer {
  readonly kind: string;
  readonly name: string;
  readonly info: unknown;
  readonly message: string;
}

export type RpcResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: RpcErrorAnswer };

/** The request could not be answered: either it never will be (fatal) or retries ran out. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly reason: string,
    readonly raw: string,
    readonly attempts: number,
    readonly fatal: boolean,
  ) {
    super(`${method} failed after ${attempts} attempt(s): ${reason}`);
    this.name = "RpcError";
  }
}

class Retry {
  constructor(
    readonly reason: string,
    readonly raw: string,
    readonly rateLimited: boolean,
  ) {}
}
class Fatal {
  constructor(
    readonly reason: string,
    readonly raw: string,
  ) {}
}

export interface RpcOptions {
  readonly attempts?: number;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: { method: string; attempt: number; reason: string; delayMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let idCounter = 0;

export class RpcClient {
  private readonly attempts: number;
  private readonly firstDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry: RpcOptions["onRetry"];

  constructor(
    readonly url: string,
    options: RpcOptions = {},
  ) {
    this.attempts = options.attempts ?? 5;
    this.firstDelayMs = options.firstDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
  }

  /** One JSON-RPC call: the result, or a definitive error answer. Throws RpcError otherwise. */
  async call(method: string, params: unknown): Promise<RpcResponse> {
    const id = `intatto-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
    let settled: RpcResponse | null = null;
    let failure: Retry = new Retry("no attempt made", "", false);
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const [response, settling] = await this.attempt(method, params, id);
        if (!settling) return response;
        settled = response;
        failure = new Retry(`${settling}, may not have reached the node yet`, "", false);
      } catch (e) {
        if (e instanceof Fatal) throw new RpcError(method, e.reason, e.raw, attempt, true);
        if (!(e instanceof Retry)) throw e;
        failure = e;
        settled = null;
      }
      if (attempt === this.attempts) break;
      const base = Math.min(this.firstDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
      // A suspected rate limit waits at least 4x the first delay before trying again.
      const floor = failure.rateLimited ? this.firstDelayMs * 4 : 0;
      const delayMs = Math.max(base, floor) * (0.8 + 0.4 * this.random());
      this.onRetry?.({ method, attempt, reason: failure.reason, delayMs });
      await this.sleep(delayMs);
    }
    if (settled) return settled;
    throw new RpcError(method, failure.reason, failure.raw, this.attempts, false);
  }

  private async attempt(method: string, params: unknown, id: string): Promise<[RpcResponse, string | null]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let raw: string;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
        // No cookies or referrer to the node.
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      status = res.status;
      raw = await res.text();
    } catch (e) {
      // CORS-less 429s surface here as TypeError("Failed to fetch").
      const reason = controller.signal.aborted ? "timed out" : `network error (${String(e)})`;
      throw new Retry(`${reason}; possibly rate limited`, "", true);
    } finally {
      clearTimeout(timer);
    }

    if (status === 429 || (status !== 200 && isRateLimit(raw))) throw new Retry(`rate limited (HTTP ${status})`, raw, true);
    if (status === 408 || status === 425 || status >= 500) throw new Retry(`HTTP ${status}`, raw, false);
    if (status >= 400) throw new Fatal(`HTTP ${status}`, raw);
    if (status !== 200) throw new Retry(`HTTP ${status}`, raw, false);

    let response: unknown;
    try {
      // JSON.parse rejects anything after the first value, so two bodies run together never parse.
      response = JSON.parse(raw);
    } catch (e) {
      throw new Retry(isRateLimit(raw) ? "rate limited" : `response is not one JSON value (${String(e)})`, raw, isRateLimit(raw));
    }
    if (!isObject(response) || response.jsonrpc !== "2.0") {
      throw new Retry(isRateLimit(raw) ? "rate limited" : "response is not a JSON-RPC 2.0 object", raw, isRateLimit(raw));
    }
    if (response.id !== id) throw new Retry(`response id ${JSON.stringify(response.id)} does not match request id`, raw, false);
    const hasResult = "result" in response;
    const hasError = "error" in response;
    if (hasResult === hasError) throw new Retry("response has neither or both of result and error", raw, false);
    if (hasResult) return [{ ok: true, result: response.result }, null];

    const error = response.error;
    if (!isObject(error)) throw new Retry("error is not an object", raw, false);
    const kind = typeof error.name === "string" ? error.name : "";
    const cause = isObject(error.cause) ? error.cause : {};
    const name = typeof cause.name === "string" ? cause.name : "";
    if (isRateLimit(JSON.stringify(error))) throw new Retry("rate limited", raw, true);
    if (kind === "REQUEST_VALIDATION_ERROR") throw new Fatal(`request rejected: ${name}`, raw);
    if (kind === "INTERNAL_ERROR" || TRANSIENT.has(name)) throw new Retry(`node error ${kind}/${name}`, raw, false);
    const answer: RpcResponse = {
      ok: false,
      error: { kind, name, info: cause.info, message: typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? null) },
    };
    if (kind === "HANDLER_ERROR" && DEFINITIVE.has(name)) return [answer, null];
    if (kind === "HANDLER_ERROR" && SETTLES.has(name)) return [answer, name];
    throw new Fatal(`unrecognised error ${kind}/${name}`, raw);
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
