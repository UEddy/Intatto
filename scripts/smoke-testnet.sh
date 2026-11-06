#!/usr/bin/env bash
# Smoke test for the Intatto vault on testnet, using near-cli-rs 0.30.1.
#
# Safe to re-run: existing sub-accounts and the agent's function-call key are reused, the vault is
# topped back up to 2 NEAR instead of being funded again, a vault left frozen by an interrupted run
# is unfrozen first, and the expected result of the first spend accounts for spends from earlier
# runs that still count toward the 24-hour limits.
#
# Keys stay in ~/.near-credentials (legacy keychain). Only near CLI reads them; this script just
# checks that key files exist.
#
# Two things differ from a plain `near ... sign-with-legacy-keychain send`, both because of how
# near-cli-rs 0.30.1 behaves:
#  - The agent signs with `sign-with-access-key-file <its function-call key file in the keychain>`.
#    Online, sign-with-legacy-keychain only ever picks a full-access key (or <account>.json) and
#    ignores --signer-public-key, so it cannot sign with a function-call key.
#  - Contract calls are signed with `display`, sent with `transaction send-signed-transaction`, and
#    their outcome is read back by hash over RPC, because `send` prints neither the transaction ID
#    nor the receipt logs when a transaction fails.
set -euo pipefail
# Make a failing command inside $(...) fail the substitution. Values that decide what the script
# does are always assigned to a variable first, so such a failure aborts the run.
shopt -s inherit_errexit

NETWORK=testnet
VAULT=vault.intatto-dev.testnet
OWNER=intatto-dev.testnet
AGENT=agent.intatto-dev.testnet
SHOP=shop.intatto-dev.testnet
EXPECTED_CODE_HASH=${EXPECTED_CODE_HASH:-943PC8wNhozLRbPULhuAH9PsZKg2AnNjbSaYUrbhkRfG}
# Read-only RPC goes to exactly the node near CLI uses for $NETWORK: scripts/lib/near_rpc.py reads
# it (and any API key) from near CLI's config.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RPC_CLIENT="$SCRIPT_DIR/lib/near_rpc.py"
EXPLORER=https://explorer.testnet.near.org/transactions/
KEYCHAIN="$HOME/.near-credentials/$NETWORK"
GAS='30 Tgas'
FC_ALLOWANCE='0.1 NEAR'
# A function-call key with less allowance left than this is replaced by a fresh one.
FC_MIN_ALLOWANCE='0.02 NEAR'

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/helper.py" <<'PY'
import base64, hashlib, json, os, re, sys
from decimal import Decimal

YOCTO = 10**24
WINDOW_NS = 24 * 60 * 60 * 10**9  # WINDOW_NS in src/lib.rs
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def near(yocto):
    yocto = int(yocto)
    sign, yocto = ("-" if yocto < 0 else ""), abs(yocto)
    whole, frac = divmod(yocto, YOCTO)
    frac = f"{frac:024d}".rstrip("0")
    return f"{sign}{whole}{'.' + frac if frac else ''} NEAR"


def strip_ansi(text):
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


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


def describe(event):
    data = event.get("data") or {}
    details = [f"{key}={data[key]}" for key in ("spend_id", "reason") if key in data]
    if "amount" in data:
        details.append(f"amount={near(data['amount'])}")
    return f"{event['event']}({', '.join(details)})"


def expectation(expected):
    if expected == "ok":
        return "success"
    if expected.startswith("ok:"):
        return f"success, returns {expected[3:]}"
    return f"failure, with a spend_rejected(reason={expected[7:]}) event"


cmd, args = sys.argv[1], sys.argv[2:]

if cmd == "yocto":  # yocto <NEAR amount>
    print(int(Decimal(args[0].split()[0]) * YOCTO))

elif cmd == "near":  # near <yoctoNEAR>
    print(near(args[0]))

