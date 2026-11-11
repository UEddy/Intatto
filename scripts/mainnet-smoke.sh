#!/usr/bin/env bash
# Mainnet smoke test with tiny amounts, using near-cli-rs 0.30.1. Dry run by default.
#
#   VAULT_ID=... SMOKE_OWNER=... SMOKE_AGENT=... FUNDER=... scripts/mainnet-smoke.sh [--send]
#
# An owner wraps SWAP_NEAR NEAR and deposits it into the vault as wNEAR. The agent, signing with a
# function-call key limited to agent_swap on the vault, then makes five calls that must be rejected
# and one swap of SWAP_NEAR wNEAR for USDt through pool #3879 that must go through:
#   - SWAP_NEAR + 0.1 wNEAR, over the per-swap cap        -> over_per_tx_cap
#   - another wNEAR/USDt pool (#5470), not allowlisted     -> pool_not_allowlisted
#   - min_amount_out of 1, far below the quote             -> slippage_too_loose
#   - while the owner has frozen the vault                 -> frozen
#   - signed by the owner instead of the agent             -> not_agent
#   - SWAP_NEAR wNEAR at the live quote less 0.5%          -> swap_completed, with the owner
#     credited net and the treasury the 0.10% fee: net + fee == amount_out
# Finally the owner withdraws the USDt. Each step is skipped if already done.
#
# Environment:
#   VAULT_ID, SMOKE_OWNER, SMOKE_AGENT, FUNDER     required (FUNDER creates and funds the two)
#   SWAP_NEAR           default 0.5
#   FC_ALLOWANCE        default 0.2 NEAR (each agent_swap reserves 300 TGas = 0.03 NEAR of it)
#   EXPECTED_CODE_HASH  default: the reproducible build of commit 6cfa90e
set -euo pipefail
shopt -s inherit_errexit
source "$(dirname "${BASH_SOURCE[0]}")/lib/mainnet.sh"

EXPECTED_CODE_HASH=${EXPECTED_CODE_HASH:-3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J}
VAULT_ID=${VAULT_ID:-}
SMOKE_OWNER=${SMOKE_OWNER:-}
SMOKE_AGENT=${SMOKE_AGENT:-}
FUNDER=${FUNDER:-}
SWAP_NEAR=${SWAP_NEAR:-$SMOKE_SWAP_NEAR_DEFAULT}
FC_ALLOWANCE=${FC_ALLOWANCE:-$SMOKE_FC_ALLOWANCE_DEFAULT}
OTHER_POOL_ID=5470 # a wNEAR/USDt simple pool the policy does not list
MAX_SLIPPAGE_BPS=100
AGENT_SLIPPAGE_BPS=50
VAULT_NEAR=0.05 # the owner's NEAR in the vault, which pays its record's storage
TOKEN_STORAGE=0.00125
SWAP_TGAS=300

parse_mode "$@"
echo "== Preflight ($MODE)"
require_tools
for var in VAULT_ID SMOKE_OWNER SMOKE_AGENT FUNDER; do
  [ -n "${!var}" ] || die "set $var"
done
PAYER=$FUNDER
vault_check "$VAULT_ID" "$EXPECTED_CODE_HASH"
exchange_check
SWAP=$(helper yocto "$SWAP_NEAR")
OVER=$(helper add "$SWAP" "$(helper yocto 0.1)")
printf '%s' "$(view "$EXCHANGE" get_pool "{\"pool_id\":$POOL_ID}")" >"$WORK/pool.json"
echo "    pool:      #$POOL_ID $(helper json "$WORK/pool.json" 'v["pool_kind"]'), fee $(helper json "$WORK/pool.json" 'v["total_fee"]') bps, tokens $(helper json "$WORK/pool.json" 'v["token_account_ids"]')"
[ "$(helper json "$WORK/pool.json" "v['token_account_ids'] == ['$WNEAR', '$USDT']")" = true ] || die "pool #$POOL_ID does not trade $WNEAR / $USDT"

