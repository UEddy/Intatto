#!/usr/bin/env node
// Intatto MCP server: lets an AI agent in any MCP client (Claude, ChatGPT, Cursor, Codex...)
// read its Intatto vault, check a swap before it signs, and trade through the vault, without
// ever holding a key that can withdraw.
//
// Transport: stdio, newline-delimited JSON-RPC 2.0, no dependencies. Dual-era per the MCP
// versioning rules: a client that opens with `initialize` (protocol 2025-11-25 and earlier) is
// served with legacy semantics; a request carrying `_meta["io.modelcontextprotocol/protocolVersion"]`
// (2026-07-28) is served statelessly, and `server/discover` answers either way.
//
// Tools:
//   intatto_vault_status     balances, freeze, lock, policy, and what is left of today's caps
//   intatto_check_agent_key  whether the signing key can only call the vault's agent methods
//   intatto_check_swap       allow / warn / block for a planned swap, with reasons and a suggested minimum
//   intatto_swap             runs the check, then signs and sends agent_swap (only with INTATTO_ALLOW_TRADES=1)
//
// The vault contract enforces the owner's policy whatever this server does. The server adds a
// pre-trade check (agent/risk-check.mjs) so that refused swaps are not sent and risks the contract
// does not judge (price impact, upgradeable tokens, a full-access signing key) are flagged.
//
// Configuration (environment, or agent/.env):
//   INTATTO_NETWORK        mainnet (default) or testnet
//   INTATTO_RPC_URL        default: https://rpc.mainnet.fastnear.com/ or https://test.rpc.fastnear.com/
//   INTATTO_VAULT_ID       default: vault.intatto.near or vault-v1.intatto-dev.testnet
//   INTATTO_OWNER_ID       the vault owner whose vault the agent trades (tools may override it)
//   INTATTO_AGENT_ID       the agent account
//   INTATTO_AGENT_KEY      the agent's function-call private key (ed25519:...), or
//   INTATTO_AGENT_KEY_FILE a near CLI key file holding it
//   INTATTO_ALLOW_TRADES   set to 1 to let intatto_swap send transactions; otherwise it reports
//                          the exact call it would make and sends nothing
//
// Claude Code:  claude mcp add --transport stdio intatto --env INTATTO_OWNER_ID=you.near \
//                 --env INTATTO_AGENT_ID=agent.you.near --env INTATTO_AGENT_KEY_FILE=/path/to/key.json \
//                 -- node /path/to/Intatto/agent/mcp-server.mjs
// The key never leaves this process: it is never returned by a tool or written to a log.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Chain, vaultEvents } from "./intent-swap.mjs";
import { keyPair } from "./near-tx.mjs";
import { assessSwap, gatherSwapFacts, keyScope, soldInWindow, spendsInWindow } from "./risk-check.mjs";
import { loadEnvFile, redact } from "./secrets.mjs";

export const SERVER_INFO = { name: "intatto", version: "0.1.0" };
export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const SWAP_GAS = 300_000_000_000_000n; // what scripts/mainnet-smoke.sh attaches; the contract needs AGENT_SWAP_TGAS of it

export const INSTRUCTIONS =
  "Intatto vault tools. The vault holds the money and enforces the owner's policy on every agent call; " +
  "this server's key can trade from the vault but never withdraw. Before every trade call intatto_check_swap " +
  "and pass its suggested min_amount_out. A 'block' verdict means the contract would refuse it or the risk is too high; " +
  "do not retry it unchanged. Never ask the user for keys.";

const NETWORKS = {
  mainnet: { rpc: "https://rpc.mainnet.fastnear.com/", vault: "vault.intatto.near", explorer: "https://nearblocks.io/txns/" },
  testnet: { rpc: "https://test.rpc.fastnear.com/", vault: "vault-v1.intatto-dev.testnet", explorer: "https://testnet.nearblocks.io/txns/" },
};

const amount = { type: "string", pattern: "^[0-9]+$", description: "In the token's smallest units, as a decimal string." };
const owner = { type: "string", description: "Vault owner account. Defaults to INTATTO_OWNER_ID." };
const swapProps = {
  owner_id: owner,
  pool_id: { type: "integer", minimum: 0, description: "Rhea (Ref) pool id from the owner's policy." },
  token_in: { type: "string", description: "Token the vault sells, e.g. wrap.near." },
  token_out: { type: "string", description: "Token the vault buys." },
  amount_in: amount,
  min_amount_out: { ...amount, description: "Least output accepted. Omit to use the check's suggestion (at most 0.5% under the exchange's quote)." },
};

