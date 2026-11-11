# Threat model

This covers the vault contract in `src/`, deployed on testnet as `vault-v1.intatto-dev.testnet`
with `exchange_id = ref-finance-101.testnet` (Rhea / Ref V1, ref-exchange 1.9.19). It is a
working document, not an audit.

vault-v1 runs the build without the swap fee (code hash `J5Mo…`). The fee build (invariants 12
and 13) is not deployed yet. It goes to a fresh testnet account, vault-v2, initialized with
`new(exchange_id, treasury_id)`, so vault-v1 and its canary are left as they are.

## What the contract is

One contract holds many owners' vaults. Each vault keeps an owner's NEAR and NEP-141 tokens, and
lets one agent account spend or swap them within a policy only the owner can set. All owners'
funds sit in the same contract account, and all owners' exchange deposits sit in the same
account on the exchange (the vault's). Per-owner balances exist only in the contract's own
bookkeeping.

## Invariants the contract enforces

"Owner" below always means the account calling the method: owner-only methods act on the
caller's own vault and cannot name another one.

1. **Only the owner changes their vault's settings or takes money out.** `set_agent`,
   `remove_agent`, `unfreeze`, `withdraw`, `withdraw_token`, `reclaim_from_exchange` and
   `lock_withdrawals_until` act only on the caller's vault and require exactly 1 yoctoNEAR,
   which a function-call key cannot attach. `freeze` needs no deposit, so any key on the owner's
   account can hit the brakes.
2. **Only the registered agent can make agent calls, and only within the policy.**
   - `agent_spend` sends NEAR only to an allowlisted receiver, at most `per_tx_cap` per call and
     `daily_cap` in any 24-hour window, never more than the vault balance.
   - `agent_swap` trades only through an allowlisted pool, only the pair the owner declared for
     it, at most the token's `per_tx_cap` per swap and `daily_cap` in any 24-hour window.
   - Spends and swaps together are limited to `max_spends_per_24h` in any 24-hour window. The
     window slides exactly: an action counts until it is exactly 24 hours old.
   - A frozen vault rejects every agent call.
3. **Swaps are checked against the exchange's own quote.** The agent's `min_amount_out` must be
   at least the exchange's `get_return` quote less the pool's `max_slippage_bps` (1 to 1000).
   Nothing is deducted until the quote comes back, and the callback that receives it re-runs
   every check in 2 against the vault as it is at that moment. A freeze, policy change or agent
   change made while the quote is in flight therefore applies to that swap.
4. **Money leaves an owner's balance only in these ways:** an owner withdrawal, an agent spend or
   swap allowed by 2 and 3 (whose output is credited less the fixed fee of invariant 12), or
   storage for that owner's own record. Every debit is made before
   the transfer or deposit that sends the money. A failed transfer or swap is credited back
   exactly once, and its spend record is removed so it stops counting toward the limits.
5. **Swap output is credited exactly as reported.** The exchange's `swap` return value is split
   into the owner's `net` and the treasury's `fee`, which add up to it exactly (invariant 12).
   This happens only after the exchange's `withdraw` confirmed delivery to the vault. If the
   withdrawal fails, the whole amount is recorded as the owner's `on_exchange` for them to
   reclaim later, with no fee. It is never credited twice.
6. **Callbacks cannot be called from outside.** Every `on_*` method is `#[private]`: only the
   contract itself can call it.
7. **Tokens are credited only for tokens the owner listed.** `ft_on_transfer` credits the
   sender's vault, and only for a token in the sender's own policy. A token contract can only
   affect the owners who listed it.
8. **Each vault pays for its own storage.** Storage added or freed by changes to an owner's
   record (vault, policy, token entries, spend records, withdrawal lock) is charged to or
   credited back to that owner's NEAR balance, never to other owners. A token's exchange ledger
   entry is shared. The owner whose swap first trades the token pays for it once, and it never
   grows.
9. **The exchange is fixed at init.** `exchange_id` is set once by `new` and cannot be changed.
10. **Withdrawal locks only extend, and also bind the agent.** After
    `lock_withdrawals_until(t)`, `withdraw`, `withdraw_token` and `set_agent` fail for that owner
    until block time reaches `t`. A refused `set_agent` logs `set_agent_rejected`. A later call
    must not set an earlier time. `remove_agent`, `freeze` and `unfreeze` still work, and the
    current agent keeps its current policy.
11. **A reclaim never takes another owner's tokens.**
    - The contract keeps a vault-wide ledger per token: what the vault's account on the exchange
      should hold. That is every owner's `on_exchange`, plus what swaps in flight have sent
      there or received there.
    - Every step of the swap and reclaim flows updates it, with checked arithmetic.
    - `reclaim_from_exchange` first asks the exchange how much the account really holds
      (`get_deposit`). If that is less than the ledger expects, it refuses, logging
      `exchange_shortfall` with both amounts.
    - It also refuses if a swap or reclaim of the token is in flight, or started between the
      query and the check. In that case the balance it read could be stale.
    - Otherwise it withdraws only the caller's own `on_exchange` amount.

12. **The swap fee is fixed in the code and taken only from delivered swap output.**
    - `FEE_BPS = 10` (0.10%) is a compile-time constant. A compile-time assertion keeps it at or
      below `MAX_FEE_BPS = 10`. No method sets or changes it; `get_fee_bps` reports it, and the
      code hash pins it.
    - When a swap's output reaches the vault, the owner is credited `net` and the treasury `fee`,
      with `fee = floor(amount_out × 10 / 10000)` and `net + fee == amount_out` exactly. The math
      cannot overflow for any `u128`, and the callback cannot panic on it. An output below 1000
      units carries no fee.
    - Output left on the exchange (a failed withdrawal, recorded as `on_exchange`) carries no
      fee, and neither does its later reclaim. So the treasury is owed only tokens the vault
      itself holds.
    - Refunded swaps, `agent_spend`, deposits, withdrawals and reclaims carry no fee.
    - `swap_completed` (version 1.1.0) logs `amount_out` (gross), `fee` and `net`. The slippage
      check still compares `min_amount_out` with the exchange's gross quote.
13. **The treasury can only withdraw accrued fees.**
    - `treasury_id` is set once by `new` and cannot be changed. It is stored under its own key
      (`t`), and the fee balances under their own prefix (`f`), outside `Contract` and `Vault`.
    - The fee balances are kept apart from every owner's. Only `withdraw_fees(token_id, amount)`
      moves them, and only to the treasury.
    - `withdraw_fees` can be called only by the treasury account, with exactly 1 yoctoNEAR. It can
      take at most the fees accrued in that token, and never touches an owner's balance.
    - A failed transfer is credited back to the treasury exactly once.
    - The treasury's entry for a token is created when a swap into it is accepted, and paid for
      by that owner, like the token's ledger entry. Callbacks never add storage.

The unit tests in `src/tests.rs` and the sandbox tests in `tests/` check these. The sandbox swap
tests run against the real ref-exchange 1.9.19 binary.

## What counts as a canary break

The canary is the vault of `canary.intatto-dev.testnet` on `vault-v1.intatto-dev.testnet`. Its
agent is `canary-agent.intatto-dev.testnet`, whose function-call key (`agent_spend` and
`agent_swap` on vault-v1 only, 1 NEAR gas allowance) is published. The vault holds 1 NEAR less
its storage, under a zero-outflow policy: empty allowlist, no pools, no tokens, NEAR caps of
zero, and `max_spends_per_24h` of 1, the smallest value allowed. Withdrawals are locked for 30
days. `scripts/canary-testnet.sh` prints the baseline balance at setup.

**A break is any decrease of the canary vault's balances, as returned by
`get_vault("canary.intatto-dev.testnet")`, below the baseline.** That means its `balance`, or the
`balance` or `on_exchange` of any token entry. It is a break no matter who signed the
transaction that caused it.

The canary owner's key signs nothing after setup. While the 30-day lock holds, even that key
cannot take funds out: it cannot withdraw, register an agent or change the policy, and the
current policy pays nobody. A decrease during the lock therefore means a flaw in the contract,
the NEAR runtime or the exchange, or a change of vault-v1's code (which ends the canary, see
below).

