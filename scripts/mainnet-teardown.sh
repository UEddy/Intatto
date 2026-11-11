#!/usr/bin/env bash
# Takes the mainnet deployment apart after the canary's lock ends (2026-11-20), using near-cli-rs
# 0.30.1, and returns everything to BENEFICIARY (default TREASURY_ID). Dry run by default: it reads
# live state, prints every transaction and where each amount goes, and sends nothing.
#
#   VAULT_ID=vault.intatto.near ROOT_ACCOUNT=intatto.near TREASURY_ID=eddyhamezz.near \
#   DEPLOYER=<implicit id> CANARY_OWNER=canary.intatto.near CANARY_AGENT=canary-agent.intatto.near \
#   SMOKE_OWNER=demo.intatto.near SMOKE_AGENT=demo-agent.intatto.near \
#   scripts/mainnet-teardown.sh [--send]
#
# Order (each step is skipped when already done, so a run that stops can be re-run):
#   1. Every vault owner (CANARY_OWNER, SMOKE_OWNER) takes out everything: tokens left on the
#      exchange are reclaimed first, then every token balance and the NEAR balance are withdrawn.
#   2. The treasury withdraws the accrued fees of every token. TREASURY_ID signs this; if its key
#      is not in the legacy keychain, the script prints the exact call to make from your wallet and
#      stops until the fees read zero. ROOT_ACCOUNT pays the treasury's token registration first if
#      it has none (otherwise the fee transfer fails and is credited back).
#   3. Every token held by an account under ROOT_ACCOUNT (not the vault) is sent to BENEFICIARY,
#      which is registered first when needed, paid by the sender.
#   4. Storage registrations on wrap.near, USDt and the exchange are removed where the balance
#      there is zero, refunding the storage deposit to the account. These are best effort: a
#      failure warns and the teardown goes on (it forfeits at most that deposit).
#   5. Accounts are deleted leaf first: CANARY_AGENT, CANARY_OWNER, SMOKE_AGENT, SMOKE_OWNER,
#      VAULT_ID, ROOT_ACCOUNT, DEPLOYER, each with BENEFICIARY receiving its whole NEAR balance.
#      Before each delete the script asserts, on chain, a zero balance on wrap.near, USDt, the
#      exchange and every other token contract the indexer has seen the account hold, and refuses
#      the delete otherwise. Before deleting the vault it also asserts that every owner the vault
#      ever had (from its event history, scripts/lib/fastnear_index.py) is empty, that no fees are
#      left, that no exchange operation is in flight, and that its state outside the code is
#      within the protocol's 10,000-byte limit for deleting an account.
#
# Refuses to send while any owner's withdrawals are still locked, or while anyone other than the two
# owners above holds funds in the vault: deleting it would hand their funds to BENEFICIARY.
#
# TEARDOWN_TEST_NETWORK=testnet (with TOKENS and EXCHANGE_ID) runs the dry run against testnet, to
# test the script on a live vault; it refuses --send.
set -euo pipefail
shopt -s inherit_errexit
source "$(dirname "${BASH_SOURCE[0]}")/lib/mainnet.sh"

parse_mode "$@"
if [ -n "${TEARDOWN_TEST_NETWORK:-}" ]; then
  [ "$MODE" = dry-run ] || die "TEARDOWN_TEST_NETWORK is for dry runs only"
  NETWORK=$TEARDOWN_TEST_NETWORK
  KEYCHAIN="$HOME/.near-credentials/$NETWORK"
  EXPLORER=https://explorer.$NETWORK.near.org/transactions/
fi
read -r -a TOKEN_IDS <<<"${TOKENS:-$WNEAR $USDT}"
EXCHANGE_ID=${EXCHANGE_ID:-$EXCHANGE}

