#!/usr/bin/env bash
# Regression tests for the mainnet scripts' failures of 2026-11-11. The deploy's step 3 died with
#   scripts/lib/mainnet.sh: line 67: /usr/bin/python3: Argument list too long
# because tx() put the signed deploy transaction (the wasm, base64: ~357 KB) into argv, and Linux
# refuses any single argument over 128 KiB (MAX_ARG_STRLEN, E2BIG).
#
#   scripts/test-mainnet-argv.sh [--lib DIR] [WASM]
#
# WASM is the real reproducible build of commit 6cfa90e (default
# target/reproducible/6cfa90e/intatto.wasm; checked against its pinned size and sha256). --lib runs
# the same checks against another copy of scripts/lib, for example the one before the fix:
#   mkdir /tmp/oldlib && for f in mainnet.sh mainnet_helper.py near_rpc.py; do
#     git show 674871f:scripts/lib/$f >/tmp/oldlib/$f; done
#   scripts/test-mainnet-argv.sh --lib /tmp/oldlib      # fails with "Argument list too long"
#
# Nothing touches the network: `near` is a stub on PATH and tx()'s RPC read-back is stubbed. The
# signed transaction is a real borsh SignedTransaction (DeployContract + FunctionCall new) built
# from the wasm, with a zero signature, so it could never be accepted by a node.
set -euo pipefail
shopt -s inherit_errexit

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LIB="$REPO/scripts/lib"
if [ "${1:-}" = --lib ]; then
  LIB=$(cd "$2" && pwd)
  shift 2
fi
WASM=$(realpath "${1:-$REPO/target/reproducible/6cfa90e/intatto.wasm}")
WASM_BYTES=267554
WASM_SHA256=2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5

PASSED=0
FAILED=0
pass() { echo "PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

[ -f "$WASM" ] || { echo "no wasm at $WASM; download the reproducible build of 6cfa90e (README, Status)" >&2; exit 2; }
[ "$(stat -c %s "$WASM")" = "$WASM_BYTES" ] && [ "$(sha256sum "$WASM" | cut -d' ' -f1)" = "$WASM_SHA256" ] ||
  { echo "$WASM is not the reproducible build of 6cfa90e ($WASM_BYTES bytes, sha256 $WASM_SHA256)" >&2; exit 2; }
echo "lib:  $LIB"
echo "wasm: $WASM ($WASM_BYTES bytes, sha256 $WASM_SHA256)"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# ---- fixture: a signed deploy transaction and near CLI's `display` output for it -----------------
python3 -I - "$WASM" "$T" <<'EOF'
import base64, hashlib, struct, sys

wasm = open(sys.argv[1], "rb").read()
out = sys.argv[2]
def string(text): return struct.pack("<I", len(text)) + text.encode()
def blob(data): return struct.pack("<I", len(data)) + data
init_args = b'{"exchange_id":"v2.ref-finance.near","treasury_id":"eddyhamezz.near"}'
actions = [
    b"\x01" + blob(wasm),                                                     # DeployContract
    b"\x02" + string("new") + blob(init_args)                                 # FunctionCall
    + struct.pack("<Q", 50 * 10**12) + (0).to_bytes(16, "little"),
]
tx = (string("vault.intatto.near") + b"\x00" + bytes(32) + struct.pack("<Q", 1)
      + string("vault.intatto.near") + bytes(32) + struct.pack("<I", len(actions)) + b"".join(actions))
signed = base64.b64encode(tx + b"\x00" + bytes(64)).decode()            # ed25519, zero signature
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n, tx_hash = int.from_bytes(hashlib.sha256(tx).digest(), "big"), ""
while n:
    n, r = divmod(n, 58)
    tx_hash = alphabet[r] + tx_hash
open(f"{out}/signed.b64", "w").write(signed)
open(f"{out}/hash", "w").write(tx_hash)
# The shape near-cli-rs 0.30.1 prints for `... display`, colour codes included.
open(f"{out}/display.txt", "w").write(
    "Unsigned transaction:\n...\n"
    f"\x1b[1mSigned transaction (serialized as base64):\x1b[0m\n{signed}\n\n"
    "This base64-encoded signed transaction is ready to be sent to the network.\n")
EOF
B64_LEN=$(stat -c %s "$T/signed.b64")
EXPECTED_HASH=$(<"$T/hash")
echo "signed transaction: $B64_LEN bytes of base64, hash $EXPECTED_HASH"

# ---- 1. the limit itself: this transaction cannot be one argument --------------------------------
set +e
python3 -I -c pass "$(<"$T/signed.b64")" 2>"$T/argv.err"
rc=$?
set -e
if [ "$B64_LEN" -gt 131072 ] && [ "$rc" = 126 ] && grep -q 'Argument list too long' "$T/argv.err"; then
  pass "a $B64_LEN-byte argument fails as on mainnet: $(sed 's/^.*: //' "$T/argv.err")"
else
  fail "expected E2BIG for a $B64_LEN-byte argument (exit $rc: $(cat "$T/argv.err"))"
fi

# ---- 2. tx() signs and sends the deploy without putting it in argv -------------------------------
mkdir "$T/bin"
cat >"$T/bin/near" <<'EOF'
#!/usr/bin/env bash
# Stub near CLI: `display` prints the fixture; sending records what it was given.
set -euo pipefail
case " $* " in
*" display "*) cat "$FIXTURE/display.txt" ;;
*" send-signed-transaction file-with-base64-signed-transaction "*)
  stat -c %a "$4" >"$FIXTURE/sent.mode"
  python3 -I -c '
