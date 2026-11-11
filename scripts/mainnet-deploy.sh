#!/usr/bin/env bash
# Deploys the vault to mainnet, using near-cli-rs 0.30.1. Dry run by default: without --send it
# reads live state, prints every transaction it would send and the total cost, and sends nothing.
#
#   scripts/mainnet-deploy.sh keygen        generate the deployer key locally (an implicit account)
#   scripts/mainnet-deploy.sh               dry run: checks, plan, cost
#   scripts/mainnet-deploy.sh --send        the same, then sign and send after you confirm
#
# Steps:
#   1. VAULT_ID is created and funded for its code storage. If ROOT_ACCOUNT is set (for example
#      intatto.near) and VAULT_ID is its sub-account (vault.intatto.near), ROOT_ACCOUNT is created
#      first and creates VAULT_ID. Otherwise VAULT_ID is created through the `near` registrar.
#      The deployer pays; new full-access keys go to the legacy keychain.
#   2. The reproducible build is deployed with new(exchange_id = v2.ref-finance.near,
#      treasury_id = TREASURY_ID). The script refuses any wasm whose hash is not EXPECTED_CODE_HASH.
#   3. The vault account registers its own storage on the exchange, wrap.near and USDt.
#   4. Checks: code hash, exchange, treasury, fee bps, the three registrations.
#
# Resuming after a failed --send: run the same command again, with the same settings.
#   - Steps 1 and 2 (creating ROOT_ACCOUNT and VAULT_ID) are skipped only if the account already
#     exists with no code (code hash 111...1), no state, and the balance this plan gives it:
#     VAULT_ID exactly its funding; ROOT_ACCOUNT its funding, less VAULT_ID's funding if VAULT_ID
#     exists, less at most RESUME_GAS_SLACK NEAR of gas for the transaction it signed. Anything
#     else (other code, state, another balance, other BOUNTY/SMOKE settings) is refused.
#   - Step 3 (deploy) runs only if VAULT_ID has no code. It is skipped only if VAULT_ID runs
#     exactly EXPECTED_CODE_HASH and its views return exchange EXCHANGE, treasury TREASURY_ID and
#     fee FEE_BPS (deploy_state in lib/mainnet.sh); any other code, or other values, is refused.
#   - ROOT_ACCOUNT's expected funding is what the transaction log of the run that created it says
#     (mainnet-mainnet-deploy-*.txs in the current directory), else this plan's formula.
#   - Steps 4-6 (registrations) are skipped if the registration is already on chain.
#
# Environment:
#   DEPLOYER            implicit account from `keygen` (key file in ~/.near-credentials/mainnet)
#   VAULT_ID            the vault account, e.g. vault.intatto.near (required)
#   ROOT_ACCOUNT        optional parent of VAULT_ID, created first; also funded for the canary
#                       and smoke scripts (run them with FUNDER=ROOT_ACCOUNT)
#   BOUNTY              the canary's bounty to fund ROOT_ACCOUNT for (unset or 0: no canary)
#   SMOKE               1 (default) to fund ROOT_ACCOUNT for the smoke test, 0 not to
#   SENDING             what you plan to send the deployer, checked against the total
#   TREASURY_ID         the only account that can withdraw fees; fixed at init (required)
#   WASM                the reproducible build (default target/near/intatto.wasm; pass it explicitly)
#   EXPECTED_CODE_HASH  default: the reproducible build of commit 6cfa90e
#   EXPECTED_SHA256     the same hash as hex; the wasm must match both
#
# The vault account keeps its full-access key, as vault-v1 does on testnet: whoever holds it can
# replace the code (THREAT_MODEL.md). Keep it offline.
set -euo pipefail
shopt -s inherit_errexit
source "$(dirname "${BASH_SOURCE[0]}")/lib/mainnet.sh"

