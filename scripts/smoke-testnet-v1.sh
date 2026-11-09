#!/usr/bin/env bash
# Smoke test for the v1 vault (swaps through Rhea / Ref V1) on testnet, using near-cli-rs 0.30.1.
#
# Deploys the locally built contract to a fresh account ($VAULT, vault-v2.intatto-dev.testnet by
# default; vault-v1 runs the build before the swap fee), initialized with
# new(exchange_id = ref-finance-101.testnet, treasury_id = $TREASURY), and checks agent swaps through the real
# wrap.testnet / usdt.itachicara.testnet pool #1084, with the agent signing every agent_swap with a
# function-call key that can only call agent_swap on this vault.
#
# Build the contract first: cargo near build non-reproducible-wasm
#
# Safe to re-run: the account, contract, storage registrations and the agent's function-call key
# are reused when they are already in place, the vault is topped back up instead of being funded
# again, a vault left frozen by an interrupted run is unfrozen first, and the expected result of
# each policy-limited swap accounts for swaps from earlier runs that still count toward the
# 24-hour limits. It never redeploys over a vault account that already holds different code: the
# contract has no state migration.
#
# Keys stay in ~/.near-credentials (legacy keychain). Only near CLI reads them; this script just
# checks that key files exist.
#
# As in scripts/smoke-testnet.sh, and for the same near-cli-rs 0.30.1 reasons:
#  - The agent signs with `sign-with-access-key-file <its function-call key file in the keychain>`,
#    because sign-with-legacy-keychain only ever picks a full-access key.
#  - Calls are signed with `display`, sent with `transaction send-signed-transaction`, and their
#    outcome is read back by hash over RPC, because `send` prints neither the transaction ID nor
#    the receipt logs when a transaction fails. A rejected swap may fail in a later receipt (the
#    slippage check runs in the quote callback), so outcomes collect logs from every receipt.
set -euo pipefail
# Make a failing command inside $(...) fail the substitution. Values that decide what the script
# does are always assigned to a variable first, so such a failure aborts the run.
shopt -s inherit_errexit

NETWORK=testnet
OWNER=intatto-dev.testnet
VAULT=${VAULT:-vault-v2.intatto-dev.testnet}
# The only account that can withdraw the swap fees; fixed at init.
TREASURY=${TREASURY:-intatto-dev.testnet}
# The fee build's FEE_BPS (src/fees.rs).
FEE_BPS=10
AGENT=agent.intatto-dev.testnet
EXCHANGE=ref-finance-101.testnet
WNEAR=wrap.testnet
USDT=usdt.itachicara.testnet
POOL_ID=1084
# Any pool the policy doesn't list.
OTHER_POOL_ID=0
# ref-exchange 1.9.19, the binary the sandbox tests run (tests/res/README.md).
EXCHANGE_CODE_HASH=AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX
WASM=${WASM:-target/near/intatto.wasm}
# Read-only RPC goes to exactly the node near CLI uses for $NETWORK: scripts/lib/near_rpc.py reads
# it (and any API key) from near CLI's config.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RPC_CLIENT="$SCRIPT_DIR/lib/near_rpc.py"
EXPLORER=https://explorer.testnet.near.org/transactions/
KEYCHAIN="$HOME/.near-credentials/$NETWORK"

# The contract's code storage (2.70 NEAR for the 270.3 kB fee build) is staked from the vault account.
VAULT_FUNDING='3 NEAR'
# The vault's NEAR balance pays for its own record's storage (vault, policy, token entries, spends).
VAULT_NEAR_TARGET='0.1 NEAR'
# wNEAR the owner keeps in the vault for the agent; topped back up on every run.
WNEAR_TARGET='0.2 NEAR'
# Policy: the agent may sell up to 0.1 wNEAR per swap and 0.3 wNEAR per 24 hours, may not sell
# USDT, may not spend NEAR, and may trade only through pool #1084 with at most 1% slippage.
SWAP_AMOUNT='0.1 NEAR'
PER_TX_CAP='0.1 NEAR'
DAILY_CAP='0.3 NEAR'
OVER_CAP_AMOUNT='0.2 NEAR'
MAX_SLIPPAGE_BPS=100
# The agent asks for the quote less 0.5%, inside the policy's 1%.
AGENT_SLIPPAGE_BPS=50
EXCHANGE_STORAGE='0.01 NEAR'
TOKEN_STORAGE='0.00125 NEAR' # storage_balance_bounds().min of both tokens
GAS='30 Tgas'
FT_CALL_GAS='100 Tgas'
SWAP_GAS='300 Tgas' # agent_swap needs at least AGENT_SWAP_TGAS = 255
FC_METHOD=agent_swap
# Every agent_swap reserves 300 Tgas x the gas price (0.03 NEAR at 100 Mgas/yNEAR) of allowance.
FC_ALLOWANCE='0.5 NEAR'
# A function-call key with less allowance left than this is replaced by a fresh one.
FC_MIN_ALLOWANCE='0.2 NEAR'

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/helper.py" <<'PY'
import base64, hashlib, json, os, re, sys
from decimal import Decimal

