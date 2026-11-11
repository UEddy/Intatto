// The Partner Portal key for the NEAR Intents Message Bus, read the way web/scripts/pages-deploy.sh
// reads cloudflare.env: from one file outside the repo, which must exist, belong to this user and
// be mode 600, and may hold only NEAR_INTENTS_JWT.
//
//   ~/.config/intatto/intents.env:   NEAR_INTENTS_JWT=<jwt>
//
// The value is returned to the caller and never printed: no error message here contains it, and
// callers add it to their redaction list (secrets.mjs `redact`) before logging anything. It is sent
// only as an HTTP header, never on a command line or in a URL.
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const INTENTS_ENV = join(homedir(), ".config/intatto/intents.env");
export const JWT_NAME = "NEAR_INTENTS_JWT";

/** Returns NEAR_INTENTS_JWT from `file`, or throws an error that names the problem, never the value. */
export function loadIntentsJwt(file = INTENTS_ENV, uid = userInfo().uid) {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new Error(`${file} is missing; it must hold ${JWT_NAME}=..., mode 600`);
  }
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.uid !== uid) throw new Error(`${file} is not owned by this user`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} has mode ${mode.toString(8)}, not 600; run: chmod 600 ${file}`);
  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} could not be parsed as KEY=value lines`);
  }
  const extra = Object.keys(parsed).filter((name) => name !== JWT_NAME);
  if (extra.length > 0) throw new Error(`${file}: unexpected variables ${extra.join(", ")} (only ${JWT_NAME})`);
  const jwt = parsed[JWT_NAME];
  if (typeof jwt !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    throw new Error(`${file} has no ${JWT_NAME} that looks like a JWT`);
  }
  return jwt;
}

/** The JWT's non-secret claims (key type, partner id, expiry), for the run log. */
export function jwtClaims(jwt) {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return {
      key_type: claims.key_type ?? null,
      expires: typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : null,
    };
  } catch {
    return { key_type: null, expires: null };
  }
}