quote() {
  view "$EXCHANGE" get_return "{\"pool_id\":$POOL_ID,\"token_in\":\"$WNEAR\",\"amount_in\":\"$1\",\"token_out\":\"$USDT\"}" | tr -d '"'
}
QUOTE=$(quote "$SWAP")
echo "    quote:     $SWAP_NEAR wNEAR -> $(helper units "$QUOTE" "$USDT_DECIMALS") USDt now"

POLICY=$(
  cat <<EOF | tr -d ' \n'
{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":5,"allowlist":[],
"tokens":[{"token_id":"$WNEAR","per_tx_cap":"$SWAP","daily_cap":"$SWAP"},
{"token_id":"$USDT","per_tx_cap":"0","daily_cap":"0"}],
"pools":[{"pool_id":$POOL_ID,"token_ids":["$WNEAR","$USDT"],"max_slippage_bps":$MAX_SLIPPAGE_BPS}]}
EOF
)

vault_of_owner() { view "$VAULT_ID" get_vault "{\"owner_id\":\"$SMOKE_OWNER\"}" >"$WORK/vault.json"; }
token_balance() { helper json "$WORK/vault.json" "next((int(t['balance']) for t in (v or {}).get('tokens', []) if t['token_id'] == '$1'), 0)"; }
registered() { [ "$(view "$1" storage_balance_of "{\"account_id\":\"$2\"}")" != null ]; }

# agent_swap_step <expect> <signer> <spec> <pool> <amount_in> <min_out> <description>
agent_swap_step() {
  call_step "$1" "$2" "$3" "$VAULT_ID" agent_swap \
    "{\"owner_id\":\"$SMOKE_OWNER\",\"pool_id\":$4,\"token_in\":\"$WNEAR\",\"token_out\":\"$USDT\",\"amount_in\":\"$5\",\"min_amount_out\":\"$6\"}" \
    0 "$SWAP_TGAS" "$7"
}

steps() {
  create_account_step "$SMOKE_OWNER" "$(helper near "$(smoke_owner_yocto "$SWAP_NEAR")")" "$FUNDER"
  create_account_step "$SMOKE_AGENT" "$(helper near "$(smoke_agent_yocto "$FC_ALLOWANCE")")" "$FUNDER"
  vault_of_owner
  if [ "$(helper json "$WORK/vault.json" 'v is None')" = true ]; then
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" deposit '{}' "$VAULT_NEAR" 30 "deposit $VAULT_NEAR NEAR for the vault record's storage"
  else
    skip "deposit (the vault exists)"
  fi
  if [ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$SMOKE_AGENT' and v['policy'] == $POLICY")" = true ]; then
    skip "set_agent (smoke policy)"
  else
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" set_agent "{\"agent_id\":\"$SMOKE_AGENT\",\"policy\":$POLICY}" \
      "$ONE_YOCTO" 30 "set_agent($SMOKE_AGENT): sell at most $SWAP_NEAR wNEAR per swap and per 24h, via pool #$POOL_ID only, $MAX_SLIPPAGE_BPS bps slippage"
  fi
  for token in "$WNEAR" "$USDT"; do
    if registered "$token" "$SMOKE_OWNER"; then
      skip "register $SMOKE_OWNER on $token"
    else
      call_step success "$SMOKE_OWNER" keychain "$token" storage_deposit \
        "{\"account_id\":\"$SMOKE_OWNER\",\"registration_only\":true}" "$TOKEN_STORAGE" 30 "register $SMOKE_OWNER on $token"
    fi
  done
  vault_of_owner
  if helper ge "$(token_balance "$WNEAR")" "$SWAP"; then
    skip "wrap and deposit $SWAP_NEAR wNEAR (the vault holds it)"
  else
    call_step success "$SMOKE_OWNER" keychain "$WNEAR" near_deposit '{}' "$SWAP_NEAR" 30 "wrap $SWAP_NEAR NEAR"
    call_step success "$SMOKE_OWNER" keychain "$WNEAR" ft_transfer_call \
      "{\"receiver_id\":\"$VAULT_ID\",\"amount\":\"$SWAP\",\"msg\":\"\"}" "$ONE_YOCTO" 100 "deposit $SWAP_NEAR wNEAR into the vault"
  fi
  add_fc_key_step "$SMOKE_AGENT" "$VAULT_ID" agent_swap "$FC_ALLOWANCE"
  local agent min_out
  agent=$(fc_key_signer "$SMOKE_AGENT" "$VAULT_ID" agent_swap)
  min_out=$(python3 -I -c 'import sys; q, bps = map(int, sys.argv[1:]); print(q * (10000 - bps) // 10000)' "$(quote "$SWAP")" "$AGENT_SLIPPAGE_BPS")

  agent_swap_step reject:over_per_tx_cap "$SMOKE_AGENT" "$agent" "$POOL_ID" "$OVER" 1 "rejected: $(helper near "$OVER") wNEAR, over the per-swap cap"
  agent_swap_step reject:pool_not_allowlisted "$SMOKE_AGENT" "$agent" "$OTHER_POOL_ID" "$SWAP" 1 "rejected: pool #$OTHER_POOL_ID is not allowlisted"
  agent_swap_step reject:slippage_too_loose "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" 1 "rejected: min_amount_out 1, far below the quote"
  call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" freeze '{}' 0 30 "owner freezes the vault"
  agent_swap_step reject:frozen "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" "$min_out" "rejected: the vault is frozen"
  call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" unfreeze '{}' "$ONE_YOCTO" 30 "owner unfreezes the vault"
  agent_swap_step reject:not_agent "$SMOKE_OWNER" keychain "$POOL_ID" "$SWAP" "$min_out" "rejected: signed by the owner, not the agent"

  local before_usdt before_fees=0
  if [ "$PHASE" = send ]; then
    vault_of_owner
    before_usdt=$(token_balance "$USDT")
    before_fees=$(view "$VAULT_ID" get_fees "{\"token_id\":\"$USDT\"}" | tr -d '"')
    min_out=$(python3 -I -c 'import sys; q, bps = map(int, sys.argv[1:]); print(q * (10000 - bps) // 10000)' "$(quote "$SWAP")" "$AGENT_SLIPPAGE_BPS")
  fi
  agent_swap_step success "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" "$min_out" \
    "swap $SWAP_NEAR wNEAR for at least $(helper units "$min_out" "$USDT_DECIMALS") USDt (quote less $AGENT_SLIPPAGE_BPS bps)"
  local net=0
  if [ "$PHASE" = send ]; then
    helper events "$WORK/last-outcome.json" "$VAULT_ID" | grep '"swap_completed"' >"$WORK/completed.json" || die "no swap_completed event"
    local out fee
    out=$(helper json "$WORK/completed.json" 'v["data"]["amount_out"]')
    fee=$(helper json "$WORK/completed.json" 'v["data"]["fee"]')
    net=$(helper json "$WORK/completed.json" 'v["data"]["net"]')
    vault_of_owner
    echo "    swap:      amount_out $out, fee $fee, net $net (USDt units)"
    check "swap_completed is version 1.1.0" [ "$(helper json "$WORK/completed.json" 'v["version"]')" = 1.1.0 ]
    check "net + fee == amount_out" [ "$(helper add "$net" "$fee")" = "$out" ]
    check "fee == floor(amount_out * $FEE_BPS / 10000)" [ "$fee" = "$(python3 -I -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]) // 10000)' "$out" "$FEE_BPS")" ]
    check "amount_out >= min_amount_out" helper ge "$out" "$min_out"
    check "owner credited net" [ "$(token_balance "$USDT")" = "$(helper add "$before_usdt" "$net")" ]
    check "treasury accrued the fee" [ "$(view "$VAULT_ID" get_fees "{\"token_id\":\"$USDT\"}" | tr -d '"')" = "$(helper add "$before_fees" "$fee")" ]
  fi
  call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" withdraw_token \
    "{\"token_id\":\"$USDT\",\"amount\":\"$( [ "$PHASE" = send ] && echo "$net" || echo '<net>')\"}" "$ONE_YOCTO" 50 "owner withdraws the swapped USDt"
}

run_steps "$SMOKE_OWNER"
[ "$MODE" = send ] || exit 0
echo "== $PASSED passed, $FAILED failed"
echo "Transactions: $TX_LOG"
[ "$FAILED" = 0 ]