YOCTO = 10**24
WINDOW_NS = 24 * 60 * 60 * 10**9  # WINDOW_NS in src/spend.rs
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
NO_CODE = "11111111111111111111111111111111"


def b58encode(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def near(yocto):
    """yoctoNEAR (or 24-decimal token units) as a decimal amount."""
    yocto = int(yocto)
    sign, yocto = ("-" if yocto < 0 else ""), abs(yocto)
    whole, frac = divmod(yocto, YOCTO)
    frac = f"{frac:024d}".rstrip("0")
    return f"{sign}{whole}{'.' + frac if frac else ''}"


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


def events(result):
    found = [
        json.loads(log.split(":", 1)[1])
        for receipt in result["receipts_outcome"]
        for log in receipt["outcome"]["logs"]
        if log.startswith("EVENT_JSON:")
    ]
    return [event for event in found if event.get("standard") == "intatto"]


def describe(event):
    data = event.get("data") or {}
    swap = data.get("swap") or data
    details = [f"{key}={data[key]}" for key in ("reason", "held_on_exchange") if key in data]
    for key in ("amount", "amount_in", "min_amount_out"):
        if key in swap:
            details.append(f"{key}={near(swap[key])}")
    if "amount_out" in data:
        details.append(f"amount_out={near(data['amount_out'])}")
    return f"{event['event']}({', '.join(details)})"


def expectation(expected):
    if expected == "ok":
        return "success"
    if expected.startswith("ok:"):
        return f"success, returns {expected[3:]}"
    if expected == "swap-ok":
        return "success, returns true, one swap_completed event with held_on_exchange=false"
    return f"failure, with a {expected[7:]} rejection event"


def live_spends(vault, now):
    return [s for s in vault["recent_spends"] if int(s["timestamp"]) + WINDOW_NS > now]


def token_balance(vault, token_id):
    for token in vault["tokens"] if vault else []:
        if token["token_id"] == token_id:
            return int(token["balance"]), int(token["on_exchange"])
    return 0, 0


cmd, args = sys.argv[1], sys.argv[2:]

if cmd == "yocto":  # yocto <NEAR amount>: yoctoNEAR, also the units of both 24-decimal tokens
    print(int(Decimal(args[0].split()[0]) * YOCTO))

elif cmd == "near":  # near <yoctoNEAR>
    print(near(args[0]))

elif cmd == "sum":  # sum <yocto>...
    print(sum(int(a) for a in args))

elif cmd == "ge":  # ge <a> <b>: exit 0 if a >= b
    sys.exit(0 if int(args[0]) >= int(args[1]) else 1)

elif cmd == "file-hash":  # file-hash <path>: base58 sha256, as NEAR reports code hashes
    print(b58encode(hashlib.sha256(open(args[0], "rb").read()).digest()))

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

elif cmd == "fc-key":  # fc-key <view_access_key_list> <key dir> <receiver> <method> <min allowance>
    # The usable key for exactly <method> on <receiver> with the most allowance left, whose key
    # file is in the keychain.
    best = None
    for key in rpc_result(args[0])["keys"]:
        permission = key["access_key"]["permission"]
        if not isinstance(permission, dict) or "FunctionCall" not in permission:
            continue
        fc = permission["FunctionCall"]
        if fc["receiver_id"] != args[2] or fc["method_names"] != [args[3]]:
            continue
        key_file = os.path.join(args[1], key["public_key"].replace(":", "_") + ".json")
        allowance = None if fc["allowance"] is None else int(fc["allowance"])
        if not os.path.exists(key_file) or (allowance is not None and allowance < int(args[4])):
            continue
        rank = float("inf") if allowance is None else allowance
        if best is None or rank > best[0]:
            best = (rank, key["public_key"], "unlimited" if allowance is None else f"{near(allowance)} NEAR")
    if best:
        print(f"{best[1]}\t{best[2]}")

elif cmd == "key-permission":  # key-permission <view_access_key response> <receiver> <method>
    # Exit 0 only if the key is a function-call key for exactly <method> on <receiver>.
    permission = rpc_result(args[0])["permission"]
    print(f"    on chain:  {json.dumps(permission)}")
    ok = (
        isinstance(permission, dict)
        and "FunctionCall" in permission
        and permission["FunctionCall"]["receiver_id"] == args[1]
        and permission["FunctionCall"]["method_names"] == [args[2]]
    )
    print(f"    result:    {'PASS' if ok else 'FAIL'} (function-call only: {args[2]} on {args[1]})")
    sys.exit(0 if ok else 1)

elif cmd == "near-top-up":  # near-top-up <vault json> <target>: yoctoNEAR to deposit
    vault = json.load(open(args[0]))
    print(max(int(args[1]) - (int(vault["balance"]) if vault else 0), 0))

elif cmd == "token-balance":  # token-balance <vault json> <token>: "<balance> <on_exchange>"
    print(*token_balance(json.load(open(args[0])), args[1]))

elif cmd == "frozen":  # frozen <vault json>
    vault = json.load(open(args[0]))
    print("true" if vault and vault["frozen"] else "false")

elif cmd == "slippage-floor":  # slippage-floor <quote> <bps>: quote * (10000 - bps) / 10000
    print(int(args[0]) * (10_000 - int(args[1])) // 10_000)

elif cmd == "predict-swap":  # predict-swap <vault json> <block time> <token> <amount> <expected>
    # Mirrors the policy checks agent_swap runs after the pool and per-tx checks, in the
    # contract's order, for swaps left by earlier runs. Prints <expected> if they all pass.
    vault, now, token, amount, expected = json.load(open(args[0])), int(args[1]), args[2], int(args[3]), args[4]
    policy = vault["policy"]
    live = live_spends(vault, now)
    sold = sum(int(s["amount"]) for s in live if s["token_id"] == token)
    daily_cap = next(int(t["daily_cap"]) for t in policy["tokens"] if t["token_id"] == token)
    balance, _ = token_balance(vault, token)
    if len(live) >= policy["max_spends_per_24h"]:
        print("reject:too_many_spends")
    elif sold + amount > daily_cap:
        print("reject:over_daily_cap")
    elif amount > balance:
        print("reject:insufficient_balance")
    else:
        print(expected)
    print(f"{len(live)} agent action(s) in the last 24 hours, {near(sold)} {token} sold, balance {near(balance)}")

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
    found = events(result)
    status = result["status"]
    if "SuccessValue" in status:
        value = base64.b64decode(status["SuccessValue"]).decode()
        actual = f"success, returned {value}" if value else "success"
    else:
        value = None
        actual = f"failure: {find(status, 'ExecutionError') or json.dumps(status)}"
    if found:
        actual += " | events: " + ", ".join(describe(event) for event in found)
    print(f"    actual:    {actual}")
    if expected == "ok":
        passed &= value is not None
    elif expected.startswith("ok:"):
        passed &= value == expected[3:]
    elif expected == "swap-ok":
        completed = [e for e in found if e["event"] == "swap_completed"]
        passed &= value == "true" and len(completed) == 1
        passed &= bool(completed) and completed[0]["data"]["held_on_exchange"] is False
    else:
        reason = expected[len("reject:"):]
        passed &= value is None and any(
            e["event"] in ("spend_rejected", "swap_rejected") and e["data"].get("reason") == reason
            for e in found
        )
        # A rejected swap must never have started: nothing deducted, nothing deposited.
        passed &= not any(e["event"] == "swap_initiated" for e in found)
    print(f"    result:    {'PASS' if passed else 'FAIL'}")
    sys.exit(0 if passed else 1)

elif cmd == "amount-out":  # amount-out <tx response>: amount_out of its swap_completed event
    completed = [e for e in events(rpc_result(args[0])) if e["event"] == "swap_completed"]
    print(completed[0]["data"]["amount_out"] if completed else 0)

elif cmd == "swap-split":  # swap-split <tx response>: "amount_out fee net" of its swap_completed
    completed = [e for e in events(rpc_result(args[0])) if e["event"] == "swap_completed"]
    d = completed[0]["data"] if completed else {}
    print(d.get("amount_out", 0), d.get("fee", 0), d.get("net", 0))

elif cmd == "show-vault":  # show-vault <vault json> <block time>
    vault, now = json.load(open(args[0])), int(args[1])
    print(json.dumps(vault, indent=2))
    live = live_spends(vault, now)
    tokens = ", ".join(
        f"{t['token_id']} {near(t['balance'])} (+{near(t['on_exchange'])} on exchange)"
        for t in vault["tokens"]
    )
    print(
        f"NEAR {near(vault['balance'])}, frozen={str(vault['frozen']).lower()}, "
        f"agent={vault['agent_id']}, {len(live)} agent action(s) in the last 24 hours; {tokens}"
    )

else:
    sys.exit(f"unknown helper command {cmd}")
PY

helper() { python3 -I "$WORK/helper.py" "$@"; }
yocto() { helper yocto "$1"; }
# stdin from /dev/null so a missing argument makes near CLI fail instead of prompting.
near_cli() { near "$@" </dev/null; }
die() {
  echo "ABORT: $*" >&2
  exit 1
}

PASSED=0
FAILED=0
record() { if [ "$1" = 0 ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi; }
# check <description> <command...>: a PASS/FAIL line for a condition checked by the script.
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

# view <contract> <method> <json args> [<name>]: writes the JSON the view returns to
# $WORK/<name or method>.json.
view() {
  local out="$WORK/${4:-$2}.json" args_b64
  args_b64=$(printf '%s' "$3" | base64 | tr -d '\n')
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args_b64\"}" \
    >"$WORK/view_response.json"
  helper call-result "$WORK/view_response.json" >"$out" || die "view call $1.$2 failed"
}
vault_view() { view "$VAULT" get_vault "{\"owner_id\":\"$OWNER\"}"; }

# send_setup <near args...>: a plain `near ... send`, used for account, key and code setup.
send_setup() {
  if near_cli "$@" >"$WORK/setup.log" 2>&1; then
    echo "    tx:        $(helper tx-id "$WORK/setup.log")"
  else
    sed 's/^/    | /' "$WORK/setup.log"
    die "near $1 $2 failed"
  fi
}

# call <expected> <expected signer key or -> <signer> <contract> <method> <json args> <deposit>
#      <gas> <signing...>
# Signs a call with near CLI, sends it, then reads its final outcome by hash and reports it
# against <expected>: ok, ok:<return value>, swap-ok, or reject:<rejection reason>.
call() {
  local expected=$1 want_key=$2 signer=$3 contract=$4 method=$5 args=$6 deposit=$7 gas=$8
  shift 8
  if ! near_cli contract call-function as-transaction "$contract" "$method" json-args "$args" \
    prepaid-gas "$gas" attached-deposit "$deposit" sign-as "$signer" \
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

# owner_call <expected> <contract> <method> <json args> <deposit> [<gas>]
owner_call() { call "$1" - "$OWNER" "$2" "$3" "$4" "$5" "${6:-$GAS}" sign-with-legacy-keychain; }
# agent_swap <expected> <pool id> <amount_in yocto> <min_amount_out>
agent_swap() {
  local args
  args=$(printf '{"owner_id":"%s","pool_id":%s,"token_in":"%s","token_out":"%s","amount_in":"%s","min_amount_out":"%s"}' \
    "$OWNER" "$2" "$WNEAR" "$USDT" "$3" "$4")
  call "$1" "$FC_KEY" "$AGENT" "$VAULT" agent_swap "$args" '0 NEAR' "$SWAP_GAS" \
    sign-with-access-key-file "$FC_KEY_FILE"
}
# quote <amount_in yocto>: the exchange's get_return for wNEAR -> USDT through the pool.
quote() {
  view "$EXCHANGE" get_return \
    "{\"pool_id\":$POOL_ID,\"token_in\":\"$WNEAR\",\"amount_in\":\"$1\",\"token_out\":\"$USDT\"}" quote
  helper json "$WORK/quote.json" 'v'
}
# register <token or exchange> <account> <deposit> <registration_only>: storage_deposit paid by the
# owner, skipped if the account is already registered there.
register() {
  view "$1" storage_balance_of "{\"account_id\":\"$2\"}" storage
  if [ "$(helper json "$WORK/storage.json" 'v is not None')" = true ]; then
    echo "── $2 on $1: already registered ($(helper json "$WORK/storage.json" 'v'))"
    return
  fi
  echo "── $2 on $1: storage_deposit $3"
  owner_call ok "$1" storage_deposit "{\"account_id\":\"$2\",\"registration_only\":$4}" "$3"
}

echo "== Preflight"
for tool in near python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
python3 -I -c 'import tomllib' 2>/dev/null || die "python3 3.11 or later is needed (tomllib)"
RPC_URL=$(python3 -I "$RPC_CLIENT" endpoint "$NETWORK")
echo "    rpc:       $RPC_URL (near CLI's $NETWORK connection)"
echo "    near CLI:  $(near --version 2>/dev/null | tail -n 1)"
for account in "$OWNER" "$AGENT"; do
  [ -e "$KEYCHAIN/$account.json" ] || [ -d "$KEYCHAIN/$account" ] ||
    die "no legacy keychain entry for $account"
done
[ -f "$WASM" ] || die "$WASM not found; build it with: cargo near build non-reproducible-wasm"
WASM_HASH=$(helper file-hash "$WASM")
echo "    wasm:      $WASM ($(wc -c <"$WASM") bytes), code hash $WASM_HASH"
EXCHANGE_HASH=$(code_hash_of "$EXCHANGE")
echo "    exchange:  $EXCHANGE, code hash $EXCHANGE_HASH"
[ "$EXCHANGE_HASH" = "$EXCHANGE_CODE_HASH" ] ||
  die "$EXCHANGE no longer runs ref-exchange 1.9.19 ($EXCHANGE_CODE_HASH), the version the tests cover"
view "$EXCHANGE" get_pool "{\"pool_id\":$POOL_ID}" pool
POOL_TOKENS=$(helper json "$WORK/pool.json" '",".join(sorted(v["token_account_ids"]))')
echo "    pool:      #$POOL_ID $(helper json "$WORK/pool.json" 'v["pool_kind"]') [$POOL_TOKENS]"
[ "$POOL_TOKENS" = "$(printf '%s\n' "$WNEAR" "$USDT" | sort | paste -sd,)" ] ||
  die "pool #$POOL_ID does not trade $WNEAR and $USDT"
VAULT_HASH=$(code_hash_of "$VAULT")
OWNER_BALANCE=$(balance_of "$OWNER")
# What the owner pays on a first run: the vault account, the vault's NEAR, the wNEAR, storage
# registrations, plus 0.1 NEAR for gas.
NEEDED=$(helper sum "$(yocto "$VAULT_NEAR_TARGET")" "$(yocto "$WNEAR_TARGET")" \
  "$(yocto "$EXCHANGE_STORAGE")" "$(yocto "$TOKEN_STORAGE")" "$(yocto "$TOKEN_STORAGE")" \
  "$(yocto "$TOKEN_STORAGE")" "$(yocto 0.1)")
if [ "$VAULT_HASH" = missing ]; then NEEDED=$(helper sum "$NEEDED" "$(yocto "$VAULT_FUNDING")"); fi
echo "    owner:     $OWNER, balance $(helper near "$OWNER_BALANCE") NEAR, needs up to $(helper near "$NEEDED") NEAR"
helper ge "$OWNER_BALANCE" "$NEEDED" ||
  die "$OWNER needs at least $(helper near "$NEEDED") NEAR; top it up from the testnet faucet"

echo
echo "== 1. Vault account with the contract, initialized with new(exchange_id = $EXCHANGE, treasury_id = $TREASURY)"
case "$VAULT_HASH" in
missing)
  echo "── create $VAULT with $VAULT_FUNDING"
  send_setup account create-account fund-myself "$VAULT" "$VAULT_FUNDING" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
  CREATED_HASH=$(code_hash_of "$VAULT")
  [ "$CREATED_HASH" = none ] || die "$VAULT was not created (code hash: $CREATED_HASH)"
  DEPLOY=yes
  ;;
none) DEPLOY=yes ;;
"$WASM_HASH")
  echo "── $VAULT already runs this build, skipping deploy"
  DEPLOY=no
  ;;
*) die "$VAULT already runs other code ($VAULT_HASH); the contract has no migration, so use a fresh account" ;;
esac
if [ "$DEPLOY" = yes ]; then
  [ -e "$KEYCHAIN/$VAULT.json" ] || [ -d "$KEYCHAIN/$VAULT" ] ||
    die "no legacy keychain entry for $VAULT to sign the deploy with"
  echo "── deploy $WASM with init call new"
  send_setup contract deploy "$VAULT" use-file "$WASM" with-init-call new \
    json-args "{\"exchange_id\":\"$EXCHANGE\",\"treasury_id\":\"$TREASURY\"}" prepaid-gas "$GAS" attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi
