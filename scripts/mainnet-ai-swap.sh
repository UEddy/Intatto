#!/usr/bin/env bash
# An AI-decided NEAR Intents swap on intents.intatto.near: the trade decision comes from a model on
# NEAR AI Cloud, and its TEE signature receipt goes into the trade's own transaction
# (agent_intent_swap's ai_decision argument; README.md, "AI decisions, verifiable"). Uses near-cli-rs
# 0.30.1 and scripts/lib/mainnet.sh. Dry run by default: without --send it reads live state, sizes
# the swap, prints every transaction with its signer and cost, then gets a live quote and the
# model's decision (agent/intent-swap.mjs --dry-run). It signs and sends nothing.
#
#   scripts/mainnet-ai-swap.sh                                         dry run; sizes the swap
#   SWAP_WNEAR=<from the dry run> FUND_NEAR=<from the dry run> scripts/mainnet-ai-swap.sh --send
#
# The plan:
#    1. FUNDER (eddyhamezz.near) sends OWNER the NEAR the swap needs beyond what OWNER holds. At most
#       FUNDER_MAX_NEAR (0.27) leaves FUNDER in all, fees included; --send refuses a plan above it.
#    2. OWNER wraps SWAP_WNEAR NEAR, deposits the wNEAR into the vault (ft_transfer_call), and moves
#       it into the vault's own account on intents.near (deposit_to_intents).
#    3. AGENT runs agent/intent-swap.mjs: a Message Bus quote; the decision on NEAR AI Cloud (the
#       agent checks the receipt; "skip" stops it); agent_intent_swap with ai_decision (the vault
#       builds the token_diff, v1.signer signs it); publish_intent (the relay submits it to
#       intents.near, signed and paid by intents.near); settle_intent_swap.
#    Checks, over RPC: each transaction's signer and outcome, the swap's arguments carry the
#    decision the agent logged and its receipt verifies, the owner was credited the USDt, nothing is
#    left unsettled, and the policy is unchanged.
#
# The owner's policy is read, never changed: wNEAR only, at most 0.3 per swap and per 24 hours, to
# USDt at no less than 3.3 USDt per wNEAR (scripts/mainnet-intents.sh, 2026-11-11). Any other
# policy stops the script.
#
# Sizing (dry run with SWAP_WNEAR unset): the largest SWAP_WNEAR, in steps of 0.01, that fits both
# the room left under the policy's caps and what OWNER can hold (its live balance plus what FUNDER
# may send, less its gas, at-hand gas, storage and OWNER_MARGIN). FUND_NEAR is then what OWNER
# lacks for it, margin included, rounded up to 0.001 NEAR. --send takes both explicitly, so it sends exactly the amounts a dry run showed.
#
# Resume: run it again with the same settings. The transfer is never sent twice (a logged one is
# verified on chain, amount and receiver included); wrap and deposits are skipped once their wNEAR
# is where they put it; an intent swap left unsettled is settled; and once the AI swap exists
# (the vault's next spend id has passed FIRST_AI_SPEND_ID), no second one is made.
#
# Environment: SWAP_WNEAR, FUND_NEAR (see above); DRY_RUN_TOPUP (lib/mainnet.sh). The Message Bus
# key is read by the agent from ~/.config/intatto/intents.env (mode 600), and NEAR_AI_API_KEY from
# the environment or agent/.env; this script only checks that they are there.
#
# The whole script is one block, so bash parses all of it before running any of it: editing the
# file while a run is in progress cannot change what that run executes.
{
set -euo pipefail
shopt -s inherit_errexit
source "$(dirname "${BASH_SOURCE[0]}")/lib/mainnet.sh"
REPO=$(cd "$LIB_DIR/../.." && pwd)
AGENT_SCRIPT="$REPO/agent/intent-swap.mjs"

# Fixed by what is deployed; deliberately not overridable.
readonly INTENTS_VAULT=intents.intatto.near
readonly EXPECTED_CODE_HASH=HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC
readonly OWNER=intents-owner.intatto.near
readonly AGENT=intents-agent.intatto.near
readonly FUNDER=eddyhamezz.near
readonly FUNDER_MAX_NEAR=0.27
# The vault's next spend id before this swap: the 2026-11-11 swap was id 0.
readonly FIRST_AI_SPEND_ID=1
# The owner's policy as set on 2026-11-11.
readonly POLICY_CAP=300000000000000000000000
readonly FLOOR_MIN_OUT=3300000
readonly FLOOR_PER_IN=1000000000000000000000000
readonly FC_METHODS=agent_intent_swap,settle_intent_swap
VAULT_ID=$INTENTS_VAULT # tx() and verify_logged read this vault's events

# Prepaid gas, in TGas, as scripts/mainnet-intents.sh and agent/intent-swap.mjs attach it.
OWNER_CALL_TGAS=30
FT_TRANSFER_CALL_TGAS=100
INTENTS_MOVE_TGAS=150
AGENT_SWAP_TGAS=150
SETTLE_TGAS=100
# The owner's NEAR inside the vault pays the swap record's storage while it is unsettled (~1 KB)
# and v1.signer's 1 yoctoNEAR.
VAULT_RESERVE=0.02
# Kept spare in OWNER's balance beyond what the plan needs at once, against the gas price rising
# between the dry run and the send (the fit check would then refuse the send).
OWNER_MARGIN=0.01

SWAP_WNEAR=${SWAP_WNEAR:-}
FUND_NEAR=${FUND_NEAR:-}

parse_mode "$@"
echo "== Preflight ($MODE)"
require_tools
command -v node >/dev/null || die "node is not installed (agent/intent-swap.mjs)"
key_in_keychain() { [ -f "$KEYCHAIN/$1.json" ] || [ -d "$KEYCHAIN/$1" ]; }
PAYER=$FUNDER

POLICY=$(
  cat <<EOF | tr -d ' \n'
{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":5,"allowlist":[],
"tokens":[{"token_id":"$WNEAR","per_tx_cap":"$POLICY_CAP","daily_cap":"$POLICY_CAP"},
{"token_id":"$USDT","per_tx_cap":"0","daily_cap":"0"}],"pools":[]}
EOF
)
INTENT_POLICY="{\"pairs\":[{\"token_in\":\"$WNEAR\",\"token_out\":\"$USDT\",\"min_out\":\"$FLOOR_MIN_OUT\",\"per_in\":\"$FLOOR_PER_IN\"}]}"

registered() { [ "$(view "$1" storage_balance_of "{\"account_id\":\"$2\"}")" != null ]; }
ft_balance() {
  local out
  out=$(view "$1" ft_balance_of "{\"account_id\":\"$2\"}")
  [ "$out" = null ] && echo 0 || echo "${out//\"/}"
}
vault_of_owner() { view "$INTENTS_VAULT" get_vault "{\"owner_id\":\"$OWNER\"}" >"$WORK/vault.json"; }
vault_token() { helper json "$WORK/vault.json" "next((int(t['balance']) for t in (v or {}).get('tokens', []) if t['token_id'] == '$1'), 0)"; }
intents_balance() {
  view "$INTENTS_VAULT" get_intents_balances "{\"owner_id\":\"$OWNER\"}" >"$WORK/ib.json"
  helper json "$WORK/ib.json" "next((int(b['balance']) for b in (v or []) if b['token_id'] == '$1'), 0)"
}
same_json() { [ "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]) == json.loads(sys.argv[2]))' "$1" "$2")" = True ]; }
balance_of() {
  local state
  state=$(account "$1")
  [ "$state" != missing ] || die "$1 does not exist"
  echo "${state%% *}"
}
# next_spend_id: the vault's next spend id, from its root state (as scripts/mainnet-intents.sh reads it).
next_spend_id() {
  rpc query "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$INTENTS_VAULT\",\"prefix_base64\":\"U1RBVEU=\"}" \
    >"$WORK/root.json" || die "view_state $INTENTS_VAULT failed"
  python3 -I - "$WORK/root.json" "$EXCHANGE" <<'PY' || die "could not read $INTENTS_VAULT's next spend id from its state"
import base64, json, struct, sys
response = json.load(open(sys.argv[1]))
values = [v for v in (response.get("result") or {}).get("values", []) if base64.b64decode(v["key"]) == b"STATE"]
raw = base64.b64decode(values[0]["value"])
assert raw[:5] == b"\x01\x00\x00\x00v", "unexpected vaults prefix"
(next_id,) = struct.unpack_from("<Q", raw, 5)
(length,) = struct.unpack_from("<I", raw, 13)
assert raw[17:17 + length].decode() == sys.argv[2], "unexpected exchange id"
print(next_id)
PY
}
# A NEAR amount, rounded: down (to 0.01) or up (to 0.001), from yoctoNEAR.
near_floor_cents() { python3 -I -c 'import sys; n = max(int(sys.argv[1]), 0) // 10**22; print(f"{n // 100}.{n % 100:02d}")' "$1"; }
near_ceil_milli() { python3 -I -c 'import sys; n = -(-max(int(sys.argv[1]), 0) // 10**21); print(f"{n // 1000}.{n % 1000:03d}")' "$1"; }

# ---- what is on chain -----------------------------------------------------------------------------

state=$(account "$INTENTS_VAULT")
[ "$state" != missing ] && [ "${state#* }" = "$EXPECTED_CODE_HASH" ] || die "$INTENTS_VAULT does not run $EXPECTED_CODE_HASH"
echo "    vault:     $INTENTS_VAULT, code hash ${state#* }"
view "$INTENTS_VAULT" get_intents_config '{}' >"$WORK/config.json"
[ "$(helper json "$WORK/config.json" 'v is not None and v["key_verified"] == True')" = true ] || die "$INTENTS_VAULT's intents key is not verified"
for who in "$INTENTS_VAULT" "$OWNER"; do
  registered "$WNEAR" "$who" || die "$who is not registered on $WNEAR (scripts/mainnet-intents.sh setup registers it)"
done
registered "$USDT" "$INTENTS_VAULT" || die "$INTENTS_VAULT is not registered on $USDT"
echo "    tokens:    $INTENTS_VAULT on $WNEAR and $USDT, $OWNER on $WNEAR: registered"

vault_of_owner
[ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$AGENT' and v['policy'] == $POLICY")" = true ] ||
  die "$OWNER's vault does not have agent $AGENT with the 2026-11-11 policy; this script never changes the policy"
[ "$(helper json "$WORK/vault.json" 'v["frozen"]')" = false ] || die "$OWNER's vault is frozen"
view "$INTENTS_VAULT" get_intent_policy "{\"owner_id\":\"$OWNER\"}" >"$WORK/ip.json"
same_json "$(cat "$WORK/ip.json")" "$INTENT_POLICY" || die "$OWNER's intent policy is not wNEAR -> USDt at >= 3.3; this script never changes it"
echo "    policy:    agent $AGENT; wNEAR at most $(helper near "$POLICY_CAP") per swap and per 24 h; USDt at >= 3.3 per wNEAR (unchanged)"
VAULT_NEAR=$(helper json "$WORK/vault.json" 'v["balance"]')
helper ge "$VAULT_NEAR" "$(helper yocto "$VAULT_RESERVE")" ||
  die "$OWNER's NEAR in the vault is $(helper near "$VAULT_NEAR"), below the $VAULT_RESERVE NEAR the swap record's storage needs"
NOW=$(block_time)
USED=$(helper json "$WORK/vault.json" "sum(int(s['amount']) for s in v['recent_spends'] if s['token_id'] == '$WNEAR' and int(s['timestamp']) + 86400 * 10**9 > $NOW)")
ROOM=$(helper sub "$POLICY_CAP" "$USED")
echo "    room:      $(helper near "$ROOM") wNEAR under the 24 h cap ($(helper near "$USED") sold in the last 24 h); vault NEAR $(helper near "$VAULT_NEAR")"

NEXT_ID=$(next_spend_id)
UNSETTLED=()
[ "$NEXT_ID" -ge "$FIRST_AI_SPEND_ID" ] || die "$INTENTS_VAULT's next spend id is $NEXT_ID, below $FIRST_AI_SPEND_ID"
[ "$NEXT_ID" -le $((FIRST_AI_SPEND_ID + 1)) ] || die "$INTENTS_VAULT has spends past id $FIRST_AI_SPEND_ID that this script did not plan; check them by hand"
if [ "$NEXT_ID" = "$FIRST_AI_SPEND_ID" ]; then
  SWAP_STATE=fresh
else
  view "$INTENTS_VAULT" get_intent_swap "{\"intent_id\":\"$FIRST_AI_SPEND_ID\"}" >"$WORK/swap.json"
  if [ "$(helper json "$WORK/swap.json" "v is not None and v['owner_id'] == '$OWNER'")" = true ]; then
    SWAP_STATE=unsettled
    UNSETTLED=("$FIRST_AI_SPEND_ID")
  else
    SWAP_STATE=done
  fi
fi
echo "    swap:      next spend id $NEXT_ID: $(case $SWAP_STATE in fresh) echo "the AI swap is not made yet" ;; unsettled) echo "AI swap $FIRST_AI_SPEND_ID is unsettled" ;; done) echo "AI swap $FIRST_AI_SPEND_ID exists and is settled" ;; esac)"
USDT_BEFORE=$(intents_balance "$USDT")

node --input-type=module -e 'const m = await import(process.argv[1]); m.loadIntentsJwt();' "$REPO/agent/intents-env.mjs" >/dev/null 2>"$WORK/jwt.err" ||
  die "the Message Bus key file is not usable: $(tail -1 "$WORK/jwt.err")"
echo "    bus key:   ~/.config/intatto/intents.env is mode 600 and holds a JWT (not printed)"
[ -n "${NEAR_AI_API_KEY:-}" ] || grep -q '^NEAR_AI_API_KEY=.' "$REPO/agent/.env" 2>/dev/null ||
  die "NEAR_AI_API_KEY is not set (environment or agent/.env); the agent needs it for the decision"
echo "    NEAR AI:   NEAR_AI_API_KEY is set (not printed)"
AGENT_SPEC=$(fc_key_signer "$AGENT" "$INTENTS_VAULT" "$FC_METHODS")
[[ "$AGENT_SPEC" != *"<function-call key"* ]] || die "no function-call key for $AGENT ($FC_METHODS on $INTENTS_VAULT) in $KEYCHAIN/$AGENT"
echo "    agent key: $FC_METHODS on $INTENTS_VAULT, allowance $(helper near "$(live_allowance "$AGENT" "$AGENT_SPEC")") NEAR"

OWNER_HAVE=$(balance_of "$OWNER")
# The fit check plans OWNER's balance as live + FUND (PLANNED_BALANCE), which also makes the lib count
# OWNER's storage as ACCOUNT_RECORD_BYTES: true only while OWNER holds nothing but its one key.
OWNER_STORAGE=$(storage_bytes "$OWNER")
[ "$OWNER_STORAGE" = "$ACCOUNT_RECORD_BYTES" ] || die "$OWNER uses $OWNER_STORAGE bytes, not $ACCOUNT_RECORD_BYTES; the fit check here assumes a plain account"
echo "    balances:  $OWNER $(helper near "$OWNER_HAVE") NEAR, $FUNDER $(helper near "$(balance_of "$FUNDER")") NEAR, $AGENT $(helper near "$(balance_of "$AGENT")") NEAR"
if key_in_keychain "$FUNDER"; then
  echo "    funder:    $FUNDER's key is in $KEYCHAIN"
else
  echo "    funder:    $FUNDER's key is NOT in $KEYCHAIN: --send cannot sign the transfer. Send FUND_NEAR to $OWNER from your wallet instead, then run with FUND_NEAR=0"
fi

# ---- the transactions -------------------------------------------------------------------------------

D_FUND_PREFIX="fund $OWNER from $FUNDER for the AI swap:"
fund_tx() {
  local fees
  fees=$(helper fees "$WORK/protocol.json" transfer)
  # shellcheck disable=SC2086 # $fees is "<send> <exec>"
  tx --fees $fees success "$FUNDER" keychain "$(helper yocto "$1")" 0 "$D_FUND_PREFIX $1 NEAR" \
    tokens "$FUNDER" send-near "$OWNER" "$1 NEAR"
}
wrap_tx() { call_step success "$OWNER" keychain "$WNEAR" near_deposit '{}' "$1" "$OWNER_CALL_TGAS" "wrap $1 NEAR"; }
deposit_tx() {
  call_step success "$OWNER" keychain "$WNEAR" ft_transfer_call \
    "{\"receiver_id\":\"$INTENTS_VAULT\",\"amount\":\"$(helper yocto "$1")\",\"msg\":\"\"}" "$ONE_YOCTO" "$FT_TRANSFER_CALL_TGAS" \
    "deposit $1 wNEAR into $INTENTS_VAULT (credited to $OWNER)"
}
intents_tx() {
  call_step success "$OWNER" keychain "$INTENTS_VAULT" deposit_to_intents \
    "{\"token_id\":\"$WNEAR\",\"amount\":\"$(helper yocto "$1")\"}" "$ONE_YOCTO" "$INTENTS_MOVE_TGAS" \
    "move $1 wNEAR into the vault's account on intents.near (ft_transfer_call as the vault)"
}
# note <description>: a step with no transaction of ours, numbered with the others.
note() {
  STEP_NO=$((STEP_NO + 1))
  [ "$PHASE" != estimate ] || printf '  %2d. %s\n      no transaction from us, no NEAR\n' "$STEP_NO" "$1"
}
# agent_step <method> <args> <TGas> <description>: planned like any other transaction (cost, key
# allowance); agent/intent-swap.mjs sends it, in run_agent. The real agent_intent_swap arguments
# also carry ai_decision (~1 KB), whose per-byte fee (~0.0002 NEAR) the plan does not count.
agent_step() { call_step success "$AGENT" "$AGENT_SPEC" "$INTENTS_VAULT" "$1" "$2" 0 "$3" "$4 (sent by agent/intent-swap.mjs)"; }

# ---- sizing -------------------------------------------------------------------------------------

# owner_need <wNEAR>: what OWNER must hold at once for its three steps, as tx() computes it. Run in
# a subshell, so the plan's totals are untouched.
owner_need() { (PHASE=estimate; { wrap_tx "$1"; deposit_tx "$1"; intents_tx "$1"; } >/dev/null; echo "${SIGNER_NEED[$OWNER]}"); }
transfer_cost() { (PHASE=estimate; fund_tx 0.001 >/dev/null; helper sub "${SIGNER_COST[$FUNDER]}" "$(helper yocto 0.001)"); }

load_costs
if [ -z "$SWAP_WNEAR" ]; then
  [ "$MODE" = dry-run ] || die "--send needs SWAP_WNEAR and FUND_NEAR set to the dry run's figures"
  [ -z "$FUND_NEAR" ] || die "set both SWAP_WNEAR and FUND_NEAR, or neither (the dry run then sizes the swap)"
  if [ "$SWAP_STATE" != fresh ]; then
    SWAP_WNEAR=0 FUND_NEAR=0
  else
    max_out=$(helper sub "$(helper yocto "$FUNDER_MAX_NEAR")" "$(transfer_cost)")
    overhead=$(helper sub "$(owner_need 0.3)" "$(helper yocto 0.3)")
    fits=$(python3 -I -c 'import sys; a, b, c, d = map(int, sys.argv[1:]); print(max(a + b - c - d, 0))' "$OWNER_HAVE" "$max_out" "$overhead" "$(helper yocto "$OWNER_MARGIN")")
    cap=$(python3 -I -c 'import sys; print(min(map(int, sys.argv[1:])))' "$fits" "$ROOM" "$POLICY_CAP")
    SWAP_WNEAR=$(near_floor_cents "$cap")
    [ "$SWAP_WNEAR" != 0.00 ] || die "no swap of 0.01 wNEAR or more fits: room $(helper near "$ROOM"), $OWNER holds $(helper near "$OWNER_HAVE"), $FUNDER may send $(helper near "$max_out")"
    FUND_NEAR=$(near_ceil_milli "$(python3 -I -c 'import sys; a, b, c = map(int, sys.argv[1:]); print(a + c - b)' "$(owner_need "$SWAP_WNEAR")" "$OWNER_HAVE" "$(helper yocto "$OWNER_MARGIN")")")
    echo "    sizing:    $OWNER needs $(helper near "$overhead") NEAR at once beyond the swap (gas spent, gas held, storage), plus a $OWNER_MARGIN NEAR margin."
    echo "               It holds $(helper near "$OWNER_HAVE"); $FUNDER may send $(helper near "$max_out") (its $FUNDER_MAX_NEAR less the transfer fee): $(helper near "$fits") fits;"
    echo "               the policy leaves $(helper near "$ROOM"). Swap $SWAP_WNEAR wNEAR; fund $OWNER with $FUND_NEAR NEAR."
  fi
fi
python3 -I -c 'import sys; from decimal import Decimal; s, f = map(Decimal, sys.argv[1:]); assert s >= 0 and f >= 0' "$SWAP_WNEAR" "$FUND_NEAR" 2>/dev/null ||
  die "SWAP_WNEAR and FUND_NEAR must be NEAR amounts"
SWAP=$(helper yocto "$SWAP_WNEAR")
FUND_YOCTO=$(helper yocto "$FUND_NEAR")
if [ "$SWAP_STATE" = fresh ]; then
  [ "$SWAP" != 0 ] || die "SWAP_WNEAR is 0"
  helper ge "$ROOM" "$SWAP" || die "SWAP_WNEAR $SWAP_WNEAR is over the $(helper near "$ROOM") wNEAR the policy leaves"
fi

# ---- steps ---------------------------------------------------------------------------------------

fund_step() {
  local hash
  hash=$(only_logged prefix "$D_FUND_PREFIX")
  if [ -n "$hash" ]; then
    verify_logged "$hash" "$FUNDER" success "the funding transfer"
    [ "$(helper json "$WORK/logged.json" "v['result']['transaction']['receiver_id'] == '$OWNER' and [int(a['Transfer']['deposit']) for a in v['result']['transaction']['actions']] == [$FUND_YOCTO]")" = true ] ||
      die "the logged transfer $hash is not exactly $FUND_NEAR NEAR to $OWNER; refusing to resume"
    done_step "$FUNDER" "$hash" "$D_FUND_PREFIX $FUND_NEAR NEAR"
  elif [ "$SWAP_STATE" != fresh ]; then
    skip "fund $OWNER (the AI swap exists)"
  elif [ "$FUND_YOCTO" = 0 ]; then
    skip "fund $OWNER from $FUNDER (FUND_NEAR is 0: no transfer in this plan; the fit check below says whether $OWNER holds enough)"
  else
    [ "$PHASE" != send ] || key_in_keychain "$FUNDER" ||
      die "$FUNDER's key is not in $KEYCHAIN: send $FUND_NEAR NEAR to $OWNER from your wallet, then run with FUND_NEAR=0"
    [ "$PHASE" != estimate ] || PLANNED_BALANCE[$OWNER]=$(helper add "$OWNER_HAVE" "$FUND_YOCTO")
    fund_tx "$FUND_NEAR"
  fi
}

owner_steps() {
  if [ "$SWAP_STATE" != fresh ]; then
    skip "wrap $SWAP_WNEAR NEAR, deposit it into the vault and move it to intents.near (the AI swap exists)"
    return 0
  fi
  local in_intents in_vault own
  vault_of_owner
  in_intents=$(intents_balance "$WNEAR")
  in_vault=$(vault_token "$WNEAR")
  if helper ge "$(helper add "$in_intents" "$in_vault")" "$SWAP"; then
    skip "wrap and deposit $SWAP_WNEAR wNEAR (the vault holds it)"
  else
    own=$(ft_balance "$WNEAR" "$OWNER")
    if helper ge "$own" "$SWAP"; then
      skip "wrap $SWAP_WNEAR NEAR ($OWNER holds the wNEAR)"
    else
      wrap_tx "$SWAP_WNEAR"
    fi
    deposit_tx "$SWAP_WNEAR"
  fi
  if helper ge "$in_intents" "$SWAP"; then
    skip "move $SWAP_WNEAR wNEAR to intents.near (the vault's intents account holds it)"
  else
    intents_tx "$SWAP_WNEAR"
  fi
}

swap_steps() {
  case $SWAP_STATE in
  done)
    skip "the AI swap (intent $FIRST_AI_SPEND_ID, settled)"
    ;;
  unsettled)
    if [ "$PHASE" = estimate ]; then
      agent_step settle_intent_swap "{\"intent_id\":\"$FIRST_AI_SPEND_ID\"}" "$SETTLE_TGAS" "settle intent swap $FIRST_AI_SPEND_ID"
    else
      run_agent --settle "$FIRST_AI_SPEND_ID"
    fi
    ;;
  fresh)
    if [ "$PHASE" = estimate ]; then
      note "quote: Message Bus quote for selling exactly $SWAP_WNEAR wNEAR for USDt (agent; off chain)"
      note "the AI decision: NEAR AI Cloud (deepseek-ai/DeepSeek-V4.1-Flash-1017) answers trade or skip; the agent checks its TEE signature receipt, and stops on skip, a bad receipt, or a quote under 3.3 USDt per wNEAR"
      agent_step agent_intent_swap \
        "{\"owner_id\":\"$OWNER\",\"token_in\":\"$WNEAR\",\"token_out\":\"$USDT\",\"amount_in\":\"$SWAP\",\"amount_out\":\"<the live quote>\",\"ai_decision\":\"<request_hash, response_hash, receipt>\"}" \
        "$AGENT_SWAP_TGAS" "agent_intent_swap with ai_decision: sell $SWAP_WNEAR wNEAR for the quote (the vault checks the floor; v1.signer signs)"
      note "publish: Message Bus publish_intent with the signed payload; the relay submits execute_intents to intents.near, signed and paid by intents.near"
      agent_step settle_intent_swap '{"intent_id":"'"$FIRST_AI_SPEND_ID"'"}' "$SETTLE_TGAS" "settle: credit the USDt once intents.near has used the nonce (or refund the wNEAR after the 300 s deadline)"
    else
      run_agent --owner "$OWNER" --token-in "$WNEAR" --token-out "$USDT" --amount-in "$SWAP"
    fi
    ;;
  esac
}

steps() {
  fund_step
  owner_steps
  swap_steps
}

# run_agent <args...>: agent/intent-swap.mjs with the agent's function-call key file (the key never
# passes through argv or the environment; the agent reads the file).
run_agent() {
  local file=${AGENT_SPEC#file:}
  [ -f "$file" ] || die "no key file $file"
  echo "── agent/intent-swap.mjs $*"
  INTENT_AGENT_KEY_FILE=$file node "$AGENT_SCRIPT" --vault "$INTENTS_VAULT" --agent "$AGENT" "$@" ||
    die "agent/intent-swap.mjs failed; its log is in agent/runs/"
}

# The FUNDER limit is part of the fit: --send refuses a plan over it.
after_estimate() {
  local spent=${SIGNER_COST[$FUNDER]:-0}
  if helper ge "$(helper yocto "$FUNDER_MAX_NEAR")" "$spent"; then
    echo "    ok:        $FUNDER sends at most $(helper near "$spent") NEAR in all, within its $FUNDER_MAX_NEAR NEAR limit"
  else
    echo "    OVER:      $FUNDER would send $(helper near "$spent") NEAR, over its $FUNDER_MAX_NEAR NEAR limit"
    FIT=no
  fi
}

# ---- checks after the send ------------------------------------------------------------------------

# agent_record: from the agent's (non-dry) run logs, this swap's transactions and decision, as JSON.
agent_record() {
  python3 -I - "$REPO/agent/runs" "$FIRST_AI_SPEND_ID" <<'PY'
import glob, json, os, sys
runs, intent = sys.argv[1], str(sys.argv[2])
out = {}
for path in sorted(glob.glob(os.path.join(runs, "*-intent-swap.jsonl"))):
    decision = None
    for line in open(path):
        e = json.loads(line)
        if e["kind"] == "ai_decision":
            decision = e
        elif e["kind"] == "agent_intent_swap" and str((e.get("result") or {}).get("intentId")) == intent:
            out.update(swap_tx=e["tx"], log=path, decision=decision and {k: decision.get(k) for k in ("decision", "reason", "request_hash", "response_hash", "verify_url")})
        elif e["kind"] == "get_status" and out.get("log") == path:
            out["relay_status"] = e.get("status")
            out["relay_tx"] = (e.get("data") or {}).get("hash")
        elif e["kind"] == "settle" and any(ev["event"] in ("intent_swap_settled", "intent_swap_refunded") and str(ev["data"]["intent_id"]) == intent for ev in e.get("events", [])):
            out["settle_tx"] = e["tx"]
print(json.dumps(out))
PY
}

swap_checks() {
  agent_record >"$WORK/record.json"
  local swap_tx settle_tx relay_tx
  swap_tx=$(helper json "$WORK/record.json" 'v.get("swap_tx") or ""')
  settle_tx=$(helper json "$WORK/record.json" 'v.get("settle_tx") or ""')
  relay_tx=$(helper json "$WORK/record.json" 'v.get("relay_tx") or ""')
  check "the agent logged agent_intent_swap for intent $FIRST_AI_SPEND_ID" [ -n "$swap_tx" ]
  check "the agent logged settle_intent_swap for intent $FIRST_AI_SPEND_ID" [ -n "$settle_tx" ]
  [ -n "$swap_tx" ] && [ -n "$settle_tx" ] || return 0
  grep -q "^$swap_tx " "$TX_LOG" 2>/dev/null || echo "$swap_tx agent_intent_swap with ai_decision, intent $FIRST_AI_SPEND_ID (agent/intent-swap.mjs)" >>"$TX_LOG"
  grep -q "^$settle_tx " "$TX_LOG" 2>/dev/null || echo "$settle_tx settle_intent_swap $FIRST_AI_SPEND_ID (agent/intent-swap.mjs)" >>"$TX_LOG"

  rpc_archival tx "{\"tx_hash\":\"$swap_tx\",\"sender_account_id\":\"$AGENT\",\"wait_until\":\"FINAL\"}" >"$WORK/swap-tx.json" || die "could not read $swap_tx"
  helper events "$WORK/swap-tx.json" "$INTENTS_VAULT" >"$WORK/swap-events.json" || true
  check "agent_intent_swap $swap_tx: signed by $AGENT" [ "$(helper json "$WORK/swap-tx.json" "v['result']['transaction']['signer_id'] == '$AGENT'")" = true ]
  check "  ...no receipt failed" helper outcome "$WORK/swap-tx.json" "$swap_tx" "$EXPLORER" "$INTENTS_VAULT" success
  check "  ...the vault logged intent_swap_signed" grep -q '"intent_swap_signed"' "$WORK/swap-events.json"
  check "  ...its ai_decision argument is the agent's decision, and its receipt verifies" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const { verifyReceipt } = await import(process.argv[1]);
      const tx = JSON.parse(readFileSync(process.argv[2], "utf8")).result.transaction;
      const logged = JSON.parse(readFileSync(process.argv[3], "utf8")).decision;
      const args = JSON.parse(Buffer.from(tx.actions[0].FunctionCall.args, "base64").toString("utf8"));
      const d = args.ai_decision;
      const same = logged && logged.decision === "trade" && d && d.request_hash === logged.request_hash && d.response_hash === logged.response_hash;
      const check = d ? await verifyReceipt(d.receipt, { requestHash: d.request_hash, responseHash: d.response_hash }) : { ok: false };
      if (!same || !check.ok) { console.error(`ai_decision: ${same ? "matches the log" : "does not match the log"}; receipt ${check.ok ? "verifies" : check.reason}`); process.exit(1); }
    ' "$REPO/agent/ai-decision.mjs" "$WORK/swap-tx.json" "$WORK/record.json"
  rpc_archival tx "{\"tx_hash\":\"$settle_tx\",\"sender_account_id\":\"$AGENT\",\"wait_until\":\"FINAL\"}" >"$WORK/settle-tx.json" || die "could not read $settle_tx"
  helper events "$WORK/settle-tx.json" "$INTENTS_VAULT" >"$WORK/settle-events.json" || true
  settled_by_agent() {
    [ "$(helper json "$WORK/settle-tx.json" "v['result']['transaction']['signer_id'] == '$AGENT'")" = true ] &&
      grep -q '"intent_swap_settled"' "$WORK/settle-events.json"
  }
  check "settle_intent_swap $settle_tx: signed by $AGENT, intent_swap_settled (not refunded)" settled_by_agent
  if [ -n "$relay_tx" ]; then
    rpc_archival tx "{\"tx_hash\":\"$relay_tx\",\"sender_account_id\":\"intents.near\",\"wait_until\":\"FINAL\"}" >"$WORK/relay-tx.json" || die "could not read $relay_tx"
    check "execute_intents $relay_tx (the relay): signed by intents.near, succeeded" helper outcome "$WORK/relay-tx.json" "$relay_tx" "$EXPLORER" none success
  else
    echo "    note:      the relay's get_status reported no transaction hash; find execute_intents on the board or an explorer"
  fi
  local usdt out
  usdt=$(intents_balance "$USDT")
  out=$(grep '"intent_swap_settled"' "$WORK/settle-events.json" | head -1 | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["amount_out"])' 2>/dev/null || echo 0)
  echo "    owner:     $(helper units "$usdt" "$USDT_DECIMALS") USDt in the vault's intents account (+$(helper units "$out" "$USDT_DECIMALS") from this swap)"
  if [ "$SWAP_STATE" = done ]; then
    echo "    note:      the swap was settled by an earlier run; its USDt is in the balance above"
  else
    check "the owner's USDt grew by the settled amount" [ "$(helper add "$USDT_BEFORE" "$out")" = "$usdt" ]
  fi
  check "the settled amount is at least 3.3 USDt per wNEAR" python3 -I -c 'import sys; o, i = map(int, sys.argv[1:]); sys.exit(0 if o * 10**24 >= 3300000 * i else 1)' "$out" "$SWAP"
  view "$INTENTS_VAULT" get_intent_swap "{\"intent_id\":\"$FIRST_AI_SPEND_ID\"}" >"$WORK/after.json"
  check "nothing left unsettled" [ "$(helper json "$WORK/after.json" 'v is None')" = true ]
  vault_of_owner
  check "the owner's policy is unchanged" [ "$(helper json "$WORK/vault.json" "v['policy'] == $POLICY")" = true ]
  echo
  echo "== For the README: agent_intent_swap $swap_tx, settle $settle_tx${relay_tx:+, execute_intents $relay_tx}"
  echo "   Verify link: $(helper json "$WORK/record.json" 'v["decision"]["verify_url"]')"
}

# ---- run -----------------------------------------------------------------------------------------

run_steps "ai-swap $SWAP_WNEAR"
if [ "$MODE" = dry-run ]; then
  echo
  if [ "$FIT" != yes ]; then
    echo "== The plan does not fit (see Fit above): do not send it."
  elif [ "$FUND_YOCTO" = 0 ] || key_in_keychain "$FUNDER"; then
    echo "== To send exactly this plan: SWAP_WNEAR=$SWAP_WNEAR FUND_NEAR=$FUND_NEAR scripts/mainnet-ai-swap.sh --send"
  else
    echo "== To send this plan: $FUNDER's key is not in $KEYCHAIN, so send exactly $FUND_NEAR NEAR to $OWNER from"
    echo "   your wallet first; then run SWAP_WNEAR=$SWAP_WNEAR FUND_NEAR=0 scripts/mainnet-ai-swap.sh (dry run: check the fit), then the same with --send"
  fi
  if [ "$SWAP_STATE" = fresh ]; then
    echo
    echo "== The agent's own dry run (live quote, preflight as if the deposit were made, the AI decision; nothing signed or sent):"
    touch "$WORK/marker"
    run_agent --owner "$OWNER" --token-in "$WNEAR" --token-out "$USDT" --amount-in "$SWAP" --dry-run --assume-balance ||
      die "STOP: the agent's dry run failed (see above); do not send"
    log=$(find "$REPO/agent/runs" -name '*-intent-swap-dry.jsonl' -newer "$WORK/marker" | sort | tail -1)
    [ -n "$log" ] || die "the agent's dry run wrote no log"
    python3 -I - "$log" "$SWAP" <<'PY'
import json, sys
steps = {e["kind"]: e for e in map(json.loads, open(sys.argv[1]))}
best, decision = steps["quotes"]["best"], steps.get("ai_decision") or {}
out, amount_in = int(best["amount_out"]), int(sys.argv[2])
floor_ok = out * 10**24 >= 3300000 * amount_in
print(f"\n== Verdict: quote {out / 1e6:.6f} USDt for {amount_in / 1e24} wNEAR ({out * 10**24 / amount_in / 1e6:.4f} USDt per wNEAR; floor 3.3: {'met' if floor_ok else 'NOT met'})")
print(f"   The model says {decision.get('decision')!r}: {decision.get('reason')}")
print(f"   Receipt (checked by the agent): {decision.get('verify_url')}")
if decision.get("decision") != "trade" or not floor_ok:
    print("   STOP: do not send.")
    sys.exit(1)
print("   A send now would trade, on a fresh quote and a fresh decision.")
PY
  fi
  [ "$FIT" = yes ] || exit 1
  exit 0
fi
swap_checks
echo "== $PASSED passed, $FAILED failed"
echo "Transactions: $TX_LOG"
[ "$FAILED" = 0 ]

exit
}
