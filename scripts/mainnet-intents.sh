#!/usr/bin/env bash
# The Chain Signatures intents vault on mainnet (branch chain-signatures), using near-cli-rs
# 0.30.1 and scripts/lib/mainnet.sh. Dry run by default: without --send it reads live state, prints
# every transaction it would send, what each signer and key must hold, and sends nothing.
#
#   TREASURY_ID=... WASM=<workflow artifact>/intatto.wasm scripts/mainnet-intents.sh [setup] [--send]
#   ... scripts/mainnet-intents.sh swap [--send]
#   TREASURY_ID=... scripts/mainnet-intents.sh check          the checks only; signs nothing
#
# It deploys only one binary: the Reproducible build workflow's build of BUILD_COMMIT below, with
# exactly the recorded sha256 and code hash. Any other wasm is refused, whatever the environment.
# It never touches vault.intatto.near, the canary's vault, which stays on 3z1W5Sfh...: it refuses
# that account, and any account already running other code.
#
# setup (default). FUNDER (intatto.near) pays for everything; every step is skipped when already
# done, so a run that stops can be run again with the same settings:
#    1. INTENTS_VAULT is created as a sub-account of FUNDER, funded for its code storage, unless it
#       exists. An existing account is resumed only if it is exactly what this plan left: no code,
#       no state, exactly the planned balance; or, after the deploy, exactly the expected code with
#       the expected exchange, treasury and fee. Anything else is refused.
#    2. The build is deployed with new(exchange_id = v2.ref-finance.near, treasury_id = TREASURY_ID).
#    3. OWNER and AGENT are created as sub-accounts of FUNDER (fresh keys in the legacy keychain).
#    4. The vault binds itself to intents.near and v1.signer (setup_intents, once), then registers
#       its MPC-derived key there (register_intents_key: derived_public_key in a callback,
#       add_public_key, then public_keys_of must be exactly that key).
#    5. The vault registers on wrap.near and USDt (to receive withdrawals from intents.near).
#    6. OWNER: deposits VAULT_NEAR, registers AGENT with a policy that moves no NEAR and lets it
#       sell at most SWAP_WNEAR wNEAR per swap and per 24 hours, registers on wrap.near and USDt,
#       wraps SWAP_WNEAR NEAR, moves it into the vault and on into the vault's intents account,
#       and allows wNEAR -> USDt at no less than FLOOR_USDT_PER_WNEAR.
#    7. AGENT gets a function-call key for INTENTS_VAULT, methods agent_intent_swap and
#       settle_intent_swap, FC_ALLOWANCE of gas (saved to the legacy keychain).
#    Checks: code hash, exchange, treasury, fee; intents.near and v1.signer bound; exactly one key
#    on intents.near for the vault, equal to v1.signer's derived_public_key; the policies; the
#    registrations; the agent key; and that vault.intatto.near still runs the canary's code.
#
# check. Only the checks of setup, plus what intents.near holds for the vault against what the
#    owner is credited, and any intent swap left unsettled. Reads only; refuses --send.
#
# swap. AGENT sells SWAP_WNEAR wNEAR for USDt through NEAR Intents with agent/intent-swap.mjs:
#    Message Bus quote, agent_intent_swap (the vault builds the token_diff, v1.signer signs it),
#    publish_intent, get_status, settle_intent_swap. The dry run plans both agent transactions and
#    checks the agent's balance and key allowance against them, then runs the agent's own
#    --dry-run (live quote and preflight; nothing sent). Intent swaps left unsettled by an earlier
#    run are settled first. The Message Bus key is read by the agent from
#    ~/.config/intatto/intents.env (mode 600); this script only checks the file.
#
# Environment:
#   TREASURY_ID          fee treasury, fixed at init (required)
#   WASM                 the workflow's intatto.wasm (required for setup)
#   FUNDER               default intatto.near (legacy keychain); pays for everything
#   INTENTS_VAULT        default intents.intatto.near
#   OWNER, AGENT         default intents-owner.intatto.near, intents-agent.intatto.near
#   SWAP_WNEAR           default 0.3 (solvers quoted 0.2 wNEAR and up on 2026-11-11, not 0.1)
#   FLOOR_USDT_PER_WNEAR default 3.3 (the market was ~3.77 USDt per wNEAR on 2026-11-11)
#   FC_ALLOWANCE         default 1 NEAR (the gas the agent key may buy; it holds no NEAR)
#   DRY_RUN_TOPUP        <account>=<NEAR>: plan as if that top-up had arrived (dry runs only)
# The whole script is one block, so bash parses all of it before running any of it: editing the
# file while a run is in progress cannot change what that run executes (bash otherwise reads a
# script as it goes, and an edit mid-run makes it execute shifted text).
{
set -euo pipefail
shopt -s inherit_errexit
source "$(dirname "${BASH_SOURCE[0]}")/lib/mainnet.sh"

STAGE=setup
case "${1:-}" in
setup | swap | check)
  STAGE=$1
  shift
  ;;