echo "── on-chain code is this build"
echo "    expected:  $WASM_HASH"
DEPLOYED_HASH=$(code_hash_of "$VAULT")
echo "    actual:    $DEPLOYED_HASH"
check "code hash" [ "$DEPLOYED_HASH" = "$WASM_HASH" ]
echo "── get_exchange_id"
view "$VAULT" get_exchange_id '{}'
EXCHANGE_ID=$(helper json "$WORK/get_exchange_id.json" 'v')
echo "    expected:  $EXCHANGE"
echo "    actual:    $EXCHANGE_ID"
check "exchange fixed at init" [ "$EXCHANGE_ID" = "$EXCHANGE" ]
echo "── get_treasury_id and get_fee_bps"
view "$VAULT" get_treasury_id '{}'
TREASURY_ID=$(helper json "$WORK/get_treasury_id.json" 'v')
view "$VAULT" get_fee_bps '{}'
FEE_BPS_ONCHAIN=$(helper json "$WORK/get_fee_bps.json" 'v')
echo "    expected:  treasury $TREASURY, fee $FEE_BPS bps"
echo "    actual:    treasury $TREASURY_ID, fee $FEE_BPS_ONCHAIN bps"
check "treasury fixed at init" [ "$TREASURY_ID" = "$TREASURY" ]
check "fee fixed in code" [ "$FEE_BPS_ONCHAIN" = "$FEE_BPS" ]

