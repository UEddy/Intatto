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
# Finally the owner withdraws the USDt.
#
# A re-run resumes: a step is skipped only when its effect on chain is exactly this plan's and its
# transaction, in an earlier run's log (mainnet-mainnet-smoke-*.txs here), re-checks over RPC.
# Rejections and the swap are never assumed done. Anything unexpected stops the script before
# anything is signed (see "Resume" below).
#
# Environment:
#   VAULT_ID, SMOKE_OWNER, SMOKE_AGENT, FUNDER     required (FUNDER creates and funds the two)
#   SWAP_NEAR           default 0.5
#   FC_ALLOWANCE        default 2 NEAR: a cap on the gas the agent's key may buy, not funds. The
#                       gas is paid from the agent's balance (SMOKE_AGENT_BALANCE, 0.55 NEAR, in
#                       scripts/lib/mainnet.sh); each agent_swap needs ~0.301 NEAR of it at hand,
#                       and the unused part is refunded.
#   EXPECTED_CODE_HASH  default: the reproducible build of commit 6cfa90e
# The whole script is one block, so bash parses all of it before running any of it: editing the
# file while a run is in progress cannot change what that run executes (bash otherwise reads a
# script as it goes, and an edit mid-run makes it execute shifted text).
{
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

# ---- Resume ----
# A re-run continues where an earlier one stopped. Each step below is either verified done or
# planned to run; nothing is skipped on a guess:
#   - a step whose effect is on chain is skipped only if that effect is exactly what this plan
#     makes, and the step's transaction, from an earlier run's log (mainnet-mainnet-smoke-*.txs in
#     this directory), re-checks over RPC;
#   - a rejection, the freeze/unfreeze pair and the swap are verified only by their own logged
#     transaction, or run (again);
#   - anything else (an account, record, policy, registration, key or balance this plan did not
#     make or does not expect) stops the script before anything is signed.
D_DEPOSIT="deposit $VAULT_NEAR NEAR for the vault record's storage"
D_SET_AGENT="set_agent($SMOKE_AGENT): sell at most $SWAP_NEAR wNEAR per swap and per 24h, via pool #$POOL_ID only, $MAX_SLIPPAGE_BPS bps slippage"
D_WRAP="wrap $SWAP_NEAR NEAR"
D_TRANSFER="deposit $SWAP_NEAR wNEAR into the vault"
D_KEY="add a function-call key to $SMOKE_AGENT: agent_swap on $VAULT_ID, $FC_ALLOWANCE NEAR allowance"
D_OVER="rejected: $(helper near "$OVER") wNEAR, over the per-swap cap"
D_POOL="rejected: pool #$OTHER_POOL_ID is not allowlisted"
D_SLIP="rejected: min_amount_out 1, far below the quote"
D_FREEZE="owner freezes the vault"
D_FROZEN="rejected: the vault is frozen"
D_UNFREEZE="owner unfreezes the vault"
D_NOT_AGENT="rejected: signed by the owner, not the agent"
D_SWAP_PREFIX="swap $SWAP_NEAR wNEAR for at least "
D_WITHDRAW="owner withdraws the swapped USDt"
# The vault record's storage that set_agent, two token entries and one swap entry can add, charged
# to its NEAR balance: at most the policy and agent id, plus 200 bytes per entry.
STORAGE_SLACK_BYTES=$((${#POLICY} + ${#SMOKE_AGENT} + 3 * 200))

# Initial balances of the accounts an earlier run created, checked against their live balances
# once the plan is known (resume_balances).
declare -A CREATED_WITH=()

seq_of() { printf '%s' "${1%% *}"; }
hash_of() { printf '%s' "${1#* }"; }

# done_call <signer> <hash> <description> <contract-method> <args> <deposit NEAR|ONE_YOCTO> <TGas>:
# a verified function call, with what it spent at most (as call_step estimates it).
done_call() {
  local yocto fees
  if [ "$6" = "$ONE_YOCTO" ]; then yocto=1; else yocto=$(helper yocto "$6"); fi
  fees=$(helper fees "$WORK/protocol.json" call "$((${#4} + ${#5}))")
  # shellcheck disable=SC2086 # $fees is "<send> <exec>"
  done_step "$1" "$2" "$3" "$yocto" "$7" $fees
}

swap_args() { printf '{"owner_id":"%s","pool_id":%s,"token_in":"%s","token_out":"%s","amount_in":"%s","min_amount_out":"%s"}' "$SMOKE_OWNER" "$1" "$WNEAR" "$USDT" "$2" "$3"; }

# resume_account <account> <initial balance NEAR> <funder>: creates <account>, or verifies an
# earlier run's creation of it: exactly one logged create transaction that re-checks, sent to it
# and transferring exactly <initial balance>; no code and no contract state; the full-access key
# saved to the legacy keychain on it. Its balance is checked once the plan is known.
resume_account() {
  local id=$1 amount=$2 funder=$3 what hash state sent key
  what="create $id with $amount NEAR (key saved to $KEYCHAIN)"
  hash=$(only_logged exact "$what")
  state=$(account "$id")
  if [ "$state" = missing ]; then
    [ -z "$hash" ] || die "$id does not exist, but the logged $hash created it; refusing to resume"
    create_account_step "$id" "$amount" "$funder"
    return 0
  fi
  [ -n "$hash" ] || die "$id exists, but no logged transaction of this script created it; refusing to resume"
  [ "${state#* }" = none ] || die "$id has code (${state#* }); refusing to resume"
  verify_logged "$hash" "$funder" success "$what"
  [ "$(helper json "$WORK/logged.json" 'v["result"]["transaction"]["receiver_id"]')" = "$id" ] || die "the logged $hash did not create $id; refusing to resume"
  sent=$(helper json "$WORK/logged.json" 'sum(int(a["Transfer"]["deposit"]) for a in v["result"]["transaction"]["actions"] if isinstance(a, dict) and "Transfer" in a)')
  [ "$sent" = "$(helper yocto "$amount")" ] || die "the logged $hash gave $id $(helper near "$sent") NEAR, not $amount; refusing to resume"
  rpc query "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$id\",\"prefix_base64\":\"\"}" >"$WORK/state.json" || die "view_state $id failed"
  [ "$(helper json "$WORK/state.json" 'len(v["result"]["values"]) if "result" in v else 0')" = 0 ] || die "$id has contract state; refusing to resume"
  [ -f "$KEYCHAIN/$id.json" ] || die "$id's key is not in $KEYCHAIN; refusing to resume"
  key=$(helper json "$KEYCHAIN/$id.json" 'v["public_key"]')
  rpc query "{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$id\",\"public_key\":\"$key\"}" >"$WORK/key.json" || die "view_access_key $id failed"
  [ "$(helper json "$WORK/key.json" 'v.get("result", {}).get("permission")')" = FullAccess ] || die "$id does not have its keychain key ($key) with full access; refusing to resume"
  CREATED_WITH[$id]=$(helper yocto "$amount")
  done_step "$funder" "$hash" "$what"
}

# resume_reject <expect> <signer> <spec> <pool> <amount_in> <min_out> <description>: verified by
# its latest logged transaction, which must show exactly this rejection, or run.
resume_reject() {
  local found
  found=$(last_logged exact "$7")
  if [ -z "$found" ]; then
    agent_swap_step "$@"
    return 0
  fi
  verify_logged "$(hash_of "$found")" "$2" "$1" "$7"
  done_call "$2" "$(hash_of "$found")" "$7" agent_swap "$(swap_args "$4" "$5" "$6")" 0 "$SWAP_TGAS"
}

# resume_state: the swap and the logged steps the rest depend on, read once per phase.
resume_state() {
  vault_of_owner
  SWAP_HASH=$(only_logged prefix "$D_SWAP_PREFIX")
  SWAP_NET=
  if [ -n "$SWAP_HASH" ]; then
    verify_logged "$SWAP_HASH" "$SMOKE_AGENT" success "the swap"
    helper events "$WORK/logged.json" "$VAULT_ID" | grep '"swap_completed"' >"$WORK/logged-swap.json" || die "the logged swap $SWAP_HASH has no swap_completed event; refusing to resume"
    local out fee
    [ "$(helper json "$WORK/logged-swap.json" "v['version'] == '1.1.0' and v['data']['swap']['owner_id'] == '$SMOKE_OWNER' and v['data']['swap']['pool_id'] == $POOL_ID and v['data']['swap']['token_in'] == '$WNEAR' and v['data']['swap']['token_out'] == '$USDT' and v['data']['swap']['amount_in'] == '$SWAP' and not v['data']['held_on_exchange']")" = true ] ||
      die "the logged swap $SWAP_HASH is not this plan's swap ($SWAP_NEAR wNEAR of $SMOKE_OWNER's through pool #$POOL_ID, credited to the vault); refusing to resume"
    out=$(helper json "$WORK/logged-swap.json" 'v["data"]["amount_out"]')
    fee=$(helper json "$WORK/logged-swap.json" 'v["data"]["fee"]')
    SWAP_NET=$(helper json "$WORK/logged-swap.json" 'v["data"]["net"]')
    [ "$(helper add "$SWAP_NET" "$fee")" = "$out" ] || die "the logged swap $SWAP_HASH: net + fee != amount_out; refusing to resume"
    [ "$fee" = "$(python3 -I -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]) // 10000)' "$out" "$FEE_BPS")" ] || die "the logged swap $SWAP_HASH: fee is not $FEE_BPS bps of amount_out; refusing to resume"
  elif [ "$(helper json "$WORK/vault.json" 'v is not None and len(v["recent_spends"]) > 0')" = true ]; then
    die "the vault has recent spends, but no logged swap of this script; refusing to resume"
  fi
}

# resume_balances (after the estimate): each account an earlier run created holds between its
# initial balance less what its verified steps spent at most, and its initial balance.
resume_balances() {
  local id have low
  for id in "${!CREATED_WITH[@]}"; do
    have=$(account "$id")
    have=${have%% *}
    low=$(helper sub "${CREATED_WITH[$id]}" "${DONE_COST[$id]:-0}")
    if helper ge "$have" "$low" && helper ge "${CREATED_WITH[$id]}" "$have"; then
      echo "    resume:    $id holds $(helper near "$have") NEAR, within $(helper near "$low")-$(helper near "${CREATED_WITH[$id]}") (created with $(helper near "${CREATED_WITH[$id]}"), less what its verified steps spent at most)"
    else
      die "$id holds $(helper near "$have") NEAR, outside $(helper near "$low")-$(helper near "${CREATED_WITH[$id]}") (created with $(helper near "${CREATED_WITH[$id]}"), less what its verified steps spent at most); refusing to resume"
    fi
  done
}
after_estimate() { resume_balances; }

steps() {
  resume_state
  resume_account "$SMOKE_OWNER" "$(helper near "$(smoke_owner_yocto "$SWAP_NEAR")")" "$FUNDER"
  resume_account "$SMOKE_AGENT" "$(helper near "$(smoke_agent_yocto)")" "$FUNDER"

  # The vault record: made by the logged deposit of exactly VAULT_NEAR, unlocked.
  local hash found deposited
  vault_of_owner
  hash=$(only_logged exact "$D_DEPOSIT")
  if [ "$(helper json "$WORK/vault.json" 'v is None')" = true ]; then
    [ -z "$hash" ] || die "the logged $hash deposited into $SMOKE_OWNER's vault, but it has no vault; refusing to resume"
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" deposit '{}' "$VAULT_NEAR" 30 "$D_DEPOSIT"
  else
    [ -n "$hash" ] || die "$SMOKE_OWNER has a vault, but no logged deposit of this script made it; refusing to resume"
    verify_logged "$hash" "$SMOKE_OWNER" success "$D_DEPOSIT"
    helper events "$WORK/logged.json" "$VAULT_ID" | grep '"event": *"deposit"' >"$WORK/logged-deposit.json" || die "the logged deposit $hash has no deposit event; refusing to resume"
    [ "$(helper json "$WORK/logged-deposit.json" 'v["data"]["owner_id"]')" = "$SMOKE_OWNER" ] || die "the logged deposit $hash was for another owner; refusing to resume"
    deposited=$(helper json "$WORK/logged-deposit.json" 'v["data"]["amount"]')
    [ "$(helper add "$deposited" "$(helper json "$WORK/logged-deposit.json" 'v["data"]["storage_cost"]')")" = "$(helper yocto "$VAULT_NEAR")" ] ||
      die "the logged deposit $hash was not exactly $VAULT_NEAR NEAR; refusing to resume"
    [ "$(helper json "$WORK/vault.json" 'v["withdrawals_locked_until"] is None')" = true ] || die "$SMOKE_OWNER's vault is locked; refusing to resume"
    local balance low
    balance=$(helper json "$WORK/vault.json" 'v["balance"]')
    low=$(helper sub "$deposited" "$(helper mul "$STORAGE_SLACK_BYTES" "$BYTE_COST")")
    { helper ge "$balance" "$low" && helper ge "$deposited" "$balance"; } ||
      die "$SMOKE_OWNER's vault holds $(helper near "$balance") NEAR, outside $(helper near "$low")-$(helper near "$deposited") (deposited, less the most storage this plan adds); refusing to resume"
    echo "    resume:    $SMOKE_OWNER's vault holds $(helper near "$balance") NEAR: $(helper near "$deposited") deposited, less $(helper near "$(helper sub "$deposited" "$balance")") of storage"
    done_call "$SMOKE_OWNER" "$hash" "$D_DEPOSIT" deposit '{}' "$VAULT_NEAR" 30
  fi

  # The agent and policy: exactly the planned ones, set by the logged set_agent.
  hash=$(only_logged exact "$D_SET_AGENT")
  if [ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$SMOKE_AGENT' and v['policy'] == $POLICY")" = true ]; then
    [ -n "$hash" ] || die "the vault has the smoke agent and policy, but no logged set_agent of this script; refusing to resume"
    verify_logged "$hash" "$SMOKE_OWNER" success "$D_SET_AGENT"
    helper events "$WORK/logged.json" "$VAULT_ID" | grep '"agent_set"' >"$WORK/logged-agent.json" || die "the logged set_agent $hash has no agent_set event; refusing to resume"
    [ "$(helper json "$WORK/logged-agent.json" "v['data']['owner_id'] == '$SMOKE_OWNER' and v['data']['agent_id'] == '$SMOKE_AGENT' and v['data']['policy'] == $POLICY")" = true ] ||
      die "the logged set_agent $hash set another agent or policy; refusing to resume"
    done_call "$SMOKE_OWNER" "$hash" "$D_SET_AGENT" set_agent "{\"agent_id\":\"$SMOKE_AGENT\",\"policy\":$POLICY}" "$ONE_YOCTO" 30
  elif [ "$(helper json "$WORK/vault.json" 'v is None or v["agent_id"] is None')" = true ] && [ -z "$hash" ]; then
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" set_agent "{\"agent_id\":\"$SMOKE_AGENT\",\"policy\":$POLICY}" "$ONE_YOCTO" 30 "$D_SET_AGENT"
  else
    die "$SMOKE_OWNER's vault has agent $(helper json "$WORK/vault.json" 'v["agent_id"]') and a policy other than the planned one$([ -z "$hash" ] || echo ", after the logged set_agent $hash"); refusing to resume"
  fi

  # Storage registrations on both tokens (anyone may register an account; a registration by
  # another account is accepted if it covers the token's minimum).
  local token what reg
  for token in "$WNEAR" "$USDT"; do
    what="register $SMOKE_OWNER on $token"
    hash=$(only_logged exact "$what")
    reg=$(view "$token" storage_balance_of "{\"account_id\":\"$SMOKE_OWNER\"}")
    if [ "$reg" = null ]; then
      [ -z "$hash" ] || die "the logged $hash registered $SMOKE_OWNER on $token, but it is not registered; refusing to resume"
      call_step success "$SMOKE_OWNER" keychain "$token" storage_deposit \
        "{\"account_id\":\"$SMOKE_OWNER\",\"registration_only\":true}" "$TOKEN_STORAGE" 30 "$what"
      continue
    fi
    printf '%s' "$reg" >"$WORK/reg.json"
    printf '%s' "$(view "$token" storage_balance_bounds '{}')" >"$WORK/bounds.json"
    helper ge "$(helper json "$WORK/reg.json" 'v["total"]')" "$(helper json "$WORK/bounds.json" 'v["min"]')" ||
      die "$SMOKE_OWNER's registration on $token is below the token's minimum; refusing to resume"
    if [ -n "$hash" ]; then
      verify_logged "$hash" "$SMOKE_OWNER" success "$what"
      done_call "$SMOKE_OWNER" "$hash" "$what" storage_deposit "{\"account_id\":\"$SMOKE_OWNER\",\"registration_only\":true}" "$TOKEN_STORAGE" 30
    else
      skip "$what (registered by another account; $(helper json "$WORK/reg.json" 'v["total"]') yocto, at least the minimum)"
    fi
  done

  # wNEAR: the owner's wallet and the vault hold exactly 0 or SWAP_NEAR, consistent with the logs.
  local wrap_hash xfer_hash owner_w vault_w
  wrap_hash=$(only_logged exact "$D_WRAP")
  xfer_hash=$(only_logged exact "$D_TRANSFER")
  vault_of_owner
  owner_w=$(view "$WNEAR" ft_balance_of "{\"account_id\":\"$SMOKE_OWNER\"}" | tr -d '"')
  vault_w=$(token_balance "$WNEAR")
  [ "$(helper json "$WORK/vault.json" "next((int(t['on_exchange']) for t in (v or {}).get('tokens', []) if t['token_id'] == '$WNEAR'), 0)")" = 0 ] ||
    die "$SMOKE_OWNER's vault has wNEAR on the exchange; refusing to resume"
  local state="owner $owner_w, vault $vault_w; logged: wrap ${wrap_hash:-no}, deposit ${xfer_hash:-no}, swap ${SWAP_HASH:-no}"
  if [ "$owner_w" = 0 ] && [ "$vault_w" = 0 ] && [ -z "$wrap_hash$xfer_hash$SWAP_HASH" ]; then
    call_step success "$SMOKE_OWNER" keychain "$WNEAR" near_deposit '{}' "$SWAP_NEAR" 30 "$D_WRAP"
    call_step success "$SMOKE_OWNER" keychain "$WNEAR" ft_transfer_call \
      "{\"receiver_id\":\"$VAULT_ID\",\"amount\":\"$SWAP\",\"msg\":\"\"}" "$ONE_YOCTO" 100 "$D_TRANSFER"
  elif [ "$owner_w" = "$SWAP" ] && [ "$vault_w" = 0 ] && [ -n "$wrap_hash" ] && [ -z "$xfer_hash$SWAP_HASH" ]; then
    verify_logged "$wrap_hash" "$SMOKE_OWNER" success "$D_WRAP"
    done_call "$SMOKE_OWNER" "$wrap_hash" "$D_WRAP" near_deposit '{}' "$SWAP_NEAR" 30
    call_step success "$SMOKE_OWNER" keychain "$WNEAR" ft_transfer_call \
      "{\"receiver_id\":\"$VAULT_ID\",\"amount\":\"$SWAP\",\"msg\":\"\"}" "$ONE_YOCTO" 100 "$D_TRANSFER"
  elif [ "$owner_w" = 0 ] && [ -n "$wrap_hash" ] && [ -n "$xfer_hash" ] &&
    { { [ "$vault_w" = "$SWAP" ] && [ -z "$SWAP_HASH" ]; } || { [ "$vault_w" = 0 ] && [ -n "$SWAP_HASH" ]; }; }; then
    verify_logged "$wrap_hash" "$SMOKE_OWNER" success "$D_WRAP"
    done_call "$SMOKE_OWNER" "$wrap_hash" "$D_WRAP" near_deposit '{}' "$SWAP_NEAR" 30
    verify_logged "$xfer_hash" "$SMOKE_OWNER" success "$D_TRANSFER"
    done_call "$SMOKE_OWNER" "$xfer_hash" "$D_TRANSFER" ft_transfer_call "{\"receiver_id\":\"$VAULT_ID\",\"amount\":\"$SWAP\",\"msg\":\"\"}" "$ONE_YOCTO" 100
  else
    die "wNEAR does not match any point of this plan ($state); refusing to resume"
  fi

  # The agent's keys: its keychain full-access key and at most one function-call key, which must
  # be exactly agent_swap on the vault, in the keychain, with at most the planned allowance (all
  # of it while no logged transaction has used it).
  local keys_json fc_count
  rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$SMOKE_AGENT\"}" >"$WORK/agent-keys.json" || die "view_access_key_list $SMOKE_AGENT failed"
  keys_json="$WORK/agent-keys.json"
  [ "$(helper json "$keys_json" 'len(v["result"]["keys"])')" -le 2 ] || die "$SMOKE_AGENT has more keys than this plan adds; refusing to resume"
  fc_count=$(helper json "$keys_json" 'sum(1 for k in v["result"]["keys"] if k["access_key"]["permission"] != "FullAccess")')
  hash=$(only_logged exact "$D_KEY")
  if [ "$fc_count" = 0 ]; then
    [ -z "$hash" ] || die "the logged $hash added $SMOKE_AGENT's function-call key, but it has none; refusing to resume"
    add_fc_key_step "$SMOKE_AGENT" "$VAULT_ID" agent_swap "$FC_ALLOWANCE"
  else
    [ "$fc_count" = 1 ] && [ -n "$hash" ] || die "$SMOKE_AGENT has a function-call key that no logged transaction of this script added; refusing to resume"
    local spec used allowance methods=agent_swap
    spec=$(fc_key_signer "$SMOKE_AGENT" "$VAULT_ID" agent_swap)
    [[ "$spec" != *"<function-call key"* ]] || die "$SMOKE_AGENT's function-call key is not exactly agent_swap on $VAULT_ID with its private key in $KEYCHAIN/$SMOKE_AGENT; refusing to resume"
    [ "$(helper json "$keys_json" "[k['access_key']['permission']['FunctionCall']['method_names'] for k in v['result']['keys'] if k['access_key']['permission'] != 'FullAccess'][0] == ['agent_swap']")" = true ] ||
      die "$SMOKE_AGENT's function-call key allows other methods; refusing to resume"
    allowance=$(live_allowance "$SMOKE_AGENT" "$spec")
    used=$(for d in "$D_OVER" "$D_POOL" "$D_SLIP" "$D_FROZEN"; do logged exact "$d"; done; [ -z "$SWAP_HASH" ] || echo "0 $SWAP_HASH")
    if [ -z "$used" ]; then
      [ "$allowance" = "$(helper yocto "$FC_ALLOWANCE")" ] || die "$SMOKE_AGENT's key allowance is $allowance, not the planned $FC_ALLOWANCE NEAR, and no logged transaction used it; refusing to resume"
    else
      [ "$allowance" != unlimited ] && helper ge "$(helper yocto "$FC_ALLOWANCE")" "$allowance" || die "$SMOKE_AGENT's key allowance ($allowance) is above the planned $FC_ALLOWANCE NEAR; refusing to resume"
    fi
    verify_logged "$hash" "$SMOKE_AGENT" success "$D_KEY"
    local fees
    fees=$(helper fees "$WORK/protocol.json" add-fc-key "$((${#VAULT_ID} + ${#methods}))")
    # shellcheck disable=SC2086 # $fees is "<send> <exec>"
    done_step "$SMOKE_AGENT" "$hash" "$D_KEY" 0 0 $fees
  fi

  local agent min_out
  agent=$(fc_key_signer "$SMOKE_AGENT" "$VAULT_ID" agent_swap)
  min_out=$(python3 -I -c 'import sys; q, bps = map(int, sys.argv[1:]); print(q * (10000 - bps) // 10000)' "$(quote "$SWAP")" "$AGENT_SLIPPAGE_BPS")

  # The freeze sequence, read before any rejection runs: a vault frozen now must have been frozen
  # by the latest logged freeze, after the three rejections that need it unfrozen.
  local fz uf fr frozen
  fz=$(last_logged exact "$D_FREEZE")
  uf=$(last_logged exact "$D_UNFREEZE")
  fr=$(last_logged exact "$D_FROZEN")
  vault_of_owner
  frozen=$(helper json "$WORK/vault.json" 'v is not None and v["frozen"]')
  if [ "$frozen" = true ]; then
    [ -n "$fz" ] && { [ -z "$uf" ] || [ "$(seq_of "$uf")" -lt "$(seq_of "$fz")" ]; } ||
      die "$SMOKE_OWNER's vault is frozen, but not by the latest logged freeze of this script; refusing to resume"
    local d
    for d in "$D_OVER" "$D_POOL" "$D_SLIP"; do
      [ -n "$(last_logged exact "$d")" ] || die "the vault is frozen, but \"$d\" (which needs it unfrozen) is not logged; refusing to resume"
    done
  fi

  resume_reject reject:over_per_tx_cap "$SMOKE_AGENT" "$agent" "$POOL_ID" "$OVER" 1 "$D_OVER"
  resume_reject reject:pool_not_allowlisted "$SMOKE_AGENT" "$agent" "$OTHER_POOL_ID" "$SWAP" 1 "$D_POOL"
  resume_reject reject:slippage_too_loose "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" 1 "$D_SLIP"

  if [ "$frozen" = true ]; then
    verify_logged "$(hash_of "$fz")" "$SMOKE_OWNER" success "$D_FREEZE"
    done_call "$SMOKE_OWNER" "$(hash_of "$fz")" "$D_FREEZE" freeze '{}' 0 30
    if [ -n "$fr" ] && [ "$(seq_of "$fr")" -gt "$(seq_of "$fz")" ]; then
      verify_logged "$(hash_of "$fr")" "$SMOKE_AGENT" reject:frozen "$D_FROZEN"
      done_call "$SMOKE_AGENT" "$(hash_of "$fr")" "$D_FROZEN" agent_swap "$(swap_args "$POOL_ID" "$SWAP" "$min_out")" 0 "$SWAP_TGAS"
    else
      agent_swap_step reject:frozen "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" "$min_out" "$D_FROZEN"
    fi
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" unfreeze '{}' "$ONE_YOCTO" 30 "$D_UNFREEZE"
  elif [ -n "$fz" ] && [ -n "$uf" ] && [ -n "$fr" ] && [ "$(seq_of "$fz")" -lt "$(seq_of "$fr")" ] && [ "$(seq_of "$fr")" -lt "$(seq_of "$uf")" ]; then
    verify_logged "$(hash_of "$fz")" "$SMOKE_OWNER" success "$D_FREEZE"
    done_call "$SMOKE_OWNER" "$(hash_of "$fz")" "$D_FREEZE" freeze '{}' 0 30
    verify_logged "$(hash_of "$fr")" "$SMOKE_AGENT" reject:frozen "$D_FROZEN"
    done_call "$SMOKE_AGENT" "$(hash_of "$fr")" "$D_FROZEN" agent_swap "$(swap_args "$POOL_ID" "$SWAP" "$min_out")" 0 "$SWAP_TGAS"
    verify_logged "$(hash_of "$uf")" "$SMOKE_OWNER" success "$D_UNFREEZE"
    done_call "$SMOKE_OWNER" "$(hash_of "$uf")" "$D_UNFREEZE" unfreeze '{}' "$ONE_YOCTO" 30
  elif [ -n "$fz" ] && { [ -z "$uf" ] || [ "$(seq_of "$uf")" -lt "$(seq_of "$fz")" ]; }; then
    die "the latest logged freeze ($(hash_of "$fz")) has no logged unfreeze after it, but the vault is not frozen; refusing to resume"
  else
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" freeze '{}' 0 30 "$D_FREEZE"
    agent_swap_step reject:frozen "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" "$min_out" "$D_FROZEN"
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" unfreeze '{}' "$ONE_YOCTO" 30 "$D_UNFREEZE"
  fi
  resume_reject reject:not_agent "$SMOKE_OWNER" keychain "$POOL_ID" "$SWAP" "$min_out" "$D_NOT_AGENT"

  # The swap: verified by its logged transaction (resume_state), or run. Never run twice: the
  # policy's daily cap would refuse a second one, and a vault that has spent without a logged swap
  # stops the script.
  local before_usdt before_fees=0 net=0 withdraw_hash usdt_now
  withdraw_hash=$(only_logged exact "$D_WITHDRAW")
  if [ -n "$SWAP_HASH" ]; then
    done_call "$SMOKE_AGENT" "$SWAP_HASH" "swap $SWAP_NEAR wNEAR (net $(helper units "$SWAP_NET" "$USDT_DECIMALS") USDt to the owner)" agent_swap "$(swap_args "$POOL_ID" "$SWAP" "$min_out")" 0 "$SWAP_TGAS"
    net=$SWAP_NET
  else
    [ -z "$withdraw_hash" ] || die "the logged $withdraw_hash withdrew USDt, but no swap is logged; refusing to resume"
    vault_of_owner
    [ "$(token_balance "$USDT")" = 0 ] || die "$SMOKE_OWNER's vault holds USDt, but no swap is logged; refusing to resume"
    if [ "$PHASE" = send ]; then
      before_usdt=$(token_balance "$USDT")
      before_fees=$(view "$VAULT_ID" get_fees "{\"token_id\":\"$USDT\"}" | tr -d '"')
      min_out=$(python3 -I -c 'import sys; q, bps = map(int, sys.argv[1:]); print(q * (10000 - bps) // 10000)' "$(quote "$SWAP")" "$AGENT_SLIPPAGE_BPS")
    fi
    agent_swap_step success "$SMOKE_AGENT" "$agent" "$POOL_ID" "$SWAP" "$min_out" \
      "${D_SWAP_PREFIX}$(helper units "$min_out" "$USDT_DECIMALS") USDt (quote less $AGENT_SLIPPAGE_BPS bps)"
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
  fi

  # The withdrawal of exactly the swap's net: verified by its logged transaction, or run.
  if [ -n "$withdraw_hash" ]; then
    vault_of_owner
    usdt_now=$(token_balance "$USDT")
    [ "$usdt_now" = 0 ] || die "the logged $withdraw_hash withdrew the USDt, but the vault still holds $usdt_now; refusing to resume"
    verify_logged "$withdraw_hash" "$SMOKE_OWNER" success "$D_WITHDRAW"
    done_call "$SMOKE_OWNER" "$withdraw_hash" "$D_WITHDRAW" withdraw_token "{\"token_id\":\"$USDT\",\"amount\":\"$net\"}" "$ONE_YOCTO" 50
  else
    if [ -n "$SWAP_HASH" ]; then
      vault_of_owner
      [ "$(token_balance "$USDT")" = "$SWAP_NET" ] || die "$SMOKE_OWNER's vault holds $(token_balance "$USDT") USDt units, not the logged swap's net $SWAP_NET; refusing to resume"
    fi
    call_step success "$SMOKE_OWNER" keychain "$VAULT_ID" withdraw_token \
      "{\"token_id\":\"$USDT\",\"amount\":\"$( [ "$PHASE" = send ] || [ -n "$SWAP_HASH" ] && echo "$net" || echo '<net>')\"}" "$ONE_YOCTO" 50 "$D_WITHDRAW"
  fi
}

run_steps "$SMOKE_OWNER"
[ "$MODE" = send ] || exit 0
echo "== $PASSED passed, $FAILED failed"
echo "Transactions: $TX_LOG"
[ "$FAILED" = 0 ]

exit
}