import json, sys
sent = json.load(open(sys.argv[1]))["signed_transaction_as_base64"]
print("same" if sent == open(sys.argv[2]).read() else "different")' "$4" "$FIXTURE/signed.b64" >"$FIXTURE/sent.content"
  ;;
*" send-signed-transaction base64-signed-transaction "*) echo argv >"$FIXTURE/sent.content" ;;
*) echo "near stub: unexpected command: $*" >&2; exit 2 ;;
esac
EOF
chmod 700 "$T/bin/near"
cat >"$T/outcome.json" <<EOF
{"jsonrpc":"2.0","id":"x","result":{"status":{"SuccessValue":""},
 "transaction_outcome":{"outcome":{"executor_id":"vault.intatto.near","logs":[],"status":{"SuccessReceiptId":"r"}}},
 "receipts_outcome":[{"outcome":{"executor_id":"vault.intatto.near","logs":[],"status":{"SuccessValue":""}}}]}}
EOF

mkdir "$T/run"
set +e
(
  set -e
  cd "$T/run" # tx() writes its transaction log here
  export PATH="$T/bin:$PATH" FIXTURE="$T"
  # shellcheck source=lib/mainnet.sh
  source "$LIB/mainnet.sh"
  echo "$WORK" >"$T/work.path"
  # The RPC read-back by hash, stubbed; the hash asked for must be the transaction's.
  rpc() {
    case "$1" in
    tx) [[ "$2" == *"\"$EXPECTED_HASH\""* ]] || die "read back the wrong hash: $2"; cat "$T/outcome.json" ;;
    *) die "rpc stub: unexpected $1" ;;
    esac
  }
  PHASE=send GAS_PRICE=100000000 VAULT_ID=vault.intatto.near
  tx success vault.intatto.near keychain 0 50 "deploy the test wasm" \
    contract deploy vault.intatto.near use-file "$WASM" with-init-call new json-args '{}' \
    prepaid-gas '50 Tgas' attached-deposit '0 NEAR'
  cp "$TX_LOG" "$T/txs"
  ls -A "$WORK" >"$T/work.after"
) >"$T/tx.out" 2>&1
rc=$?
set -e
if [ "$rc" = 0 ]; then
  pass "tx() sent the $WASM_BYTES-byte deploy"
else
  fail "tx() failed (exit $rc):"
  sed 's/^/    | /' "$T/tx.out"
fi
if [ "$rc" = 0 ]; then
  [ "$(cat "$T/sent.content" 2>/dev/null)" = same ] &&
    pass "near CLI got the transaction from a file, byte for byte" ||
    fail "near CLI got $(cat "$T/sent.content" 2>/dev/null || echo nothing)"
  [ "$(cat "$T/sent.mode" 2>/dev/null)" = 600 ] &&
    pass "the signed transaction file was mode 600" ||
    fail "the signed transaction file was mode $(cat "$T/sent.mode" 2>/dev/null || echo '?')"
  [ "$(cut -d' ' -f1 "$T/txs")" = "$EXPECTED_HASH" ] &&
    pass "the transaction log has the right hash ($EXPECTED_HASH)" ||
    fail "the transaction log has $(cat "$T/txs")"
  ! grep -qE '^(signed\.json|sign\.log)$' "$T/work.after" &&
    pass "the signed transaction and near CLI's output were deleted after sending" ||
    fail "left in \$WORK after sending: $(tr '\n' ' ' <"$T/work.after")"
