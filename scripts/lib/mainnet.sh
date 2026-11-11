# Shared by scripts/mainnet-*.sh. Sourced, not run.
#
# Every script declares its steps once, in a `steps` function, and it runs twice:
#   1. estimate: reads live state, prints each step's command and its cost, and the total. Nothing
#      is signed or sent. This is all that happens without --send.
#   2. send (only with --send, after typing the confirmation): signs and sends each step that is
#      still needed, and checks its outcome over RPC before the next one.
#
# Costs (protocol 88, checked against mainnet transactions Gt9czWeB... and BXYjPyR5... on
# 2026-11-11, to the yoctoNEAR):
#   - What a transaction spends, at most: its deposit, plus its static action fees (send and
#     execution, from the live protocol config) and its prepaid gas at the current gas price, plus
#     the protocol's flat account_creation_charge (0.007 NEAR) for each account it creates. That
#     charge is most of an account creation's cost: it measured 0.007115 NEAR (sub-account) and
#     0.007444 NEAR (top-level, through the `near` registrar), not the 30 TGas (0.003 NEAR) the
#     plan used to assume.
#   - What its signer must hold when it is sent: its deposit, its send fees at the gas price, and
#     its execution fees and prepaid gas at the gas purchase price, max(gas price,
#     min_gas_purchase_price): 1e9 against a gas price of 1e8. The unused part is refunded, so this
#     is needed at hand, not spent. A function-call key's allowance must cover the same gas part.
#   - On top, the storage the signer's balance must keep staked after the step: its live storage
#     (or ACCOUNT_RECORD_BYTES for an account this plan creates), plus what earlier steps added
#     (code, keys; tx --storage).
# Totals are per signer: an account the plan creates pays its own steps from the balance the plan
# gives it, so only the funder's (PAYER's) total comes out of your wallet. Every signer, and every
# function-call key, is checked against its balance (live, or the one the plan gives it): --send
# refuses a plan that does not fit.
#
# Transactions are signed with `display`, sent with `transaction send-signed-transaction`, and read
# back by hash over RPC (scripts/lib/near_rpc.py), as in the testnet scripts, because near-cli-rs
# 0.30.1's `send` prints no transaction id when a transaction fails.
#
# Nothing of unbounded size goes into argv: Linux refuses any single argument over 128 KiB (E2BIG,
# "Argument list too long"), and a signed deploy is ~360 KB of base64. The signed transaction goes
# from near CLI's output file to a JSON file (mode 600) that near CLI sends from, and RPC params go
# to near_rpc.py on stdin. Temporary files live in $WORK (mode 700, umask 077) and are removed on
# exit, including on Ctrl-C. scripts/test-mainnet-argv.sh checks this with the real deploy wasm.

NETWORK=mainnet
LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RPC_CLIENT="$LIB_DIR/near_rpc.py"
HELPER="$LIB_DIR/mainnet_helper.py"
EXPLORER=https://explorer.near.org/transactions/
KEYCHAIN="$HOME/.near-credentials/$NETWORK"
EXCHANGE=v2.ref-finance.near
# ref-exchange 1.9.21 on v2.ref-finance.near (metadata().version, view_code, 2026-11-09); the
# sandbox suite runs against this binary (tests/res/README.md).
EXCHANGE_CODE_HASH=GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi
WNEAR=wrap.near
USDT=usdt.tether-token.near
USDT_DECIMALS=6
POOL_ID=3879
FEE_BPS=10

# What scripts/mainnet-canary.sh and scripts/mainnet-smoke.sh give the accounts they create, defined
# once so that scripts/mainnet-deploy.sh can fund ROOT_ACCOUNT for both (run them with
# FUNDER=ROOT_ACCOUNT). Each script still takes its own overrides (FC_ALLOWANCE, SWAP_NEAR).
CANARY_FC_ALLOWANCE_DEFAULT=0.25
# The canary owner's balance beyond the bounty: its account storage, the vault record, policy and
# lock storage (charged to the vault balance), and gas.
CANARY_OWNER_EXTRA=0.1
CANARY_AGENT_EXTRA=0.05
SMOKE_SWAP_NEAR_DEFAULT=0.5
# A function-call key's allowance caps the gas the key may buy; it holds no NEAR, and the gas is
# paid from the agent account's balance. Each agent_swap (300 TGas) needs ~0.301 NEAR at hand: its
# gas is bought at the purchase price (1e9) and the unused part refunded to the balance. Whether
# the refund also restores the allowance is not verified on chain, so the fit check assumes it
# does not (every call's gas at the purchase price counts against the allowance), and the
# allowance is set well above that: 2 NEAR against ~1.51 NEAR for the five agent calls. The real
# limit is the agent account's balance, SMOKE_AGENT_BALANCE, which does not follow the allowance.
SMOKE_FC_ALLOWANCE_DEFAULT=2
# The smoke owner's balance beyond the swap: vault deposit (0.05), two token registrations, gas,
# and ~0.301 NEAR at hand for its own 300 TGas agent_swap (the not_agent rejection). It needs
# 0.8872 NEAR at once at most (dry run, 2026-11-11).
SMOKE_OWNER_EXTRA=0.45
# The smoke agent's initial balance: ~0.301 NEAR at hand for one agent_swap at a time, the gas
# its calls spend, and its account and key storage.
SMOKE_AGENT_BALANCE=0.55