esac

# The only binary this script deploys: the Reproducible build workflow (.github/workflows/
# reproducible-build.yml) run on BUILD_COMMIT. Recorded from the same build run locally in the
# workflow's pinned image (CHAIN_SIGNATURES.md); the workflow's artifact must match it exactly.
# Deliberately not overridable.
readonly BUILD_COMMIT=fc23fbc3abee3d503ecaeb5ced56d315374cdc20
readonly EXPECTED_CODE_HASH=HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC
readonly EXPECTED_SHA256=f41283390697530c7a446a9509dd73269e34e12932a1e76e2ac2895ddf191bd7
readonly EXPECTED_BYTES=394254
# The canary's vault and code, which this script must never touch.
readonly CANARY_VAULT=vault.intatto.near
readonly CANARY_CODE_HASH=3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J
# What the sandbox suite ran against (tests/res/README.md, CHAIN_SIGNATURES.md), read on mainnet
# 2026-11-11: intents.near 0.4.5 from near/intents 16d04f6; v1.signer 3.18.0 from near/mpc e691bdb.
readonly INTENTS=intents.near
readonly INTENTS_CODE_HASH=BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk
readonly MPC_SIGNER=v1.signer
readonly MPC_VERSION=3.18.0
# The vault's key: v1.signer domain 1 (Ed25519), derived from the vault's account and this path
# (src/intents.rs INTENTS_KEY_PATH). The vault sends `sign` 50 TGas (src/intent_swap.rs).
readonly KEY_PATH=intatto/intents.near/v1
readonly KEY_DOMAIN=1
readonly VAULT_SIGN_TGAS=50

TREASURY_ID=${TREASURY_ID:-}
WASM=${WASM:-}
FUNDER=${FUNDER:-intatto.near}
INTENTS_VAULT=${INTENTS_VAULT:-intents.intatto.near}
OWNER=${OWNER:-intents-owner.intatto.near}
AGENT=${AGENT:-intents-agent.intatto.near}
SWAP_WNEAR=${SWAP_WNEAR:-0.3}
FLOOR_USDT_PER_WNEAR=${FLOOR_USDT_PER_WNEAR:-3.3}
FC_ALLOWANCE=${FC_ALLOWANCE:-1}
FC_METHODS=agent_intent_swap,settle_intent_swap

# Prepaid gas, in TGas, for each call: at least what the contract requires (src/intents.rs,
# src/intent_swap.rs), and what agent/intent-swap.mjs attaches for the agent's two calls.
SETUP_TGAS=30
REGISTER_KEY_TGAS=100     # register_intents_key needs 60
INTENTS_MOVE_TGAS=150     # deposit_to_intents: ft_transfer_call to intents.near (50) and callback
AGENT_SWAP_TGAS=150       # agent_intent_swap needs 125; agent/intent-swap.mjs attaches 150
SETTLE_TGAS=100           # settle_intent_swap needs 50; agent/intent-swap.mjs attaches 100
OWNER_CALL_TGAS=30
FT_TRANSFER_CALL_TGAS=100
TOKEN_STORAGE=0.00125     # storage_balance_bounds().min of wrap.near and usdt.tether-token.near
# The owner's NEAR inside the vault: its records' storage (vault, policy, intent policy, intents
# balances, one swap record of ~1 KB while unsettled) and the signer's 1 yoctoNEAR per swap.
VAULT_NEAR=0.1
# On top of the vault's code storage: its account record and key, the contract's own state
# (config, intents keys), its two token registrations, and the gas it must hold at once for
# register_intents_key (100 TGas bought at the purchase price, refunded after).
VAULT_MARGIN=0.25
# The owner's balance beyond the swap and VAULT_NEAR: token registrations, gas spent, and the gas
# it must hold at once for its largest call (deposit_to_intents, 150 TGas at the purchase price).
OWNER_EXTRA=0.3
# The agent's balance: the gas it must hold at once for agent_intent_swap (150 TGas at the purchase
# price), the gas it spends, and its account and key storage.
AGENT_BALANCE=0.35

parse_mode "$@"
echo "== Preflight ($MODE, $STAGE)"
require_tools
[ -n "$TREASURY_ID" ] || die "set TREASURY_ID (the fee treasury, fixed at init)"
[ "$INTENTS_VAULT" != "$CANARY_VAULT" ] || die "INTENTS_VAULT is the canary's vault; this script never touches $CANARY_VAULT"
for id in INTENTS_VAULT OWNER AGENT; do
  [[ "${!id}" == *".$FUNDER" ]] || die "$id (${!id}) must be a sub-account of FUNDER ($FUNDER)"
done
[ "$INTENTS_VAULT" != "$OWNER" ] && [ "$INTENTS_VAULT" != "$AGENT" ] && [ "$OWNER" != "$AGENT" ] ||
  die "INTENTS_VAULT, OWNER and AGENT must be three different accounts"