echo
echo "== 2. Storage registrations"
# The vault's own account on the exchange, where swaps happen.
register "$EXCHANGE" "$VAULT" "$EXCHANGE_STORAGE" false
# The vault on both pool tokens, so the exchange can send it the output and refunds.
register "$WNEAR" "$VAULT" "$TOKEN_STORAGE" true
register "$USDT" "$VAULT" "$TOKEN_STORAGE" true
# The owner on wNEAR, to wrap NEAR.
register "$WNEAR" "$OWNER" "$TOKEN_STORAGE" true

echo
echo "== 3. Owner funds the vault, registers the agent, and deposits wNEAR"
# Order matters: the first NEAR deposit creates the vault, and ft_on_transfer only accepts tokens
# the vault's policy lists, so set_agent must come before the wNEAR deposit.
vault_view
TOP_UP=$(helper near-top-up "$WORK/get_vault.json" "$(yocto "$VAULT_NEAR_TARGET")")
if [ "$TOP_UP" = 0 ]; then
  echo "── deposit: vault already holds at least $VAULT_NEAR_TARGET, skipping"
else
  echo "── deposit $(helper near "$TOP_UP") NEAR (pays the vault record's storage)"
  owner_call ok "$VAULT" deposit '{}' "$TOP_UP yoctoNEAR"