fi
if [ -f "$T/work.path" ] && [ ! -e "$(cat "$T/work.path")" ]; then
  pass "\$WORK was removed on exit"
else
  fail "\$WORK was not removed on exit"
fi

# ---- 3. RPC params of any size go on stdin --------------------------------------------------------
# A 400 KB params string that is deliberately not JSON: near_rpc.py must get it and reject it before
# any network call, rather than the shell failing to start python3.
set +e
(
  source "$LIB/mainnet.sh"
  rpc query "{\"pad\":\"$(head -c 400000 /dev/zero | tr '\0' a)\""
) >"$T/rpc.out" 2>&1
set -e
if grep -q 'params are not JSON' "$T/rpc.out" && ! grep -q 'Argument list too long' "$T/rpc.out"; then
  pass "a 400 KB RPC params string reaches near_rpc.py"
else
  fail "a 400 KB RPC params string did not reach near_rpc.py: $(head -c 300 "$T/rpc.out")"
fi

# ---- 4. resuming step 3: deploy_state -----------------------------------------------------------
# The vault's account and views are stubbed. Step 3 is "done" only for exactly the expected build
# with the expected exchange, treasury and fee; it deploys only to an account with no code.
EXPECTED=3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J
# deploy_case <want: deploy|done|refuse> <description> <account state> <exchange> <treasury> <fee>
deploy_case() {
  local want=$1 what=$2 out rc
  set +e
  out=$(
    exec 2>&1
    source "$LIB/mainnet.sh"
    STUB_STATE=$3 STUB_EXCHANGE=$4 STUB_TREASURY=$5 STUB_FEE=$6
    account() { echo "$STUB_STATE"; }
    view() {
      case "$2" in
      get_exchange_id) echo "$STUB_EXCHANGE" ;;
      get_treasury_id) echo "$STUB_TREASURY" ;;
      get_fee_bps) echo "$STUB_FEE" ;;
      *) die "view stub: unexpected $2" ;;
      esac
    }
    deploy_state vault.intatto.near "$EXPECTED" v2.ref-finance.near eddyhamezz.near 10
  )
  rc=$?
  set -e
  local got=$out
  [ "$rc" = 0 ] || got=refuse
  if [ "$got" = "$want" ]; then
    pass "step 3, $what: $want$([ "$want" = refuse ] && echo " (${out#ABORT: })")"
  else
    fail "step 3, $what: wanted $want, got $got (exit $rc: $out)"
  fi
}
GOOD_EX='"v2.ref-finance.near"' GOOD_TR='"eddyhamezz.near"'
deploy_case deploy "no account yet" missing "" "" ""
deploy_case deploy "account with no code" "2775540000000000000000000 none" "" "" ""
deploy_case done "the expected build, exchange, treasury and fee" "2700000000000000000000000 $EXPECTED" "$GOOD_EX" "$GOOD_TR" 10
deploy_case refuse "other code" "2700000000000000000000000 7aiNbHTnDs4irAQaaGuudHmEgcQvjuMDRzxUSGrZHHiR" "$GOOD_EX" "$GOOD_TR" 10
deploy_case refuse "the expected build, another exchange" "2700000000000000000000000 $EXPECTED" '"v2.ref-labs.near"' "$GOOD_TR" 10
deploy_case refuse "the expected build, another treasury" "2700000000000000000000000 $EXPECTED" "$GOOD_EX" '"attacker.near"' 10
deploy_case refuse "the expected build, another fee" "2700000000000000000000000 $EXPECTED" "$GOOD_EX" "$GOOD_TR" 0
deploy_case refuse "the expected build, views fail (null)" "2700000000000000000000000 $EXPECTED" null null null

# ---- 5. cost bounds cover what mainnet charged ------------------------------------------------------
# Protocol 88's fee table (EXPERIMENTAL_protocol_config, 2026-11-11), and what the two transactions
# sent on 2026-11-11 actually cost their signers (balance before - after - deposit).
cat >"$T/protocol.json" <<'EOF'
{"result":{"runtime_config":{"transaction_costs":{"action_receipt_creation_config":{"execution":108059500000,"send_not_sir":108059500000,"send_sir":108059500000},"action_creation_config":{"create_account_cost":{"execution":7200000000000,"send_not_sir":500000000000,"send_sir":500000000000},"transfer_cost":{"execution":115123062500,"send_not_sir":115123062500,"send_sir":115123062500},"deploy_contract_cost":{"execution":184765750000,"send_not_sir":184765750000,"send_sir":184765750000},"deploy_contract_cost_per_byte":{"execution":64572944,"send_not_sir":47683715,"send_sir":6812999},"function_call_cost":{"execution":780000000000,"send_not_sir":200000000000,"send_sir":200000000000},"function_call_cost_per_byte":{"execution":2235934,"send_not_sir":47683715,"send_sir":2235934},"add_key_cost":{"full_access_cost":{"execution":101765125000,"send_not_sir":101765125000,"send_sir":101765125000},"function_call_cost":{"execution":102217625000,"send_not_sir":102217625000,"send_sir":102217625000},"function_call_cost_per_byte":{"execution":1925331,"send_not_sir":47683715,"send_sir":1925331}}}},"min_gas_purchase_price":"1000000000","account_creation_charge":"7000000000000000000000","storage_amount_per_byte":"10000000000000000000"}}}
EOF
set +e
out=$(
  exec 2>&1
  source "$LIB/mainnet.sh"
  cp "$T/protocol.json" "$WORK/protocol.json"
  GAS_PRICE=100000000 ACCOUNT_CREATION_CHARGE=7000000000000000000000
  # vault.intatto.near by intatto.near (BXYjPyR5...): 0.0071149895375 NEAR
  sub=$(create_cost_yocto vault.intatto.near intatto.near)
  # intatto.near by the deployer through the registrar (Gt9czWeB...): 0.0074440391287192 NEAR
  top=$(create_cost_yocto intatto.near 45b26f4b659bf4dc8734522cfee1a16be226164f27921d4ec1130b51417f1e12)
  read -r send exec < <(helper fees "$WORK/protocol.json" deploy 267554 75)
  echo "$sub $top $(((send + exec + 50000000000000) / 100000000000))"
)
rc=$?
set -e
read -r sub top deploy_dtgas <<<"$out"
if [ "$rc" = 0 ] && python3 -I -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= 7114989537500000000000 else 1)' "$sub"; then
  pass "sub-account creation bound $(python3 -I -c 'import sys; print(int(sys.argv[1]) / 1e24)' "$sub") NEAR covers the measured 0.0071149895375"