# Initial balances in yoctoNEAR, from NEAR amounts.
canary_owner_yocto() { helper add "$(helper yocto "$1")" "$(helper yocto "$CANARY_OWNER_EXTRA")"; }
canary_agent_yocto() { helper add "$(helper yocto "$1")" "$(helper yocto "$CANARY_AGENT_EXTRA")"; }
smoke_owner_yocto() { helper add "$(helper yocto "$1")" "$(helper yocto "$SMOKE_OWNER_EXTRA")"; }
smoke_agent_yocto() { helper yocto "$SMOKE_AGENT_BALANCE"; }

MODE=dry-run
PHASE=estimate
TOTAL_YOCTO=0
STEP_NO=0
# Per signer: what its steps spend at most (SIGNER_COST), and the most it must hold at once
# (SIGNER_NEED: what it spent before a step plus that step's up-front cost). The same for the gas
# a function-call key's allowance pays (KEY_COST, KEY_NEED).
declare -A SIGNER_COST=() SIGNER_NEED=() KEY_COST=() KEY_NEED=() KEY_SPEC=()
# Per signer: the storage (bytes) its balance must keep staked, as of the steps planned so far.
declare -A SIGNER_STORAGE=()
# An account with one full-access key, as created here (storage_usage of intatto.near,
# vault.intatto.near and the deployer on mainnet).
ACCOUNT_RECORD_BYTES=182
# Balances and allowances this plan gives the accounts and keys it creates.
declare -A PLANNED_BALANCE=() PLANNED_ALLOWANCE=()
SIGNERS=()
# The `near` registrar's create_account, as near CLI calls it to create a top-level account.
REGISTRAR_TGAS=30
# Signed transactions, keys and RPC responses are written only by this user.
umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Run the EXIT trap on Ctrl-C and kill too.
trap 'exit 130' INT
trap 'exit 143' TERM
LAST_TX_HASH=
# Every sent transaction, one "<hash> <description>" per line, kept after the run.
TX_LOG="$(pwd)/mainnet-$(basename "$0" .sh)-$(date -u +%Y%m%dT%H%M%SZ).txs"

helper() { python3 -I "$HELPER" "$@"; }
near_cli() { near "$@" </dev/null; }
die() {
  echo "ABORT: $*" >&2
  exit 1
}

parse_mode() {
  for arg in "$@"; do
    case "$arg" in
    --send) MODE=send ;;
    --dry-run) MODE=dry-run ;;
    *) die "unknown argument $arg (use --dry-run, the default, or --send)" ;;
    esac
  done
  # DRY_RUN_TOPUP=<account>=<NEAR>: the fit check adds that much to <account>'s live balance, to
  # plan against a top-up not yet sent. Dry runs only.
  if [ -n "${DRY_RUN_TOPUP:-}" ]; then
    [ "$MODE" = dry-run ] || die "DRY_RUN_TOPUP is for dry runs only; unset it to --send"
    [[ "$DRY_RUN_TOPUP" == ?*=?* ]] || die "DRY_RUN_TOPUP must be <account>=<NEAR>"
  fi
}

require_tools() {
  for tool in near python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
  python3 -I -c 'import tomllib' 2>/dev/null || die "python3 3.11 or later is needed"
  near --version 2>/dev/null | grep -q '0\.30\.' || echo "    note:      tested with near-cli-rs 0.30.1; you have $(near --version 2>/dev/null)"
  check_connections
}

# Endpoints: near CLI's connections, from its config (scripts/lib/near_rpc.py reads the same
# file). Live reads, signing (nonce and block hash), sending and the read-back of a transaction
# just sent all go to the non-archival `<network>-fastnear` connection. The archival `<network>`
# connection rate-limits bursts much sooner (about 15 requests, measured 2026-11-08; on
# 2026-11-11 it refused the smoke test's nonce fetch), so it is used only to look up transactions
# of earlier runs (verify_logged), which a non-archival node may no longer have.
live_connection() { printf '%s' "$NETWORK-fastnear"; }
archival_connection() { printf '%s' "$NETWORK"; }

