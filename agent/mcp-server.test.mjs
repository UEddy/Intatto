import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configFrom, handle, LEGACY_VERSIONS, makeTools, MODERN_VERSION, TOOLS } from "./mcp-server.mjs";
import { base58Encode, keyPair } from "./near-tx.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000_000_000n;
const VAULT = "vault.intatto.near";
const W = "wrap.near";
const U = "usdt.tether-token.near";

function secretKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return `ed25519:${base58Encode(Buffer.concat([d, x]))}`;
}
const SECRET = secretKey();
const PUBLIC = keyPair(SECRET).publicKey;

function fakeChain({ permission = { FunctionCall: { receiver_id: VAULT, method_names: ["agent_swap"] } }, frozen = false } = {}) {
  const sent = [];
  return {
    sent,
    rpc: async (method, params) => {
      if (method === "block") return { header: { height: 123, timestamp_nanosec: NOW.toString() } };
      if (params.request_type === "view_access_key") return { permission };
      if (params.request_type === "view_access_key_list") return { keys: [] };
      throw new Error("unexpected " + method);
    },
    view: async (_account, method, args) => {
      if (method === "get_vault")
        return {
          balance: "0",
          frozen,
          agent_id: "agent.near",
          withdrawals_locked_until: (NOW + 1000n).toString(),
          policy: {
            max_spends_per_24h: 5,
            tokens: [{ token_id: W, per_tx_cap: "1000", daily_cap: "3000" }],
            pools: [{ pool_id: 7, token_ids: [W, U], max_slippage_bps: 100 }],
          },
          recent_spends: [{ spend_id: "1", timestamp: (NOW - 5n).toString(), token_id: W, amount: "500" }],
          tokens: [{ token_id: W, balance: "5000", on_exchange: "0" }],
        };
      if (method === "get_exchange_id") return "v2.ref-finance.near";
      if (method === "get_return") return String(BigInt(args.amount_in) * 4n);
      throw new Error("unexpected " + method);
    },
    call: async (tx) => {
      sent.push(tx);
      return {
        transaction: { hash: "HASH1" },
        receipts_outcome: [{ outcome: { executor_id: VAULT, logs: [`EVENT_JSON:${JSON.stringify({ standard: "intatto", version: "1.0.0", event: "swap_initiated", data: { agent_id: "agent.near" } })}`] } }],
      };
    },
  };
}

function ctx(env = {}, chainOpts) {
  const cfg = configFrom({ INTATTO_OWNER_ID: "owner.near", INTATTO_AGENT_ID: "agent.near", INTATTO_AGENT_KEY: SECRET, ...env });
  const chain = fakeChain(chainOpts);
  return { chain, c: { tools: makeTools(cfg, chain), state: {}, secrets: [SECRET] } };
}

const call = (c, name, args, id = 1, meta) => handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }, c);
const body = (res) => res.result.structuredContent;

test("legacy clients get an initialize handshake with the version they asked for", async () => {
  const { c } = ctx();
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, c);
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, "intatto");
  const unknown = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, c);
  assert.equal(unknown.result.protocolVersion, LEGACY_VERSIONS[0]);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, c), null);
});

test("modern clients: server/discover, per-request version, unsupported versions rejected", async () => {
  const { c } = ctx();
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION };
  const d = await handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: meta } }, c);
  assert.equal(d.result.resultType, "complete");
  assert.ok(d.result.supportedVersions.includes(MODERN_VERSION));
  assert.equal(d.result._meta["io.modelcontextprotocol/serverInfo"].name, "intatto");
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }, c);
  assert.equal(list.result.resultType, "complete");
  assert.equal(list.result.cacheScope, "public");
  assert.deepEqual(list.result.tools.map((t) => t.name), [...TOOLS.map((t) => t.name)].sort());
  const bad = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }, c);
  assert.equal(bad.error.code, -32022);
  assert.equal(bad.error.data.requested, "1900-01-01");
  const missing = await handle({ jsonrpc: "2.0", id: 4, method: "nope" }, c);
  assert.equal(missing.error.code, -32601);
});