key_in_keychain() { [ -f "$KEYCHAIN/$1.json" ] || [ -d "$KEYCHAIN/$1" ]; }
if [ "$MODE" = send ]; then
  key_in_keychain "$FUNDER" || die "no key for $FUNDER in $KEYCHAIN (legacy keychain)"
fi
PAYER=$FUNDER
SWAP=$(helper yocto "$SWAP_WNEAR")
MIN_OUT=$(python3 -I -c 'import sys; from decimal import Decimal; v = Decimal(sys.argv[1]) * 10**int(sys.argv[2]); assert v == v.to_integral_value() and v > 0; print(int(v))' \
  "$FLOOR_USDT_PER_WNEAR" "$USDT_DECIMALS") || die "FLOOR_USDT_PER_WNEAR must be a positive USDt amount with at most $USDT_DECIMALS decimals"

# ---- the counterparties: the exact code the sandbox suite ran against -------------------------

exchange_check
state=$(account "$INTENTS")
echo "    intents:   $INTENTS, code hash ${state#* }, version $(view "$INTENTS" contract_source_metadata '{}' | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
[ "${state#* }" = "$INTENTS_CODE_HASH" ] ||
  die "$INTENTS's code changed (${state#* }, tested $INTENTS_CODE_HASH); rerun the sandbox suite against it first"
printf '%s' "$(view "$MPC_SIGNER" version '{}')" >"$WORK/mpc-version.json"
printf '%s' "$(view "$MPC_SIGNER" config '{}')" >"$WORK/mpc-config.json"
printf '%s' "$(view "$MPC_SIGNER" public_key "{\"domain_id\":$KEY_DOMAIN}")" >"$WORK/mpc-key.json"
mpc_version=$(helper json "$WORK/mpc-version.json" 'v')
mpc_sign_gas=$(helper json "$WORK/mpc-config.json" 'v["sign_call_gas_attachment_requirement_tera_gas"] + v["return_signature_and_clean_state_on_success_call_tera_gas"]')
echo "    signer:    $MPC_SIGNER $mpc_version, domain $KEY_DOMAIN key $(helper json "$WORK/mpc-key.json" 'v'), sign needs $mpc_sign_gas TGas"
[ "$mpc_version" = "$MPC_VERSION" ] || die "$MPC_SIGNER runs $mpc_version, tested $MPC_VERSION; rerun the sandbox suite against it first"
[[ "$(helper json "$WORK/mpc-key.json" 'v')" == ed25519:* ]] || die "$MPC_SIGNER domain $KEY_DOMAIN is not Ed25519"
[ "$mpc_sign_gas" -le "$VAULT_SIGN_TGAS" ] || die "$MPC_SIGNER needs $mpc_sign_gas TGas for sign; the vault sends $VAULT_SIGN_TGAS"
canary=$(account "$CANARY_VAULT")
echo "    canary:    $CANARY_VAULT, code hash ${canary#* } (never touched here)"

# ---- reads --------------------------------------------------------------------------------------

POLICY=$(
  cat <<EOF | tr -d ' \n'
{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":5,"allowlist":[],
"tokens":[{"token_id":"$WNEAR","per_tx_cap":"$SWAP","daily_cap":"$SWAP"},
{"token_id":"$USDT","per_tx_cap":"0","daily_cap":"0"}],"pools":[]}
EOF
)
INTENT_POLICY="{\"pairs\":[{\"token_in\":\"$WNEAR\",\"token_out\":\"$USDT\",\"min_out\":\"$MIN_OUT\",\"per_in\":\"1000000000000000000000000\"}]}"

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
intents_config() { view "$INTENTS_VAULT" get_intents_config '{}' >"$WORK/config.json"; }
agent_key_present() { [[ "$(fc_key_signer "$AGENT" "$INTENTS_VAULT" "$FC_METHODS")" != *"<function-call key"* ]]; }
# next_spend_id: the vault's next spend id, from its root state ("STATE": the Borsh Contract, whose
# layout this build keeps from master: vaults LookupMap prefix "v", next_spend_id u64, exchange_id).
# 0 if the vault has no state yet.
next_spend_id() {
  rpc query "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$INTENTS_VAULT\",\"prefix_base64\":\"U1RBVEU=\"}" \
    >"$WORK/root.json" || die "view_state $INTENTS_VAULT failed"
  python3 -I - "$WORK/root.json" "$EXCHANGE" <<'PY' || die "could not read $INTENTS_VAULT's next spend id from its state"
import base64, json, struct, sys
response = json.load(open(sys.argv[1]))
values = [v for v in (response.get("result") or {}).get("values", []) if base64.b64decode(v["key"]) == b"STATE"]
if not values:
    print(0)
    sys.exit(0)
raw = base64.b64decode(values[0]["value"])
assert raw[:5] == b"\x01\x00\x00\x00v", "unexpected vaults prefix"
(next_id,) = struct.unpack_from("<Q", raw, 5)
(length,) = struct.unpack_from("<I", raw, 13)
assert raw[17:17 + length].decode() == sys.argv[2], "unexpected exchange id"
print(next_id)
PY
}
# unsettled_ids: this owner's intent swaps not settled yet. Intent ids are spend ids, below
# next_spend_id; settled swaps are deleted, so get_intent_swap returns null for them.
unsettled_ids() {
  local id next
  next=$(next_spend_id)
  [ "$next" -le 500 ] || die "$INTENTS_VAULT has $next spend ids; scanning them all is not supported"
  for ((id = 0; id < next; id++)); do
    view "$INTENTS_VAULT" get_intent_swap "{\"intent_id\":\"$id\"}" >"$WORK/swap-$id.json"
    [ "$(helper json "$WORK/swap-$id.json" "v is not None and v['owner_id'] == '$OWNER'")" != true ] || echo "$id"
  done
}
# mt_balance <token>: what intents.near holds of nep141:<token> for the vault's own account there.
mt_balance() { view "$INTENTS" mt_balance_of "{\"account_id\":\"$INTENTS_VAULT\",\"token_id\":\"nep141:$1\"}" | tr -d '"'; }
same_json() { [ "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]) == json.loads(sys.argv[2]))' "$1" "$2")" = True ]; }