fi
POLICY=$(printf '{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":5,"allowlist":[],"tokens":[{"token_id":"%s","per_tx_cap":"%s","daily_cap":"%s"},{"token_id":"%s","per_tx_cap":"0","daily_cap":"0"}],"pools":[{"pool_id":%s,"token_ids":["%s","%s"],"max_slippage_bps":%s}]}' \
  "$WNEAR" "$(yocto "$PER_TX_CAP")" "$(yocto "$DAILY_CAP")" "$USDT" "$POOL_ID" "$WNEAR" "$USDT" "$MAX_SLIPPAGE_BPS")
echo "── set_agent($AGENT): sell up to $PER_TX_CAP wNEAR per swap and $DAILY_CAP per 24h, no USDT, no NEAR,"
echo "   pool #$POOL_ID only with at most $MAX_SLIPPAGE_BPS bps slippage, 5 actions per 24h"
owner_call ok "$VAULT" set_agent "{\"agent_id\":\"$AGENT\",\"policy\":$POLICY}" '1 yoctoNEAR'
echo "── get_policy matches what was set"
view "$VAULT" get_policy "{\"owner_id\":\"$OWNER\"}"
status=0
helper policy-check "$WORK/get_policy.json" "$POLICY" || status=$?
record "$status"
vault_view
if [ "$(helper frozen "$WORK/get_vault.json")" = true ]; then
  echo "── vault was left frozen by an earlier run: unfreezing first"
  owner_call ok "$VAULT" unfreeze '{}' '1 yoctoNEAR'