EXPECTED_CODE_HASH=${EXPECTED_CODE_HASH:-3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J}
# The same hash as hex, for `sha256sum`: base58-decoding 3z1W5Sfh... gives these 32 bytes. Checked
# separately from the helper, so the file must match both.
EXPECTED_SHA256=${EXPECTED_SHA256:-2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5}
# Pass the reproducible build explicitly. target/near/intatto.wasm is overwritten by every local
# `cargo near build` (on 2026-11-11 it held the testnet vault-v2 build, 7aiNbHTn...), which this
# script refuses.
WASM=${WASM:-target/near/intatto.wasm}
VAULT_ID=${VAULT_ID:-}
ROOT_ACCOUNT=${ROOT_ACCOUNT:-}
TREASURY_ID=${TREASURY_ID:-}
DEPLOYER=${DEPLOYER:-}
# With ROOT_ACCOUNT: also fund it for scripts/mainnet-canary.sh (BOUNTY NEAR; unset or 0 for none)
# and scripts/mainnet-smoke.sh (SMOKE=1, the default; 0 for none), both run with
# FUNDER=ROOT_ACCOUNT. Uses those scripts' default allowances and swap size (lib/mainnet.sh).
BOUNTY=${BOUNTY:-}
SMOKE=${SMOKE:-1}
# What you plan to send the deployer, checked against the plan's total (optional).
SENDING=${SENDING:-}
# Left on the deployer after it pays: its own account record and key, with room to spare.
DEPLOYER_KEEP=0.01
# Storage the vault's exchange account needs: the account plus its wNEAR and USDt slots
# (storage_balance_bounds().min is 0.00102 NEAR; 0.01 NEAR leaves room, as on testnet).
EXCHANGE_STORAGE=0.01
TOKEN_STORAGE=0.00125 # storage_balance_bounds().min of wrap.near and usdt.tether-token.near
# On top of code storage: the account record, its key, the contract's own state, and gas.
VAULT_MARGIN=0.1
# Resuming: how much less than planned ROOT_ACCOUNT may hold, for the gas of the one transaction it
# signs (creating VAULT_ID). On 2026-11-11 that transaction (BXYjPyR5...) cost 0.007115 NEAR.
RESUME_GAS_SLACK=0.01

if [ "${1:-}" = keygen ]; then
  require_tools
  mkdir -p "$KEYCHAIN"
  before=$(ls "$KEYCHAIN" 2>/dev/null | sort)
  near_cli account create-account fund-later use-auto-generation save-to-folder "$KEYCHAIN" >"$WORK/keygen.log" 2>&1 ||
    { cat "$WORK/keygen.log"; die "keygen failed"; }
  after=$(ls "$KEYCHAIN" | sort)
  new=$(comm -13 <(echo "$before") <(echo "$after") | grep -E '^[0-9a-f]{64}\.json$' || true)
  [ -n "$new" ] || { cat "$WORK/keygen.log"; die "no new implicit account key file in $KEYCHAIN"; }
  chmod 600 "$KEYCHAIN/$new"
  id=${new%.json}
  echo "Deployer (implicit account): $id"
  echo "Key file: $KEYCHAIN/$new (mode 600; back it up offline, never commit it)"
  echo "It exists on chain once you send it NEAR. Run the dry run to see how much:"
  echo "  DEPLOYER=$id VAULT_ID=<vault account> TREASURY_ID=<treasury> scripts/mainnet-deploy.sh"
  exit 0
fi

parse_mode "$@"
echo "== Preflight ($MODE)"
require_tools
[ -n "$VAULT_ID" ] || die "set VAULT_ID"
[ -n "$TREASURY_ID" ] || die "set TREASURY_ID (your Meteor account)"
if [ -n "$ROOT_ACCOUNT" ]; then
  [[ "$VAULT_ID" == *".$ROOT_ACCOUNT" ]] || die "VAULT_ID must be a sub-account of ROOT_ACCOUNT"
fi
if [ -z "$DEPLOYER" ]; then
  [ "$MODE" = dry-run ] || die "set DEPLOYER (run: scripts/mainnet-deploy.sh keygen)"
  DEPLOYER='<deployer>'
  echo "    deployer:  not set (dry run only)"
else
  [ -f "$KEYCHAIN/$DEPLOYER.json" ] || die "no key file $KEYCHAIN/$DEPLOYER.json"