After the lock ends, a decrease can also mean a compromise of the canary owner's key. The signer
of the transaction that caused it tells the two apart.

These are not breaks:
- `canary-agent`'s own NEAR going down, or its key's allowance running out. That is gas paid by
  whoever uses the published key.
- `vault-v1`'s account balance changing. It holds every vault and earns gas rewards.
- Increases of the canary's balances.

**The canary ends, rather than breaks, if `vault-v1`'s code hash changes.** It only tests the
code that was deployed when it was set up.

The canary tests whether anyone holding the agent key, or any other account, can reduce another
owner's vault. It does not exercise swaps that are allowed to happen, token deposits, or the
exchange beyond rejected calls.

## Trust assumptions

- **NEAR runtime.** We rely on the protocol for several things:
  - `predecessor_account_id` is the real caller;
  - function-call keys are limited to their receiver and methods, and cannot attach deposits;
  - a failed transfer's NEAR comes back to the contract;
  - a panicking receipt reverts its state changes;
  - callbacks run with the results of the promises they follow;
  - block timestamps are close enough to real time for 24-hour windows and locks.
- **The exchange contract** (`ref-finance-101.testnet`). The vault credits the amounts the
  exchange reports from `swap` and `withdraw`, and keeps owners' tokens in the vault's account
  on the exchange between steps. An exchange that reported false amounts could make the vault
  credit balances backed by other owners' tokens.
  - The exchange's owner (`metadata().owner`, `reflabs.sputnikv2.testnet` on testnet) can
    replace its code through its `upgrade` method.
  - The owner or its guardians can pause it (`change_state`) or freeze tokens
    (`extend_frozenlist_tokens`). Pausing or freezing makes swaps refund and withdrawals from the
    exchange fail, which leaves amounts recorded as `on_exchange` until it resumes.
  - On testnet the exchange account also has full-access keys, whose holders can deploy any
    code. The integration was checked
  against ref-exchange 1.9.19; the smoke scripts refuse to run if the exchange's code hash
  changes.
- **The mainnet exchange's blacklist** (`v2.ref-finance.near`, ref-exchange 1.9.21). Its owner
  (`ref-finance.sputnik-dao.near`) appoints blacklist managers, and a manager can blacklist any
  account. On 2026-11-09 the one manager was `blockdexuser.near`, and 174 accounts were
  blacklisted. If the vault's account is blacklisted, the exchange refuses its deposits, so every
  owner's swap is refunded at the deposit step, and refuses its withdrawals. Output already on
  the exchange then stays recorded as `on_exchange` and cannot be reclaimed until the vault is
  removed from the list. Nothing is lost or misattributed. Both cases run against the real 1.9.21
  binary in `tests/swap.rs` (`blacklisted_vault_on_1_9_21_*`).
- **Token contracts an owner lists.** These are trusted as NEP-141 implementations by that
  owner only. A dishonest token can fake deposits or withdrawals of itself, for the owners who
  listed it.