VAULT_ID=${VAULT_ID:-}
ROOT_ACCOUNT=${ROOT_ACCOUNT:-}
TREASURY_ID=${TREASURY_ID:-}
DEPLOYER=${DEPLOYER:-}
CANARY_OWNER=${CANARY_OWNER:-}
CANARY_AGENT=${CANARY_AGENT:-}
SMOKE_OWNER=${SMOKE_OWNER:-}
SMOKE_AGENT=${SMOKE_AGENT:-}
BENEFICIARY=${BENEFICIARY:-$TREASURY_ID}
RECLAIM_TGAS=150
DELETE_TGAS=5 # a delete-account action burns about 1 TGas; this only sizes the estimate
MAX_DELETABLE_STATE=10000 # Account::MAX_ACCOUNT_DELETION_STORAGE_USAGE in nearcore

echo "== Preflight ($MODE, $NETWORK)"
require_tools
for var in VAULT_ID ROOT_ACCOUNT TREASURY_ID DEPLOYER CANARY_OWNER CANARY_AGENT SMOKE_OWNER SMOKE_AGENT; do
  [ -n "${!var}" ] || die "set $var"
done
OWNERS=("$CANARY_OWNER" "$SMOKE_OWNER")
# Accounts under ROOT_ACCOUNT whose tokens are swept to BENEFICIARY (the vault's are owners' funds).
SWEPT=("$CANARY_OWNER" "$CANARY_AGENT" "$SMOKE_OWNER" "$SMOKE_AGENT" "$ROOT_ACCOUNT")
REGISTERED=("${SWEPT[@]}" "$VAULT_ID")
DELETE_ORDER=("$CANARY_AGENT" "$CANARY_OWNER" "$SMOKE_AGENT" "$SMOKE_OWNER" "$VAULT_ID" "$ROOT_ACCOUNT" "$DEPLOYER")
for id in "${DELETE_ORDER[@]}"; do
  [ "$id" != "$BENEFICIARY" ] || die "BENEFICIARY cannot be one of the accounts to delete"
done
[ "$(account "$BENEFICIARY")" != missing ] || die "beneficiary $BENEFICIARY does not exist; its refunds would be lost"
echo "    beneficiary: $BENEFICIARY exists"
PAYER=
BLOCKERS=()
blocker() {
  BLOCKERS+=("$1")
  echo "    BLOCKER:   $1"
}

# ---- reads -----------------------------------------------------------------------------------