# ---- setup ---------------------------------------------------------------------------------------

setup_preflight() {
  [ -n "$WASM" ] || die "set WASM to intatto.wasm from the Reproducible build workflow run on $BUILD_COMMIT"
  [ -f "$WASM" ] || die "$WASM not found"
  WASM_HASH=$(helper file-hash "$WASM")
  WASM_SHA256=$(sha256sum "$WASM" | cut -d' ' -f1)
  WASM_BYTES=$(helper file-size "$WASM")
  echo "    wasm:      $WASM, $WASM_BYTES bytes, code hash $WASM_HASH, sha256 $WASM_SHA256"
  [ "$WASM_HASH" = "$EXPECTED_CODE_HASH" ] && [ "$WASM_SHA256" = "$EXPECTED_SHA256" ] && [ "$WASM_BYTES" = "$EXPECTED_BYTES" ] ||
    die "$WASM is not the recorded build of $BUILD_COMMIT (code hash $EXPECTED_CODE_HASH, sha256 $EXPECTED_SHA256, $EXPECTED_BYTES bytes); use the Reproducible build workflow's artifact for that commit"
  grep -a -q -F "?rev=$BUILD_COMMIT" "$WASM" || die "$WASM's source metadata does not name commit $BUILD_COMMIT"
  local treasury
  treasury=$(account "$TREASURY_ID")
  if [ "$treasury" = missing ]; then
    [ "$MODE" = dry-run ] || die "treasury $TREASURY_ID does not exist"
    echo "    WARNING:   treasury $TREASURY_ID does not exist on $NETWORK"
  else
    echo "    treasury:  $TREASURY_ID exists"
  fi
  rpc EXPERIMENTAL_protocol_config '{"finality":"final"}' >"$WORK/config0.json" || die "protocol config failed"
  local byte_cost code_storage
  byte_cost=$(helper json "$WORK/config0.json" 'v["result"]["runtime_config"]["storage_amount_per_byte"]')
  code_storage=$(helper mul "$WASM_BYTES" "$byte_cost")
  VAULT_FUNDING=$(helper near "$(helper add "$code_storage" "$(helper yocto "$VAULT_MARGIN")")")
  OWNER_FUNDING=$(helper near "$(helper add "$SWAP" "$(helper add "$(helper yocto "$VAULT_NEAR")" "$(helper yocto "$OWNER_EXTRA")")")")
  echo "    funding:   $INTENTS_VAULT $VAULT_FUNDING NEAR (code storage $(helper near "$code_storage") + $VAULT_MARGIN), $OWNER $OWNER_FUNDING NEAR, $AGENT $AGENT_BALANCE NEAR"
  echo "    swap:      $SWAP_WNEAR wNEAR -> USDt at no less than $FLOOR_USDT_PER_WNEAR USDt per wNEAR (min_out $MIN_OUT per 10^24)"
  INIT_ARGS="{\"exchange_id\":\"$EXCHANGE\",\"treasury_id\":\"$TREASURY_ID\"}"
}

