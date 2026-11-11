// Secrets for the demo agent: where they come from, and keeping them out of every log.
//
// The demo reads two secrets: NEAR_AI_API_KEY (for --llm) and DEMO_AGENT_KEY (the agent's
// function-call private key). Both come from the process environment, or from agent/.env, which
// .gitignore lists (`/agent/.env`). Variables already set in the environment win over the file.
//
// Nothing the demo writes, to stdout or to agent/runs/*.jsonl, may contain a secret's value.
// `redact` replaces every occurrence of each secret value with "[redacted]". The demo runs every
// log line through it, including error messages and text from servers that might echo a key.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const SECRET_NAMES = ["NEAR_AI_API_KEY", "DEMO_AGENT_KEY"];
export const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), ".env");

/** Loads `file` into `env` without overriding variables that are already set. */
export function loadEnvFile(env = process.env, file = ENV_FILE) {
  if (!existsSync(file)) return [];
  const parsed = parseEnv(readFileSync(file, "utf8"));
  const loaded = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded; // names only, never values
}

/** The values to keep out of logs: every secret that is set, at least 8 characters long. */
export function secretValues(env = process.env) {
  return SECRET_NAMES.map((name) => env[name]).filter((v) => typeof v === "string" && v.length >= 8);
}

/** `text` with every occurrence of each secret value replaced by "[redacted]". */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}