- **The owner's key.** A full-access key on the owner's account controls the vault completely
  when no withdrawal lock is in force: it can withdraw everything, or register an agent it
  controls with a permissive policy and spend the vault through it. While a lock is in force, a
  stolen owner key can do only these:
  - freeze, unfreeze, or remove the agent;
  - extend the lock;
  - add funds (`deposit`, or tokens the policy lists);
  - reclaim its own `on_exchange` amount back into the vault;
  - wait for the lock to end, then do anything.

  It cannot withdraw, register an agent or change the policy. Unfreezing does matter: if the
  current agent's key is also compromised, unfreezing lets that agent spend again within the
  current policy. Freeze is therefore only as strong as the owner key's custody.
- **The vault account's key.** `vault-v1.intatto-dev.testnet` has a full-access key. Whoever
  holds it can deploy any code to the vault account, including code that sends every owner's
  funds anywhere, or delete the account. See the limitations below.

## Chain Signatures intents path (branch `chain-signatures`, live on mainnet)

This section covers code that exists only on the `chain-signatures` branch; master does not depend
on it. It adds a second way for the agent to swap: through NEAR Intents, with the vault's intents
account signed for by the MPC network.

Since 2026-11-11 it runs on mainnet as **`intents.intatto.near`**:
- built from commit `fc23fbc`, code hash `HRkrMN8o…`, by the Reproducible build workflow;
- a separate account from the canary's `vault.intatto.near`, which still runs `3z1W5Sfh…`;
- one real agent intent swap has settled there: 0.3 wNEAR for 1.130742 USDt.

Accounts, results and every transaction are in [CHAIN_SIGNATURES.md](CHAIN_SIGNATURES.md).

**What it adds.** The vault gets one account of its own on the Verifier, intents.near, under
the vault's account id. All owners' intents balances sit in that one account, like their exchange
deposits on Rhea. Per-owner amounts are the vault's bookkeeping (`get_intents_balances`).
- Deposits and withdrawals there use predecessor auth: the vault calls intents.near as itself
  (`ft_transfer_call` to it, `ft_withdraw` from it).
- Intents are authenticated by signature. intents.near executes a NEP-413 payload for the vault's
  account only if it is signed by a key registered for that account. That key is the vault's
  Ed25519 key derived by v1.signer (domain 1) from the vault's account id and the fixed path
  `intatto/intents.near/v1`. Only a `sign` request whose predecessor is the vault's account can
  produce a signature under it. That means a call made by the vault contract, or, while the
  account keeps a full-access key, a transaction signed with that key (see the trust assumptions
  below).

### Invariants (intents path)

14. **The Verifier and signer are fixed once.** `setup_intents(intents_id, signer_id)` can be
    called only by the vault account itself (`#[private]`, i.e. its full-access key) and only
    once. Nothing changes them afterwards.
15. **The vault's intents account has exactly one key, and it is the MPC-derived one.**
    - `register_intents_key` reads the key from the signer's
      `derived_public_key(path, vault, 1)` in a callback, then registers it with
      `add_public_key`.
    - It then reads `public_keys_of(vault)` and records `key_verified` only if that is exactly
      the derived key.
    - The stored key never changes: if the signer later derives a different one, registering
      again fails.
    - Anyone can re-run the check (`verify_intents_key`). If another key ever appears on the
      vault's account, the check fails and agent intent swaps stop until the key set is right
      again (`an_extra_key_on_the_verifier_fails_the_key_check`).
16. **Moving tokens to and from the intents account touches only the caller's own amounts.**
    - `deposit_to_intents` and `withdraw_from_intents` act on the caller's vault and need
      exactly 1 yoctoNEAR (full-access key only).
    - Each debits before its promise. The tokens stay in the vault's custody, so neither is
      blocked by freeze or a withdrawal lock.
    - If the Verifier keeps less than was sent, or delivers less than was asked, the
      difference goes back exactly once: to the vault balance for a deposit, to the intents
      balance for a withdrawal, where intents.near re-credits the vault's account
      (`a_paused_verifier_refunds_deposits_and_withdrawals`).
    - Balance entries are created by the call that starts a flow and paid for by that owner,
      so callbacks never add storage.
17. **The agent's intent swaps stay inside the owner's rules, and the vault signs only what it
    built.**
    - `agent_intent_swap(owner, token_in, token_out, amount_in, amount_out)` is open only to the
      registered agent. It needs a verified intents key (15), a pair and direction the owner
      listed with `set_intent_policy`, and `amount_out / amount_in` at or above that pair's
      floor (compared exactly in 256 bits).
    - `amount_in` must be within token_in's `per_tx_cap` and `daily_cap` in `Policy::tokens`.
      It shares the 24-hour window and `max_spends_per_24h` with spends and Rhea swaps, and
      must not exceed the owner's intents balance.
    - A frozen vault rejects it. `set_intent_policy` needs 1 yoctoNEAR and is refused while
      withdrawals are locked; `remove_agent` clears the intent policy.
    - Every check runs twice: at the call, and again in the callback that receives
      intents.near's salt, against the vault as it is then. Only then is `amount_in` reserved
      (debited from the owner's intents balance) and the swap recorded.
    - The agent supplies no bytes. The vault writes the NEP-413 message itself:
      `signer_id` = the vault, `deadline` = now + 300 s (whole seconds), and exactly one
      `token_diff` of `-amount_in` token_in and `+amount_out` token_out. It also writes the
      versioned nonce: intents.near's current salt, a nonce deadline 30 days after the intent's,
      and the swap id. It asks v1.signer to sign SHA-256 of the NEP-413 envelope
      (recipient = the Verifier).
    - The answer is stored and logged (`intent_swap_signed`, with the full `MultiPayload`) only
      if it verifies under the vault's registered key over exactly that hash. A timeout, a
      failure, another scheme, or a signature by any other key returns `amount_in` and removes
      the spend record. The callback never panics on the answer.
    - The record is fixed-size from the start, and its storage and the signer's 1-yoctoNEAR
      deposit are charged to that owner.
18. **Settlement credits what happened, once, and never guesses.** intents.near executes a
    `token_diff` exactly or not at all. `settle_intent_swap` (anyone, any time after signing)
    asks `is_nonce_used(vault, nonce)`:
    - **Used:** the owner is credited exactly `amount_out` and the record is deleted. Racing
      settlements credit once (`intent_swap_is_signed_executed_and_settled_exactly_once`).
    - **Unused before the deadline:** refused; nothing changes.
    - **Unused, asked after the deadline:** the vault then asks `is_valid_salt`. It refunds
      `amount_in` only if the salt is still valid and the nonce's own deadline has not passed.
      Only then can "unused" not be a used nonce that governance cleaned up: `cleanup_nonces`
      only removes nonces whose salt is invalid or whose deadline passed, and an invalidated salt
      never becomes valid again.
    - **Otherwise:** unresolved (`intent_swap_unresolved`). `amount_in` stays reserved and
      nothing is credited. `a_cleaned_up_nonce_is_never_mistaken_for_an_unexecuted_intent`
      executes a swap, then has the sandbox DAO invalidate the salt and clean the nonce. Then
      `is_nonce_used` is false, and settlement still refuses to refund.

**Upgrade compatibility.** Everything the intents path stores lives under its own keys: the
config (`i`), intents balances (`n`), intent policies (`q`) and unsettled swaps (`s`). The Borsh
layouts of `Contract` and `Vault` are unchanged, so this build can replace master's code (the
reproducible build `3z1W5Sfh…`) over its state without a migration.
`master_3z1w5_state_survives_the_intents_upgrade` checks that every view reads back unchanged
and that spend ids continue, then runs an intent swap on the upgraded vault.