export const TOOLS = [
  {
    name: "intatto_check_agent_key",
    title: "Check the agent's key",
    description: "Reports whether the configured signing key can only call the vault's agent methods (safe) or can do more (unsafe).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "intatto_check_swap",
    title: "Check a swap before signing",
    description:
      "Pre-trade risk check for an agent swap: allow, warn or block, with reasons. Mirrors every refusal the vault contract would make " +
      "(policy, caps, freeze, slippage against the exchange's quote) and flags price impact, upgradeable tokens and an unsafe key. Read-only.",
    inputSchema: { type: "object", properties: swapProps, required: ["pool_id", "token_in", "token_out", "amount_in"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "intatto_swap",
    title: "Swap through the vault",
    description:
      "Runs intatto_check_swap, then signs agent_swap with the agent's function-call key. Refuses on 'block'; on 'warn' needs acknowledge_warnings. " +
      "Sends nothing unless the server runs with INTATTO_ALLOW_TRADES=1. The vault contract re-checks the policy on chain.",
    inputSchema: {
      type: "object",
      properties: { ...swapProps, acknowledge_warnings: { type: "boolean", description: "Proceed although the check returned warnings." } },
      required: ["pool_id", "token_in", "token_out", "amount_in"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "intatto_vault_status",
    title: "Vault status",
    description: "The vault's balances, freeze and withdrawal lock, the owner's policy, and what is left of today's caps for each token. Read-only.",
    inputSchema: { type: "object", properties: { owner_id: owner }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
].sort((a, b) => a.name.localeCompare(b.name)); // deterministic order, as the spec asks

/** Reads configuration from `env`. The agent key is loaded lazily and only its public half is kept in view. */
export function configFrom(env) {
  const network = env.INTATTO_NETWORK ?? "mainnet";
  const n = NETWORKS[network];
  if (!n) throw new Error(`INTATTO_NETWORK must be mainnet or testnet, not ${network}`);
  let secret = env.INTATTO_AGENT_KEY;
  if (!secret && env.INTATTO_AGENT_KEY_FILE) {
    try {
      secret = JSON.parse(readFileSync(env.INTATTO_AGENT_KEY_FILE, "utf8")).private_key;
    } catch {
      throw new Error(`INTATTO_AGENT_KEY_FILE is not a readable near CLI key file`);
    }
  }
  return {
    network,
    rpcUrl: env.INTATTO_RPC_URL ?? n.rpc,
    vaultId: env.INTATTO_VAULT_ID ?? n.vault,
    explorer: n.explorer,
    ownerId: env.INTATTO_OWNER_ID,
    agentId: env.INTATTO_AGENT_ID,
    allowTrades: env.INTATTO_ALLOW_TRADES === "1",
    secret, // kept for signing only; never returned
  };
}

class ToolError extends Error {}

function need(value, name) {
  if (!value) throw new ToolError(`${name} is not set. Pass it as an argument or set it in the server's environment.`);
  return value;
}

function swapParams(cfg, args, publicKey) {
  return {
    vaultId: cfg.vaultId,
    ownerId: need(args.owner_id ?? cfg.ownerId, "owner_id (INTATTO_OWNER_ID)"),
    agentId: need(cfg.agentId, "INTATTO_AGENT_ID"),
    agentPublicKey: publicKey,
    poolId: Number(args.pool_id),
    tokenIn: String(args.token_in),
    tokenOut: String(args.token_out),
    amountIn: String(args.amount_in),
    minAmountOut: args.min_amount_out === undefined ? undefined : String(args.min_amount_out),
  };
}

/** Facts, then the verdict; with no min_amount_out given, the check's own suggestion is used. */
async function checkSwap(chain, cfg, args, publicKey) {
  const p = swapParams(cfg, args, publicKey);
  const facts = await gatherSwapFacts(chain, { ...p, minAmountOut: p.minAmountOut ?? "1" });
  let minAmountOut = p.minAmountOut;
  if (minAmountOut === undefined) {
    minAmountOut = assessSwap({ ...facts, minAmountOut: "1" }).suggestedMinOut ?? "0";
  }
  const result = assessSwap({ ...facts, minAmountOut });
  return { params: { ...p, minAmountOut }, result };
}

function publicKeyOf(cfg) {
  if (!cfg.secret) return undefined;
  return keyPair(cfg.secret).publicKey;
}

export function makeTools(cfg, chain) {
  return {
    async intatto_vault_status(args) {
      const ownerId = need(args.owner_id ?? cfg.ownerId, "owner_id (INTATTO_OWNER_ID)");
      const block = await chain.rpc("block", { finality: "final" });
      const nowNs = BigInt(block.header.timestamp_nanosec ?? block.header.timestamp);
      const v = await chain.view(cfg.vaultId, "get_vault", { owner_id: ownerId });
      if (!v) return { network: cfg.network, vault_id: cfg.vaultId, owner_id: ownerId, exists: false };
      const policy = v.policy ?? {};
      const lock = v.withdrawals_locked_until ? BigInt(v.withdrawals_locked_until) : null;
      return {
        network: cfg.network,
        vault_id: cfg.vaultId,
        owner_id: ownerId,
        exists: true,
        block_height: block.header.height,
        agent_id: v.agent_id,
        frozen: v.frozen,
        withdrawals_locked_until_ns: lock !== null && lock > nowNs ? lock.toString() : null,
        near_balance_yocto: v.balance,
        tokens: (v.tokens ?? []).map((t) => ({ token_id: t.token_id, balance: t.balance, on_exchange: t.on_exchange })),
        agent_calls_last_24h: spendsInWindow(v.recent_spends, nowNs),
        max_agent_calls_per_24h: policy.max_spends_per_24h,
        token_caps: (policy.tokens ?? []).map((t) => {
          const sold = soldInWindow(v.recent_spends, t.token_id, nowNs);
          const left = BigInt(t.daily_cap) > sold ? BigInt(t.daily_cap) - sold : 0n;
          return { token_id: t.token_id, per_swap_cap: t.per_tx_cap, daily_cap: t.daily_cap, sold_last_24h: sold.toString(), left_today: left.toString() };
        }),
        pools: policy.pools ?? [],
      };
    },

    async intatto_check_agent_key() {
      const agentId = need(cfg.agentId, "INTATTO_AGENT_ID");
      const publicKey = publicKeyOf(cfg);
      if (!publicKey) throw new ToolError("No agent key is configured (INTATTO_AGENT_KEY or INTATTO_AGENT_KEY_FILE).");
      let permission;
      try {
        permission = (await chain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: agentId, public_key: publicKey })).permission;
      } catch {
        return { agent_id: agentId, public_key: publicKey, scope: "missing", safe: false, message: `This key is not an access key of ${agentId}.` };
      }
      const scope = keyScope(permission, cfg.vaultId);
      const messages = {
        "vault-only": `Safe: the key can only call the vault's agent methods on ${cfg.vaultId}, and cannot attach a deposit.`,
        wider: `Not safe: the key can call vault methods beyond the agent methods. Replace it with one limited to agent_swap (and agent_spend if needed).`,
        full: `Not safe: this is a full-access key. Anyone who gets it controls ${agentId}. Use a function-call key on ${cfg.vaultId} instead.`,
        other: `Not usable: the key cannot call ${cfg.vaultId}.`,
      };
      return { agent_id: agentId, public_key: publicKey, scope, safe: scope === "vault-only", permission, message: messages[scope] };
    },

    async intatto_check_swap(args) {
      const { params, result } = await checkSwap(chain, cfg, args, publicKeyOf(cfg));
      return { min_amount_out_used: params.minAmountOut, ...result };
    },

    async intatto_swap(args) {
      const publicKey = publicKeyOf(cfg);
      if (!publicKey) throw new ToolError("No agent key is configured (INTATTO_AGENT_KEY or INTATTO_AGENT_KEY_FILE).");
      const { params, result } = await checkSwap(chain, cfg, args, publicKey);
      if (result.verdict === "block") return { sent: false, check: result, message: "Not sent: the check blocked this swap. Fix the reasons, do not retry it unchanged." };
      if (result.verdict === "warn" && args.acknowledge_warnings !== true) {
        return { sent: false, check: result, message: "Not sent: the check returned warnings. Call again with acknowledge_warnings: true to proceed, or change the trade." };
      }
      const call = {
        signer_id: params.agentId,
        receiver_id: cfg.vaultId,
        method: "agent_swap",
        args: { owner_id: params.ownerId, pool_id: params.poolId, token_in: params.tokenIn, token_out: params.tokenOut, amount_in: params.amountIn, min_amount_out: params.minAmountOut },
        gas: SWAP_GAS.toString(),
        deposit: "0",
      };
      if (!cfg.allowTrades) return { sent: false, dry_run: true, check: result, call, message: "Dry run: INTATTO_ALLOW_TRADES is not 1, so nothing was signed. This is the exact call." };
      const keys = keyPair(cfg.secret);
      const outcome = await chain.call({ signerId: params.agentId, keys, receiverId: cfg.vaultId, method: "agent_swap", args: call.args, gas: SWAP_GAS });
      const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
      const events = vaultEvents(outcome, cfg.vaultId).map((e) => ({ event: e.event, data: e.data }));
      const rejected = events.find((e) => e.event === "swap_rejected");
      return {
        sent: true,
        tx_hash: hash,
        explorer: hash ? `${cfg.explorer}${hash}` : null,
        status: rejected ? `refused by the vault: ${rejected.data?.reason}` : events.some((e) => e.event === "swap_completed") ? "completed" : "initiated",
        events,
        check: result,
      };
    },
  };
}

function jsonText(value) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/**
 * Handles one JSON-RPC message; returns the response object, or null for a notification.
 * `state.legacy` records an `initialize` handshake (legacy era) for this process.
 */
export async function handle(msg, { tools, state, secrets = [] }) {
  const isRequest = msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isRequest || msg?.id === undefined ? { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } } : null;
  }
  if (!isRequest) return null; // notifications (notifications/initialized, cancelled, ...) need no answer
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message, data) => ({ jsonrpc: "2.0", id: msg.id, error: data === undefined ? { code, message } : { code, message, data } });
  const params = msg.params ?? {};
  const requested = params._meta?.[META_VERSION];
  const modern = requested !== undefined;
  if (modern && requested !== MODERN_VERSION) {
    return fail(-32022, "Unsupported protocol version", { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested });
  }
  const withMeta = (result) => (modern ? { resultType: "complete", ...result, _meta: { [META_SERVER]: SERVER_INFO } } : result);

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      state.legacy = true;
      return reply({
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return reply({
        resultType: "complete",
        supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        _meta: { [META_SERVER]: SERVER_INFO },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply(withMeta({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" }));
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      for (const key of tool.inputSchema.required ?? []) {
        if (args[key] === undefined) return reply(withMeta({ content: [{ type: "text", text: `Missing argument: ${key}` }], isError: true }));
      }
      for (const [key, value] of Object.entries(args)) {
        const schema = tool.inputSchema.properties[key];
        if (!schema) return reply(withMeta({ content: [{ type: "text", text: `Unknown argument: ${key}` }], isError: true }));
        if (schema.pattern && !(typeof value === "string" && new RegExp(schema.pattern).test(value))) {
          return reply(withMeta({ content: [{ type: "text", text: `${key} must be a decimal string of digits` }], isError: true }));
        }
        if (schema.type === "integer" && !Number.isSafeInteger(value)) return reply(withMeta({ content: [{ type: "text", text: `${key} must be an integer` }], isError: true }));
      }
      try {
        const out = await tools[tool.name](args);
        const isError = out?.sent === false && !out?.dry_run;
        return reply(withMeta({ content: [{ type: "text", text: redact(jsonText(out), secrets) }], structuredContent: JSON.parse(jsonText(out)), isError }));
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `Failed: ${err?.message ?? err}`;
        return reply(withMeta({ content: [{ type: "text", text: redact(text, secrets) }], isError: true }));
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function main() {
  loadEnvFile();
  const cfg = configFrom(process.env);
  const secrets = cfg.secret ? [cfg.secret] : [];
  const tools = makeTools(cfg, new Chain(cfg.rpcUrl));
  const state = { legacy: false };
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  // Logs go to stderr only: stdout carries protocol messages and nothing else.
  console.error(`intatto mcp: ${cfg.network}, vault ${cfg.vaultId}, trades ${cfg.allowTrades ? "enabled" : "dry-run"}`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // Requests are independent; answer each as it finishes.
    handle(msg, { tools, state, secrets }).then(
      (res) => res && write(res),
      (err) => write({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: redact(String(err?.message ?? err), secrets) } }),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`intatto mcp: ${err?.message ?? err}`);
    process.exit(1);
  });
}