else
  fail "sub-account creation bound: $out"
fi
if [ "$rc" = 0 ] && python3 -I -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= 7444039128719200000000 else 1)' "$top"; then
  pass "registrar creation bound $(python3 -I -c 'import sys; print(int(sys.argv[1]) / 1e24)' "$top") NEAR covers the measured 0.0074440391287192"
else
  fail "registrar creation bound: $out"
fi
if [ "$rc" = 0 ] && [ "$deploy_dtgas" = 816 ]; then
  pass "deploy of the $WASM_BYTES-byte wasm with new(): 81.6 TGas (50 prepaid + 31.6 fees)"
else
  fail "deploy gas: wanted 81.6 TGas, got ${deploy_dtgas:-?} (tenths; $out)"
fi

# ---- 4. signing is retried only before anything is signed; a send never is ----------------------
# The smoke test's --send of 2026-11-11 stopped at step 6 with near CLI's "Cannot sign a transaction
# due to an error while fetching the most recent nonce value ... error sending request for url
# (https://archival-rpc.mainnet.fastnear.com/)". Nothing was signed, so that is safe to retry.
mkdir "$T/bin4"
cat >"$T/bin4/near" <<'STUB'
#!/usr/bin/env bash
# Stub near CLI: `display` fails as $STUB_MODE says for the first $FAILS calls; sends always fail.
# (Not $MODE: scripts/lib/mainnet.sh sets that when sourced.)
set -euo pipefail
case " $* " in
*" display "*)
  n=$(($(cat "$FIXTURE/sign.count" 2>/dev/null || echo 0) + 1)); echo "$n" >"$FIXTURE/sign.count"
  if [ "$n" -le "$FAILS" ]; then
    case "$STUB_MODE" in
    transient) echo "Error: Cannot sign a transaction due to an error while fetching the most recent nonce value: error sending request for url (https://archival-rpc.mainnet.fastnear.com/)" >&2 ;;
    fatal) echo "Error: Cannot sign a transaction due to an error while fetching the most recent nonce value: Access key for public key ed25519:x does not exist while viewing" >&2 ;;
    esac
    exit 1
  fi
  cat "$FIXTURE/display.txt" ;;