test("arguments are validated before anything touches the chain", async () => {
  const { c } = ctx();
  assert.equal((await call(c, "intatto_check_swap", { pool_id: 7, token_in: W, token_out: U })).result.isError, true);
  assert.equal((await call(c, "intatto_check_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1e3" })).result.isError, true);
  assert.equal((await call(c, "intatto_check_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "10", extra: 1 })).result.isError, true);
  assert.equal((await call(c, "intatto_check_swap", { pool_id: 7.5, token_in: W, token_out: U, amount_in: "10" })).result.isError, true);
});

test("vault status reports what is left of today's caps", async () => {
  const { c } = ctx();
  const s = body(await call(c, "intatto_vault_status", {}));
  assert.equal(s.exists, true);
  assert.equal(s.agent_calls_last_24h, 1);
  assert.equal(s.token_caps[0].left_today, "2500");
  assert.equal(s.withdrawals_locked_until_ns, (NOW + 1000n).toString());
});

test("the key check says whether the key can only call the vault", async () => {
  assert.equal(body(await call(ctx().c, "intatto_check_agent_key", {})).safe, true);
  const full = body(await call(ctx({}, { permission: "FullAccess" }).c, "intatto_check_agent_key", {}));
  assert.equal(full.scope, "full");
  assert.equal(full.safe, false);
  assert.equal(full.public_key, PUBLIC);
});

test("check_swap suggests a tight minimum when none is given", async () => {
  const r = body(await call(ctx().c, "intatto_check_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }));
  assert.equal(r.verdict, "allow");
  assert.equal(r.min_amount_out_used, "3980");
});

test("with no minimum given and no quote, the check reports the missing quote, not a zero minimum", async () => {
  const { c, chain } = ctx();
  const view = chain.view;
  chain.view = async (a, m, args) => (m === "get_return" ? Promise.reject(new Error("pool has no such token")) : view(a, m, args));
  const r = body(await call(c, "intatto_check_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }));
  assert.equal(r.verdict, "block");
  assert.equal(r.min_amount_out_used, null);
  assert.ok(r.reasons.some((x) => x.code === "quote_failed"));
  assert.ok(!r.reasons.some((x) => x.code === "zero_min_amount_out"));
  const s = body(await call(c, "intatto_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }));
  assert.equal(s.sent, false);
  assert.equal(chain.sent.length, 0);
});

test("swap: dry run by default, refuses blocks and unacknowledged warnings, sends only when allowed", async () => {
  const dry = ctx();
  const d = body(await call(dry.c, "intatto_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }));
  assert.equal(d.dry_run, true);
  assert.equal(d.call.args.min_amount_out, "3980");
  assert.equal(dry.chain.sent.length, 0);

  const frozen = ctx({ INTATTO_ALLOW_TRADES: "1" }, { frozen: true });
  const f = await call(frozen.c, "intatto_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" });
  assert.equal(f.result.isError, true);
  assert.equal(body(f).check.verdict, "block");
  assert.equal(frozen.chain.sent.length, 0);

  const warned = ctx({ INTATTO_ALLOW_TRADES: "1" });
  const loose = { pool_id: 7, token_in: W, token_out: U, amount_in: "1000", min_amount_out: "3961" };
  assert.equal(body(await call(warned.c, "intatto_swap", loose)).sent, false);
  assert.equal(warned.chain.sent.length, 0);
  const ok = body(await call(warned.c, "intatto_swap", { ...loose, acknowledge_warnings: true }));
  assert.equal(ok.sent, true);
  assert.equal(ok.tx_hash, "HASH1");
  assert.equal(ok.explorer, "https://nearblocks.io/txns/HASH1");
  assert.equal(ok.status, "initiated");
  assert.equal(warned.chain.sent.length, 1);
  assert.equal(warned.chain.sent[0].method, "agent_swap");
  assert.equal(warned.chain.sent[0].receiverId, VAULT);
});

test("the private key never appears in any tool output", async () => {
  const { c } = ctx({ INTATTO_ALLOW_TRADES: "1" });
  const outputs = [];
  for (const [name, args] of [
    ["intatto_check_agent_key", {}],
    ["intatto_vault_status", {}],
    ["intatto_check_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }],
    ["intatto_swap", { pool_id: 7, token_in: W, token_out: U, amount_in: "1000" }],
  ]) {
    outputs.push(JSON.stringify(await call(c, name, args)));
  }
  const raw = SECRET.slice("ed25519:".length);
  for (const o of outputs) assert.ok(!o.includes(raw));
});

test("over stdio: answers initialize and tools/list, logs only to stderr", async () => {
  const child = spawn(process.execPath, [join(here, "mcp-server.mjs")], { env: { PATH: process.env.PATH, INTATTO_NETWORK: "testnet" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  child.stdin.write("not json\n");
  const deadline = Date.now() + 5000;
  while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  assert.equal(lines.find((l) => l.id === 1).result.protocolVersion, "2025-11-25");
  assert.equal(lines.find((l) => l.id === 2).result.tools.length, TOOLS.length);
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
});