fi
read -r WNEAR_HELD _ < <(helper token-balance "$WORK/get_vault.json" "$WNEAR")
WNEAR_TOP_UP=$(python3 -I -c 'import sys; print(max(int(sys.argv[1]) - int(sys.argv[2]), 0))' \
  "$(yocto "$WNEAR_TARGET")" "$WNEAR_HELD")
if [ "$WNEAR_TOP_UP" = 0 ]; then
  echo "── vault already holds at least $WNEAR_TARGET wNEAR for $OWNER, skipping"
else
  echo "── owner wraps $(helper near "$WNEAR_TOP_UP") NEAR"
  owner_call ok "$WNEAR" near_deposit '{}' "$WNEAR_TOP_UP yoctoNEAR"
  echo "── owner deposits $(helper near "$WNEAR_TOP_UP") wNEAR into the vault (ft_transfer_call, all of it used)"
  owner_call "ok:\"$WNEAR_TOP_UP\"" "$WNEAR" ft_transfer_call \
    "{\"receiver_id\":\"$VAULT\",\"amount\":\"$WNEAR_TOP_UP\",\"msg\":\"\"}" '1 yoctoNEAR' "$FT_CALL_GAS"
fi
vault_view
read -r WNEAR_HELD _ < <(helper token-balance "$WORK/get_vault.json" "$WNEAR")
echo "── vault's wNEAR balance for $OWNER"
echo "    expected:  at least $WNEAR_TARGET"
echo "    actual:    $(helper near "$WNEAR_HELD")"
check "wNEAR credited" helper ge "$WNEAR_HELD" "$(yocto "$WNEAR_TARGET")"

