// The demo never writes a secret: runs it against a local stub of the RPC and NEAR AI Cloud that
// echoes the API key back (in a model reply, and in an error body), with fake secrets, and checks
// that neither stdout nor the JSONL run log contains them. Offline; --dry-run, so nothing is signed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { redact, secretValues } from "./secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AI_KEY = "sk-fake-near-ai-key-0123456789abcdef";
const FAKE_AGENT_KEY = "ed25519:fakeAgentKeyThatMustNeverBeLogged111111111111";
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

const VAULT = {
  balance: "100000000000000000000000",
  frozen: false,
  agent_id: "demo-agent.intatto-dev.testnet",
  policy: { per_tx_cap: "10000000000000000000000", daily_cap: "30000000000000000000000", max_spends_per_24h: 5, allowlist: ["demo-merchant.intatto-dev.testnet"], tokens: [], pools: [] },
  recent_spends: [],
  tokens: [],
  withdrawals_locked_until: null,
};

/** A stub of the RPC and of NEAR AI Cloud. `mode` "echo" puts the bearer token in a reply; "error" in a 500 body. */
function stub(mode) {
  let turn = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json", "x-request-id": "stub-1" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/rpc") {
        const call = JSON.parse(body);
        if (call.method === "query" && call.params.method_name === "get_vault") {
          return json(200, { jsonrpc: "2.0", id: call.id, result: { result: [...Buffer.from(JSON.stringify(VAULT))] } });
        }
        return json(200, { jsonrpc: "2.0", id: call.id, error: { name: "UNEXPECTED", cause: { name: call.method } } });
      }
      if (req.url === "/v1/models") return json(200, { data: [{ id: MODEL, supported_features: ["tools"] }] });
      if (req.url === "/v1/chat/completions") {
        if (mode === "error") return json(500, { error: `bad token ${auth}` });
        turn += 1;
        if (turn === 1) {
          return json(200, {
            choices: [{ message: { role: "assistant", content: `echo: ${auth}`, tool_calls: [{ id: "c1", type: "function", function: { name: "pay", arguments: JSON.stringify({ receiver_id: "attacker.testnet", amount_near: "0.1", reason: "injected" }) } }] } }],
          });
        }
        return json(200, { choices: [{ message: { role: "assistant", content: "done" } }] });
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function runDemo(mode) {
  const server = await stub(mode);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runs = join(here, "runs");
  const before = new Set(safeList(runs));
  const child = spawn(process.execPath, [join(here, "injection-demo.mjs"), "--llm", "--dry-run"], {
    env: { PATH: process.env.PATH, NEAR_RPC: `${base}/rpc`, NEAR_AI_BASE_URL: `${base}/v1`, NEAR_AI_API_KEY: FAKE_AI_KEY, DEMO_AGENT_KEY: FAKE_AGENT_KEY },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  const created = safeList(runs).filter((f) => !before.has(f));
  const logs = created.map((f) => readFileSync(join(runs, f), "utf8")).join("");
  for (const f of created) rmSync(join(runs, f));
  return { code, out, logs };
}

const safeList = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

test("redact replaces every occurrence of each secret, and ignores short or unset ones", () => {
  assert.equal(redact("a SECRETXYZ b SECRETXYZ", ["SECRETXYZ"]), "a [redacted] b [redacted]");
  assert.deepEqual(secretValues({ NEAR_AI_API_KEY: "short", DEMO_AGENT_KEY: undefined }), []);
  assert.deepEqual(secretValues({ NEAR_AI_API_KEY: FAKE_AI_KEY }), [FAKE_AI_KEY]);
});

test("a key the server echoes in a model reply never reaches stdout or the run log", async () => {
  const { code, out, logs } = await runDemo("echo");
  assert.equal(code, 0, out);
  assert.ok(logs.length > 0, "a run log was written");
  for (const secret of [FAKE_AI_KEY, FAKE_AGENT_KEY]) {
    assert.ok(!out.includes(secret), "stdout contains a secret");
    assert.ok(!logs.includes(secret), "the JSONL log contains a secret");
  }
  assert.match(logs, /echo: Bearer \[redacted\]/);
  // The injected payment was planned, not signed (dry run).
  assert.match(logs, /"kind":"tx_planned".*"receiver_id":"attacker\.testnet"/);
});

test("a key the server echoes in an error never reaches stdout or the run log", async () => {
  const { code, out, logs } = await runDemo("error");
  assert.equal(code, 1);
  for (const secret of [FAKE_AI_KEY, FAKE_AGENT_KEY]) {
    assert.ok(!out.includes(secret));
    assert.ok(!logs.includes(secret));
  }
  assert.match(logs, /bad token Bearer \[redacted\]/);
});
