# Threat model

This covers the vault contract in `src/`, deployed on testnet as `vault-v1.intatto-dev.testnet`
with `exchange_id = ref-finance-101.testnet` (Rhea / Ref V1, ref-exchange 1.9.19). It is a
working document, not an audit.

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
   swap allowed by 2 and 3, or storage for that owner's own record. Every debit is made before
   the transfer or deposit that sends the money. A failed transfer or swap is credited back
   exactly once, and its spend record is removed so it stops counting toward the limits.
5. **Swap output is credited exactly as reported.** The owner is credited the amount the
   exchange's `swap` returned, and only after the exchange's `withdraw` confirmed delivery to
   the vault. If the withdrawal fails, the amount is recorded as `on_exchange` for the owner to
   reclaim later; it is never credited twice.
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
  on load (signer, receiver, logged event or deployed code hash) before counting from them.
- Before every signature, a review sheet shows each action's receiver, method, arguments,
  deposit and gas.

### Wallet executors

Wallets connect through near-connect (`@hot-labs/near-connect` 0.12.0). The page offers four,
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

GitHub Pages cannot set headers, so the policy is a `<meta>` tag. `boot.js`, the first script on
the page, inserts it together with a nonce that is random on every page load
(`crypto.getRandomValues`, 18 bytes) and never appears in the served HTML. Only `boot.js` runs
before the policy exists.

- **`script-src 'self' 'nonce-…'`.** The executors' `srcdoc` iframes inherit the page's policy,
  and near-connect gives their inline scripts this nonce (`cspNonce`). Injected markup cannot
  know it.
- **`style-src 'self' 'unsafe-inline'`.** near-connect's wallet picker and the executors' documents
  use inline `<style>` without a nonce. The page keeps no secrets in its DOM for CSS to leak.
- **`img-src 'self' data:`, `font-src 'self'`.** Wallet icons are embedded in the pinned manifest.
- **`frame-src https://wallet.intear.tech`.** Intear's "choose how to connect" page, which its
  executor loads inside its own iframe.
- **`connect-src`.** Exactly these, and nothing else:

| Origin | Why |
|---|---|
| `test.rpc.fastnear.com`, `rpc.mainnet.fastnear.com` | Live view calls and transaction status |
| `archival-rpc.testnet.fastnear.com`, `archival-rpc.mainnet.fastnear.com` | Old transactions only (canary setup and run start) |
| `tx.test.fastnear.com`, `tx.main.fastnear.com` | Transaction lists (FastNEAR, primary) |
| `api-testnet.nearblocks.io`, `api.nearblocks.io` | Transaction lists (NearBlocks, fallback) |
| `raw.githubusercontent.com` | Executor code of Meteor, HOT and MyNearWallet |
| `wallet.intear.tech` | Executor code of Intear |
| `mc.meteorwallet.app` (https and wss) | Meteor Connect bridge: `/api/action`, `/api/bridge/…` and its WebSocket, used for the web-wallet handoff and mobile QR pairing |
| `wss://logout-bridge-service.intear.tech` | Intear's bridge for its App connection method and logout notices |

The wallet entries were measured on testnet on 2026-11-09. The Meteor and Intear connect and sign
flows were driven to the wallet's own window, recording every request the page and the executors
made (`web/e2e/harness`); Intear's WebSocket comes from its executor code, since the Web method
does not open it. `web/e2e/wallets.spec.ts` repeats both flows under the enforced policy and
fails on any blocked load other than these cosmetic ones, which stay blocked: Meteor's loader
image (`meteorwallet.app`), its font stylesheets (`rsms.me`, `fonts.cdnfonts.com`) and an inline
`data:` font. Its picker falls back to system fonts.

Limits of this measurement:

- Signing was measured up to the wallet's window; completing it needs a logged-in wallet. Both
  wallets sign and broadcast in their own window and return the result by `postMessage` or the
  bridge above.
- HOT and MyNearWallet were not measured, because they do not run on testnet. Their executors
  call other backends (HOT: `h4n.app`, `api0.herewallet.app`, `storage.herewallet.app`), which the
  policy blocks. They must be measured, and their backends listed here, before the mainnet demo.
- Meteor's executor defaults to `free.rpc.fastnear.com` for mainnet. It made no RPC call in the
  testnet flows; recheck on mainnet.

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
- **Rejected agent calls cost the agent gas, nothing else.** Anyone with the agent key can make
  the agent pay gas for rejected calls, up to the key's allowance.