### Trust assumptions (intents path)

All of these were read from mainnet on 2026-11-11 (blocks around 224,083,600 to 224,086,400).

- **The MPC network (`v1.signer`).** near/mpc 3.18.0, built from `e691bdb`
  (`contract_source_metadata`). The protocol state is Running with **16 participants and a
  threshold of 11**, and domain 1 is Ed25519 (FROST) with reconstruction threshold 11.
  - **Safety:** any 11 participants together can sign anything under the vault's derived key.
    That includes intents that move every owner's tokens out of the vault's intents account. The
    vault cannot limit what the MPC network signs; it can only limit what it asks for. Treat
    the intents balance as held jointly by the vault and the MPC network.
  - **Liveness:** if 6 or more participants are down or refuse, nothing gets signed. Agent intent
    swaps then fail and are refunded after the protocol's yield timeout (200 blocks). Deposits and
    withdrawals use predecessor auth, not signatures, so they still work.
  - **Upgrades:** v1.signer has no full-access key. Its code and config change by a
    governance-threshold vote of the current participants (`vote_contract_update`), so the same
    11-of-16 can replace the code, or turn off new requests (`accept_requests`, for example
    after a failed TEE attestation). New requests then fail, which the vault treats as a failed
    signature.
- **intents.near governance.** defuse 0.4.5, code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`,
  built from near/intents `16d04f6`. The account has no full-access key (9 function-call keys:
  relayer keys).
  - **Who holds roles.** Super admins are `intents.sputnik-dao.near` and `intents.near` itself.
    The DAO role is held by `intents.sputnik-dao.near` and Upgrader by `ctl-intents.near`.
    PauseManager is held by `pm.bridge.near` and 6 implicit accounts, UnrestrictedAccountLocker
    by 2 implicit accounts, and RelayerKeysManager by `relay-key-manager.near`. SaltManager,
    GarbageCollector, FeesManager, UnrestrictedWithdrawer, UnrestrictedAccountManager and
    UnpauseManager had no grantees. The DAO can do all of those itself, and super admins can
    grant any role.
  - **What they can do to the vault's account there:**
    - Replace the contract's code: `upgrade` (DAO, Upgrader). That can do anything to any balance.
    - Run arbitrary calls and transfers as intents.near (`admin_call`, DAO), or add a full-access
      key to it (`add_full_access_key`, DAO).
    - Withdraw any account's tokens to anyone (`ft_force_withdraw` and the other force
      withdrawals; DAO, UnrestrictedWithdrawer).
    - Lock the vault's account (`force_lock_account`; DAO, UnrestrictedAccountLocker). Deposits
      still arrive, but withdrawals and intents by the vault fail.
    - Turn off the vault's predecessor auth (`force_disable_auth_by_predecessor_ids`). Deposits
      and withdrawals by the vault then fail.
    - Pause the contract (PauseManager). Deposits are refunded to the vault balance and
      withdrawals to the intents balance (tested).
    - Rotate or invalidate nonce salts (`update_current_salt`, `invalidate_salts`; DAO,
      SaltManager), and clean up nonces whose salt is invalid or whose deadline passed
      (`cleanup_nonces`; DAO, GarbageCollector). Settlement depends on this; see the intent swap
      invariants.
    - Change the protocol fee (DAO, FeesManager). It is charged on the selling side of a
      `token_diff` and collected from the counterparty, so the vault's own deltas stay exact.
  - `force_add_public_keys` exists in the source but only in the `far` build, not in
    intents.near's.
- **`intents.intatto.near` still holds its own full-access key:**
  `ed25519:B6J5YQj4MdZz2NYu91ybZnJyrhdKAgJGptZxUcQ4WrcA`, the account's only key (read on mainnet
  2026-11-11, block 224,098,526). Whoever holds it acts as the vault account itself, outside every
  check this contract makes, and needs no new code to do so:
  - **It can sign intents outside the policy.** It can call `v1.signer`'s `sign` directly, as
    `intents.intatto.near` with path `intatto/intents.near/v1`, and get any NEP-413 payload
    signed under the vault's registered key. That is any intent for the vault's intents account:
    a `transfer` or `ft_withdraw` of every owner's balance there, any `token_diff` at any price,
    `add_public_key`. No pair allowlist, cap, floor, 24-hour window or 300 s deadline applies.
    The vault's own checks (invariants 17 and 18) bind only intents the contract asks for.
  - **It can move the vault's intents balances directly.** It can call intents.near as the vault
    through predecessor auth: `ft_withdraw` to any receiver, `add_public_key`,
    `disable_auth_by_predecessor_id`.
  - **It can replace or delete the vault,** as on every deployment: deploy other code to the
    vault account, or delete it.

  The operator holds this key offline. It signed only the setup steps (deploy, `setup_intents`,
  `register_intents_key`, the vault's two token registrations).

  Removing it ("locking" the account) is the post-hackathon step. It makes the code permanent,
  with the trade-offs under Known limitations: no upgrades, so no fixes and no recovery of stuck
  amounts. Until then, every guarantee of the intents vault holds only as far as the operator's
  custody of that key.

### Known limitations (intents path)

- **A signed intent cannot be recalled.** Freeze, `remove_agent` and a policy change stop new
  intent swaps, but a payload already signed stays valid on intents.near until its deadline,
  at most 300 s after it was accepted. Anyone who sees the `intent_swap_signed` log can submit
  it in that time. It can only execute as signed: exactly `amount_in` for exactly `amount_out`,
  at or above the owner's floor.
- **An unresolved swap stays reserved.** If intents.near governance invalidates the salt, or
  nobody settles within 30 days after the deadline, settlement cannot tell executed from not
  executed. The reserved `amount_in` then stays reserved for good: it is never credited to
  anyone, but the owner cannot use it without a code upgrade.
- **The price floor is the owner's, not the market's: a floor, not a target.**
  - The vault checks `amount_out` against the owner's floor only; nothing on chain compares it
    with a market price. A careless or compromised agent can sell at the floor, and the caps
    bound how much it can sell that way.
  - On mainnet, `intents-owner.intatto.near`'s floor is **3.3 USDt per wNEAR**. The live swap got
    3.769 because the agent took the best Message Bus quote, not because of the floor. The vault
    would have accepted any `amount_out` down to 3.3 per wNEAR, about 12% below that day's
    market.
  - With the caps (0.3 wNEAR per swap and per 24 hours), a careless or compromised agent could
    lose at most about 0.14 USDt a day at that market.
  - The floor does not follow the market. If the price falls below 3.3, intent swaps are
    refused. If it rises, the gap between market and floor, and so the possible loss per swap,
    grows. The owner has to move the floor (`set_intent_policy`) for it to track anything.
- **No protocol fee on intent swaps.** The 10 bps fee (invariant 12) applies to Rhea swaps only.
- **Swaps can be signed but not filled.** Solver quotes come and go. On 2026-11-11 an early
  probe got no wNEAR to USDT quote at 0.01, 0.1 or 1 wNEAR, and a later one did (0.3 wNEAR for
  1.121835 USDT). An intent nobody fills expires and is refunded at settlement.

- **A shortfall in the shared intents account falls on whoever withdraws last.** There is no
  ledger check like the exchange's (invariant 11). If tokens leave the vault's intents account
  outside the vault's flows (governance force-withdrawal, a malicious upgrade, or 11 MPC
  participants), earlier `withdraw_from_intents` calls succeed in full. Later ones fail, and
  their amounts go back to those owners' intents balances.
- **The Message Bus key's role is unverified.** The agent publishes signed intents through the
  Message Bus (`solver-relay-v2.chaindefuser.com`). Its documentation says it needs a Partner
  Portal JWT, and documents access only for KYC'd market-maker keys. The live swap's
  `publish_intent`, sent with our Distribution Channel key, returned OK and the relay settled it.
  But earlier probes found the relay answering `quote`, `publish_intent` and `get_status`
  identically with that key, a malformed key and no key. So whether the key was required, or
  recognized, is still unverified. Nothing on chain depends on it: the relay can only submit what
  the vault signed.

## Frontend

The site in `web/` (served from GitHub Pages) holds no keys and enforces nothing. **Every rule is
enforced by the vault contract on chain;** the page reads state and asks the user's wallet to
sign. A compromised page can show wrong figures or ask the wallet to sign something other than
what it shows, so the wallet's own confirmation, and the chain itself, are what to trust.

What the page does to keep its own part honest:

- Every figure is read over the configured RPC (`test.rpc.fastnear.com` / `rpc.mainnet.fastnear.com`)
  and shown with its source: method, arguments, raw value and block.
- Indexer data (FastNEAR, NearBlocks) only lists transactions. Vault events are parsed only from
  receipts the vault contract itself executed, so another contract cannot forge them.
- The board verifies the canary's setup transaction and the current run's deployment transaction
  on load (signer, receiver, logged event or deployed code hash) before counting from the later
  of the two.
- Before every signature, a review sheet shows each action's receiver, method, arguments,
  deposit and gas.

### Wallet executors

Wallets connect through near-connect, vendored at NEAR-DevHub/near-connect `f2fc970`
(`web/vendor/near-connect/VENDORED.md`; it replaced `@hot-labs/near-connect` 0.12.0). The page offers four,
from a pinned copy of near-connect's manifest (`web/src/wallet/manifest.pinned.json`, from
manifest 1.1.0, sha256 `a90e85a7…`, 2026-11-09), so a change to the remote manifest cannot add or
swap a wallet. On testnet only Meteor and Intear appear; HOT and MyNearWallet declare mainnet only.

Each wallet's executor, the code that talks to the wallet, is **not** pinned. near-connect
fetches it at connect time from the URL in the manifest, and these URLs are mutable:

| Wallet | Executor URL |
|---|---|
| Meteor | `raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/data-storage/storage/meteor-near-connect-latest.js` |
| Intear | `wallet.intear.tech/near-selector.js` |
| HOT | `raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/hotwallet.js` |
| MyNearWallet | `raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/mnw.js` |

Whoever can change those files can change what runs. near-connect contains them: each executor
runs in an `<iframe sandbox="allow-scripts">` built from `srcdoc`, with no `allow-same-origin`, so
it has an opaque origin and cannot read the page, its storage or its cookies. It talks to the page
only through near-connect's `postMessage` protocol, which lets it open the wallet's windows and
return results. A malicious executor could still lie about a result or ask the wallet to sign a
different transaction, which is why the wallet's own confirmation screen is the last check, and
the contract's policy the real one.

### Content security policy

On Cloudflare Pages (prepared, `web/scripts/pages-deploy.sh`, not deployed) the build also emits
`_headers`: the same policy as a real header, plus `frame-ancestors 'none'`, `X-Frame-Options:
DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a
`Permissions-Policy` that allows WebAuthn on this origin only and turns off camera, microphone,
geolocation, USB, Bluetooth, HID, serial and payment. A static header cannot carry the per-load
nonce, so its `script-src` allows `'self' 'unsafe-inline'`, and the `<meta>` policy below still
requires the nonce: a script must pass both.

