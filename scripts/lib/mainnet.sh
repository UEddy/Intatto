# Shared by scripts/mainnet-*.sh. Sourced, not run.
#
# Every script declares its steps once, in a `steps` function, and it runs twice:
#   1. estimate: reads live state, prints each step's command and its cost, and the total. Nothing
#      is signed or sent. This is all that happens without --send.
#   2. send (only with --send, after typing the confirmation): signs and sends each step that is
#      still needed, and checks its outcome over RPC before the next one.
#
# Costs are upper bounds: attached deposits and initial balances, plus each transaction's prepaid
# gas at the current gas price (unused gas is refunded, so the real cost is lower). They are
# totalled per signer: an account the plan creates pays its own steps from the balance the plan
# gives it, so only the funder's (PAYER's) total comes out of your wallet.
#
# Transactions are signed with `display`, sent with `transaction send-signed-transaction`, and read
# back by hash over RPC (scripts/lib/near_rpc.py), as in the testnet scripts, because near-cli-rs
# 0.30.1's `send` prints no transaction id when a transaction fails.

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

MODE=dry-run
PHASE=estimate
TOTAL_YOCTO=0
STEP_NO=0
declare -A SIGNER_COST=()
SIGNERS=()
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
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
}

require_tools() {
  for tool in near python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
  python3 -I -c 'import tomllib' 2>/dev/null || die "python3 3.11 or later is needed"
  near --version 2>/dev/null | grep -q '0\.30\.' || echo "    note:      tested with near-cli-rs 0.30.1; you have $(near --version 2>/dev/null)"
}

# rpc <method> <params json>: one JSON-RPC response (see scripts/lib/near_rpc.py).
rpc() { python3 -I "$RPC_CLIENT" call "$NETWORK" "$1" "$2"; }

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

# The signing part of a near CLI command for <signer spec>: "file:<access key file>" for a key
# file (the implicit deployer, function-call keys), "keychain" for the legacy keychain.
sign_args() {
  case "$1" in
  file:*) printf '%s\n' sign-with-access-key-file "${1#file:}" ;;
  keychain) printf '%s\n' sign-with-legacy-keychain ;;
  *) die "bad signer spec $1" ;;
  esac
}

# tx <expect> <signer account> <signer spec> <deposit yocto> <prepaid TGas> <description> <near args...>
# One transaction. <near args> are the near CLI command up to, not including, network-config.
# <expect> is "success" or "reject:<reason>" (a rejected agent call).
tx() {
  local expect=$1 signer=$2 spec=$3 deposit=$4 tgas=$5 what=$6
  shift 6
  local cost
  STEP_NO=$((STEP_NO + 1))
  cost=$(helper add "$deposit" "$(helper mul "$(helper mul "$tgas" 1000000000000)" "$GAS_PRICE")")
  if [ "$PHASE" = estimate ]; then
    TOTAL_YOCTO=$(helper add "$TOTAL_YOCTO" "$cost")
    if [ -z "${SIGNER_COST[$signer]:-}" ]; then
      SIGNER_COST[$signer]=0
      SIGNERS+=("$signer")
    fi
    SIGNER_COST[$signer]=$(helper add "${SIGNER_COST[$signer]}" "$cost")
    printf '  %2d. %s\n      signer %s, at most %s NEAR (deposit %s + %s TGas)\n      near' \
      "$STEP_NO" "$what" "$signer" "$(helper near "$cost")" "$(helper near "$deposit")" "$tgas"
    printf " %q" "$@" network-config "$NETWORK" $(sign_args "$spec") send
    printf '\n'
    return 0
  fi
  echo "── $STEP_NO. $what"
  local -a signing
  mapfile -t signing < <(sign_args "$spec")
  near_cli "$@" network-config "$NETWORK" "${signing[@]}" display >"$WORK/sign.log" 2>&1 ||
    { sed 's/^/    | /' "$WORK/sign.log"; die "could not sign: $what"; }
  local signed tx_hash
  signed=$(helper signed-b64 "$WORK/sign.log")
  tx_hash=$(helper tx-hash "$signed")
  near_cli transaction send-signed-transaction base64-signed-transaction "$signed" \
    network-config "$NETWORK" send >"$WORK/send.log" 2>&1 || true
  rpc tx "{\"tx_hash\":\"$tx_hash\",\"sender_account_id\":\"$signer\",\"wait_until\":\"FINAL\"}" >"$WORK/outcome.json" ||
    die "could not read the outcome of $tx_hash over RPC; check $EXPLORER$tx_hash before re-running"
  cp "$WORK/outcome.json" "$WORK/last-outcome.json"
  LAST_TX_HASH=$tx_hash
  echo "$tx_hash $what" >>"$TX_LOG"
  helper outcome "$WORK/outcome.json" "$tx_hash" "$EXPLORER" "${VAULT_ID:-none}" "$expect" ||
    die "unexpected outcome: $what"
}

