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
# Environment:
#   DEPLOYER            implicit account from `keygen` (key file in ~/.near-credentials/mainnet)
#   VAULT_ID            the vault account, e.g. vault.intatto.near (required)
#   ROOT_ACCOUNT        optional parent of VAULT_ID, created first
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
# Storage the vault's exchange account needs: the account plus its wNEAR and USDt slots
# (storage_balance_bounds().min is 0.00102 NEAR; 0.01 NEAR leaves room, as on testnet).
EXCHANGE_STORAGE=0.01
TOKEN_STORAGE=0.00125 # storage_balance_bounds().min of wrap.near and usdt.tether-token.near
# On top of code storage: the account record, its key, the contract's own state, and gas.
VAULT_MARGIN=0.1

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

steps() {
  if [ -n "$ROOT_ACCOUNT" ]; then
    local root_funding
    root_funding=$(helper near "$(helper add "$(helper yocto "$VAULT_FUNDING")" "$(helper yocto 0.1)")")
    create_account_step "$ROOT_ACCOUNT" "$root_funding" "$DEPLOYER"
    create_account_step "$VAULT_ID" "$VAULT_FUNDING" "$ROOT_ACCOUNT"
  else
    create_account_step "$VAULT_ID" "$VAULT_FUNDING" "$DEPLOYER"
  fi
  local state code
  state=$(account "$VAULT_ID")
  code=${state#* }
  if [ "$code" = "$EXPECTED_CODE_HASH" ]; then
    skip "deploy $WASM_HASH to $VAULT_ID"
  elif [ "$state" = missing ] || [ "$code" = none ]; then
    tx success "$VAULT_ID" keychain 0 50 "deploy $WASM_HASH to $VAULT_ID with new($INIT_ARGS)" \
      contract deploy "$VAULT_ID" use-file "$WASM" with-init-call new json-args "$INIT_ARGS" \
      prepaid-gas '50 Tgas' attached-deposit '0 NEAR'
  else
    die "$VAULT_ID already runs other code ($code); use a fresh account"
  fi
  register_step "$EXCHANGE" "$EXCHANGE_STORAGE" false
  register_step "$WNEAR" "$TOKEN_STORAGE" true
  register_step "$USDT" "$TOKEN_STORAGE" true
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