echo
echo "== 4. Agent function-call key (receiver $VAULT, method $FC_METHOD, allowance $FC_ALLOWANCE)"
find_fc_key() {
  query view_access_key_list "$AGENT" >"$WORK/agent_keys.json"
  helper fc-key "$WORK/agent_keys.json" "$KEYCHAIN/$AGENT" "$VAULT" "$FC_METHOD" "$(yocto "$FC_MIN_ALLOWANCE")"
}
FC_LINE=$(find_fc_key)
if [ -n "$FC_LINE" ]; then
  echo "    reusing an existing key that is on chain and in the keychain"
else
  echo "    expected:  new function-call key, saved to the legacy keychain"
  send_setup account add-key "$AGENT" grant-function-call-access --allowance "$FC_ALLOWANCE" \
    --contract-account-id "$VAULT" --function-names "$FC_METHOD" autogenerate-new-keypair \
    save-to-legacy-keychain network-config "$NETWORK" sign-with-legacy-keychain send
  FC_LINE=$(find_fc_key)
  [ -n "$FC_LINE" ] || die "the new function-call key is not both on chain and in the keychain"
fi
FC_KEY=${FC_LINE%%$'\t'*}
FC_KEY_FILE="$KEYCHAIN/$AGENT/${FC_KEY//:/_}.json"
echo "    key:       $FC_KEY (allowance left: ${FC_LINE#*$'\t'})"
echo "    key file:  $FC_KEY_FILE"
rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$AGENT\",\"public_key\":\"$FC_KEY\"}" \
  >"$WORK/fc_key.json"
status=0
helper key-permission "$WORK/fc_key.json" "$VAULT" "$FC_METHOD" || status=$?
record "$status"

echo
echo "== 5. Agent swaps $SWAP_AMOUNT wNEAR for USDT through pool #$POOL_ID, within policy"
AMOUNT=$(yocto "$SWAP_AMOUNT")
QUOTE=$(quote "$AMOUNT")
MIN_OUT=$(helper slippage-floor "$QUOTE" "$AGENT_SLIPPAGE_BPS")
echo "    quote:     $(helper near "$QUOTE") USDT; agent asks for at least $(helper near "$MIN_OUT") (quote - $AGENT_SLIPPAGE_BPS bps)"
vault_view
read -r USDT_BEFORE _ < <(helper token-balance "$WORK/get_vault.json" "$USDT")
read -r WNEAR_BEFORE _ < <(helper token-balance "$WORK/get_vault.json" "$WNEAR")
NOW=$(block_time)
PREDICTION=$(helper predict-swap "$WORK/get_vault.json" "$NOW" "$WNEAR" "$AMOUNT" swap-ok)
SWAP_EXPECTED=${PREDICTION%%$'\n'*}
echo "    note:      ${PREDICTION#*$'\n'}"
agent_swap "$SWAP_EXPECTED" "$POOL_ID" "$AMOUNT" "$MIN_OUT"
if [ "$SWAP_EXPECTED" = swap-ok ]; then
  read -r AMOUNT_OUT SWAP_FEE SWAP_NET < <(helper swap-split "$WORK/outcome.json")
  vault_view
  read -r USDT_AFTER USDT_ON_EXCHANGE < <(helper token-balance "$WORK/get_vault.json" "$USDT")
  read -r WNEAR_AFTER _ < <(helper token-balance "$WORK/get_vault.json" "$WNEAR")
  echo "── the owner is credited the exchange's output less the $FEE_BPS bps fee, and paid exactly $SWAP_AMOUNT wNEAR"
  echo "    expected:  USDT +$(helper near "$SWAP_NET") = $(helper near "$AMOUNT_OUT") (at least $(helper near "$MIN_OUT")) - fee $SWAP_FEE, wNEAR -$(helper near "$AMOUNT"), nothing held on the exchange"
  echo "    actual:    USDT $(helper near "$USDT_BEFORE") -> $(helper near "$USDT_AFTER") (+$(helper near "$USDT_ON_EXCHANGE") on exchange), wNEAR $(helper near "$WNEAR_BEFORE") -> $(helper near "$WNEAR_AFTER")"
  check "exact crediting, net + fee == amount_out" python3 -I -c '
