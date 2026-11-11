#!/usr/bin/env node
// An agent intent swap through the vault's Chain Signatures path (branch chain-signatures):
//
//   1. Message Bus `quote` for selling exactly --amount-in of --token-in for --token-out.
//   2. Read-only preflight on the vault: intents key verified, pair listed, best quote at or above
//      the owner's floor, enough intents balance, and the agent key allowed to call the vault.
//   3. `agent_intent_swap(owner, token_in, token_out, amount_in, amount_out = quote)`, signed with
//      the agent's function-call key. The vault builds the NEP-413 token_diff, the MPC network
//      signs it, and the vault logs the signed payload (`intent_swap_signed`).
//   4. Message Bus `publish_intent` with that payload and the quote's hash, then `get_status`
//      until the relay reports SETTLED or gives up.
//   5. `settle_intent_swap(intent_id)`: the vault asks intents.near whether the nonce was used and
//      credits the output (or, after the deadline, refunds the input).
//
//   node agent/intent-swap.mjs --vault V --owner O --agent A --token-in T --token-out U --amount-in N [--dry-run]
//   node agent/intent-swap.mjs --vault V --agent A --settle <intent_id>
//
// Secrets, never printed (every log line goes through redact()):
//   INTENT_AGENT_KEY  the agent's function-call private key (environment, or agent/.env), or
//   INTENT_AGENT_KEY_FILE  a near CLI key file holding it ({"private_key": "ed25519:..."}), as
//                     scripts/mainnet-intents.sh passes the legacy-keychain key file
//   NEAR_INTENTS_JWT  ~/.config/intatto/intents.env only, mode 600 (intents-env.mjs)
// NEAR_RPC overrides the RPC (default: mainnet FastNEAR). --dry-run stops after the preflight and
// prints the transaction it would send; it signs and sends nothing.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { jwtClaims, loadIntentsJwt } from "./intents-env.mjs";
import { MessageBus, meetsFloor } from "./message-bus.mjs";
import { keyPair, serializeTransaction, signTransaction } from "./near-tx.mjs";
import { loadEnvFile, redact } from "./secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SWAP_GAS = 150_000_000_000_000n;
const SETTLE_GAS = 100_000_000_000_000n;

/** The agent's private key: INTENT_AGENT_KEY, else the `private_key` of INTENT_AGENT_KEY_FILE. */
export function agentSecret(env) {
  if (env.INTENT_AGENT_KEY) return env.INTENT_AGENT_KEY;
  if (!env.INTENT_AGENT_KEY_FILE) return undefined;
  let key;
  try {
    key = JSON.parse(readFileSync(env.INTENT_AGENT_KEY_FILE, "utf8")).private_key;
  } catch {
    throw new Error(`INTENT_AGENT_KEY_FILE ${env.INTENT_AGENT_KEY_FILE} is not a readable near CLI key file`);
  }
  if (typeof key !== "string" || !key.startsWith("ed25519:")) {
    throw new Error(`INTENT_AGENT_KEY_FILE ${env.INTENT_AGENT_KEY_FILE} holds no ed25519 private_key`);
  }
  return key;
}

/** The vault's events in a transaction outcome, from receipts the vault itself executed only. */
export function vaultEvents(outcome, vaultId) {
  const events = [];
  for (const receipt of outcome?.receipts_outcome ?? []) {
    if (receipt.outcome?.executor_id !== vaultId) continue;
    for (const line of receipt.outcome.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const event = JSON.parse(line.slice("EVENT_JSON:".length));
        if (event.standard === "intatto") events.push(event);
      } catch {
        // Not an event.
      }
    }
  }
  return events;
}

/** The outcome of an `agent_intent_swap` transaction: signed (with its payload), refunded or rejected. */
export function intentSwapResult(outcome, vaultId) {
  const events = vaultEvents(outcome, vaultId);
  const find = (name) => events.find((e) => e.event === name)?.data;
  const signed = find("intent_swap_signed");
  if (signed) return { kind: "signed", intentId: signed.intent_id, deadline: signed.deadline, signedData: signed.signed_data };
  const refunded = find("intent_swap_refunded");
  if (refunded) return { kind: "refunded", intentId: refunded.intent_id, reason: refunded.reason };
  const rejected = find("intent_swap_rejected");
  if (rejected) return { kind: "rejected", reason: rejected.reason };
  return { kind: "unknown" };
}

/** Whether an access key's permission lets it call `methods` on `vaultId` (and nothing that moves NEAR). */
export function keyAllows(permission, vaultId, methods) {
  const call = permission?.FunctionCall;
  if (!call || call.receiver_id !== vaultId) return false;
  const allowed = call.method_names ?? [];
  return allowed.length > 0 && methods.every((m) => allowed.includes(m));
}