GitHub Pages cannot set headers, so the policy is a `<meta>` tag. `boot.js`, the first script on
the page, inserts it together with a nonce that is random on every page load
(`crypto.getRandomValues`, 18 bytes) and never appears in the served HTML. Only `boot.js` runs
before the policy exists.

- **`script-src 'self' 'nonce-…'`.** The executors' `srcdoc` iframes inherit the page's policy,
  and near-connect gives their inline scripts this nonce (`cspNonce`). Injected markup cannot
  know it.
- **`style-src 'self' 'unsafe-inline'`.** near-connect's wallet picker and the executors' documents
  use inline `<style>` without a nonce. The page keeps no secrets in its DOM for CSS to leak.
- **`img-src 'self' data: https://hot-labs.org https://storage.herewallet.app`, `font-src 'self'`.**
  Wallet icons are embedded in the pinned manifest. HOT's executor loads its logo and QR frame
  from those two hosts and shuts itself down (near-connect removes its iframe before the relay
  answers) if they are blocked, so they are allowed; images cannot run script. Measured
  2026-11-11.
- **`frame-src https://wallet.intear.tech`.** Intear's "choose how to connect" page, which its
  executor loads inside its own iframe.
- **`connect-src`.** Exactly these, and nothing else:

| Origin | Why |
|---|---|
| `'self'` | The passkey executor this site serves (`/wallets/passkey-executor-798e9e5.js`) |
| `test.rpc.fastnear.com`, `rpc.mainnet.fastnear.com` | Live view calls and transaction status |
| `archival-rpc.testnet.fastnear.com`, `archival-rpc.mainnet.fastnear.com` | Old transactions only (canary setup and run start) |
| `tx.test.fastnear.com`, `tx.main.fastnear.com` | Transaction lists (FastNEAR, primary) |
| `api-testnet.nearblocks.io`, `api.nearblocks.io` | Transaction lists (NearBlocks, fallback) |
| `raw.githubusercontent.com` | Executor code of Meteor, HOT and MyNearWallet |
| `wallet.intear.tech` | Executor code of Intear |
| `mc.meteorwallet.app` (https and wss) | Meteor Connect bridge: `/api/action`, `/api/bridge/…` and its WebSocket, used for the web-wallet handoff and mobile QR pairing |
| `wss://logout-bridge-service.intear.tech` | Intear's bridge for its App connection method and logout notices |
| `h4n.app` | HOT's relay: the connect or sign request is posted to `/<id>/request` and the wallet's answer polled from `/<id>/response` (QR, app and Telegram connections) |
| `api0.herewallet.app` | HOT's clock (`/api/v1/web/time`), which dates and expires its relay requests |