fi
PAYER=$DEPLOYER
[ -f "$WASM" ] || die "$WASM not found; pass WASM=<path to the reproducible build of 6cfa90e>"
WASM_HASH=$(helper file-hash "$WASM")
WASM_SHA256=$(sha256sum "$WASM" | cut -d' ' -f1)
WASM_BYTES=$(helper file-size "$WASM")
echo "    wasm:      $WASM, $WASM_BYTES bytes, code hash $WASM_HASH, sha256 $WASM_SHA256"
[ "$WASM_HASH" = "$EXPECTED_CODE_HASH" ] && [ "$WASM_SHA256" = "$EXPECTED_SHA256" ] ||
  die "$WASM is not the expected reproducible build (code hash $EXPECTED_CODE_HASH, sha256 $EXPECTED_SHA256); pass WASM=<path> to the output of \`cargo near build reproducible-wasm\` of commit 6cfa90e"
exchange_check
TREASURY_STATE=$(account "$TREASURY_ID")
if [ "$TREASURY_STATE" = missing ]; then
  [ "$MODE" = dry-run ] || die "treasury $TREASURY_ID does not exist"
  echo "    WARNING:   treasury $TREASURY_ID does not exist on $NETWORK"
else
  echo "    treasury:  $TREASURY_ID exists"
fi
rpc EXPERIMENTAL_protocol_config '{"finality":"final"}' >"$WORK/config.json" || die "protocol config failed"
BYTE_COST=$(helper json "$WORK/config.json" 'v["result"]["runtime_config"]["storage_amount_per_byte"]')
CODE_STORAGE=$(helper mul "$WASM_BYTES" "$BYTE_COST")
VAULT_FUNDING=$(helper near "$(helper add "$CODE_STORAGE" "$(helper yocto "$VAULT_MARGIN")")")
echo "    storage:   $BYTE_COST yoctoNEAR per byte; code storage $(helper near "$CODE_STORAGE") NEAR; vault funding $VAULT_FUNDING NEAR"
VAULT_STATE=$(account "$VAULT_ID")
echo "    vault:     $VAULT_ID, $VAULT_STATE"
INIT_ARGS="{\"exchange_id\":\"$EXCHANGE\",\"treasury_id\":\"$TREASURY_ID\"}"