elif cmd == "signed-b64":  # signed-b64 <output of `near ... display`>
    text = strip_ansi(open(args[0]).read())
    match = re.search(r"Signed transaction \(serialized as base64\):\s+(\S+)", text)
    if not match:
        sys.exit("no signed transaction found in near CLI output")
    print(match.group(1))

elif cmd == "tx-hash":  # tx-hash <base64 signed transaction>
    raw = base64.b64decode(args[0])
    # A SignedTransaction is borsh(Transaction) followed by borsh(Signature), and an ed25519
    # signature is a 0 tag plus 64 bytes. The transaction ID is the sha256 of the first part.
    if raw[-65] != 0:
        sys.exit("expected an ed25519-signed transaction")
    print(b58encode(hashlib.sha256(raw[:-65]).digest()))

elif cmd == "tx-id":  # tx-id <output of a plain `near ... send`>
    ids = re.findall(r"Transaction ID: (\w+)", strip_ansi(open(args[0]).read()))
    print(ids[-1] if ids else "(not printed)")

elif cmd == "account-amount":  # account-amount <view_account response>: yoctoNEAR, or "missing"
    print("missing" if unknown_account(args[0]) else rpc_result(args[0])["amount"])

elif cmd == "code-hash":  # code-hash <view_account response>
    print(rpc_result(args[0])["code_hash"])

elif cmd == "block-time":  # block-time <block response>
    print(rpc_result(args[0])["header"]["timestamp"])

elif cmd == "fc-key":  # fc-key <view_access_key_list response> <key dir> <vault> <min allowance>
    # The usable agent_spend-only key for the vault with the most allowance left, whose key file
    # is in the keychain.
    best = None
    for key in rpc_result(args[0])["keys"]:
        permission = key["access_key"]["permission"]
        if not isinstance(permission, dict) or "FunctionCall" not in permission:
            continue
        fc = permission["FunctionCall"]
        if fc["receiver_id"] != args[2] or fc["method_names"] != ["agent_spend"]:
            continue
        key_file = os.path.join(args[1], key["public_key"].replace(":", "_") + ".json")
        allowance = None if fc["allowance"] is None else int(fc["allowance"])
        if not os.path.exists(key_file) or (allowance is not None and allowance < int(args[3])):
            continue
        rank = float("inf") if allowance is None else allowance
        if best is None or rank > best[0]:
            best = (rank, key["public_key"], "unlimited" if allowance is None else near(allowance))
    if best:
        print(f"{best[1]}\t{best[2]}")

elif cmd == "top-up":  # top-up <vault json> <target>: yoctoNEAR to deposit to reach the target
    vault = json.load(open(args[0]))
    print(max(int(args[1]) - (int(vault["balance"]) if vault else 0), 0))

elif cmd == "frozen":  # frozen <vault json>
    vault = json.load(open(args[0]))
    print("true" if vault and vault["frozen"] else "false")

elif cmd == "predict-spend":  # predict-spend <vault json> <block time> <amount>
    # Mirrors agent_spend's 24-hour checks, in the contract's order, for spends left by earlier runs.
    vault, now, amount = json.load(open(args[0])), int(args[1]), int(args[2])
    live = [s for s in vault["recent_spends"] if int(s["timestamp"]) + WINDOW_NS > now]
    spent = sum(int(s["amount"]) for s in live)
    if len(live) >= vault["policy"]["max_spends_per_24h"]:
        print("reject:too_many_spends")
    elif spent + amount > int(vault["policy"]["daily_cap"]):
        print("reject:over_daily_cap")
    else:
        print("ok:true")
    print(f"{len(live)} spend(s) totalling {near(spent)} already count toward the 24-hour limits")

elif cmd == "policy-check":  # policy-check <policy json> <expected policy json>
    actual, expected = json.load(open(args[0])), json.loads(args[1])
    print(f"    expected:  {json.dumps(expected, sort_keys=True)}")
    print(f"    actual:    {json.dumps(actual, sort_keys=True)}")
    print(f"    result:    {'PASS' if actual == expected else 'FAIL'}")
    sys.exit(0 if actual == expected else 1)