The wallet entries were measured on testnet on 2026-11-09 (Meteor, Intear) and on mainnet on
2026-11-11 (all four). Each wallet's connect and sign flows were driven to the wallet's own window
or QR code, recording every request the page and the executors made (`web/e2e/harness`, with
`NETWORK=mainnet`); Intear's WebSocket comes from its executor code, since the Web method does not
open it. The HOT and MyNearWallet executors' code (fetched 2026-11-11, sha256 `3139b7ae…` and
`428055ae…`) was also searched for every host it names. `web/e2e/wallets.spec.ts` repeats the
Meteor and Intear flows on testnet and the HOT and MyNearWallet flows on mainnet under the
enforced policy, and fails on any blocked load other than these cosmetic ones, which stay blocked:
Meteor's loader image (`meteorwallet.app`), Meteor's and HOT's font stylesheets (`rsms.me`,
`fonts.cdnfonts.com`) and an inline `data:` font. Their pickers fall back to system fonts. The HOT
test also checks that its QR code stays up and that its relay answers.

- **MyNearWallet** needs nothing beyond its executor's code: it logs in and signs in its own
  window (`app.mynearwallet.com`) and reads the chain through the RPC near-connect hands it (the
  configured one). The fallback RPCs in its code (`c1`/`c2.rpc.fastnear.com`, `*.aurora.dev`,
  `rpc.mainnet.near.org`) are used only when near-connect provides none, which it always does here.
- **HOT** needs its relay and clock above. Its code also names `my.herewallet.app/request`, the
  default endpoint of a QR strategy this executor overrides with the relay, and an RPC helper
  with no caller; neither was contacted.