# check_connections: both exist, the live one is not the archival one, and it is for $NETWORK, so
# near CLI's legacy keychain is $KEYCHAIN.
check_connections() {
  local live archival name
  live=$(python3 -I "$RPC_CLIENT" endpoint "$(live_connection)") || die "near CLI's config has no $(live_connection) connection"
  archival=$(python3 -I "$RPC_CLIENT" endpoint "$(archival_connection)") || die "near CLI's config has no $(archival_connection) connection"
  [ "$live" != "$archival" ] && [[ "$live" != *archival* ]] || die "near CLI's $(live_connection) connection is archival ($live)"
  name=$(python3 -I "$RPC_CLIENT" network-name "$(live_connection)") || die "near CLI's $(live_connection) connection has no network_name"
  [ "$name" = "$NETWORK" ] || die "near CLI's $(live_connection) connection is for network $name, not $NETWORK (its keychain would not be $KEYCHAIN)"
  echo "    rpc:       $live (reads, signing, sending); archival $archival (earlier runs' transactions only)"
}

# rpc <method> <params json>: one JSON-RPC response from the live endpoint (see
# scripts/lib/near_rpc.py). The params go on stdin (printf is a builtin, so no argv limit applies).
rpc() { printf '%s' "$2" | python3 -I "$RPC_CLIENT" call "$(live_connection)" "$1" -; }
# rpc_archival <method> <params json>: the same from the archival endpoint, for old transactions.
rpc_archival() { printf '%s' "$2" | python3 -I "$RPC_CLIENT" call "$(archival_connection)" "$1" -; }

# view <contract> <method> <args json>: what the view call returned, as JSON; null if no such
# account or code.
view() {
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "$3" | base64 -w0)\"}" \
    >"$WORK/view.json" || die "view $1.$2 failed"
  helper call-result "$WORK/view.json"
}

# account <id>: "missing", or "<balance yocto> <code hash or none>".
account() {
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" >"$WORK/account.json" ||
    die "view_account $1 failed"
  helper account "$WORK/account.json"
}

gas_price() {
  rpc gas_price '[null]' >"$WORK/gas.json" || die "gas_price failed"
  helper json "$WORK/gas.json" 'v["result"]["gas_price"]'
}

# load_costs: the gas price, gas purchase price, account creation charge and static fees, live.
load_costs() {
  GAS_PRICE=$(gas_price)
  rpc EXPERIMENTAL_protocol_config '{"finality":"final"}' >"$WORK/protocol.json" || die "protocol config failed"
  PURCHASE_PRICE=$(helper max "$GAS_PRICE" "$(helper json "$WORK/protocol.json" 'v["result"]["runtime_config"]["min_gas_purchase_price"]')")
  ACCOUNT_CREATION_CHARGE=$(helper json "$WORK/protocol.json" 'v["result"]["runtime_config"]["account_creation_charge"]')
  BYTE_COST=$(helper json "$WORK/protocol.json" 'v["result"]["runtime_config"]["storage_amount_per_byte"]')
  # For a transaction whose kind tx() is not told: a function call with 4 KB of arguments, more
  # than any add-key, delete-key or delete-account costs.
  DEFAULT_FEES=$(helper fees "$WORK/protocol.json" call 4096)
}

# create_cost_yocto <account> <funder>: the most creating <account> (with no balance) costs <funder>.
create_cost_yocto() {
  local send exec
  if [[ "$1" == *".$2" ]]; then
    read -r send exec < <(helper fees "$WORK/protocol.json" create)
    helper add "$(helper mul "$(helper add "$send" "$exec")" "$GAS_PRICE")" "$ACCOUNT_CREATION_CHARGE"
  else
    read -r send exec < <(helper fees "$WORK/protocol.json" call 200)
    helper add "$(helper mul "$(helper add "$(helper add "$send" "$exec")" "$((REGISTRAR_TGAS * 1000000000000))")" "$GAS_PRICE")" "$ACCOUNT_CREATION_CHARGE"
  fi
}

# The signing part of a near CLI command for <signer spec>: "file:<access key file>" for a key
# file (the implicit deployer, function-call keys), "keychain" for the legacy keychain.
sign_args() {
  case "$1" in
  file:*) printf '%s\n' sign-with-access-key-file "${1#file:}" ;;
  keychain) printf '%s\n' sign-with-legacy-keychain ;;
  *) die "bad signer spec $1" ;;
  esac
}

# storage_bytes <account>: its storage usage on chain, or ACCOUNT_RECORD_BYTES if this plan creates
# it (or it is the <deployer> placeholder).
storage_bytes() {
  if [ -n "${PLANNED_BALANCE[$1]:-}" ] || [ "$1" = '<deployer>' ]; then
    echo "$ACCOUNT_RECORD_BYTES"
    return 0
  fi
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" >"$WORK/storage.json" ||
    die "view_account $1 failed"
  helper json "$WORK/storage.json" 'v["result"]["storage_usage"] if "result" in v else 0'
}