elif cmd == "outcome":  # outcome <tx response> <expected> <expected signer key or -> <tx hash> <explorer>
    path, expected, want_key, tx_hash, explorer = args
    print(f"    tx:        {tx_hash}")
    print(f"    explorer:  {explorer}{tx_hash}")
    print(f"    expected:  {expectation(expected)}")
    response = load_response(path)
    if "error" in response:
        # near_rpc.py passes an error through only when it is the node's answer; for a
        # transaction that means UNKNOWN_TRANSACTION on every attempt.
        known = error_name(response) == "UNKNOWN_TRANSACTION"
        what = "transaction not found on chain" if known else "RPC error"
        print(f"    actual:    {what}: {json.dumps(response['error'])}")
        print("    result:    FAIL")
        sys.exit(1)
    result = response["result"]
    passed = True
    signer_key = result["transaction"]["public_key"]
    if want_key != "-":
        same_key = signer_key == want_key
        passed &= same_key
        note = "the agent's function-call key" if same_key else f"NOT the function-call key {want_key}"
        print(f"    signed by: {signer_key} ({note})")
    events = [
        json.loads(log.split(":", 1)[1])
        for receipt in result["receipts_outcome"]
        for log in receipt["outcome"]["logs"]
        if log.startswith("EVENT_JSON:")
    ]
    events = [event for event in events if event.get("standard") == "intatto"]
    status = result["status"]
    if "SuccessValue" in status:
        value = base64.b64decode(status["SuccessValue"]).decode()
        actual = f"success, returned {value}" if value else "success"
    else:
        value = None
        actual = f"failure: {find(status, 'ExecutionError') or json.dumps(status)}"
    if events:
        actual += " | events: " + ", ".join(describe(event) for event in events)
    print(f"    actual:    {actual}")
    if expected == "ok":
        passed &= value is not None
    elif expected.startswith("ok:"):
        passed &= value == expected[3:]
    else:
        reason = expected[len("reject:"):]
        passed &= value is None and any(
            e["event"] == "spend_rejected" and e["data"].get("reason") == reason for e in events
        )
    print(f"    result:    {'PASS' if passed else 'FAIL'}")
    sys.exit(0 if passed else 1)

elif cmd == "succeeded":  # succeeded <tx response>: exit 0 if the call returned true, 1 if not,
    # 2 if the response holds no outcome (the transaction was not found)
    response = load_response(args[0])
    if "error" in response:
        sys.exit(2)
    status = response["result"]["status"]
    sys.exit(0 if base64.b64decode(status.get("SuccessValue", "")) == b"true" else 1)

elif cmd == "show-vault":  # show-vault <vault json> <block time>
    vault, now = json.load(open(args[0])), int(args[1])
    print(json.dumps(vault, indent=2))
    live = [s for s in vault["recent_spends"] if int(s["timestamp"]) + WINDOW_NS > now]
    print(
        f"balance {near(vault['balance'])}, frozen={str(vault['frozen']).lower()}, "
        f"agent={vault['agent_id']}, {len(live)} spend(s) totalling "
        f"{near(sum(int(s['amount']) for s in live))} in the last 24 hours"
    )

else:
    sys.exit(f"unknown helper command {cmd}")
PY

helper() { python3 -I "$WORK/helper.py" "$@"; }
# stdin from /dev/null so a missing argument makes near CLI fail instead of prompting.
near_cli() { near "$@" </dev/null; }
die() {
  echo "ABORT: $*" >&2
  exit 1
}