Limits of this measurement:

- Signing was measured up to the wallet's window; completing it needs a logged-in wallet. Both
  wallets sign and broadcast in their own window and return the result by `postMessage` or the
  bridge above.
- HOT's flows were measured up to its QR code: the request reached the relay and the relay was
  polled. Completing a connection needs the HOT app; its answer comes back through the same relay.
- Meteor's executor defaults to `free.rpc.fastnear.com` for mainnet. It made no RPC call in the
  testnet or mainnet flows (2026-11-11). Asked to sign with no wallet connected, it resolved with
  no transaction and made no request; the page treats a result without a transaction hash as an
  error and signs only with a connected session.

## Known limitations

- **Sandwiching and price manipulation, within the caps.**
  - The slippage check compares the agent's minimum with the pool's own current price. Someone
    who moves that pool's price before the quote makes the quote itself bad, and the check then
    accepts a minimum relative to the bad price.
  - Between the quote and the swap, the price can also move within what `min_amount_out`
    allows.
  - A compromised or careless agent, alone or together with someone moving the price, can
    therefore lose up to the amount it swaps. That is at most the token's `per_tx_cap` per swap
    and its `daily_cap` per 24 hours.
  - The caps bound the loss; they do not prevent it.
- **Freeze cannot recall a sent transfer.** Freeze blocks agent calls from the next one on.
  - A NEAR transfer already sent by `agent_spend` is final.
  - A swap whose quote callback runs after the freeze is rejected.
  - A swap already past its quote (its tokens deposited on the exchange) runs to completion or
    refund.
  - Freeze does not block the owner's withdrawals; a lock does.
- **Exchange lostfound edge case.**
  - When the exchange's transfer of a withdrawal to the vault fails, ref-exchange 1.9.19
    normally puts the tokens back in the vault's exchange account. The vault records them as
    `on_exchange`, and `reclaim_from_exchange` withdraws them again.
  - If the exchange cannot put them back, it moves them to the vault's "lostfound" entry. That
    happens when the account no longer exists, or when the token's slot in it is gone and a new
    slot doesn't fit its storage. If the exchange has 100 NEAR or less free, they go to the
    exchange owner's central lostfound instead.
  - The vault has no `claim_lostfound` call, and `reclaim_from_exchange` withdraws from the
    deposit account, not lostfound. Such tokens stay stuck until the vault's code is upgraded to
    claim them, or, for the central lostfound, until the exchange owner returns them.
  - Before the exchange ledger (invariant 11), the stuck owner's reclaim could draw on tokens
    that another owner had in the shared account, moving the loss onto them. The code deployed
    on vault-v1 today does this, and `v1_lets_one_owner_reclaim_another_owners_tokens` in
    `tests/swap.rs` shows it.
  - With the ledger, a shortfall makes every reclaim of that token refuse instead, including
    reclaims by owners whose own tokens are still there. Their tokens are not taken, but they
    cannot reclaim them until the shortfall is resolved: by an upgrade that claims the lostfound
    tokens, or by the missing tokens coming back to the account.
  - Our own flows cannot reach this path. They withdraw with `unregister: false`, so the slot
    stays, and a failed withdrawal is put back without a storage check. The vault never
    unregisters, and 1.9.20 disables `storage_unregister` altogether.
  - It is reachable by anyone who can act as the vault account on the exchange, which today
    means the vault account's full-access key. `tests/swap.rs` uses that key in the sandbox to
    force tokens into lostfound on the real 1.9.19 binary: one transaction runs
    `withdraw(unregister: true)` followed by `storage_withdraw`.
- **Reclaims wait for quiet.** A reclaim of a token is refused while any swap or reclaim of that
  token is in flight. An agent that swaps a token nonstop can therefore delay other owners'
  reclaims of it. Nothing is lost; the reclaim has to be retried.
- **The ledger only knows what it saw.**
  - Tokens that reach the vault's exchange account outside the vault's own flows (for example
    lostfound tokens returned by the exchange owner) are not credited to anyone. They only make
    the account hold more than expected.
  - Steps the ledger never saw start, such as a swap begun under v1 code and finished after the
    upgrade, make it remove more than it holds. It then clamps at zero and logs
    `exchange_ledger_underflow` rather than fail a settlement callback.
  - vault-v1 held no `on_exchange` amounts and had nothing on the exchange or in lostfound when
    this was written, so an upgrade starts the ledger from a correct zero.
- **The exchange is fixed at init.** Moving to another exchange, or to a changed Rhea V1
  interface, needs a new deployment and every owner moving their funds. If the exchange at
  `exchange_id` is upgraded to behave differently, every owner's swaps are exposed to it.
- **The vault account has a full-access key until it is locked.** While
  `vault-v1.intatto-dev.testnet` has a full-access key (`ed25519:4EEqitkSSjYGSuNk5Ju9Db3AVHWAfHLJPLXWzyAUFF43`
  as of this writing), every owner, and the canary, trusts whoever holds it. Deleting the key
  ("locking" the account) makes the code permanent. Bugs could then not be fixed, and stuck
  amounts such as lostfound could not be recovered by an upgrade. Code upgrades so far keep
  the stored layout unchanged; `tests/upgrade.rs` checks that this build reads state written by
  the deployed v1 code.
- **The withdrawal lock binds the owner key, but not completely.** While locked, the owner key
  cannot withdraw or set a new agent or policy. It can still freeze, unfreeze, remove the agent,
  extend the lock, add funds and reclaim its own exchange amount (see "The owner's key" above).
  The current agent keeps spending and swapping within the current policy, so a lock protects
  the vault only as far as that policy does. There is no upper bound on the lock: a mistaken
  timestamp can block withdrawals and `set_agent` for centuries. Until then the funds can leave
  only through the agent and policy that were in place when it was set.