# The vault's account: created, resumed only if exactly as this plan left it, then deployed.
vault_steps() {
  local state balance values
  state=$(account "$INTENTS_VAULT")
  if [ "$state" = missing ]; then
    create_account_step "$INTENTS_VAULT" "$VAULT_FUNDING" "$FUNDER"
  elif [ "${state#* }" = none ]; then
    balance=${state%% *}
    rpc query "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$INTENTS_VAULT\",\"prefix_base64\":\"\"}" \
      >"$WORK/state.json" || die "view_state $INTENTS_VAULT failed"
    values=$(helper json "$WORK/state.json" 'len(v["result"]["values"])') || die "could not read the state of $INTENTS_VAULT"
    [ "$values" = 0 ] || die "$INTENTS_VAULT exists with no code but $values state keys; refusing to resume"
    [ "$balance" = "$(helper yocto "$VAULT_FUNDING")" ] ||
      die "$INTENTS_VAULT exists with $(helper near "$balance") NEAR, not the $VAULT_FUNDING NEAR this plan gives it; refusing to resume"
    skip "create $INTENTS_VAULT (exists: no code, no state, $VAULT_FUNDING NEAR as planned)"
  else
    skip "create $INTENTS_VAULT (exists with code; checked next)"
  fi
  local deploy fees
  deploy=$(deploy_state "$INTENTS_VAULT" "$EXPECTED_CODE_HASH" "$EXCHANGE" "$TREASURY_ID" "$FEE_BPS")
  if [ "$deploy" = deploy ]; then
    fees=$(helper fees "$WORK/protocol.json" deploy "$WASM_BYTES" "$((3 + ${#INIT_ARGS}))")
    # shellcheck disable=SC2086 # $fees is "<send> <exec>"
    # Storage: the code, plus what new() writes (~200 bytes).
    tx --fees $fees --storage "$((WASM_BYTES + 1000))" success "$INTENTS_VAULT" keychain 0 50 \
      "deploy $EXPECTED_CODE_HASH (commit ${BUILD_COMMIT:0:7}) to $INTENTS_VAULT with new($INIT_ARGS)" \
      contract deploy "$INTENTS_VAULT" use-file "$WASM" with-init-call new json-args "$INIT_ARGS" \
      prepaid-gas '50 Tgas' attached-deposit '0 NEAR'
  else
    skip "deploy $EXPECTED_CODE_HASH to $INTENTS_VAULT (runs it, with exchange $EXCHANGE, treasury $TREASURY_ID, fee $FEE_BPS bps)"
  fi
}

intents_steps() {
  intents_config
  if [ "$(helper json "$WORK/config.json" 'v is None')" = true ]; then
    call_step success "$INTENTS_VAULT" keychain "$INTENTS_VAULT" setup_intents \
      "{\"intents_id\":\"$INTENTS\",\"signer_id\":\"$MPC_SIGNER\"}" 0 "$SETUP_TGAS" \
      "bind $INTENTS_VAULT to $INTENTS and $MPC_SIGNER (once, for good)"
  else
    [ "$(helper json "$WORK/config.json" "v['intents_id'] == '$INTENTS' and v['signer_id'] == '$MPC_SIGNER'")" = true ] ||
      die "$INTENTS_VAULT is bound to $(helper json "$WORK/config.json" 'v["intents_id"]') / $(helper json "$WORK/config.json" 'v["signer_id"]'), not $INTENTS / $MPC_SIGNER"
    skip "setup_intents ($INTENTS, $MPC_SIGNER)"
  fi
  if [ "$(helper json "$WORK/config.json" 'v is not None and v["key_verified"] and v["public_key"] is not None')" = true ]; then
    skip "register_intents_key ($(helper json "$WORK/config.json" 'v["public_key"]'), verified)"
  else
    call_step success "$INTENTS_VAULT" keychain "$INTENTS_VAULT" register_intents_key '{}' "$ONE_YOCTO" "$REGISTER_KEY_TGAS" \
      "register the vault's key: $MPC_SIGNER derived_public_key($KEY_PATH, $INTENTS_VAULT, $KEY_DOMAIN) on $INTENTS, then check it is the only key"
  fi
  local token
  for token in "$WNEAR" "$USDT"; do
    if registered "$token" "$INTENTS_VAULT"; then
      skip "register $INTENTS_VAULT on $token"
    else
      call_step success "$INTENTS_VAULT" keychain "$token" storage_deposit \
        "{\"account_id\":\"$INTENTS_VAULT\",\"registration_only\":true}" "$TOKEN_STORAGE" "$OWNER_CALL_TGAS" "register $INTENTS_VAULT on $token"
    fi
  done
}