register_step() {
  local contract=$1 deposit=$2 only=$3
  if [ "$(view "$contract" storage_balance_of "{\"account_id\":\"$VAULT_ID\"}")" != null ]; then
    skip "register $VAULT_ID on $contract"
    return 0
  fi
  call_step success "$VAULT_ID" keychain "$contract" storage_deposit \
    "{\"account_id\":\"$VAULT_ID\",\"registration_only\":$only}" "$deposit" 30 \
    "register $VAULT_ID on $contract ($deposit NEAR)"
}

# create_or_resume <account> <funding NEAR> <funder> <expected balance yocto> <slack yocto>: creates
# <account> if it does not exist. If it exists, skips the step only if the account is exactly what
# an earlier run of this plan left: no code, no state, and a balance between <expected> - <slack>
# and <expected>. Anything else stops the script.
create_or_resume() {
  local id=$1 amount=$2 funder=$3 expected=$4 slack=$5
  local state balance code values low
  state=$(account "$id")
  if [ "$state" = missing ]; then
    create_account_step "$id" "$amount" "$funder"
    return 0
  fi
  balance=${state%% *}
  code=${state#* }
  [ "$code" = none ] || die "$id exists and has code ($code); refusing to resume"
  rpc query "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$id\",\"prefix_base64\":\"\"}" \
    >"$WORK/state.json" || die "view_state $id failed"
  values=$(helper json "$WORK/state.json" 'len(v["result"]["values"])') || die "could not read the state of $id"
  [ "$values" = 0 ] || die "$id exists and has $values state keys; refusing to resume"
  low=$(helper sub "$expected" "$slack")
  if ! helper ge "$balance" "$low" || ! helper ge "$expected" "$balance"; then
    if [ "$slack" = 0 ]; then
      die "$id exists and holds $(helper near "$balance") NEAR, not the $(helper near "$expected") NEAR this plan gives it; refusing to resume (same BOUNTY, SMOKE and WASM as the first run?)"
    fi
    die "$id exists and holds $(helper near "$balance") NEAR, outside the $(helper near "$low")-$(helper near "$expected") NEAR this plan leaves it; refusing to resume (same BOUNTY, SMOKE and WASM as the first run?)"
  fi
  skip "create $id (exists: no code, no state, holds $(helper near "$balance") NEAR as planned)"
}

# reserve_yocto: what mainnet-canary.sh and mainnet-smoke.sh will take from ROOT_ACCOUNT as their
# FUNDER, at most: each account's initial balance plus the cost of the transaction creating it
# (create_cost_yocto: fees plus the account creation charge; all four are sub-accounts of it).
reserve_yocto() {
  local total=0 create
  create=$(create_cost_yocto "sub.$ROOT_ACCOUNT" "$ROOT_ACCOUNT")
  if [ -n "$BOUNTY" ] && [ "$BOUNTY" != 0 ]; then
    total=$(helper add "$total" "$(canary_owner_yocto "$BOUNTY")")
    total=$(helper add "$total" "$(canary_agent_yocto "$CANARY_FC_ALLOWANCE_DEFAULT")")
    total=$(helper add "$total" "$(helper mul 2 "$create")")
  fi
  if [ "$SMOKE" = 1 ]; then
    total=$(helper add "$total" "$(smoke_owner_yocto "$SMOKE_SWAP_NEAR_DEFAULT")")
    total=$(helper add "$total" "$(smoke_agent_yocto)")
    total=$(helper add "$total" "$(helper mul 2 "$create")")
  fi
  echo "$total"
}

# logged_funding <account>: the NEAR amount an earlier --send of this script created <account>
# with, from its transaction logs (mainnet-mainnet-deploy-*.txs here), or nothing. Resuming checks
# the account against what it was actually given, which stays right when this plan's formulas
# change.
logged_funding() {
  local logs=() amounts pattern
  for f in mainnet-mainnet-deploy-*.txs; do [ -f "$f" ] && logs+=("$f"); done
  [ "${#logs[@]}" -gt 0 ] || return 0
  pattern="^[1-9A-HJ-NP-Za-km-z]\{43,44\} create ${1//./\\.} with \([0-9.]*\) NEAR .*"
  amounts=$(sed -n "s/$pattern/\1/p" "${logs[@]}" | sort -u)
  [ "$(printf '%s' "$amounts" | grep -c . || true)" -le 1 ] || die "the transaction logs create $1 more than once ($amounts)"
  printf '%s' "$amounts"
}

steps() {
  if [ -n "$ROOT_ACCOUNT" ]; then
    local root_funding reserve root_expected
    reserve=$(reserve_yocto)
    # The vault's funding, 0.1 NEAR for ROOT_ACCOUNT's own record and the gas of creating the vault,
    # and the canary and smoke reserve.
    root_funding=$(helper near "$(helper add "$(helper add "$(helper yocto "$VAULT_FUNDING")" "$(helper yocto 0.1)")" "$reserve")")
    if [ "$PHASE" = estimate ]; then
      echo "    $ROOT_ACCOUNT funding: vault $VAULT_FUNDING + own 0.1 + reserve $(helper near "$reserve") NEAR" \
        "(canary: ${BOUNTY:-0} NEAR bounty; smoke: $([ "$SMOKE" = 1 ] && echo "$SMOKE_SWAP_NEAR_DEFAULT NEAR swap" || echo none))"
    fi
    # What ROOT_ACCOUNT holds if it was created by this plan: its funding (as logged when it was
    # created, if it was), less the vault's once it has created the vault, less the gas of that
    # one transaction (checked by create_or_resume).
    local logged
    logged=$(logged_funding "$ROOT_ACCOUNT")
    if [ "$(account "$ROOT_ACCOUNT")" != missing ] && [ -n "$logged" ]; then
      [ "$PHASE" != estimate ] || echo "    $ROOT_ACCOUNT was created with $logged NEAR (transaction log); checking it against that"
      root_expected=$(helper yocto "$logged")
    else
      root_expected=$(helper yocto "$root_funding")
    fi
    if [ "$(account "$VAULT_ID")" != missing ]; then
      root_expected=$(helper sub "$root_expected" "$(helper yocto "$VAULT_FUNDING")")
    fi
    create_or_resume "$ROOT_ACCOUNT" "$root_funding" "$DEPLOYER" "$root_expected" "$(helper yocto "$RESUME_GAS_SLACK")"
    create_or_resume "$VAULT_ID" "$VAULT_FUNDING" "$ROOT_ACCOUNT" "$(helper yocto "$VAULT_FUNDING")" 0
  else
    create_or_resume "$VAULT_ID" "$VAULT_FUNDING" "$DEPLOYER" "$(helper yocto "$VAULT_FUNDING")" 0
  fi
  local deploy fees
  deploy=$(deploy_state "$VAULT_ID" "$EXPECTED_CODE_HASH" "$EXCHANGE" "$TREASURY_ID" "$FEE_BPS")
  if [ "$deploy" = deploy ]; then
    fees=$(helper fees "$WORK/protocol.json" deploy "$WASM_BYTES" "$((3 + ${#INIT_ARGS}))")
    # shellcheck disable=SC2086 # $fees is "<send> <exec>"
    # Storage: the code, plus what new() writes (the contract struct and the treasury: ~200 bytes).
    tx --fees $fees --storage "$((WASM_BYTES + 1000))" success "$VAULT_ID" keychain 0 50 \
      "deploy $WASM_HASH to $VAULT_ID with new($INIT_ARGS)" \
      contract deploy "$VAULT_ID" use-file "$WASM" with-init-call new json-args "$INIT_ARGS" \
      prepaid-gas '50 Tgas' attached-deposit '0 NEAR'
  else
    skip "deploy $EXPECTED_CODE_HASH to $VAULT_ID (it runs it, with exchange $EXCHANGE, treasury $TREASURY_ID, fee $FEE_BPS bps)"
  fi
  register_step "$EXCHANGE" "$EXCHANGE_STORAGE" false
  register_step "$WNEAR" "$TOKEN_STORAGE" true
  register_step "$USDT" "$TOKEN_STORAGE" true
}

# After the plan's cost: how much to send the deployer, and whether SENDING covers it.
after_estimate() {
  local need
  need=$(helper add "${SIGNER_NEED[$PAYER]:-0}" "$(helper yocto "$DEPLOYER_KEEP")")
  echo "== Send the deployer at least $(helper near "$need") NEAR (the most the plan needs it to hold at once, $(helper near "${SIGNER_NEED[$PAYER]:-0}"), + $DEPLOYER_KEEP left on it)"
  if [ -n "$SENDING" ]; then
    if helper ge "$(helper yocto "$SENDING")" "$need"; then
      echo "   You plan to send $SENDING NEAR: enough, $(helper near "$(helper sub "$(helper yocto "$SENDING")" "$need")") NEAR to spare."
    else
      echo "   WARNING: you plan to send $SENDING NEAR, which is short by $(helper near "$(helper sub "$need" "$(helper yocto "$SENDING")")") NEAR."
    fi
  fi
}

run_steps "$VAULT_ID"

state=$(account "$VAULT_ID")
if [ "$state" = missing ] || [ "${state#* }" = none ]; then
  [ "$MODE" != send ] || die "$VAULT_ID has no code after the deploy step"
  echo "    (not deployed yet: these checks run after --send)"
  exit 0
fi
check "code hash is $EXPECTED_CODE_HASH" [ "${state#* }" = "$EXPECTED_CODE_HASH" ]
check "exchange is $EXCHANGE" [ "$(view "$VAULT_ID" get_exchange_id '{}')" = "\"$EXCHANGE\"" ]
check "treasury is $TREASURY_ID" [ "$(view "$VAULT_ID" get_treasury_id '{}')" = "\"$TREASURY_ID\"" ]
check "fee is $FEE_BPS bps" [ "$(view "$VAULT_ID" get_fee_bps '{}')" = "$FEE_BPS" ]
for contract in "$EXCHANGE" "$WNEAR" "$USDT"; do
  check "registered on $contract" [ "$(view "$contract" storage_balance_of "{\"account_id\":\"$VAULT_ID\"}")" != null ]
done
echo "== $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