# skip <description>: a step that is already done, shown in both phases.
skip() {
  if [ "$PHASE" = estimate ]; then
    printf '   -  %s: already done, skipped\n' "$1"
  else
    echo "── skip: $1 (already done)"
  fi
}

# run_steps <confirmation word>: estimate, then (with --send) confirm and send.
run_steps() {
  GAS_PRICE=$(gas_price)
  echo
  echo "== Plan (gas price $GAS_PRICE yoctoNEAR per gas unit; costs are upper bounds)"
  PHASE=estimate
  steps
  echo
  echo "== Cost per signer (at most)"
  local s
  for s in "${SIGNERS[@]}"; do
    printf '    %-48s %s NEAR\n' "$s" "$(helper near "${SIGNER_COST[$s]}")"
  done
  if [ -n "${PAYER:-}" ]; then
    echo "== You pay: at most $(helper near "${SIGNER_COST[$PAYER]:-0}") NEAR, from $PAYER"
    echo "   (the other signers pay from balances the plan gives them)"
    payer_check
  fi
  if [ "$MODE" != send ]; then
    echo
    echo "Dry run: nothing was signed or sent. Run again with --send to send these transactions."
    return 0
  fi
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

# The account that pays most of the plan must hold at least the total.
payer_check() {
  local state balance
  [ "$PAYER" != '<deployer>' ] || return 0
  state=$(account "$PAYER")
  [ "$state" != missing ] || { echo "    payer:     $PAYER does not exist yet"; return 0; }
  balance=${state%% *}
  echo "    payer:     $PAYER holds $(helper near "$balance") NEAR"
  helper ge "$balance" "${SIGNER_COST[$PAYER]:-0}" ||
    echo "    WARNING:   $PAYER holds less than the total; top it up before --send"
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
  local id=$1 amount=$2 funder=$3
  if [ "$(account "$id")" != missing ]; then
    skip "create $id"
    return 0
  fi
  tx success "$funder" "$(key_file_signer "$funder")" "$(helper yocto "$amount")" 30 \
    "create $id with $amount NEAR (key saved to $KEYCHAIN)" \
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
  tx "$expect" "$signer" "$spec" "$yocto" "$tgas" "$what" \
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
  tx success "$id" keychain 0 10 "add a function-call key to $id: $methods on $receiver, $allowance NEAR allowance" \
    account add-key "$id" grant-function-call-access --allowance "$allowance NEAR" \
    --contract-account-id "$receiver" --function-names "$methods" autogenerate-new-keypair \
    save-to-legacy-keychain
}

# vault_check <vault> <expected code hash>: the vault runs that code and the expected exchange.
vault_check() {
  local state
  state=$(account "$1")
  if [ "$state" = missing ] && [ "$MODE" = dry-run ]; then
    echo "    WARNING:   $1 does not exist yet; planning as if scripts/mainnet-deploy.sh had run"
    return 0
  fi
  [ "$state" != missing ] || die "$1 does not exist; run scripts/mainnet-deploy.sh first"
  echo "    vault:     $1, code hash ${state#* }"
  [ "${state#* }" = "$2" ] || die "$1 does not run the expected build $2"
  [ "$(view "$1" get_exchange_id '{}')" = "\"$EXCHANGE\"" ] || die "$1 is not bound to $EXCHANGE"
}

block_time() {
  rpc block '{"finality":"final"}' >"$WORK/block.json" || die "block failed"
  helper json "$WORK/block.json" 'v["result"]["header"]["timestamp"]'
}