PASSED=0
FAILED=0
record() { if [ "$1" = 0 ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi; }

# rpc <method> <params json>: one JSON-RPC response, either a result or an error that is the node's
# answer (UNKNOWN_ACCOUNT, ...). Rate limits and unusable responses are retried with backoff; if no
# usable response comes, scripts/lib/near_rpc.py prints why and the raw response and fails, which
# ends the run. Its output is never a guess.
rpc() { python3 -I "$RPC_CLIENT" call "$NETWORK" "$1" "$2"; }
query() { rpc query "{\"request_type\":\"$1\",\"finality\":\"final\",\"account_id\":\"$2\"}"; }
balance_of() { query view_account "$1" >"$WORK/account.json" && helper account-amount "$WORK/account.json"; }
block_time() { rpc block '{"finality":"final"}' >"$WORK/block.json" && helper block-time "$WORK/block.json"; }

# view <method> <json args>: writes the view function's JSON return value to $WORK/<method>.json.
view() {
  near_cli contract call-function as-read-only "$VAULT" "$1" json-args "$2" \
    network-config "$NETWORK" now >"$WORK/$1.json" 2>"$WORK/view.log" ||
    { cat "$WORK/view.log" >&2; die "view call $1 failed"; }
}

# send_setup <near args...>: a plain `near ... send`, used for account and key setup.
send_setup() {
  if near_cli "$@" >"$WORK/setup.log" 2>&1; then
    echo "    tx:        $(helper tx-id "$WORK/setup.log")"
  else
    sed 's/^/    | /' "$WORK/setup.log"
    die "near $1 $2 failed"
  fi
}

# call <expected> <expected signer key or -> <signer> <method> <json args> <deposit> <signing...>
# Signs a vault call with near CLI, sends it, then reads its final outcome by hash and reports it
# against <expected>: ok, ok:<return value>, or reject:<spend_rejected reason>.
call() {
  local expected=$1 want_key=$2 signer=$3 method=$4 args=$5 deposit=$6
  shift 6
  if ! near_cli contract call-function as-transaction "$VAULT" "$method" json-args "$args" \
    prepaid-gas "$GAS" attached-deposit "$deposit" sign-as "$signer" \
    network-config "$NETWORK" "$@" display >"$WORK/sign.log" 2>&1; then
    sed 's/^/    | /' "$WORK/sign.log"
    echo "    result:    FAIL (could not sign)"
    record 1
    return
  fi
  local signed tx_hash
  signed=$(helper signed-b64 "$WORK/sign.log")
  tx_hash=$(helper tx-hash "$signed")
  # A rejected call makes near CLI exit non-zero; the outcome below is what gets judged.
  near_cli transaction send-signed-transaction base64-signed-transaction "$signed" \
    network-config "$NETWORK" send >"$WORK/send.log" 2>&1 || true
  rpc tx "{\"tx_hash\":\"$tx_hash\",\"sender_account_id\":\"$signer\",\"wait_until\":\"FINAL\"}" \
    >"$WORK/outcome.json" ||
    die "could not read the outcome of $tx_hash over RPC; check $EXPLORER$tx_hash before re-running"
  local status=0
  helper outcome "$WORK/outcome.json" "$expected" "$want_key" "$tx_hash" "$EXPLORER" || status=$?
  if [ "$status" != 0 ]; then sed 's/^/    | /' "$WORK/send.log" | tail -n 20; fi
  record "$status"
}

owner_call() { call "$1" - "$OWNER" "$2" "$3" "$4" sign-with-legacy-keychain; }
agent_spend() {
  local args
  args=$(printf '{"owner_id":"%s","receiver_id":"%s","amount":"%s"}' "$OWNER" "$2" "$(helper yocto "$3")")
  call "$1" "$FC_KEY" "$AGENT" agent_spend "$args" '0 NEAR' sign-with-access-key-file "$FC_KEY_FILE"
}

echo "== Preflight"
for tool in near python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
python3 -I -c 'import tomllib' 2>/dev/null || die "python3 3.11 or later is needed (tomllib)"
RPC_URL=$(python3 -I "$RPC_CLIENT" endpoint "$NETWORK")
echo "    rpc:       $RPC_URL (near CLI's $NETWORK connection)"
echo "    near CLI:  $(near --version)"
[ -e "$KEYCHAIN/$OWNER.json" ] || [ -d "$KEYCHAIN/$OWNER" ] || die "no legacy keychain entry for $OWNER"
query view_account "$VAULT" >"$WORK/vault_account.json"
CODE_HASH=$(helper code-hash "$WORK/vault_account.json")
echo "    vault:     $VAULT, code hash $CODE_HASH"
[ "$CODE_HASH" = "$EXPECTED_CODE_HASH" ] ||
  die "vault code hash is not $EXPECTED_CODE_HASH (set EXPECTED_CODE_HASH to run against this build)"
OWNER_BALANCE=$(balance_of "$OWNER")
echo "    owner:     $OWNER, balance $(helper near "$OWNER_BALANCE")"

echo
echo "== 1. Sub-accounts with 1 NEAR each"
for account in "$AGENT" "$SHOP"; do
  echo "── $account"
  existing=$(balance_of "$account")
  if [ "$existing" != missing ]; then
    echo "    exists (balance $(helper near "$existing")), skipping creation"
    continue
  fi
  echo "    expected:  account created with 1 NEAR"
  send_setup account create-account fund-myself "$account" '1 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
  created=$(balance_of "$account")
  [ "$created" != missing ] || die "$account was not created"
  echo "    actual:    created, balance $(helper near "$created")"
done
SHOP_BALANCE_BEFORE=$(balance_of "$SHOP")

echo
echo "== 2. Agent function-call key (receiver $VAULT, method agent_spend, allowance $FC_ALLOWANCE)"
find_fc_key() {
  query view_access_key_list "$AGENT" >"$WORK/agent_keys.json"
  helper fc-key "$WORK/agent_keys.json" "$KEYCHAIN/$AGENT" "$VAULT" "$(helper yocto "$FC_MIN_ALLOWANCE")"
}
FC_LINE=$(find_fc_key)
if [ -n "$FC_LINE" ]; then
  echo "    reusing an existing key that is on chain and in the keychain"
else
  [ -e "$KEYCHAIN/$AGENT.json" ] || [ -d "$KEYCHAIN/$AGENT" ] ||
    die "no legacy keychain entry for $AGENT to sign add-key with"
  echo "    expected:  new function-call key, saved to the legacy keychain"
  send_setup account add-key "$AGENT" grant-function-call-access --allowance "$FC_ALLOWANCE" \
    --contract-account-id "$VAULT" --function-names agent_spend autogenerate-new-keypair \
    save-to-legacy-keychain network-config "$NETWORK" sign-with-legacy-keychain send
  FC_LINE=$(find_fc_key)
  [ -n "$FC_LINE" ] || die "the new function-call key is not both on chain and in the keychain"
fi
FC_KEY=${FC_LINE%%$'\t'*}
FC_KEY_FILE="$KEYCHAIN/$AGENT/${FC_KEY//:/_}.json"
echo "    key:       $FC_KEY (allowance left: ${FC_LINE#*$'\t'})"
echo "    key file:  $FC_KEY_FILE"

echo
echo "== 3. Owner funds the vault and registers the agent"
view get_vault "{\"owner_id\":\"$OWNER\"}"
TOP_UP=$(helper top-up "$WORK/get_vault.json" "$(helper yocto 2)")
if [ "$TOP_UP" = 0 ]; then
  echo "── deposit: vault already holds at least 2 NEAR, skipping"
else
  echo "── deposit $(helper near "$TOP_UP") (2 NEAR on the first run, a top-up back to 2 NEAR after)"
  owner_call ok deposit '{}' "$TOP_UP yoctoNEAR"
fi
POLICY=$(printf '{"per_tx_cap":"%s","daily_cap":"%s","max_spends_per_24h":5,"allowlist":["%s"]}' \
  "$(helper yocto 0.1)" "$(helper yocto 0.3)" "$SHOP")
echo "── set_agent($AGENT, per-tx 0.1 NEAR, 24h 0.3 NEAR, 5 spends per 24h, allowlist [$SHOP])"
owner_call ok set_agent "{\"agent_id\":\"$AGENT\",\"policy\":$POLICY}" '1 yoctoNEAR'
echo "── get_policy matches what was set"
view get_policy "{\"owner_id\":\"$OWNER\"}"
status=0
helper policy-check "$WORK/get_policy.json" "$POLICY" || status=$?
record "$status"
view get_vault "{\"owner_id\":\"$OWNER\"}"
FROZEN=$(helper frozen "$WORK/get_vault.json")
if [ "$FROZEN" = true ]; then
  echo "── vault was left frozen by an earlier run: unfreezing first"
  owner_call ok unfreeze '{}' '1 yoctoNEAR'
fi

echo
echo "== 4. Agent spends 0.1 NEAR to $SHOP"
NOW=$(block_time)
PREDICTION=$(helper predict-spend "$WORK/get_vault.json" "$NOW" "$(helper yocto 0.1)")
SPEND_EXPECTED=${PREDICTION%%$'\n'*}
echo "    note:      ${PREDICTION#*$'\n'}"
agent_spend "$SPEND_EXPECTED" "$SHOP" 0.1
SHOP_EXPECTED_GAIN=0
status=0
helper succeeded "$WORK/outcome.json" || status=$?
case "$status" in
0) SHOP_EXPECTED_GAIN=$(helper yocto 0.1) ;;
1) ;;
*) die "the spend's outcome is unknown, so the shop's balance change cannot be checked" ;;
esac