# tx [--fees <send gas> <exec gas>] [--charge <yocto>] [--storage <bytes>] <expect> <signer account> <signer spec>
#    <deposit yocto> <prepaid TGas> <description> <near args...>
# One transaction. <near args> are the near CLI command up to, not including, network-config.
# <expect> is "success", "reject:<reason>" (a rejected agent call), or "try" (should succeed, but a
# failure only warns). --fees are its static action fees (default DEFAULT_FEES), --charge what the
# protocol charges on top (account creation), --storage the bytes it adds to the signer's own
# storage (code, keys). <deposit> and <prepaid TGas> are what the near args attach; they are used
# here only for the cost.
tx() {
  local fees=${DEFAULT_FEES:-} charge=0 storage=0
  while [ "${1:-}" = --fees ] || [ "${1:-}" = --charge ] || [ "${1:-}" = --storage ]; do
    case "$1" in
    --fees) fees="$2 $3"; shift 3 ;;
    --charge) charge=$2; shift 2 ;;
    --storage) storage=$2; shift 2 ;;
    esac
  done
  local expect=$1 signer=$2 spec=$3 deposit=$4 tgas=$5 what=$6
  shift 6
  STEP_NO=$((STEP_NO + 1))
  if [ "$PHASE" = estimate ]; then
    local send exec prepaid gas_cost upfront_gas cost upfront
    read -r send exec <<<"$fees"
    prepaid=$(helper mul "$tgas" 1000000000000)
    # Spent at most: all gas at the gas price, plus the charge.
    gas_cost=$(helper add "$(helper mul "$(helper add "$send" "$(helper add "$exec" "$prepaid")")" "$GAS_PRICE")" "$charge")
    cost=$(helper add "$deposit" "$gas_cost")
    # Held at signing: send fees at the gas price, the rest bought at the purchase price (and at
    # least what it spends, the charge included).
    upfront_gas=$(helper max "$(helper add "$(helper mul "$send" "$GAS_PRICE")" "$(helper mul "$(helper add "$exec" "$prepaid")" "$PURCHASE_PRICE")")" "$gas_cost")
    upfront=$(helper add "$deposit" "$upfront_gas")
    TOTAL_YOCTO=$(helper add "$TOTAL_YOCTO" "$cost")
    if [ -z "${SIGNER_COST[$signer]:-}" ]; then
      SIGNER_COST[$signer]=0
      SIGNER_NEED[$signer]=0
      SIGNER_STORAGE[$signer]=$(storage_bytes "$signer")
      SIGNERS+=("$signer")
    fi
    SIGNER_STORAGE[$signer]=$((SIGNER_STORAGE[$signer] + storage))
    SIGNER_NEED[$signer]=$(helper max "${SIGNER_NEED[$signer]}" \
      "$(helper add "$(helper add "${SIGNER_COST[$signer]}" "$upfront")" "$(helper mul "${SIGNER_STORAGE[$signer]}" "$BYTE_COST")")")
    SIGNER_COST[$signer]=$(helper add "${SIGNER_COST[$signer]}" "$cost")
    # Signed with a function-call key ($KEYCHAIN/<account>/<key>.json): its allowance pays the gas.
    # No refund to the allowance is assumed (unverified on chain): each call counts its gas at the
    # purchase price, so KEY_NEED is the sum of upfront_gas.
    if [[ "$spec" == "file:$KEYCHAIN/$signer/"* ]]; then
      KEY_NEED[$signer]=$(helper add "${KEY_COST[$signer]:-0}" "$upfront_gas")
      KEY_COST[$signer]=$(helper add "${KEY_COST[$signer]:-0}" "$upfront_gas")
      KEY_SPEC[$signer]=$spec
    fi
    printf '  %2d. %s\n      signer %s, at most %s NEAR (deposit %s + %s TGas prepaid + %s TGas fees%s), %s NEAR at hand\n      near' \
      "$STEP_NO" "$what" "$signer" "$(helper near "$cost")" "$(helper near "$deposit")" "$tgas" \
      "$(python3 -I -c 'import sys; print(round((int(sys.argv[1]) + int(sys.argv[2])) / 1e12, 2))' "$send" "$exec")" \
      "$([ "$charge" = 0 ] || echo " + $(helper near "$charge") NEAR account creation")" "$(helper near "$upfront")"
    printf " %q" "$@" network-config "$(live_connection)" $(sign_args "$spec") send
    printf '\n'
    return 0
  fi
  echo "── $STEP_NO. $what"
  local -a signing
  mapfile -t signing < <(sign_args "$spec")
  sign_tx "$@" network-config "$(live_connection)" "${signing[@]}" display ||
    { sed 's/^/    | /' "$WORK/sign.log"; die "could not sign: $what"; }
  local tx_hash
  rm -f "$WORK/signed.json"
  tx_hash=$(helper signed-tx "$WORK/sign.log" "$WORK/signed.json") || die "could not read the signed transaction: $what"
  near_cli transaction send-signed-transaction file-with-base64-signed-transaction "$WORK/signed.json" \
    network-config "$(live_connection)" send >"$WORK/send.log" 2>&1 || true
  rm -f "$WORK/signed.json" "$WORK/sign.log"
  rpc tx "{\"tx_hash\":\"$tx_hash\",\"sender_account_id\":\"$signer\",\"wait_until\":\"FINAL\"}" >"$WORK/outcome.json" ||
    die "could not read the outcome of $tx_hash over RPC; check $EXPLORER$tx_hash before re-running"
  cp "$WORK/outcome.json" "$WORK/last-outcome.json"
  LAST_TX_HASH=$tx_hash
  echo "$tx_hash $what" >>"$TX_LOG"
  local check_as=$expect
  [ "$expect" != try ] || check_as=success
  if ! helper outcome "$WORK/outcome.json" "$tx_hash" "$EXPLORER" "${VAULT_ID:-none}" "$check_as"; then
    # "try": a best-effort step (an unregistration) whose failure changes nothing else.
    [ "$expect" = try ] || die "unexpected outcome: $what"
    echo "    WARNING:   $what failed; continuing (nothing else depends on it)"
  fi
}

