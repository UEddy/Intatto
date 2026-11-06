#!/usr/bin/env bash
# Canary on testnet, using near-cli-rs 0.30.1: a vault on vault-v1.intatto-dev.testnet whose agent
# key is published. The vault holds 1 NEAR under a zero-outflow policy (nobody to pay, no pools,
# no tokens, zero caps) with withdrawals locked for 30 days, so no call the agent key can make
# should ever move it. Any decrease of the canary vault's balances is a break (THREAT_MODEL.md).
#
# Accounts, created by intatto-dev.testnet if missing:
#   canary.intatto-dev.testnet        the vault owner; its key stays private and signs nothing
#                                     after this script
#   canary-agent.intatto-dev.testnet  the agent; its full-access key stays private, and only a
#                                     function-call key (agent_spend, agent_swap on vault-v1,
#                                     1 NEAR allowance) is printed for publishing
#
# vault-v1 must already run this build (with lock_withdrawals_until); the script refuses to run
# against other code and never deploys anything.
#
# Safe to re-run: existing accounts, the vault, the policy, an existing lock and an existing agent
# key are reused; nothing is deposited or locked twice, and set_agent (refused while withdrawals
# are locked) is only called if the agent or policy differ.
#
# Signing and outcome checks work as in scripts/smoke-testnet-v1.sh: calls are signed with
# `display`, sent with `transaction send-signed-transaction`, and read back by hash over RPC.
set -euo pipefail
shopt -s inherit_errexit

NETWORK=testnet
FUNDER=intatto-dev.testnet
OWNER=canary.intatto-dev.testnet
AGENT=canary-agent.intatto-dev.testnet
VAULT=vault-v1.intatto-dev.testnet
WASM=${WASM:-target/near/intatto.wasm}
# Read-only RPC goes to exactly the node near CLI uses for $NETWORK: scripts/lib/near_rpc.py reads
# it (and any API key) from near CLI's config.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RPC_CLIENT="$SCRIPT_DIR/lib/near_rpc.py"
EXPLORER=https://explorer.testnet.near.org/transactions/
KEYCHAIN="$HOME/.near-credentials/$NETWORK"
GAS='30 Tgas'

# The owner deposits 1 NEAR; the rest pays the account's own storage and gas.
OWNER_FUNDING='1.2 NEAR'
DEPOSIT='1 NEAR'
# Gas for calls signed with the published key comes out of the agent account's balance, at most
# the key's allowance.
AGENT_FUNDING='1.1 NEAR'
FC_ALLOWANCE='1 NEAR'
FC_METHODS=agent_spend,agent_swap
LOCK_DAYS=30
# The smallest max_spends_per_24h set_agent accepts (1 to 100); with every cap at zero it never
# matters.
POLICY='{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":1,"allowlist":[],"tokens":[],"pools":[]}'

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/helper.py" <<'PY'
import base64, datetime, hashlib, json, os, re, sys
from decimal import Decimal

YOCTO = 10**24
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
NO_CODE = "11111111111111111111111111111111"