import sys
before, after, out, fee, net, bps, min_out, held, w_before, w_after, amount = map(int, sys.argv[1:])
ok = (after - before == net and net + fee == out and fee == out * bps // 10000
      and out >= min_out and held == 0 and w_before - w_after == amount)
sys.exit(0 if ok else 1)
' "$USDT_BEFORE" "$USDT_AFTER" "$AMOUNT_OUT" "$SWAP_FEE" "$SWAP_NET" "$FEE_BPS" "$MIN_OUT" "$USDT_ON_EXCHANGE" "$WNEAR_BEFORE" "$WNEAR_AFTER" "$AMOUNT"
fi

echo
echo "== 6. Rejections (each must fail with a swap_rejected event and start no swap)"
echo "── $OVER_CAP_AMOUNT wNEAR, over the $PER_TX_CAP per-swap cap"
OVER=$(yocto "$OVER_CAP_AMOUNT")
OVER_QUOTE=$(quote "$OVER")
OVER_MIN_OUT=$(helper slippage-floor "$OVER_QUOTE" "$AGENT_SLIPPAGE_BPS")
agent_swap reject:over_per_tx_cap "$POOL_ID" "$OVER" "$OVER_MIN_OUT"
echo "── pool #$OTHER_POOL_ID, not on the policy's pool allowlist"
agent_swap reject:pool_not_allowlisted "$OTHER_POOL_ID" "$AMOUNT" "$MIN_OUT"
echo "── min_amount_out of 1, far looser than the quote less $MAX_SLIPPAGE_BPS bps"
vault_view
NOW=$(block_time)
PREDICTION=$(helper predict-swap "$WORK/get_vault.json" "$NOW" "$WNEAR" "$AMOUNT" reject:slippage_too_loose)
echo "    note:      ${PREDICTION#*$'\n'}"
[ "${PREDICTION%%$'\n'*}" = reject:slippage_too_loose ] ||
  echo "    note:      the 24-hour limits now reject before the quote is checked; this case cannot test slippage until they free up"
agent_swap "${PREDICTION%%$'\n'*}" "$POOL_ID" "$AMOUNT" 1
echo "── frozen vault"
echo "── owner freezes"
owner_call ok "$VAULT" freeze '{}' '0 NEAR'
echo "── agent tries a swap within policy while frozen"
agent_swap reject:frozen "$POOL_ID" "$AMOUNT" "$MIN_OUT"
echo "── owner unfreezes"
owner_call ok "$VAULT" unfreeze '{}' '1 yoctoNEAR'

echo
echo "== 7. Final state"
echo "── get_vault($OWNER)"
vault_view
NOW=$(block_time)
helper show-vault "$WORK/get_vault.json" "$NOW" | sed 's/^/    /'
echo "── the vault's deposits on the exchange (all zero: nothing is stuck there)"
view "$EXCHANGE" get_deposits "{\"account_id\":\"$VAULT\"}" deposits
echo "    actual:    $(helper json "$WORK/deposits.json" 'v')"
check "nothing left on the exchange" [ "$(helper json "$WORK/deposits.json" 'all(int(a) == 0 for a in v.values())')" = true ]
query view_access_key_list "$AGENT" >"$WORK/agent_keys.json"
echo "── agent function-call key allowance left: $(helper fc-key "$WORK/agent_keys.json" "$KEYCHAIN/$AGENT" "$VAULT" "$FC_METHOD" 0 | cut -f2)"

echo
echo "== Summary: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