vault_json() { view "$VAULT_ID" get_vault "{\"owner_id\":\"$1\"}" >"$WORK/vault-$1.json"; }
ft_balance() {
  local out
  out=$(view "$1" ft_balance_of "{\"account_id\":\"$2\"}")
  [ "$out" = null ] && echo 0 || echo "${out//\"/}"
}
registered() { [ "$(view "$1" storage_balance_of "{\"account_id\":\"$2\"}")" != null ]; }
min_storage() {
  printf '%s' "$(view "$1" storage_balance_bounds '{}')" >"$WORK/bounds.json"
  helper near "$(helper json "$WORK/bounds.json" 'v["min"]')"
}
# exchange_deposits <account>: "<token>=<amount> ..." of the account's exchange deposits (registered
# accounts only; the exchange panics for others).
exchange_deposits() {
  printf '%s' "$(view "$EXCHANGE_ID" get_deposits "{\"account_id\":\"$1\"}")" >"$WORK/deposits.json"
  helper json "$WORK/deposits.json" '" ".join(f"{k}={x}" for k, x in v.items())'
}
key_in_keychain() { [ -f "$KEYCHAIN/$1.json" ] || [ -d "$KEYCHAIN/$1" ]; }

# What the plan moves, so that the estimate of later steps (sweeps, deletes) sees earlier ones.
# In the send phase the live state is read instead.
declare -A PLAN_FT=() PLAN_NEAR=()
plan_ft() { PLAN_FT["$1 $2"]=$(python3 -I -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "${PLAN_FT["$1 $2"]:-0}" "$3"); }
plan_near() { PLAN_NEAR[$1]=$(python3 -I -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "${PLAN_NEAR[$1]:-0}" "$2"); }
# ft_now <token> <account>: the balance now (send phase) or after the planned steps (estimate).
ft_now() {
  local live
  live=$(ft_balance "$1" "$2")
  if [ "$PHASE" = estimate ]; then
    python3 -I -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "$live" "${PLAN_FT["$1 $2"]:-0}"
  else
    echo "$live"
  fi
}
near_now() {
  local state
  state=$(account "$1")
  [ "$state" != missing ] || { echo 0; return 0; }
  if [ "$PHASE" = estimate ]; then helper add "${state%% *}" "${PLAN_NEAR[$1]:-0}"; else echo "${state%% *}"; fi
}

FLOWS=()
flow() { [ "$PHASE" = estimate ] && FLOWS+=("$(printf '%-34s -> %-30s %s' "$1" "$2" "$3")") || true; }

# ---- preflight checks ------------------------------------------------------------------------

NOW_NS=$(block_time)
if [ "$(account "$VAULT_ID")" = missing ]; then
  echo "    vault:     $VAULT_ID does not exist; nothing in it to withdraw"
  ALL_OWNERS=()
else
  [ "$(view "$VAULT_ID" get_treasury_id '{}')" = "\"$TREASURY_ID\"" ] || die "$VAULT_ID's treasury is not $TREASURY_ID"
  mapfile -t ALL_OWNERS < <(python3 -I "$LIB_DIR/fastnear_index.py" owners "$NETWORK" "$VAULT_ID")
  echo "    owners:    ${#ALL_OWNERS[@]} ever, from the vault's history: ${ALL_OWNERS[*]:-none}"
  for owner in "${ALL_OWNERS[@]}"; do
    vault_json "$owner"
    locked=$(helper json "$WORK/vault-$owner.json" 'int((v or {}).get("withdrawals_locked_until") or 0)')
    if helper ge "$locked" "$NOW_NS" && [ "$locked" != 0 ]; then
      blocker "$owner's withdrawals are locked until $(helper ns-utc "$locked")"
    fi
    case " ${OWNERS[*]} " in *" $owner "*) continue ;; esac
    holds=$(helper json "$WORK/vault-$owner.json" 'v is not None and (int(v["balance"]) > 0 or any(int(t["balance"]) + int(t["on_exchange"]) > 0 for t in v["tokens"]))')
    [ "$holds" = false ] || blocker "$owner, not one of the teardown's owners, still holds funds in $VAULT_ID"
  done
fi
if [ "${#BLOCKERS[@]}" -gt 0 ] && [ "$MODE" = send ]; then
  die "refusing to send: ${BLOCKERS[*]}"
fi

# ---- steps -------------------------------------------------------------------------------------

# manual_step <description> <command for the wallet>: a transaction this script cannot sign.
manual_step() {
  if [ "$PHASE" = estimate ]; then
    STEP_NO=$((STEP_NO + 1))
    printf '  %2d. %s\n      MANUAL: sign this from your wallet, then run the script again:\n      %s\n' "$STEP_NO" "$1" "$2"
  else
    die "manual step: $1. Sign it from your wallet ($2), then run this script again."
  fi
}

declare -A PLAN_REG=()
# registered_now <token> <account>: registered on chain, or (estimate) by a step planned above.
registered_now() { registered "$1" "$2" || { [ "$PHASE" = estimate ] && [ -n "${PLAN_REG["$1 $2"]:-}" ]; }; }

register_for() { # register_for <payer> <token> <account>
  if registered_now "$2" "$3"; then return 0; fi
  local min
  min=$(min_storage "$2")
  call_step success "$1" keychain "$2" storage_deposit "{\"account_id\":\"$3\",\"registration_only\":true}" "$min" 30 \
    "register $3 on $2 ($min NEAR, paid by $1)"
  PLAN_REG["$2 $3"]=1
}

withdraw_owner() { # 1. one owner takes everything out of the vault
  local owner=$1 token held on_ex amount near_balance
  [ "$(account "$VAULT_ID")" != missing ] || return 0
  vault_json "$owner"
  if [ "$(helper json "$WORK/vault-$owner.json" 'v is None')" = true ]; then
    skip "withdraw everything for $owner (no vault)"
    return 0
  fi
  for token in $(helper json "$WORK/vault-$owner.json" '" ".join(t["token_id"] for t in v["tokens"])'); do
    vault_json "$owner"
    held=$(helper json "$WORK/vault-$owner.json" "next(int(t['balance']) for t in v['tokens'] if t['token_id'] == '$token')")
    on_ex=$(helper json "$WORK/vault-$owner.json" "next(int(t['on_exchange']) for t in v['tokens'] if t['token_id'] == '$token')")
    if [ "$on_ex" != 0 ]; then
      call_step success "$owner" keychain "$VAULT_ID" reclaim_from_exchange "{\"token_id\":\"$token\"}" "$ONE_YOCTO" "$RECLAIM_TGAS" \
        "$owner reclaims $on_ex $token units left on the exchange"
      if [ "$PHASE" = send ]; then
        vault_json "$owner"
        held=$(helper json "$WORK/vault-$owner.json" "next(int(t['balance']) for t in v['tokens'] if t['token_id'] == '$token')")
      else
        held=$(helper add "$held" "$on_ex")
      fi
    fi
    if [ "$held" = 0 ]; then
      skip "withdraw $owner's $token (none left)"
      continue
    fi
    register_for "$owner" "$token" "$owner"
    call_step success "$owner" keychain "$VAULT_ID" withdraw_token "{\"token_id\":\"$token\",\"amount\":\"$held\"}" "$ONE_YOCTO" 50 \
      "$owner withdraws $held $token units"
    flow "$VAULT_ID" "$owner" "$held $token units"
    plan_ft "$token" "$owner" "$held"
    plan_ft "$token" "$VAULT_ID" "-$held"
  done
  vault_json "$owner"
  near_balance=$(helper json "$WORK/vault-$owner.json" 'int(v["balance"])')
  if [ "$near_balance" = 0 ]; then
    skip "withdraw $owner's NEAR (none left)"
  else
    call_step success "$owner" keychain "$VAULT_ID" withdraw "{\"amount\":\"$near_balance\"}" "$ONE_YOCTO" 30 \
      "$owner withdraws $(helper near "$near_balance") NEAR"
    flow "$VAULT_ID" "$owner" "$(helper near "$near_balance") NEAR"
    plan_near "$owner" "$near_balance"
    plan_near "$VAULT_ID" "-$near_balance"
  fi
}

withdraw_fees_step() { # 2. the treasury takes the accrued fees
  local token fees call
  [ "$(account "$VAULT_ID")" != missing ] || return 0
  for token in "${TOKEN_IDS[@]}"; do
    fees=$(view "$VAULT_ID" get_fees "{\"token_id\":\"$token\"}" | tr -d '"')
    if [ "$fees" = 0 ]; then
      skip "treasury withdraws $token fees (none accrued)"
      continue
    fi
    register_for "$ROOT_ACCOUNT" "$token" "$TREASURY_ID"
    call="near contract call-function as-transaction $VAULT_ID withdraw_fees json-args '{\"token_id\":\"$token\",\"amount\":\"$fees\"}' prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as $TREASURY_ID network-config $(live_connection)"
    if key_in_keychain "$TREASURY_ID"; then
      call_step success "$TREASURY_ID" keychain "$VAULT_ID" withdraw_fees "{\"token_id\":\"$token\",\"amount\":\"$fees\"}" "$ONE_YOCTO" 50 \
        "treasury $TREASURY_ID withdraws $fees $token units of fees"
    else
      manual_step "treasury $TREASURY_ID withdraws $fees $token units of fees" "$call"
    fi
    flow "$VAULT_ID" "$TREASURY_ID" "$fees $token units (fees)"
    plan_ft "$token" "$TREASURY_ID" "$fees"
    plan_ft "$token" "$VAULT_ID" "-$fees"
  done
}

sweep_tokens() { # 3. tokens on accounts under ROOT_ACCOUNT go to BENEFICIARY
  local id token amount
  for id in "${SWEPT[@]}"; do
    [ "$(account "$id")" != missing ] || continue
    for token in "${TOKEN_IDS[@]}"; do
      amount=$(ft_now "$token" "$id")
      [ "$amount" != 0 ] || continue
      register_for "$id" "$token" "$BENEFICIARY"
      call_step success "$id" keychain "$token" ft_transfer \
        "{\"receiver_id\":\"$BENEFICIARY\",\"amount\":\"$amount\",\"memo\":\"intatto teardown\"}" "$ONE_YOCTO" 30 \
        "$id sends its $amount $token units to $BENEFICIARY"
      flow "$id" "$BENEFICIARY" "$amount $token units"
      plan_ft "$token" "$id" "-$amount"
      plan_ft "$token" "$BENEFICIARY" "$amount"
    done
  done
}

unregister_storage() { # 4. storage deposits back to each account, where its balance is zero
  local id token deposits nonzero ids
  for id in "${REGISTERED[@]}"; do
    [ "$(account "$id")" != missing ] || continue
    for token in "${TOKEN_IDS[@]}"; do
      registered_now "$token" "$id" || continue
      if [ "$(ft_now "$token" "$id")" != 0 ]; then
        echo "   -  keep $id's registration on $token: its balance there is not zero"
        continue
      fi
      call_step try "$id" keychain "$token" storage_unregister '{}' "$ONE_YOCTO" 30 \
        "unregister $id from $token (its storage deposit returns to $id)"
      flow "$token" "$id" "storage deposit ($(min_storage "$token") NEAR at most)"
    done
    registered "$EXCHANGE_ID" "$id" || continue
    deposits=$(exchange_deposits "$id")
    nonzero=$(printf '%s\n' $deposits | grep -v -E '=0$' || true)
    if [ -n "$nonzero" ] && [ "$PHASE" = send ]; then
      echo "   -  keep $id's registration on $EXCHANGE_ID: it still holds $nonzero"
      continue
    fi
    if [ -n "$deposits" ]; then
      ids=$(printf '%s\n' $deposits | cut -d= -f1 | python3 -I -c 'import json, sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
      call_step try "$id" keychain "$EXCHANGE_ID" unregister_tokens "{\"token_ids\":$ids}" "$ONE_YOCTO" 30 \
        "unregister $id's empty token slots on $EXCHANGE_ID"
    fi
    call_step try "$id" keychain "$EXCHANGE_ID" storage_unregister '{}' "$ONE_YOCTO" 30 \
      "unregister $id from $EXCHANGE_ID (its storage deposit returns to $id)"
    flow "$EXCHANGE_ID" "$id" "storage deposit"
  done
}

# assert_empty <account>: the reasons <account> cannot be deleted yet, one per line; none if it can.
assert_empty() {
  local id=$1 token amount deposits contracts state usage code
  contracts=$( { printf '%s\n' "${TOKEN_IDS[@]}"; python3 -I "$LIB_DIR/fastnear_index.py" tokens "$NETWORK" "$id"; } | sort -u)
  for token in $contracts; do
    amount=$(ft_now "$token" "$id")
    [ "$amount" = 0 ] || echo "holds $amount units on $token"
  done
  if registered "$EXCHANGE_ID" "$id"; then
    deposits=$(exchange_deposits "$id")
    for entry in $deposits; do
      [ "${entry#*=}" != 0 ] || continue
      # In the estimate, the vault's exchange deposits are owners' tokens that step 1 reclaims;
      # the send phase reads them again after it.
      if [ "$PHASE" = estimate ] && [ "$id" = "$VAULT_ID" ]; then continue; fi
      echo "holds ${entry#*=} ${entry%%=*} units on $EXCHANGE_ID"
    done
  fi
  if [ "$id" = "$VAULT_ID" ]; then
    for owner in "${ALL_OWNERS[@]}"; do
      case " ${OWNERS[*]} " in *" $owner "*) [ "$PHASE" = estimate ] && continue ;; esac
      vault_json "$owner"
      [ "$(helper json "$WORK/vault-$owner.json" 'v is not None and (int(v["balance"]) > 0 or any(int(t["balance"]) + int(t["on_exchange"]) > 0 for t in v["tokens"]))')" = false ] ||
        echo "owner $owner still has funds in it"
    done
    for token in "${TOKEN_IDS[@]}"; do
      [ "$PHASE" = estimate ] && break
      [ "$(view "$VAULT_ID" get_fees "{\"token_id\":\"$token\"}" | tr -d '"')" = 0 ] || echo "$token fees are still accrued"
      printf '%s' "$(view "$VAULT_ID" get_exchange_ledger "{\"token_id\":\"$token\"}")" >"$WORK/ledger.json"
      [ "$(helper json "$WORK/ledger.json" 'int(v["expected"]) == 0 and int(v["in_flight"]) == 0')" = true ] ||
        echo "the exchange ledger for $token is not settled"
    done
    rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}" >"$WORK/va.json" || die "view_account $id failed"
    rpc query "{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$id\"}" >"$WORK/vc.json" || die "view_code $id failed"
    usage=$(helper json "$WORK/va.json" 'int(v["result"]["storage_usage"])')
    code=$(helper json "$WORK/vc.json" 'len(__import__("base64").b64decode(v["result"]["code_base64"]))')
    helper ge "$MAX_DELETABLE_STATE" "$((usage - code))" ||
      echo "its state outside the code is $((usage - code)) bytes, over the $MAX_DELETABLE_STATE the protocol allows deleting"
  fi
}

delete_step() { # 5. one account, after asserting it holds nothing
  local id=$1 problems balance
  if [ "$(account "$id")" = missing ]; then
    skip "delete $id (does not exist)"
    return 0
  fi
  problems=$(assert_empty "$id")
  if [ -n "$problems" ]; then
    [ "$PHASE" = send ] && die "refusing to delete $id: $(echo "$problems" | paste -sd ';' -)"
    while IFS= read -r p; do blocker "delete $id: $p"; done <<<"$problems"
    return 0
  fi
  balance=$(near_now "$id")
  tx success "$id" "$(key_file_signer "$id")" 0 "$DELETE_TGAS" \
    "delete $id; $BENEFICIARY receives its $(helper near "$balance") NEAR" \
    account delete-account "$id" beneficiary "$BENEFICIARY"
  flow "$id (deleted)" "$BENEFICIARY" "$(helper near "$balance") NEAR"
  plan_near "$BENEFICIARY" "$balance"
}

steps() {
  local owner id
  echo "  -- 1. owners withdraw everything"
  for owner in "${OWNERS[@]}"; do withdraw_owner "$owner"; done
  echo "  -- 2. treasury withdraws the fees"
  withdraw_fees_step
  echo "  -- 3. tokens go to $BENEFICIARY"
  sweep_tokens
  echo "  -- 4. storage registrations are removed where empty"
  unregister_storage
  echo "  -- 5. accounts are deleted, leaf first"
  for id in "${DELETE_ORDER[@]}"; do delete_step "$id"; done
}

run_steps teardown

if [ "$MODE" = dry-run ]; then
  echo
  echo "== Where everything goes (estimate from live state; gas comes out of the NEAR amounts)"
  [ "${#FLOWS[@]}" -gt 0 ] && printf '    %s\n' "${FLOWS[@]}" || echo "    nothing: none of the accounts exist"
  echo "    $BENEFICIARY receives about $(helper near "${PLAN_NEAR[$BENEFICIARY]:-0}") NEAR in total from the deletes."
  if [ "${#BLOCKERS[@]}" -gt 0 ]; then
    echo
    echo "== ${#BLOCKERS[@]} blocker(s); --send would stop at the first:"
    printf '    %s\n' "${BLOCKERS[@]}"
  fi
fi