- **One contract for everyone.** All owners' NEAR and tokens are pooled in one account. Per-owner
  balances are the contract's bookkeeping, so a bookkeeping bug could move value between
  owners.
- **An owner's worst case per swap is the pool's `max_slippage_bps` plus 10 bps.** The slippage
  floor bounds the gross output. The owner then receives that less the 0.10% fee, so at worst
  the floor less 10 bps.
- **Fees on output held on the exchange are not collected.** If the vault is not registered
  with a swap's output token, the output stays on the exchange and is later reclaimed without a
  fee. We register the vault with every token the console offers. An owner who lists another
  token can avoid the fee on it until the vault is registered with that token.
- **A lost treasury key strands the fees.** Nothing can change `treasury_id`. Owner funds are not
  affected.
- **A vault upgraded from code without a treasury has none.** For example, vault-v1 replaced in
  place: fees from later swaps accrue there, but no account can withdraw them, because nothing
  can set a treasury after init. That is why the fee build goes to a fresh vault-v2.
- **Rejected agent calls cost the agent gas, nothing else.** Anyone with the agent key can make
  the agent pay gas for rejected calls, up to the key's allowance.

## Passkey sign-in (planned, mainnet only, experimental)

Built, not deployed (the site is not on Cloudflare Pages yet). The console labels the passkey
path **"Experimental: unaudited wallet contract, upgradeable by Trezu; small amounts only."**, in
a banner and in the wallet menu, and recommends a withdrawal lock. Code: `web/src/wallet/passkey.ts`.

How it works: a passkey account is a deterministic `0s…` account (NEP-616). It runs a WebAuthn
wallet contract, deployed as a global contract by account id (NEP-591):
`p256-passkey-wallet-contract.trezu.near` or `ed25519-passkey-wallet-contract.trezu.near`.
The passkey's public key determines the account id. The executor
([near-connect-passkey](https://github.com/NEAR-DevHub/near-connect-passkey)) signs each request
with WebAuthn. Trezu's sponsor contract `helper.trezu.near` creates the account and relays the
call, through a public function-call key, so the owner never holds a NEAR key. We run no relayer
of our own.

Trust and risks:

- **Trezu can change the code of every passkey wallet.** Each code account holds one full-access
  key (checked on mainnet, 2026-11-09). Whoever holds it can redeploy the code for all `0s…`
  wallets that use it. Malicious code could call `withdraw` on our vault as the owner. A
  withdrawal lock (invariant 10) blocks that while it lasts. That is why the console recommends
  a lock for passkey owners.
- **The wallet contract is unaudited.** Its README says: "DO NOT store any significant funds on
  it."
- **Account creation and relaying depend on `helper.trezu.near`.** Its limits are shared by all
  of its users (20 new accounts and 100 relays per 10 minutes when checked), and Trezu can
  change or revoke the public key. If it is unavailable, passkey owners cannot sign. Their funds
  stay in the vault, and an owner with a NEAR wallet is unaffected.
- **Recovery uses the open registry `passkeys-registry.near`.** Clients verify every candidate
  key against the assertion signature, so a wrong entry cannot forge a signature.
- **Passkeys are bound to the site's domain (rpId).** The site moves to `intatto.pages.dev`
  (Cloudflare Pages), production deployments only, previews off. A preview at
  `<hash>.intatto.pages.dev` could claim the same rpId and ask for the same passkeys. Changing
  the domain later strands existing passkeys, so the domain is fixed before launch. Cloudflare
  Pages also lets us set real HTTP security headers (`_headers`), instead of the `<meta>` policy
  GitHub Pages forces.
- **The page runs third-party code.** near-connect is vendored at commit `f2fc970` of the
  `passkeys-20261104` branch, because no release has the WebAuthn bridge yet. Its review and the
  check that its build matches its source are in `web/vendor/near-connect/VENDORED.md`. The
  executor is `passkey-executor.js` at `798e9e5`, rebuilt byte for byte from source and served from
  our own origin (`web/vendor/PASSKEY-EXECUTOR.md`).
- **Only the passkey wallet can use WebAuthn.** The vendored near-connect runs
  `navigator.credentials` in our page for any wallet whose manifest grants `webauthn`, with
  options that wallet chooses. Only the passkey entry has it, and no offered wallet has the
  `walletConnect` or `keepAlive` permissions this build widened (`web/src/wallet/passkey.test.ts`).
  near-connect would also register wallets from a `debug-wallets` storage entry. Its storage
  (`web/src/wallet/connectorStorage.ts`) never returns that key.
- **A cancelled prompt in another language shows as an error.** The executor's messages are
  localized, and only English "cancelled" is recognised as a rejection. Nothing is sent either way.
- **Several transactions run concurrently.** The wallet contract runs the promises of one request
  concurrently, not in order. The passkey adapter therefore submits a multi-transaction plan one
  transaction at a time, waiting for each to finish. Each one needs its own passkey prompt.
- **Relayed transactions are signed by the sponsor, not the owner.** The console checks a
  relayed transaction by its signer (`helper.trezu.near`) and by a receipt from the owner's
  `0s…` account on the vault.
- **The account must hold NEAR before it deposits.** The sponsor pays the gas, but a deposit is
  the account's own NEAR. The console refuses a deposit the account cannot cover and says where
  to send NEAR (`fundingBlocker` in `web/src/console/intents.ts`).
- **Testing:** there is no testnet deployment of the wallet contracts, the registry or the
  sponsor. The adapter is tested with recorded mainnet transactions relayed by
  `helper.trezu.near` (`web/src/test/fixtures/rpc-tx-status-relayed-*.json`) and fakes, then a
  mainnet canary with tiny amounts.