export class Chain {
  constructor(rpcUrl, fetchImpl = fetch, retryDelayMs = 1000) {
    this.url = rpcUrl;
    this.fetch = fetchImpl;
    this.retryDelayMs = retryDelayMs;
  }

  async rpc(method, params) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await this.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "intent-swap", method, params }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`HTTP ${response.status}`);
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
        continue;
      }
      const body = await response.json();
      if (body.error) {
        const error = new Error(`${method}: ${JSON.stringify(body.error).slice(0, 400)}`);
        error.cause = body.error;
        throw error;
      }
      return body.result;
    }
    throw new Error(`${method}: ${last}`);
  }

  async view(accountId, method, args) {
    const result = await this.rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8"));
  }

  /** Signs and sends one function call, then waits for every receipt (including MPC yield-resume). */
  async call({ signerId, keys, receiverId, method, args, gas }) {
    const access = await this.rpc("query", { request_type: "view_access_key", finality: "final", account_id: signerId, public_key: keys.publicKey });
    const block = await this.rpc("block", { finality: "final" });
    const tx = serializeTransaction({
      signerId,
      publicKey: keys.publicKey,
      nonce: BigInt(access.nonce) + 1n,
      receiverId,
      blockHash: block.header.hash,
      actions: [{ method, args, gas, deposit: 0n }],
    });
    const { signed, hash } = signTransaction(tx, keys.privateKey);
    try {
      return await this.rpc("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "EXECUTED_OPTIMISTIC" });
    } catch (err) {
      // The MPC answer can take longer than the RPC waits; keep asking for the same transaction.
      if (!JSON.stringify(err.cause ?? "").includes("TIMEOUT")) throw err;
      for (let i = 0; i < 60; i++) {
        try {
          return await this.rpc("tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" });
        } catch (again) {
          if (!JSON.stringify(again.cause ?? "").match(/TIMEOUT|UNKNOWN_TRANSACTION/)) throw again;
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
      throw new Error(`transaction ${hash} did not finish`);
    }
  }
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node agent/intent-swap.mjs --vault V --owner O --agent A --token-in T --token-out U --amount-in N [--min-deadline-ms 120000] [--dry-run]");
  console.error("       node agent/intent-swap.mjs --vault V --agent A --settle <intent_id>");
  process.exit(2);
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      vault: { type: "string" },
      owner: { type: "string" },
      agent: { type: "string" },
      "token-in": { type: "string" },
      "token-out": { type: "string" },
      "amount-in": { type: "string" },
      "min-deadline-ms": { type: "string", default: "120000" },
      settle: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!opts.vault || !opts.agent) usage("--vault and --agent are required");
  const settleOnly = opts.settle !== undefined;
  if (!settleOnly && !(opts.owner && opts["token-in"] && opts["token-out"] && /^[0-9]+$/.test(opts["amount-in"] ?? ""))) {
    usage("--owner, --token-in, --token-out and an integer --amount-in are required");
  }

  const env = process.env;
  loadEnvFile(env); // agent/.env, gitignored; the environment wins
  const jwt = settleOnly ? null : loadIntentsJwt();
  const agentKey = agentSecret(env);
  const secrets = [jwt, agentKey].filter((s) => typeof s === "string" && s.length >= 8);
  const runs = join(here, "runs");
  mkdirSync(runs, { recursive: true });
  const logFile = join(runs, `${new Date().toISOString().replace(/[:.]/g, "-")}-intent-swap${opts["dry-run"] ? "-dry" : ""}.jsonl`);
  let step = 0;
  const log = (kind, data) => {
    step += 1;
    const line = redact(JSON.stringify({ step, at: new Date().toISOString(), kind, ...data }), secrets);
    appendFileSync(logFile, `${line}\n`);
    console.log(redact(`[${String(step).padStart(2, "0")}] ${kind.padEnd(16)} ${JSON.stringify(data)}`, secrets));
  };
  const chain = new Chain(env.NEAR_RPC ?? "https://rpc.mainnet.fastnear.com");
  const keys = () => {
    if (!agentKey) throw new Error("set INTENT_AGENT_KEY (environment or agent/.env) or INTENT_AGENT_KEY_FILE");
    return keyPair(agentKey);
  };
  const settle = async (intentId) => {
    const outcome = await chain.call({ signerId: opts.agent, keys: keys(), receiverId: opts.vault, method: "settle_intent_swap", args: { intent_id: String(intentId) }, gas: SETTLE_GAS });
    const events = vaultEvents(outcome, opts.vault).map((e) => ({ event: e.event, data: e.data }));
    log("settle", { tx: outcome.transaction?.hash, status: outcome.status, events });
    return outcome;
  };

  if (settleOnly) {
    await settle(opts.settle);
    return;
  }

  const tokenIn = opts["token-in"];
  const tokenOut = opts["token-out"];
  const amountIn = opts["amount-in"];
  log("start", { vault: opts.vault, owner: opts.owner, agent: opts.agent, tokenIn, tokenOut, amountIn, key: jwtClaims(jwt), dryRun: opts["dry-run"] });

  // 1. Quote.
  const bus = new MessageBus({ jwt });
  const quotes = await bus.quote({ tokenIn, tokenOut, amountIn, minDeadlineMs: Number(opts["min-deadline-ms"]) });
  log("quotes", { count: quotes.length, best: quotes[0] ?? null });
  if (quotes.length === 0) throw new Error(`no solver quoted ${amountIn} ${tokenIn} -> ${tokenOut}`);
  const quote = quotes[0];

  // 2. Preflight, read-only: the vault would reject anything failing here, and the agent pays gas for that.
  const config = await chain.view(opts.vault, "get_intents_config", {});
  const policy = await chain.view(opts.vault, "get_intent_policy", { owner_id: opts.owner });
  const balances = await chain.view(opts.vault, "get_intents_balances", { owner_id: opts.owner });
  const pair = policy.pairs.find((p) => p.token_in === tokenIn && p.token_out === tokenOut);
  const held = balances.find((b) => b.token_id === tokenIn)?.balance ?? "0";
  const preflight = {
    keyVerified: config?.key_verified === true,
    pairListed: Boolean(pair),
    floor: pair ? `${pair.min_out} per ${pair.per_in}` : null,
    meetsFloor: pair ? meetsFloor(amountIn, quote.amount_out, pair.min_out, pair.per_in) : false,
    intentsBalance: held,
    enoughBalance: BigInt(held) >= BigInt(amountIn),
  };
  if (agentKey) {
    const access = await chain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: opts.agent, public_key: keys().publicKey });
    preflight.agentKeyAllowed = keyAllows(access.permission, opts.vault, ["agent_intent_swap", "settle_intent_swap"]);
  } else if (!opts["dry-run"]) {
    throw new Error("set INTENT_AGENT_KEY (environment or agent/.env) or INTENT_AGENT_KEY_FILE");
  }
  log("preflight", preflight);
  const failed = Object.entries(preflight).filter(([k, v]) => v === false).map(([k]) => k);
  if (failed.length > 0) throw new Error(`preflight failed: ${failed.join(", ")}`);
  const args = { owner_id: opts.owner, token_in: tokenIn, token_out: tokenOut, amount_in: amountIn, amount_out: quote.amount_out };
  if (opts["dry-run"]) {
    log("dry-run", { would_call: `${opts.vault}.agent_intent_swap`, args, gas: SWAP_GAS.toString(), then: "publish_intent, get_status, settle_intent_swap" });
    return;
  }

  // 3. The vault builds, the MPC network signs.
  const outcome = await chain.call({ signerId: opts.agent, keys: keys(), receiverId: opts.vault, method: "agent_intent_swap", args, gas: SWAP_GAS });
  const result = intentSwapResult(outcome, opts.vault);
  log("agent_intent_swap", { tx: outcome.transaction?.hash, result: { ...result, signedData: result.signedData ? "(logged by the vault)" : undefined } });
  if (result.kind !== "signed") throw new Error(`the vault did not sign: ${JSON.stringify(result)}`);

  // 4. Publish and watch.
  const published = await bus.publishIntent({ quoteHash: quote.quote_hash, signedData: result.signedData });
  log("publish_intent", published);
  if (published?.status !== "OK") throw new Error(`publish_intent failed: ${JSON.stringify(published)}`);
  const deadlineMs = Number(BigInt(result.deadline) / 1_000_000n);
  let status;
  while (Date.now() < deadlineMs + 30_000) {
    status = await bus.getStatus(published.intent_hash);
    if (status?.status === "SETTLED" || status?.status === "NOT_FOUND_OR_NOT_VALID") break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  log("get_status", status ?? {});

  // 5. Settle on chain. An unsettled intent can only be refunded once its deadline has passed.
  if (status?.status !== "SETTLED") {
    const wait = deadlineMs + 5_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await settle(result.intentId);
  log("done", { log: logFile });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    const secrets = [];
    try {
      const key = agentSecret(process.env);
      if (key) secrets.push(key);
    } catch {
      // No key file: nothing to redact.
    }
    try {
      secrets.push(loadIntentsJwt());
    } catch {
      // No key file: nothing more to redact.
    }
    console.error(redact(`error: ${err.message}`, secrets));
    process.exit(1);
  });
}