def b58encode(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def b58decode(text):
    n = 0
    for char in text:
        n = n * 58 + B58.index(char)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def near(yocto):
    yocto = int(yocto)
    whole, frac = divmod(yocto, YOCTO)
    frac = f"{frac:024d}".rstrip("0")
    return f"{whole}{'.' + frac if frac else ''} NEAR"


def load_response(path):
    """A response scripts/lib/near_rpc.py printed: one JSON-RPC object holding a result, or an
    error the node gave as an answer. Anything else stops the run instead of being read."""
    with open(path) as file:
        raw = file.read()
    try:
        response = json.loads(raw)
    except ValueError as error:
        sys.exit(f"RPC response in {path} is not JSON ({error}): {raw[:2000]!r}")
    if not isinstance(response, dict) or ("result" in response) == ("error" in response):
        sys.exit(f"RPC response in {path} is neither a result nor an error: {raw[:2000]!r}")
    return response


def error_name(response):
    error = response.get("error")
    cause = error.get("cause") if isinstance(error, dict) else None
    return cause.get("name") if isinstance(cause, dict) else None


def rpc_result(path):
    response = load_response(path)
    if "error" in response:
        sys.exit(f"RPC error in {path}: {json.dumps(response['error'])}")
    return response["result"]


def unknown_account(path):
    """True only for the node's UNKNOWN_ACCOUNT answer; any other error stops the run."""
    response = load_response(path)
    if "error" not in response:
        return False
    if error_name(response) == "UNKNOWN_ACCOUNT":
        return True
    sys.exit(
        f"RPC error in {path} says nothing about whether the account exists: "
        f"{json.dumps(response['error'])}"
    )


def find(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        obj = list(obj.values())
    if isinstance(obj, list):
        for value in obj:
            found = find(value, key)
            if found is not None:
                return found
    return None


def utc(ns):
    return datetime.datetime.fromtimestamp(int(ns) / 1e9, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def fc_methods(permission):
    if not isinstance(permission, dict) or "FunctionCall" not in permission:
        return None
    return permission["FunctionCall"]


cmd, args = sys.argv[1], sys.argv[2:]

if cmd == "yocto":  # yocto <NEAR amount>
    print(int(Decimal(args[0].split()[0]) * YOCTO))

elif cmd == "near":  # near <yoctoNEAR>
    print(near(args[0]))

elif cmd == "utc":  # utc <ns timestamp>
    print(utc(args[0]))

elif cmd == "file-hash":  # file-hash <path>: base58 sha256, as NEAR reports code hashes
    print(b58encode(hashlib.sha256(open(args[0], "rb").read()).digest()))

elif cmd == "signed-b64":  # signed-b64 <output of `near ... display`>
    text = re.sub(r"\x1b\[[0-9;]*m", "", open(args[0]).read())
    match = re.search(r"Signed transaction \(serialized as base64\):\s+(\S+)", text)
    if not match:
        sys.exit("no signed transaction found in near CLI output")
    print(match.group(1))

elif cmd == "tx-hash":  # tx-hash <base64 signed transaction>
    raw = base64.b64decode(args[0])
    if raw[-65] != 0:
        sys.exit("expected an ed25519-signed transaction")
    print(b58encode(hashlib.sha256(raw[:-65]).digest()))

elif cmd == "tx-id":  # tx-id <output of a plain `near ... send`>
    ids = re.findall(r"Transaction ID: (\w+)", re.sub(r"\x1b\[[0-9;]*m", "", open(args[0]).read()))
    print(ids[-1] if ids else "(not printed)")

elif cmd == "account-amount":  # account-amount <view_account response>: yoctoNEAR, or "missing"
    print("missing" if unknown_account(args[0]) else rpc_result(args[0])["amount"])

elif cmd == "code-hash":  # code-hash <view_account response>: the hash, "none", or "missing"
    if unknown_account(args[0]):
        print("missing")
    else:
        code_hash = rpc_result(args[0])["code_hash"]
        print("none" if code_hash == NO_CODE else code_hash)

elif cmd == "block-time":  # block-time <block response>
    print(rpc_result(args[0])["header"]["timestamp"])

elif cmd == "call-result":  # call-result <call_function response>: the JSON it returned
    result = rpc_result(args[0])
    if "error" in result:
        raise SystemExit(f"view call failed: {result['error']}")
    print(bytes(result["result"]).decode())

elif cmd == "json":  # json <file> <python expression over `v`>
    v = json.load(open(args[0]))
    out = eval(args[1], {"v": v, "int": int})
    print(out if isinstance(out, str) else json.dumps(out))

elif cmd == "fc-key":  # fc-key <view_access_key_list> <key dir> <receiver> <methods,...>
    # A function-call key for exactly these methods on <receiver> whose key file is in the
    # keychain.
    want = sorted(args[3].split(","))
    for key in rpc_result(args[0])["keys"]:
        fc = fc_methods(key["access_key"]["permission"])
        if not fc or fc["receiver_id"] != args[2] or sorted(fc["method_names"]) != want:
            continue
        key_file = os.path.join(args[1], key["public_key"].replace(":", "_") + ".json")
        if os.path.exists(key_file):
            print(key["public_key"])
            break

elif cmd == "key-check":  # key-check <view_access_key response> <receiver> <methods,...> <allowance>
    permission = rpc_result(args[0])["permission"]
    print(f"    on chain:  {json.dumps(permission)}")
    fc = fc_methods(permission)
    ok = (
        fc is not None
        and fc["receiver_id"] == args[1]
        and sorted(fc["method_names"]) == sorted(args[2].split(","))
        and fc["allowance"] is not None
        and int(fc["allowance"]) <= int(args[3])
    )
    print(f"    result:    {'PASS' if ok else 'FAIL'} (function-call only, {args[2]} on {args[1]}, allowance at most {near(args[3])})")
    sys.exit(0 if ok else 1)

elif cmd == "key-file":  # key-file <key file> <public key>: prints the key pair, checked
    data = json.load(open(args[0]))
    public, private = data["public_key"], data["private_key"]
    if public != args[1] or not private.startswith("ed25519:"):
        sys.exit("key file does not hold the expected ed25519 key")
    secret = b58decode(private.split(":", 1)[1])
    # An ed25519 secret key in NEAR's format is the 32-byte seed followed by the public key.
    if len(secret) != 64 or b58encode(secret[32:]) != public.split(":", 1)[1]:
        sys.exit("the private key in the key file does not match its public key")
    print(public)
    print(private)
    print(secret[32:].hex())  # the implicit account this key also controls

elif cmd == "policy-check":  # policy-check <policy json> <expected policy json>
    actual, expected = json.load(open(args[0])), json.loads(args[1])
    print(f"    expected:  {json.dumps(expected, sort_keys=True)}")
    print(f"    actual:    {json.dumps(actual, sort_keys=True)}")
    print(f"    result:    {'PASS' if actual == expected else 'FAIL'}")
    sys.exit(0 if actual == expected else 1)

elif cmd == "outcome":  # outcome <tx response> <tx hash> <explorer>: success expected
    path, tx_hash, explorer = args
    print(f"    tx:        {tx_hash}")
    print(f"    explorer:  {explorer}{tx_hash}")
    response = load_response(path)
    if "error" in response:
        # near_rpc.py passes an error through only when it is the node's answer; for a
        # transaction that means UNKNOWN_TRANSACTION on every attempt.
        known = error_name(response) == "UNKNOWN_TRANSACTION"
        what = "transaction not found on chain" if known else "RPC error"
        print(f"    result:    FAIL ({what}: {json.dumps(response['error'])})")
        sys.exit(1)
    status = response["result"]["status"]
    if "SuccessValue" in status:
        print("    result:    PASS")
        sys.exit(0)
    print(f"    result:    FAIL: {find(status, 'ExecutionError') or json.dumps(status)}")
    sys.exit(1)

else:
    sys.exit(f"unknown helper command {cmd}")
PY

helper() { python3 -I "$WORK/helper.py" "$@"; }
yocto() { helper yocto "$1"; }
near_cli() { near "$@" </dev/null; }
die() {
  echo "ABORT: $*" >&2
  exit 1
}

PASSED=0
FAILED=0
record() { if [ "$1" = 0 ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi; }
check() {
  local what=$1
  shift
  if "$@"; then
    echo "    result:    PASS ($what)"
    record 0
  else
    echo "    result:    FAIL ($what)"
    record 1
  fi
}

# rpc <method> <params json>: one JSON-RPC response, either a result or an error that is the node's
# answer (UNKNOWN_ACCOUNT, ...). Rate limits and unusable responses are retried with backoff; if no
# usable response comes, scripts/lib/near_rpc.py prints why and the raw response and fails, which
# ends the run. Its output is never a guess.
rpc() { python3 -I "$RPC_CLIENT" call "$NETWORK" "$1" "$2"; }
query() { rpc query "{\"request_type\":\"$1\",\"finality\":\"final\",\"account_id\":\"$2\"}"; }
balance_of() { query view_account "$1" >"$WORK/account.json" && helper account-amount "$WORK/account.json"; }
code_hash_of() { query view_account "$1" >"$WORK/account.json" && helper code-hash "$WORK/account.json"; }
block_time() { rpc block '{"finality":"final"}' >"$WORK/block.json" && helper block-time "$WORK/block.json"; }
has_keychain_entry() { [ -e "$KEYCHAIN/$1.json" ] || [ -d "$KEYCHAIN/$1" ]; }

# view <method> <json args>: the vault view's JSON return value, in $WORK/<method>.json.
view() {
  local args_b64
  args_b64=$(printf '%s' "$2" | base64 | tr -d '\n')
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VAULT\",\"method_name\":\"$1\",\"args_base64\":\"$args_b64\"}" \
    >"$WORK/view_response.json"
  helper call-result "$WORK/view_response.json" >"$WORK/$1.json" || die "view call $1 failed"
}
vault_view() { view get_vault "{\"owner_id\":\"$OWNER\"}"; }

send_setup() {
  if near_cli "$@" >"$WORK/setup.log" 2>&1; then
    echo "    tx:        $(helper tx-id "$WORK/setup.log")"
  else
    sed 's/^/    | /' "$WORK/setup.log"
    die "near $1 $2 failed"
  fi
}

# owner_call <method> <json args> <deposit>: a vault call signed by the canary owner that must
# succeed; aborts the run otherwise.
owner_call() {
  near_cli contract call-function as-transaction "$VAULT" "$1" json-args "$2" \
    prepaid-gas "$GAS" attached-deposit "$3" sign-as "$OWNER" \
    network-config "$NETWORK" sign-with-legacy-keychain display >"$WORK/sign.log" 2>&1 ||
    { sed 's/^/    | /' "$WORK/sign.log"; die "could not sign $1"; }
  local signed tx_hash
  signed=$(helper signed-b64 "$WORK/sign.log")
  tx_hash=$(helper tx-hash "$signed")
  near_cli transaction send-signed-transaction base64-signed-transaction "$signed" \
    network-config "$NETWORK" send >"$WORK/send.log" 2>&1 || true
  rpc tx "{\"tx_hash\":\"$tx_hash\",\"sender_account_id\":\"$OWNER\",\"wait_until\":\"FINAL\"}" \
    >"$WORK/outcome.json" ||
    die "could not read the outcome of $tx_hash over RPC; check $EXPLORER$tx_hash before re-running"
  helper outcome "$WORK/outcome.json" "$tx_hash" "$EXPLORER" ||
    { sed 's/^/    | /' "$WORK/send.log" | tail -n 20; die "$1 failed"; }
}

echo "== Preflight"
for tool in near python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
python3 -I -c 'import tomllib' 2>/dev/null || die "python3 3.11 or later is needed (tomllib)"
RPC_URL=$(python3 -I "$RPC_CLIENT" endpoint "$NETWORK")
echo "    rpc:       $RPC_URL (near CLI's $NETWORK connection)"
has_keychain_entry "$FUNDER" || die "no legacy keychain entry for $FUNDER"
[ -f "$WASM" ] || die "$WASM not found; build it with: cargo near build non-reproducible-wasm"
WASM_HASH=$(helper file-hash "$WASM")
VAULT_HASH=$(code_hash_of "$VAULT")
echo "    vault:     $VAULT, code hash $VAULT_HASH"
echo "    build:     $WASM, code hash $WASM_HASH"
[ "$VAULT_HASH" = "$WASM_HASH" ] ||
  die "$VAULT does not run this build (no lock_withdrawals_until before it); upgrade it first"
FUNDER_BALANCE=$(balance_of "$FUNDER")
echo "    funder:    $FUNDER, balance $(helper near "$FUNDER_BALANCE")"

echo
echo "== 1. Accounts"
for pair in "$OWNER=$OWNER_FUNDING" "$AGENT=$AGENT_FUNDING"; do
  account=${pair%%=*}
  funding=${pair#*=}
  echo "── $account"
  existing=$(balance_of "$account")
  if [ "$existing" != missing ]; then
    echo "    exists (balance $(helper near "$existing")), reusing it"
    has_keychain_entry "$account" || die "no legacy keychain entry for $account"
    continue
  fi
  send_setup account create-account fund-myself "$account" "$funding" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$FUNDER" network-config "$NETWORK" sign-with-legacy-keychain send
  created=$(balance_of "$account")
  [ "$created" != missing ] || die "$account was not created"
  echo "    created with $funding"
done

echo
echo "== 2. Canary vault: $DEPOSIT, zero-outflow policy for $AGENT, withdrawals locked $LOCK_DAYS days"
vault_view
if [ "$(helper json "$WORK/get_vault.json" 'v is None')" = true ]; then
  echo "── deposit $DEPOSIT"
  owner_call deposit '{}' "$DEPOSIT"
else
  echo "── vault exists, no second deposit"
fi
vault_view
# set_agent is refused while withdrawals are locked, so a re-run keeps what an earlier run set.
if [ "$(helper json "$WORK/get_vault.json" "v[\"agent_id\"] == \"$AGENT\" and v[\"policy\"] == $POLICY")" = true ]; then
  echo "── $AGENT is already registered with the zero-outflow policy"
else
  echo "── set_agent($AGENT, zero-outflow policy)"
  owner_call set_agent "{\"agent_id\":\"$AGENT\",\"policy\":$POLICY}" '1 yoctoNEAR'
fi
view get_policy "{\"owner_id\":\"$OWNER\"}"
status=0
helper policy-check "$WORK/get_policy.json" "$POLICY" || status=$?
record "$status"
vault_view
LOCKED=$(helper json "$WORK/get_vault.json" 'v["withdrawals_locked_until"] or ""')
if [ -z "$LOCKED" ]; then
  NOW=$(block_time)
  LOCK_UNTIL=$(python3 -I -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]) * 86400 * 10**9)' \
    "$NOW" "$LOCK_DAYS")
  echo "── lock_withdrawals_until($LOCK_UNTIL = $(helper utc "$LOCK_UNTIL"))"
  owner_call lock_withdrawals_until "{\"timestamp_ns\":\"$LOCK_UNTIL\"}" '1 yoctoNEAR'
else
  echo "── withdrawals already locked until $LOCKED ($(helper utc "$LOCKED")), not re-locking"
fi

echo
echo "== 3. Agent function-call key ($FC_METHODS on $VAULT, allowance $FC_ALLOWANCE)"
find_fc_key() {
  query view_access_key_list "$AGENT" >"$WORK/agent_keys.json"
  helper fc-key "$WORK/agent_keys.json" "$KEYCHAIN/$AGENT" "$VAULT" "$FC_METHODS"
}
FC_KEY=$(find_fc_key)
if [ -n "$FC_KEY" ]; then
  echo "    reusing the existing key, which is on chain and in the keychain"
else
  send_setup account add-key "$AGENT" grant-function-call-access --allowance "$FC_ALLOWANCE" \
    --contract-account-id "$VAULT" --function-names "$FC_METHODS" autogenerate-new-keypair \
    save-to-legacy-keychain network-config "$NETWORK" sign-with-legacy-keychain send
  FC_KEY=$(find_fc_key)
  [ -n "$FC_KEY" ] || die "the new function-call key is not both on chain and in the keychain"
fi
rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$AGENT\",\"public_key\":\"$FC_KEY\"}" \
  >"$WORK/fc_key.json"
status=0
helper key-check "$WORK/fc_key.json" "$VAULT" "$FC_METHODS" "$(yocto "$FC_ALLOWANCE")" || status=$?
record "$status"
KEY_FILE="$KEYCHAIN/$AGENT/${FC_KEY//:/_}.json"
KEY_LINES=$(helper key-file "$KEY_FILE" "$FC_KEY")
{
  read -r PUBLIC_KEY
  read -r PRIVATE_KEY
  read -r IMPLICIT_ACCOUNT
} <<<"$KEY_LINES"
IMPLICIT_STATE=$(balance_of "$IMPLICIT_ACCOUNT")
echo "── the implicit account this key also controls: $IMPLICIT_ACCOUNT"
echo "    expected:  does not exist on $NETWORK"
echo "    actual:    $([ "$IMPLICIT_STATE" = missing ] && echo "does not exist" || echo "EXISTS, balance $(helper near "$IMPLICIT_STATE")")"
check "implicit account unused" [ "$IMPLICIT_STATE" = missing ]

echo
echo "== 4. Canary baseline"
vault_view
echo "── get_vault($OWNER)"
sed 's/^/    /' "$WORK/get_vault.json"
echo
check "agent is $AGENT" [ "$(helper json "$WORK/get_vault.json" 'v["agent_id"]')" = "$AGENT" ]
check "not frozen" [ "$(helper json "$WORK/get_vault.json" 'v["frozen"]')" = false ]
check "withdrawals locked" [ -n "$(helper json "$WORK/get_vault.json" 'v["withdrawals_locked_until"] or ""')" ]
BASELINE=$(helper json "$WORK/get_vault.json" 'v["balance"]')
LOCKED=$(helper json "$WORK/get_vault.json" 'v["withdrawals_locked_until"]')
echo "    baseline:  vault balance $BASELINE yoctoNEAR ($(helper near "$BASELINE")), no tokens"
echo "    locked:    until $LOCKED ($(helper utc "$LOCKED"))"

echo
echo "== Summary: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ] || die "not publishing a key for a canary that failed its checks"

cat <<EOF

================================================================================================
CANARY AGENT KEY, FOR PUBLISHING

  account:     $AGENT
  public key:  $PUBLIC_KEY
  private key: $PRIVATE_KEY

What this key can do, enforced by the NEAR protocol (the key's on-chain permission, checked above):
  - sign transactions from $AGENT that call agent_spend or agent_swap on $VAULT,
    and nothing else: no other contract, no other method, no attached deposit;
  - spend at most $FC_ALLOWANCE of $AGENT's balance on gas, in total.
It cannot transfer NEAR, add or delete keys, deploy code, or call anything else. It controls
nothing but this canary agent, plus the implicit account $IMPLICIT_ACCOUNT, which does not
exist; never send anything to that account, on any network.

The canary: $OWNER's vault on $VAULT holds $(helper near "$BASELINE") under a policy that lets the agent
pay nobody and swap nothing, with withdrawals locked until $(helper utc "$LOCKED").
Any decrease of that vault's balances (get_vault $OWNER: balance, or any token balance or
on_exchange amount) is a break. See THREAT_MODEL.md.

Check it with:
  near contract call-function as-read-only $VAULT get_vault \\
    json-args '{"owner_id":"$OWNER"}' network-config $NETWORK now
================================================================================================
EOF