echo
echo "== 5. Agent tries 0.2 NEAR (over the 0.1 NEAR per-tx cap)"
agent_spend reject:over_per_tx_cap "$SHOP" 0.2

echo
echo "== 6. Agent tries 0.05 NEAR to $OWNER (not allowlisted)"
agent_spend reject:receiver_not_allowlisted "$OWNER" 0.05

echo
echo "== 7. Freeze blocks the agent"
echo "── owner freezes"
owner_call ok freeze '{}' '0 NEAR'
echo "── agent tries 0.05 NEAR to $SHOP while frozen"
agent_spend reject:frozen "$SHOP" 0.05
echo "── owner unfreezes"
owner_call ok unfreeze '{}' '1 yoctoNEAR'

echo
echo "== 8. Final state"
echo "── get_vault($OWNER)"
view get_vault "{\"owner_id\":\"$OWNER\"}"
NOW=$(block_time)
helper show-vault "$WORK/get_vault.json" "$NOW" | sed 's/^/    /'
echo "── $SHOP balance change during this run"
SHOP_BALANCE_AFTER=$(balance_of "$SHOP")
SHOP_GAIN=$(python3 -I -c 'import sys; print(int(sys.argv[2]) - int(sys.argv[1]))' \
  "$SHOP_BALANCE_BEFORE" "$SHOP_BALANCE_AFTER")
echo "    expected:  +$(helper near "$SHOP_EXPECTED_GAIN")"
echo "    actual:    +$(helper near "$SHOP_GAIN") ($(helper near "$SHOP_BALANCE_BEFORE") -> $(helper near "$SHOP_BALANCE_AFTER"))"
if [ "$SHOP_GAIN" = "$SHOP_EXPECTED_GAIN" ]; then
  echo "    result:    PASS"
  record 0
else
  echo "    result:    FAIL"
  record 1
fi
query view_access_key_list "$AGENT" >"$WORK/agent_keys.json"
echo "── agent function-call key allowance left: $(helper fc-key "$WORK/agent_keys.json" "$KEYCHAIN/$AGENT" "$VAULT" 0 | cut -f2)"

echo
echo "== Summary: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