owner_steps() {
  vault_of_owner
  if [ "$(helper json "$WORK/vault.json" 'v is None')" = true ]; then
    call_step success "$OWNER" keychain "$INTENTS_VAULT" deposit '{}' "$VAULT_NEAR" "$OWNER_CALL_TGAS" \
      "$OWNER deposits $VAULT_NEAR NEAR (its records' storage and the signer's deposits)"
  else
    skip "deposit (the owner's vault exists)"
  fi
  if [ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$AGENT' and v['policy'] == $POLICY")" = true ]; then
    skip "set_agent($AGENT)"
  else
    call_step success "$OWNER" keychain "$INTENTS_VAULT" set_agent "{\"agent_id\":\"$AGENT\",\"policy\":$POLICY}" "$ONE_YOCTO" "$OWNER_CALL_TGAS" \
      "set_agent($AGENT): no NEAR out; sell at most $SWAP_WNEAR wNEAR per swap and per 24h"
  fi
  local token
  for token in "$WNEAR" "$USDT"; do
    if registered "$token" "$OWNER"; then
      skip "register $OWNER on $token"
    else
      call_step success "$OWNER" keychain "$token" storage_deposit \
        "{\"account_id\":\"$OWNER\",\"registration_only\":true}" "$TOKEN_STORAGE" "$OWNER_CALL_TGAS" "register $OWNER on $token"
    fi
  done
  local in_intents in_vault own
  in_intents=$(intents_balance "$WNEAR")
  in_vault=$(vault_token "$WNEAR")
  if helper ge "$(helper add "$in_intents" "$in_vault")" "$SWAP"; then
    skip "wrap and deposit $SWAP_WNEAR wNEAR (the vault holds it)"
  else
    own=$(ft_balance "$WNEAR" "$OWNER")
    if helper ge "$own" "$SWAP"; then
      skip "wrap $SWAP_WNEAR NEAR ($OWNER holds the wNEAR)"
    else
      call_step success "$OWNER" keychain "$WNEAR" near_deposit '{}' "$SWAP_WNEAR" "$OWNER_CALL_TGAS" "wrap $SWAP_WNEAR NEAR"
    fi
    call_step success "$OWNER" keychain "$WNEAR" ft_transfer_call \
      "{\"receiver_id\":\"$INTENTS_VAULT\",\"amount\":\"$SWAP\",\"msg\":\"\"}" "$ONE_YOCTO" "$FT_TRANSFER_CALL_TGAS" \
      "deposit $SWAP_WNEAR wNEAR into $INTENTS_VAULT"
  fi
  if helper ge "$in_intents" "$SWAP"; then
    skip "deposit_to_intents ($SWAP_WNEAR wNEAR is in the vault's intents account)"
  else
    call_step success "$OWNER" keychain "$INTENTS_VAULT" deposit_to_intents \
      "{\"token_id\":\"$WNEAR\",\"amount\":\"$SWAP\"}" "$ONE_YOCTO" "$INTENTS_MOVE_TGAS" \
      "move $SWAP_WNEAR wNEAR into the vault's account on $INTENTS (ft_transfer_call as the vault)"
  fi
  view "$INTENTS_VAULT" get_intent_policy "{\"owner_id\":\"$OWNER\"}" >"$WORK/ip.json"
  if same_json "$(cat "$WORK/ip.json")" "$INTENT_POLICY"; then
    skip "set_intent_policy (wNEAR -> USDt at >= $FLOOR_USDT_PER_WNEAR)"
  else
    call_step success "$OWNER" keychain "$INTENTS_VAULT" set_intent_policy "{\"policy\":$INTENT_POLICY}" "$ONE_YOCTO" "$OWNER_CALL_TGAS" \
      "set_intent_policy: wNEAR -> USDt only, at no less than $FLOOR_USDT_PER_WNEAR USDt per wNEAR"
  fi
}

setup_steps() {
  vault_steps
  create_account_step "$OWNER" "$OWNER_FUNDING" "$FUNDER"
  create_account_step "$AGENT" "$AGENT_BALANCE" "$FUNDER"
  intents_steps
  owner_steps
  add_fc_key_step "$AGENT" "$INTENTS_VAULT" "$FC_METHODS" "$FC_ALLOWANCE"
}

setup_checks() {
  local state key derived
  state=$(account "$INTENTS_VAULT")
  if [ "$state" = missing ] || [ "${state#* }" = none ]; then
    [ "$MODE" != send ] || die "$INTENTS_VAULT has no code after the deploy step"
    echo "    (not deployed yet: these checks run after --send)"
    return 0
  fi
  check "code hash is $EXPECTED_CODE_HASH" [ "${state#* }" = "$EXPECTED_CODE_HASH" ]
  check "exchange is $EXCHANGE" [ "$(view "$INTENTS_VAULT" get_exchange_id '{}')" = "\"$EXCHANGE\"" ]
  check "treasury is $TREASURY_ID" [ "$(view "$INTENTS_VAULT" get_treasury_id '{}')" = "\"$TREASURY_ID\"" ]
  check "fee is $FEE_BPS bps" [ "$(view "$INTENTS_VAULT" get_fee_bps '{}')" = "$FEE_BPS" ]
  intents_config
  check "bound to $INTENTS and $MPC_SIGNER" [ "$(helper json "$WORK/config.json" "v is not None and v['intents_id'] == '$INTENTS' and v['signer_id'] == '$MPC_SIGNER'")" = true ]
  check "intents key verified by the vault" [ "$(helper json "$WORK/config.json" 'v is not None and v["key_verified"] == True')" = true ]
  key=$(helper json "$WORK/config.json" 'v["public_key"] if v else None')
  derived=$(view "$MPC_SIGNER" derived_public_key "{\"path\":\"$KEY_PATH\",\"predecessor\":\"$INTENTS_VAULT\",\"domain_id\":$KEY_DOMAIN}" | tr -d '"')
  echo "    key:       vault $key, $MPC_SIGNER derived $derived"
  check "registered key equals $MPC_SIGNER derived_public_key" [ "$key" = "$derived" ]
  view "$INTENTS" public_keys_of "{\"account_id\":\"$INTENTS_VAULT\"}" >"$WORK/keys-on-intents.json"
  echo "    on $INTENTS: $(cat "$WORK/keys-on-intents.json")"
  check "exactly one key on $INTENTS for $INTENTS_VAULT, the derived one" \
    [ "$(helper json "$WORK/keys-on-intents.json" "v == ['$derived']")" = true ]
  vault_of_owner
  check "agent is $AGENT, with the planned policy" [ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$AGENT' and v['policy'] == $POLICY")" = true ]
  view "$INTENTS_VAULT" get_intent_policy "{\"owner_id\":\"$OWNER\"}" >"$WORK/ip.json"
  check "intent policy: wNEAR -> USDt at >= $FLOOR_USDT_PER_WNEAR USDt per wNEAR" same_json "$(cat "$WORK/ip.json")" "$INTENT_POLICY"
  local token who
  for token in "$WNEAR" "$USDT"; do
    for who in "$INTENTS_VAULT" "$OWNER"; do
      check "$who registered on $token" registered "$token" "$who"
    done
  done
  local in_intents usdt mt_wnear mt_usdt unsettled
  in_intents=$(intents_balance "$WNEAR")
  usdt=$(intents_balance "$USDT")
  mt_wnear=$(mt_balance "$WNEAR")
  mt_usdt=$(mt_balance "$USDT")
  unsettled=$(unsettled_ids | wc -w)
  echo "    on $INTENTS: the vault's account holds $(helper near "$mt_wnear") wNEAR ($mt_wnear) and $(helper units "$mt_usdt" "$USDT_DECIMALS") USDt"
  echo "    credited:  $OWNER $(helper near "$in_intents") wNEAR ($in_intents) and $(helper units "$usdt" "$USDT_DECIMALS") USDt; $unsettled intent swap(s) unsettled"
  if [ "$usdt" = 0 ] && [ "$unsettled" = 0 ]; then
    # Before any swap: exactly the owner's deposit, all of it the owner's.
    check "$INTENTS holds exactly $SWAP_WNEAR wNEAR for $INTENTS_VAULT" [ "$mt_wnear" = "$SWAP" ]
    check "all of it credited to $OWNER" [ "$in_intents" = "$SWAP" ]
  else
    check "the vault's wNEAR on $INTENTS covers $OWNER's credit and any reservation" helper ge "$mt_wnear" "$in_intents"
    check "the vault's USDt on $INTENTS covers $OWNER's credit" helper ge "$mt_usdt" "$usdt"
  fi
  check "agent function-call key: $FC_METHODS on $INTENTS_VAULT, in $KEYCHAIN/$AGENT" agent_key_present
  canary=$(account "$CANARY_VAULT")
  check "$CANARY_VAULT still runs the canary's $CANARY_CODE_HASH" [ "${canary#* }" = "$CANARY_CODE_HASH" ]
}

# ---- swap ----------------------------------------------------------------------------------------

AGENT_SCRIPT="$(cd "$LIB_DIR/../.." && pwd)/agent/intent-swap.mjs"

swap_preflight() {
  local state
  state=$(account "$INTENTS_VAULT")
  [ "$state" != missing ] && [ "${state#* }" = "$EXPECTED_CODE_HASH" ] || die "$INTENTS_VAULT does not run $EXPECTED_CODE_HASH; run setup first"
  intents_config
  [ "$(helper json "$WORK/config.json" 'v is not None and v["key_verified"] == True')" = true ] || die "$INTENTS_VAULT's intents key is not verified; run setup first"
  command -v node >/dev/null || die "node is not installed (agent/intent-swap.mjs)"
  node --input-type=module -e 'const m = await import(process.argv[1]); m.loadIntentsJwt();' \
    "$(dirname "$AGENT_SCRIPT")/intents-env.mjs" >/dev/null 2>"$WORK/jwt.err" ||
    die "the Message Bus key file is not usable: $(cat "$WORK/jwt.err" | tail -1)"
  echo "    bus key:   ~/.config/intatto/intents.env is mode 600 and holds a JWT (not printed)"
  AGENT_SPEC=$(fc_key_signer "$AGENT" "$INTENTS_VAULT" "$FC_METHODS")
  if [[ "$AGENT_SPEC" == *"<function-call key"* ]]; then
    [ "$MODE" = dry-run ] || die "no function-call key for $AGENT in $KEYCHAIN/$AGENT; run setup first"
    echo "    WARNING:   $AGENT has no function-call key yet; run setup first"
  fi
  local id
  read -r -a UNSETTLED <<<"$(unsettled_ids | tr '\n' ' ')"
  for id in "${UNSETTLED[@]}"; do
    echo "    unsettled: intent swap $id ($(helper json "$WORK/swap-$id.json" 'v["status"]'), deadline $(helper ns-utc "$(helper json "$WORK/swap-$id.json" 'v["deadline"]')"))"
  done
  IN_INTENTS=$(intents_balance "$WNEAR")
  USDT_IN_INTENTS=$(intents_balance "$USDT")
  echo "    owner:     $(helper near "$IN_INTENTS") wNEAR and $(helper units "$USDT_IN_INTENTS" "$USDT_DECIMALS") USDt in the vault's intents account"
}

# agent_step <method> <args> <TGas> <description>: one agent transaction, planned (cost and key
# allowance) like any other. agent/intent-swap.mjs sends it, in run_agent.
agent_step() {
  call_step success "$AGENT" "$AGENT_SPEC" "$INTENTS_VAULT" "$1" "$2" 0 "$3" "$4 (sent by agent/intent-swap.mjs)"
}

swap_steps() {
  local id
  for id in "${UNSETTLED[@]}"; do
    if [ "$PHASE" = estimate ]; then
      agent_step settle_intent_swap "{\"intent_id\":\"$id\"}" "$SETTLE_TGAS" "settle intent swap $id"
    else
      run_agent --settle "$id"
    fi
  done
  if [ "${#UNSETTLED[@]}" = 0 ] && [ "$USDT_IN_INTENTS" != 0 ] && ! helper ge "$IN_INTENTS" "$SWAP"; then
    skip "intent swap ($OWNER already holds $(helper units "$USDT_IN_INTENTS" "$USDT_DECIMALS") USDt from it)"
    return 0
  fi
  if [ "$PHASE" = estimate ]; then
    agent_step agent_intent_swap \
      "{\"owner_id\":\"$OWNER\",\"token_in\":\"$WNEAR\",\"token_out\":\"$USDT\",\"amount_in\":\"$SWAP\",\"amount_out\":\"<the live quote>\"}" \
      "$AGENT_SWAP_TGAS" "agent_intent_swap: sell $SWAP_WNEAR wNEAR for the Message Bus quote (>= $FLOOR_USDT_PER_WNEAR USDt per wNEAR)"
    agent_step settle_intent_swap '{"intent_id":"<from the swap>"}' "$SETTLE_TGAS" "settle it once the relay reports SETTLED, or after its 300 s deadline"
  else
    run_agent --owner "$OWNER" --token-in "$WNEAR" --token-out "$USDT" --amount-in "$SWAP"
  fi
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

swap_checks() {
  local in_intents usdt
  in_intents=$(intents_balance "$WNEAR")
  usdt=$(intents_balance "$USDT")
  echo "    owner:     $(helper near "$in_intents") wNEAR and $(helper units "$usdt" "$USDT_DECIMALS") USDt in the vault's intents account"
  check "the intent swap settled: $OWNER was credited USDt" [ "$usdt" != 0 ]
  check "no intent swap of $OWNER left unsettled" [ "$(unsettled_ids | wc -w)" = 0 ]
}

# ---- run -----------------------------------------------------------------------------------------

after_estimate() {
  local need state have
  need=${SIGNER_NEED[$FUNDER]:-0}
  state=$(account "$FUNDER")
  have=${state%% *}
  [ "$state" != missing ] || have=0
  echo
  echo "== $FUNDER must hold at once $(helper near "$need") NEAR (it spends at most $(helper near "${SIGNER_COST[$FUNDER]:-0}") NEAR; the rest is gas bought and refunded, and its own storage)"
  if helper ge "$have" "$need"; then
    echo "   It holds $(helper near "$have") NEAR: enough, $(helper near "$(helper sub "$have" "$need")") NEAR to spare."
  else
    echo "   It holds $(helper near "$have") NEAR: send it at least $(helper near "$(helper sub "$need" "$have")") NEAR more."
  fi
}

# Only setup spends FUNDER's NEAR: the other stages neither report nor check it.
if [ "$STAGE" != setup ]; then
  PAYER=
  unset -f after_estimate
fi
if [ "$STAGE" = check ]; then
  [ "$MODE" = dry-run ] || die "check signs nothing; run it without --send"
  echo
  echo "== Checks (reads only; nothing is signed or sent)"
  setup_checks
elif [ "$STAGE" = setup ]; then
  setup_preflight
  steps() { setup_steps; }
  run_steps "$INTENTS_VAULT"
  setup_checks
else
  swap_preflight
  steps() { swap_steps; }
  run_steps "swap $SWAP_WNEAR"
  if [ "$MODE" = dry-run ]; then
    if [[ "$AGENT_SPEC" != *"<function-call key"* ]] && [ "${#UNSETTLED[@]}" = 0 ]; then
      echo
      echo "== The agent's own dry run (live quote and preflight; nothing signed or sent):"
      run_agent --owner "$OWNER" --token-in "$WNEAR" --token-out "$USDT" --amount-in "$SWAP" --dry-run
    fi
    exit 0
  fi
  swap_checks
fi
echo "== $PASSED passed, $FAILED failed"
[ "$MODE" = dry-run ] || echo "Transactions: $TX_LOG"
[ "$FAILED" = 0 ]

exit
}
