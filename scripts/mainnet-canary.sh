#!/usr/bin/env bash
# The mainnet canary, using near-cli-rs 0.30.1: a vault whose agent key is published, holding
# BOUNTY NEAR under a zero-outflow policy (nobody to pay, no pools, no tokens, zero caps), with
# withdrawals locked until LOCK_UNTIL. No call the published key can make should move it; any
# decrease of the canary vault's balances is a break (THREAT_MODEL.md). Dry run by default.
#
#   BOUNTY=5 VAULT_ID=... CANARY_OWNER=... CANARY_AGENT=... FUNDER=... scripts/mainnet-canary.sh [--send]
#
# Steps (each skipped if already done, so a re-run continues where one stopped):
#   1. CANARY_OWNER and CANARY_AGENT are created, paid by FUNDER (the deployer, or any account
#      in the legacy keychain).
#   2. The owner deposits BOUNTY, registers the agent with the zero-outflow policy, and locks
#      withdrawals until LOCK_UNTIL. set_agent comes before the lock, which blocks it.
#   3. The agent gets a function-call key (agent_spend, agent_swap on the vault, FC_ALLOWANCE of
#      gas), saved to the legacy keychain. Publish its private key; never the owner's.
#
# Environment:
#   VAULT_ID, CANARY_OWNER, CANARY_AGENT, FUNDER, BOUNTY (NEAR)    required
#   LOCK_UNTIL          default 2026-11-20T12:00:00Z
#   FC_ALLOWANCE        default 0.25 NEAR. Anyone can spend it on gas with the published key; when
#                       it runs out the key stops working, and the vault is unaffected.
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
CANARY_OWNER=${CANARY_OWNER:-}
CANARY_AGENT=${CANARY_AGENT:-}
FUNDER=${FUNDER:-}
BOUNTY=${BOUNTY:-}
LOCK_UNTIL=${LOCK_UNTIL:-2026-11-20T12:00:00Z}
FC_ALLOWANCE=${FC_ALLOWANCE:-$CANARY_FC_ALLOWANCE_DEFAULT}
FC_METHODS=agent_spend,agent_swap
# The smallest max_spends_per_24h set_agent accepts (1 to 100); with every cap at zero it never
# matters.
POLICY='{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":1,"allowlist":[],"tokens":[],"pools":[]}'

parse_mode "$@"
echo "== Preflight ($MODE)"
require_tools
for var in VAULT_ID CANARY_OWNER CANARY_AGENT FUNDER BOUNTY; do
  [ -n "${!var}" ] || die "set $var"
done
PAYER=$FUNDER
vault_check "$VAULT_ID" "$EXPECTED_CODE_HASH"
LOCK_NS=$(helper utc-ns "$LOCK_UNTIL")
NOW_NS=$(block_time)
echo "    lock:      until $LOCK_UNTIL ($LOCK_NS ns); chain time now $(helper ns-utc "$NOW_NS")"
helper ge "$LOCK_NS" "$(helper add "$NOW_NS" 3600000000000)" || die "LOCK_UNTIL must be at least an hour from now"
echo "    bounty:    $BOUNTY NEAR; agent key allowance $FC_ALLOWANCE NEAR"

vault_of_owner() {
  view "$VAULT_ID" get_vault "{\"owner_id\":\"$CANARY_OWNER\"}" >"$WORK/vault.json"
}

steps() {
  create_account_step "$CANARY_OWNER" "$(helper near "$(canary_owner_yocto "$BOUNTY")")" "$FUNDER"
  create_account_step "$CANARY_AGENT" "$(helper near "$(canary_agent_yocto "$FC_ALLOWANCE")")" "$FUNDER"
  vault_of_owner
  if [ "$(helper json "$WORK/vault.json" 'v is None')" = true ]; then
    call_step success "$CANARY_OWNER" keychain "$VAULT_ID" deposit '{}' "$BOUNTY" 30 "deposit the $BOUNTY NEAR bounty"
  else
    skip "deposit (the vault exists)"
  fi
  if [ "$(helper json "$WORK/vault.json" "v is not None and v['agent_id'] == '$CANARY_AGENT' and v['policy'] == $POLICY")" = true ]; then
    skip "set_agent($CANARY_AGENT, zero-outflow policy)"
  else
    call_step success "$CANARY_OWNER" keychain "$VAULT_ID" set_agent \
      "{\"agent_id\":\"$CANARY_AGENT\",\"policy\":$POLICY}" "$ONE_YOCTO" 30 \
      "set_agent($CANARY_AGENT, zero-outflow policy)"
  fi
  if [ "$(helper json "$WORK/vault.json" "v is not None and int(v.get('withdrawals_locked_until') or 0) >= $LOCK_NS")" = true ]; then
    skip "lock_withdrawals_until($LOCK_UNTIL)"
  else
    call_step success "$CANARY_OWNER" keychain "$VAULT_ID" lock_withdrawals_until \
      "{\"timestamp_ns\":\"$LOCK_NS\"}" "$ONE_YOCTO" 30 \
      "lock_withdrawals_until($LOCK_NS = $LOCK_UNTIL)"
    BASELINE_TX=${LAST_TX_HASH:-}
  fi
  add_fc_key_step "$CANARY_AGENT" "$VAULT_ID" "$FC_METHODS" "$FC_ALLOWANCE"
}

run_steps "$CANARY_OWNER"
[ "$MODE" = send ] || exit 0

vault_of_owner
check "agent is $CANARY_AGENT" [ "$(helper json "$WORK/vault.json" 'v["agent_id"]')" = "$CANARY_AGENT" ]
check "zero-outflow policy" [ "$(helper json "$WORK/vault.json" "v['policy'] == $POLICY")" = true ]
check "not frozen" [ "$(helper json "$WORK/vault.json" 'v["frozen"]')" = false ]
check "locked until $LOCK_UNTIL" [ "$(helper json "$WORK/vault.json" 'v["withdrawals_locked_until"]')" = "$LOCK_NS" ]
SPEC=$(fc_key_signer "$CANARY_AGENT" "$VAULT_ID" "$FC_METHODS")
KEY_FILE=${SPEC#file:}
check "function-call key in the keychain" [ -f "$KEY_FILE" ]
BASELINE=$(helper json "$WORK/vault.json" 'v["balance"]')
echo "== $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ] || die "not publishing a key for a canary that failed its checks"
cat <<EOF

CANARY AGENT KEY, FOR PUBLISHING (CANARY.md, mainnet section)
  account:     $CANARY_AGENT
  key file:    $KEY_FILE   (its private_key is what you publish)
  permission:  FunctionCall on $VAULT_ID, methods $FC_METHODS, allowance $FC_ALLOWANCE NEAR

Baseline for web/src/config/networks.ts (MAINNET.canary):
  ownerId:      $CANARY_OWNER
  agentId:      $CANARY_AGENT
  balanceYocto: $BASELINE
  txHash:       ${BASELINE_TX:-<the lock_withdrawals_until transaction in $TX_LOG>}
EOF

exit
}