*" send-signed-transaction "*)
  n=$(($(cat "$FIXTURE/send.count" 2>/dev/null || echo 0) + 1)); echo "$n" >"$FIXTURE/send.count"
  echo "Error: error sending request for url (https://archival-rpc.mainnet.fastnear.com/)" >&2; exit 1 ;;
*) echo "near stub: unexpected command: $*" >&2; exit 2 ;;
esac
STUB
chmod 700 "$T/bin4/near"
# sign4 <mode> <fails>: runs tx() once against the stub; prints "<exit> <signs> <sends> <reads>".
sign4() {
  rm -f "$T/sign.count" "$T/send.count" "$T/read.count"
  mkdir -p "$T/run4"
  set +e
  (
    set -e
    cd "$T/run4"
    export PATH="$T/bin4:$PATH" FIXTURE="$T" STUB_MODE=$1 FAILS=$2
    # shellcheck source=lib/mainnet.sh
    source "$LIB/mainnet.sh"
    SIGN_FIRST_DELAY_S=0
    rpc() {
      case "$1" in
      tx) echo x >>"$T/read.count"; cat "$T/outcome.json" ;;
      *) die "rpc stub: unexpected $1" ;;
      esac
    }
    PHASE=send GAS_PRICE=100000000 VAULT_ID=vault.intatto.near
    tx success vault.intatto.near keychain 0 50 "deploy the test wasm" \
      contract deploy vault.intatto.near use-file "$WASM" with-init-call new json-args '{}' \
      prepaid-gas '50 Tgas' attached-deposit '0 NEAR'
  ) >"$T/sign4.out" 2>&1
  local rc=$?
  set -e
  echo "$rc $(cat "$T/sign.count" 2>/dev/null || echo 0) $(cat "$T/send.count" 2>/dev/null || echo 0) $(cat "$T/read.count" 2>/dev/null | wc -l)"
}
if ! grep -q 'SIGN_ATTEMPTS' "$LIB/mainnet.sh"; then
  fail "this lib has no signing retry (sign_tx)"
else
  read -r rc signs sends reads <<<"$(sign4 transient 2)"
  if [ "$rc" = 0 ] && [ "$signs" = 3 ] && [ "$sends" = 1 ] && [ "$reads" = 1 ]; then
    pass "a nonce fetch that fails twice is retried; then signed once, sent once, read back by hash"
  else
    fail "transient signing failure: exit $rc, $signs signs, $sends sends, $reads reads"
    sed 's/^/    | /' "$T/sign4.out"
  fi
  read -r rc signs sends reads <<<"$(sign4 transient 99)"
  if [ "$rc" != 0 ] && [ "$signs" = 5 ] && [ "$sends" = 0 ] && grep -q 'could not sign' "$T/sign4.out"; then
    pass "signing gives up after 5 tries and sends nothing"
  else
    fail "persistent signing failure: exit $rc, $signs signs, $sends sends"
    sed 's/^/    | /' "$T/sign4.out"
  fi
  read -r rc signs sends reads <<<"$(sign4 fatal 99)"
  if [ "$rc" != 0 ] && [ "$signs" = 1 ] && [ "$sends" = 0 ]; then
    pass "a missing access key is not retried"
  else
    fail "fatal signing failure: exit $rc, $signs signs, $sends sends"
    sed 's/^/    | /' "$T/sign4.out"
  fi
  # The send itself fails (a connection error): it is not re-sent; its outcome is read by hash.
  read -r rc signs sends reads <<<"$(sign4 none 0)"
  if [ "$rc" = 0 ] && [ "$signs" = 1 ] && [ "$sends" = 1 ] && [ "$reads" = 1 ]; then
    pass "a failed send is never re-sent: its outcome is read back by hash instead"
  else
    fail "failed send: exit $rc, $signs signs, $sends sends, $reads reads"
    sed 's/^/    | /' "$T/sign4.out"
  fi
fi

echo "== $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