# Signing: near CLI fetches the signer's nonce and a recent block hash over RPC, then signs
# (`display` prints the signed transaction; it sends nothing). A failure while fetching them
# (connection, DNS, timeout, rate limit, a 5xx) means nothing was signed, so sign_tx retries it,
# SIGN_ATTEMPTS times in all, with backoff. Any other failure (a missing key, a bad argument) stops
# at once. Nothing is ever retried after `send-signed-transaction`: tx() reads that transaction's
# outcome by its hash instead, and stops if it cannot.
SIGN_ATTEMPTS=5
SIGN_FIRST_DELAY_S=2
PRESIGN_TRANSIENT='error sending request|connection (refused|reset|closed)|timed? ?out|dns error|failed to lookup|temporary failure in name resolution|too many requests|rate.?limit|\b429\b|\b50[234]\b|bad gateway|service unavailable'
PRESIGN_FATAL='does not exist|UnknownAccessKey|UNKNOWN_ACCESS_KEY|UnknownAccount|UNKNOWN_ACCOUNT|No such file|Permission denied'
sign_tx() {
  local attempt=1 delay=$SIGN_FIRST_DELAY_S
  while :; do
    rm -f "$WORK/sign.log"
    near_cli "$@" >"$WORK/sign.log" 2>&1 && return 0
    if [ "$attempt" -ge "$SIGN_ATTEMPTS" ] || ! grep -qiE "$PRESIGN_TRANSIENT" "$WORK/sign.log" || grep -qiE "$PRESIGN_FATAL" "$WORK/sign.log"; then
      return 1
    fi
    echo "    retry:     near CLI could not fetch the nonce or block hash; nothing was signed (try $attempt of $SIGN_ATTEMPTS, next in ${delay}s)"
    grep -iE "$PRESIGN_TRANSIENT" "$WORK/sign.log" | head -2 | cut -c1-200 | sed 's/^/    | /'
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# ---- Resuming (scripts/mainnet-smoke.sh) ----
# A step is skipped only when its effect is verified on chain and its transaction, from an earlier
# run's log (TX_LOG: mainnet-<script>-*.txs in this directory, kept after every run), re-checks
# over RPC.

# The logs of earlier runs of this script, oldest first. The current run's log is not written yet
# while the plan is estimated.
run_logs() {
  local f
  # The same name as TX_LOG, any time.
  for f in "$(pwd)/mainnet-$(basename "$0" .sh)"-*.txs; do [ -f "$f" ] && echo "$f"; done
}

# logged <exact|prefix> <description>: "<seq> <hash>" of every logged transaction with that
# description, oldest first; nothing if none.
logged() {
  local -a logs
  mapfile -t logs < <(run_logs)
  [ "${#logs[@]}" -gt 0 ] || return 0
  helper logged "$1" "$2" "${logs[@]}"
}

# last_logged <exact|prefix> <description>: "<seq> <hash>" of the latest one, or nothing.
last_logged() { logged "$1" "$2" | tail -n 1; }

# only_logged <exact|prefix> <description>: the hash of the one logged transaction with that
# description; nothing if none; stops if there are several (a step that must run once).
only_logged() {
  local found
  found=$(logged "$1" "$2")
  [ "$(printf '%s' "$found" | grep -c . || true)" -le 1 ] || die "the transaction logs have \"$2\" more than once; refusing to resume"
  printf '%s' "${found#* }"
}

# verify_logged <hash> <signer> <expect> <description>: re-reads a logged transaction's outcome
# (to $WORK/logged.json) and checks it as tx() did when it was sent. Stops if it does not check.
verify_logged() {
  rpc_archival tx "{\"tx_hash\":\"$1\",\"sender_account_id\":\"$2\",\"wait_until\":\"FINAL\"}" >"$WORK/logged.json" ||
    die "could not read the logged transaction $1 ($4) over RPC; refusing to resume"
  helper outcome "$WORK/logged.json" "$1" "$EXPLORER" "${VAULT_ID:-none}" "$3" >"$WORK/logged-check.txt" ||
    { sed 's/^/  /' "$WORK/logged-check.txt"; die "the logged transaction $1 ($4) does not check as $3; refusing to resume"; }
}

# What earlier runs' verified steps spent at most, per signer, for the balance check of resume.
declare -A DONE_COST=()

# done_step <signer> <hash> <description> [<deposit yocto> <prepaid TGas> <send gas> <exec gas> [<charge>]]:
# a step verified done. It keeps its number. With costs, what it spent at most (as tx() estimates
# it, at the current gas price) is added to the signer's DONE_COST.
done_step() {
  local signer=$1 hash=$2 what=$3
  STEP_NO=$((STEP_NO + 1))
  if [ $# -ge 7 ]; then
    local gas
    gas=$(helper mul "$(helper add "$6" "$(helper add "$7" "$(helper mul "$5" 1000000000000)")")" "$GAS_PRICE")
    DONE_COST[$signer]=$(helper add "${DONE_COST[$signer]:-0}" "$4" "$gas" "${8:-0}")
  fi
  if [ "$PHASE" = estimate ]; then
    printf '  %2d. %s: done, verified (%s)\n' "$STEP_NO" "$what" "$hash"
  else
    echo "── $STEP_NO. done: $what ($hash, verified)"
  fi
}

# skip <description>: a step that is already done, shown in both phases. It keeps its number, so a
# resumed plan is numbered as the full plan is.
skip() {
  STEP_NO=$((STEP_NO + 1))
  if [ "$PHASE" = estimate ]; then
    printf '  %2d. %s: already done, skipped\n' "$STEP_NO" "$1"
  else
    echo "── $STEP_NO. skip: $1 (already done)"
  fi
}

# run_steps <confirmation word>: estimate, then (with --send) confirm and send.
run_steps() {
  load_costs
  echo
  echo "== Plan (gas price $GAS_PRICE, purchase price $PURCHASE_PRICE yoctoNEAR per gas unit; account creation charge $(helper near "$ACCOUNT_CREATION_CHARGE") NEAR; costs are upper bounds)"
  PHASE=estimate
  steps
  echo
  echo "== Cost per signer (spends at most / must hold at once, storage stake included)"
  local s
  for s in "${SIGNERS[@]}"; do
    printf '    %-48s %s / %s NEAR (storage %s bytes after its steps)\n' "$s" "$(helper near "${SIGNER_COST[$s]}")" \
      "$(helper near "${SIGNER_NEED[$s]}")" "${SIGNER_STORAGE[$s]}"
  done
  if [ -n "${PAYER:-}" ]; then
    echo "== You pay: at most $(helper near "${SIGNER_COST[$PAYER]:-0}") NEAR, from $PAYER"
    echo "   (the other signers pay from balances the plan gives them)"
  fi
  fit_check
  # A script may print more about the plan here (mainnet-deploy.sh: what to send the deployer).
  if [ "$(type -t after_estimate)" = function ]; then after_estimate; fi
  if [ "$MODE" != send ]; then
    echo
    echo "Dry run: nothing was signed or sent. Run again with --send to send these transactions."
    return 0
  fi
  [ "$FIT" = yes ] || die "the plan does not fit (see above); nothing was sent"
  echo
  local answer
  read -r -p "Type 'send $1' to sign and send the steps above on $NETWORK: " answer </dev/tty
  [ "$answer" = "send $1" ] || die "not confirmed; nothing was sent"
  PHASE=send
  STEP_NO=0
  steps
  echo
  echo "== Sent. Checks:"
}

# fit_check: every signer holds (or is given by the plan) what it must hold at once, and every
# function-call key's allowance covers the gas it pays. Sets FIT to yes or no.
FIT=yes
fit_check() {
  local s have source state
  echo "== Fit (must hold at once / has)"
  for s in "${SIGNERS[@]}"; do
    if [ -n "${PLANNED_BALANCE[$s]:-}" ]; then
      have=${PLANNED_BALANCE[$s]} source="given by this plan"
    elif [ "$s" = '<deployer>' ]; then
      echo "    $s: not set (dry run only)"
      continue
    else
      state=$(account "$s")
      if [ "$state" = missing ]; then
        echo "    SHORT:     $s needs $(helper near "${SIGNER_NEED[$s]}") NEAR and does not exist"
        FIT=no
        continue
      fi
      have=${state%% *} source=live
      if [ -n "${DRY_RUN_TOPUP:-}" ] && [ "${DRY_RUN_TOPUP%%=*}" = "$s" ]; then
        have=$(helper add "$have" "$(helper yocto "${DRY_RUN_TOPUP#*=}")")
        source="live + ${DRY_RUN_TOPUP#*=} NEAR top-up assumed (DRY_RUN_TOPUP)"
      fi
    fi
    fit_line "$s" "${SIGNER_NEED[$s]}" "$have" "$source"
  done
  for s in "${!KEY_NEED[@]}"; do
    if [ -n "${PLANNED_ALLOWANCE[$s]:-}" ]; then
      have=${PLANNED_ALLOWANCE[$s]} source="allowance given by this plan"
    else
      have=$(live_allowance "$s" "${KEY_SPEC[$s]}") source="live allowance"
    fi
    if [ "$have" = unlimited ]; then
      echo "    ok:        $s function-call key, unlimited allowance"
    else
      fit_line "$s function-call key" "${KEY_NEED[$s]}" "$have" "$source"
    fi
  done
}

# fit_line <who> <need yocto> <have yocto> <source>
fit_line() {
  if helper ge "$3" "$2"; then
    printf '    ok:        %s: %s / %s NEAR (%s), %s to spare\n' "$1" "$(helper near "$2")" "$(helper near "$3")" "$4" "$(helper near "$(helper sub "$3" "$2")")"
  else
    printf '    SHORT:     %s: %s / %s NEAR (%s), short by %s NEAR\n' "$1" "$(helper near "$2")" "$(helper near "$3")" "$4" "$(helper near "$(helper sub "$2" "$3")")"
    FIT=no
  fi
}

# live_allowance <account> <spec file:...>: the allowance of that key on chain.
live_allowance() {
  local file=${2#file:} key
  key=$(basename "$file" .json)
  key=${key/_/:}
  rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
    >"$WORK/keys.json" || die "view_access_key_list $1 failed"
  helper fc-allowance "$WORK/keys.json" "$key"
}

PASSED=0
FAILED=0
check() {
  local what=$1
  shift
  if "$@"; then
    echo "    PASS: $what"
    PASSED=$((PASSED + 1))
  else
    echo "    FAIL: $what"
    FAILED=$((FAILED + 1))
  fi
}

# key_file_signer <account>: "file:<path>" for an implicit account's key file saved by
# `scripts/mainnet-deploy.sh keygen`, else "keychain".
key_file_signer() {
  if [[ "$1" =~ ^[0-9a-f]{64}$ ]] || [ "$1" = '<deployer>' ]; then
    echo "file:$KEYCHAIN/$1.json"
  else
    echo keychain
  fi
}

# create_account_step <new account> <initial balance NEAR> <funder>: creates <new account> with a
# fresh full-access key saved to the legacy keychain, unless it exists. A sub-account of <funder>
# is created by <funder>; any other name by the `near` registrar, paid by <funder>.
create_account_step() {
  local id=$1 amount=$2 funder=$3 tgas fees
  if [ "$(account "$id")" != missing ]; then
    skip "create $id"
    return 0
  fi
  if [[ "$id" == *".$funder" ]]; then
    # CreateAccount + Transfer + AddKey, signed by the parent: no prepaid gas.
    tgas=0 fees=$(helper fees "$WORK/protocol.json" create)
  else
    # The `near` registrar's create_account; the new account's receipt is paid from its gas.
    tgas=$REGISTRAR_TGAS fees=$(helper fees "$WORK/protocol.json" call 200)
  fi
  [ "$PHASE" != estimate ] || PLANNED_BALANCE[$id]=$(helper yocto "$amount")
  # shellcheck disable=SC2086 # $fees is "<send> <exec>"
  tx --fees $fees --charge "$ACCOUNT_CREATION_CHARGE" success "$funder" "$(key_file_signer "$funder")" \
    "$(helper yocto "$amount")" "$tgas" "create $id with $amount NEAR (key saved to $KEYCHAIN)" \
    account create-account fund-myself "$id" "$amount NEAR" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$funder"
}

# call_step <expect> <signer> <spec> <contract> <method> <args> <deposit> <TGas> <description>
# <deposit> is a NEAR amount, or ONE_YOCTO for the 1 yoctoNEAR the owner methods require.
ONE_YOCTO=1yocto
call_step() {
  local expect=$1 signer=$2 spec=$3 contract=$4 method=$5 args=$6 deposit=$7 tgas=$8 what=$9
  local yocto text
  if [ "$deposit" = "$ONE_YOCTO" ]; then
    yocto=1
    text='1 yoctoNEAR'
  else
    yocto=$(helper yocto "$deposit")
    text="$deposit NEAR"
  fi
  local fees
  fees=$(helper fees "$WORK/protocol.json" call "$((${#method} + ${#args}))")
  # shellcheck disable=SC2086 # $fees is "<send> <exec>"
  tx --fees $fees "$expect" "$signer" "$spec" "$yocto" "$tgas" "$what" \
    contract call-function as-transaction "$contract" "$method" json-args "$args" \
    prepaid-gas "$tgas Tgas" attached-deposit "$text" sign-as "$signer"
}

# exchange_check: the exchange runs the code the sandbox suite was run against, and is running.
exchange_check() {
  local state hash meta version running
  state=$(account "$EXCHANGE")
  hash=${state#* }
  meta=$(view "$EXCHANGE" metadata '{}')
  printf '%s' "$meta" >"$WORK/meta.json"
  version=$(helper json "$WORK/meta.json" 'v["version"]')
  running=$(helper json "$WORK/meta.json" 'v["state"]')
  echo "    exchange:  $EXCHANGE, version $version, $running, code hash $hash"
  [ "$hash" = "$EXCHANGE_CODE_HASH" ] ||
    die "$EXCHANGE's code changed ($hash, tested $EXCHANGE_CODE_HASH); rerun the sandbox suite against it first"
  [ "$running" = Running ] || die "$EXCHANGE is not Running"
}

# fc_key_signer <account> <receiver> <methods,...>: "file:<key file>" of the function-call key with
# exactly that permission, if it is on chain and in the legacy keychain; else a placeholder that
# only a dry run may use.
fc_key_signer() {
  rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" \
    >"$WORK/keys.json" || die "view_access_key_list $1 failed"
  local key
  key=$(helper fc-key "$WORK/keys.json" "$KEYCHAIN/$1" "$2" "$3" 2>/dev/null || true)
  if [ -n "$key" ]; then
    echo "file:$KEYCHAIN/$1/${key//:/_}.json"
  else
    echo "file:$KEYCHAIN/$1/<function-call key, created above>.json"
  fi
}

# add_fc_key_step <account> <receiver> <methods,...> <allowance NEAR>: a function-call key, saved to
# the legacy keychain, unless one with exactly that permission is already there.
add_fc_key_step() {
  local id=$1 receiver=$2 methods=$3 allowance=$4 spec
  spec=$(fc_key_signer "$id" "$receiver" "$methods")
  if [[ "$spec" != *"<function-call key"* ]]; then
    skip "function-call key on $id for $methods on $receiver"
    return 0
  fi
  local fees
  fees=$(helper fees "$WORK/protocol.json" add-fc-key "$((${#receiver} + ${#methods}))")
  [ "$PHASE" != estimate ] || PLANNED_ALLOWANCE[$id]=$(helper yocto "$allowance")
  # shellcheck disable=SC2086 # $fees is "<send> <exec>"
  # The key's record: public key, receiver, method names, allowance, and per-record overhead.
  tx --fees $fees --storage "$((200 + ${#receiver} + ${#methods}))" success "$id" keychain 0 0 \
    "add a function-call key to $id: $methods on $receiver, $allowance NEAR allowance" \
    account add-key "$id" grant-function-call-access --allowance "$allowance NEAR" \
    --contract-account-id "$receiver" --function-names "$methods" autogenerate-new-keypair \
    save-to-legacy-keychain
}

# vault_check <vault> <expected code hash>: the vault runs that code and the expected exchange.
vault_check() {
  local state
  state=$(account "$1")
  if { [ "$state" = missing ] || [ "${state#* }" = none ]; } && [ "$MODE" = dry-run ]; then
    echo "    WARNING:   $1 $([ "$state" = missing ] && echo "does not exist yet" || echo "has no code yet"); planning as if scripts/mainnet-deploy.sh had run"
    return 0
  fi
  [ "$state" != missing ] || die "$1 does not exist; run scripts/mainnet-deploy.sh first"
  echo "    vault:     $1, code hash ${state#* }"
  [ "${state#* }" = "$2" ] || die "$1 does not run the expected build $2"
  [ "$(view "$1" get_exchange_id '{}')" = "\"$EXCHANGE\"" ] || die "$1 is not bound to $EXCHANGE"
}

# deploy_state <vault> <expected code hash> <exchange> <treasury> <fee bps>: "deploy" if <vault> is
# missing or has no code; "done" if it runs exactly <expected code hash> and its views return that
# exchange, treasury and fee. Anything else stops the script.
deploy_state() {
  local vault=$1 expected=$2 exchange=$3 treasury=$4 fee=$5 state code got
  state=$(account "$vault")
  code=${state#* }
  if [ "$state" = missing ] || [ "$code" = none ]; then
    echo deploy
    return 0
  fi
  [ "$code" = "$expected" ] || die "$vault runs other code ($code, expected $expected); refusing to deploy over it or resume past it"
  got=$(view "$vault" get_exchange_id '{}')
  [ "$got" = "\"$exchange\"" ] || die "$vault runs $expected but its exchange is $got, not $exchange; refusing to resume"
  got=$(view "$vault" get_treasury_id '{}')
  [ "$got" = "\"$treasury\"" ] || die "$vault runs $expected but its treasury is $got, not $treasury; refusing to resume"
  got=$(view "$vault" get_fee_bps '{}')
  [ "$got" = "$fee" ] || die "$vault runs $expected but its fee is $got bps, not $fee; refusing to resume"
  echo done
}

block_time() {
  rpc block '{"finality":"final"}' >"$WORK/block.json" || die "block failed"
  helper json "$WORK/block.json" 'v["result"]["header"]["timestamp"]'
}
