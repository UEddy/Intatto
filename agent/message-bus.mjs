// Client for the NEAR Intents Message Bus JSON-RPC (docs.near-intents.org, "Message Bus → API
// Reference", read 2026-11-11): `quote`, `publish_intent`, `get_status`.
//
//   POST https://solver-relay-v2.chaindefuser.com/rpc, key in the X-API-Key header.
//
// The relay only carries messages: it can submit what the vault signed, and nothing else. Every
// on-chain rule is the vault's (THREAT_MODEL.md, invariants 17 and 18).
//
// Observed 2026-11-11: the relay answered identically with the Distribution Channel key, a
// malformed key and no key, so it does not enforce authentication today, and whether it accepts
// this key type is unverified. The key is sent anyway, as documented.

export const MESSAGE_BUS_RPC = "https://solver-relay-v2.chaindefuser.com/rpc";

const DIGITS = /^[0-9]+$/;

export class MessageBus {
  /**
   * `jwt` goes only into the X-API-Key header. `fetchImpl` lets tests answer without a network.
   */
  constructor({ jwt, url = MESSAGE_BUS_RPC, fetchImpl = fetch, timeoutMs = 20_000 }) {
    this.jwt = jwt;
    this.url = url;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(method, params) {
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.jwt ? { "X-API-Key": this.jwt } : {}) },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: [params] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Message Bus ${method}: HTTP ${response.status}: ${text.slice(0, 300)}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Message Bus ${method}: not JSON: ${text.slice(0, 300)}`);
    }
    if (body.error) throw new Error(`Message Bus ${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
    return body.result;
  }

  /**
   * Quotes for selling exactly `amountIn` of `tokenIn` (NEP-141 account ids). Returns only quotes
   * that answer this exact request, best (largest amount_out) first; [] if there are none.
   */
  async quote({ tokenIn, tokenOut, amountIn, minDeadlineMs = 120_000 }) {
    if (!DIGITS.test(String(amountIn))) throw new Error(`amountIn must be an integer string, got ${amountIn}`);
    const assetIn = `nep141:${tokenIn}`;
    const assetOut = `nep141:${tokenOut}`;
    const result = await this.call("quote", {
      defuse_asset_identifier_in: assetIn,
      defuse_asset_identifier_out: assetOut,
      exact_amount_in: String(amountIn),
      min_deadline_ms: minDeadlineMs,
    });
    return selectQuotes(result, { assetIn, assetOut, amountIn: String(amountIn) });
  }

  /** Publishes the vault's signed intent against `quoteHash`. Returns `{status, intent_hash, reason?}`. */
  async publishIntent({ quoteHash, signedData }) {
    if (signedData?.standard !== "nep413") throw new Error("only the vault's nep413 payload is published");
    return this.call("publish_intent", { quote_hashes: [quoteHash], signed_data: signedData });
  }

  /** `{intent_hash, status, status_details, data: {hash}}`; status PENDING, TX_BROADCASTED, SETTLED or NOT_FOUND_OR_NOT_VALID. */
  async getStatus(intentHash) {
    return this.call("get_status", { intent_hash: intentHash });
  }
}

/**
 * The quotes in a `quote` result that are for exactly this sale, with integer amounts, sorted by
 * amount_out descending. Anything else in the answer is dropped, not trusted.
 */
export function selectQuotes(result, { assetIn, assetOut, amountIn }) {
  if (!Array.isArray(result)) return [];
  return result
    .filter(
      (q) =>
        q &&
        q.defuse_asset_identifier_in === assetIn &&
        q.defuse_asset_identifier_out === assetOut &&
        q.amount_in === amountIn &&
        typeof q.amount_out === "string" &&
        DIGITS.test(q.amount_out) &&
        BigInt(q.amount_out) > 0n &&
        typeof q.quote_hash === "string" &&
        q.quote_hash.length > 0,
    )
    .sort((a, b) => (BigInt(b.amount_out) > BigInt(a.amount_out) ? 1 : BigInt(b.amount_out) < BigInt(a.amount_out) ? -1 : 0));
}

/** Whether `amountOut / amountIn >= minOut / perIn`, in exact integers, like the vault's floor check. */
export function meetsFloor(amountIn, amountOut, minOut, perIn) {
  return BigInt(amountOut) * BigInt(perIn) >= BigInt(amountIn) * BigInt(minOut);
}
