# Intatto

[![CI](https://github.com/UEddy/Intatto/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/UEddy/Intatto/actions/workflows/ci.yml)

Author: [UEddy](https://github.com/UEddy)

Intatto is a NEAR smart contract that holds an owner's NEAR and NEP-141 tokens and lets one AI
agent spend or swap them only within limits the owner sets on chain. The agent signs with a
function-call access key. The contract, not the agent's software, checks every limit, so an agent
that is buggy, compromised or prompt-injected can move no more than the policy allows.

The repository has three parts: the vault contract (`src/`), a web app with an owner console and a
public canary board (`web/`), and testnet scripts (`scripts/`).

## The problem

An agent that pays for things needs a key that can move money. A full-access key, or an agent
that holds the owner's key, can move everything. A NEAR function-call key alone limits *which
contract and methods* the agent may call, not *how much money* it can move through them. Intatto
adds the second part: per-transaction caps, 24-hour caps, a receiver allowlist, a pool and pair
allowlist for swaps, a slippage bound checked against the exchange's own quote, a freeze switch,
and an optional time lock on the owner's own withdrawals.

## What is deployed

Testnet only. Mainnet is not deployed yet.

| | Testnet |
|---|---|
| Vault contract | [`vault-v1.intatto-dev.testnet`](https://explorer.testnet.near.org/accounts/vault-v1.intatto-dev.testnet) |
| Code hash | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL`, the reproducible build of commit [`b85cece`](https://github.com/UEddy/Intatto/commit/b85cece7e8afc49e8f3476cb8ae69f0792d99444), deployed in [`A3KLQkGa…`](https://explorer.testnet.near.org/transactions/A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc) |
| Exchange it is bound to | `ref-finance-101.testnet` (Rhea / Ref V1, ref-exchange 1.9.19) |
| Canary owner | `canary.intatto-dev.testnet` |
| Canary agent | `canary-agent.intatto-dev.testnet` (its function-call private key is published, see below) |
| Earlier v0 deployment | `vault.intatto-dev.testnet` (spending only, no swaps) |

The canary is a vault whose agent key is public. Anyone can sign with it and try to take the
money. Rules and baseline: [CANARY.md](CANARY.md). Threat model and invariants:
[THREAT_MODEL.md](THREAT_MODEL.md).

## Try it

Each step says what to run and what you should see. Steps 1 to 3 need only `curl` and
`python3`. Steps 4 and 5 need [near-cli-rs](https://github.com/near/near-cli-rs) (tested with
0.30.1).

**1. Read the canary vault.**

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault-v1.intatto-dev.testnet","method_name":"get_vault","args_base64":"eyJvd25lcl9pZCI6ImNhbmFyeS5pbnRhdHRvLWRldi50ZXN0bmV0In0="}}' \
  | python3 -c 'import json,sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"])), indent=1))'
```

You should see `"balance": "997400000000000000000000"` (0.9974 NEAR), an empty `allowlist`, caps of
`"0"`, and `"withdrawals_locked_until": "1796577187277683986"` (2026-12-06 17:13:07 UTC). Any lower
balance is a canary break (see [CANARY.md](CANARY.md)).

**2. Check that the deployed code is the published build.**

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"vault-v1.intatto-dev.testnet"}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])'
```

You should see `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL`. To reproduce it, check out commit
`b85cece`, run `cargo near build reproducible-wasm`, and compare `sha256sum target/near/intatto.wasm`
with hex `fdb4855d004545633f78479a1600abaae429b0562e6d37a962fc2737b0fb4999`. The build image is
pinned in [Cargo.toml](Cargo.toml).

**3. Check the published key's permission.**

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key","finality":"final","account_id":"canary-agent.intatto-dev.testnet","public_key":"ed25519:EHqQpQk85svJoeAWkJugoCGUXGMaVg77hak6pkiteZqr"}}' \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"]["permission"]))'
```

You should see a `FunctionCall` permission with receiver `vault-v1.intatto-dev.testnet`, methods
`agent_spend` and `agent_swap`, and an allowance in yoctoNEAR (1 NEAR at setup, lower once
anyone has used the key).

**4. Try to drain the canary with the published key.** The private key is in
[CANARY.md](CANARY.md). Put any account id as the receiver; you do not need a testnet account of
your own, because the agent account pays the gas.

```bash
export CANARY_KEY='<the private key from CANARY.md>'
near contract call-function as-transaction vault-v1.intatto-dev.testnet agent_spend \
  json-args '{"owner_id":"canary.intatto-dev.testnet","receiver_id":"anyone.testnet","amount":"997400000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as canary-agent.intatto-dev.testnet network-config testnet \
  sign-with-plaintext-private-key "$CANARY_KEY" send
```

You should see the transaction fail with `Receiver anyone.testnet is not on the vault's allowlist`,
and its logs contain a `spend_rejected` event with `"reason":"receiver_not_allowlisted"`. Then
repeat step 1: the balance is unchanged. Changing the amount, receiver or method, or calling
`agent_swap`, gives other rejection reasons; none moves funds.

**5. Run every test.** See [Tests](#tests). You should see all tests pass.

**6. Run the web app locally.**

```bash
cd web && npm ci && npm run dev
```

Open the printed URL (it ends in `/Intatto/`). The board reads the canary from testnet: its
balance against the baseline, the code-hash check, and every transaction signed with the
published key. The owner console (`#/console`) connects a NEAR wallet on testnet. The board is
not hosted publicly yet.

## Tests

One command runs the contract's unit tests and sandbox tests:

```bash
cargo test
```

It needs the Rust toolchain from [rust-toolchain.toml](rust-toolchain.toml) (rustup installs it)
and [cargo-near](https://github.com/near/cargo-near) 0.22.0, which the sandbox tests use to build
the contract. The sandbox tests download a `neard` sandbox binary and run up to four nodes at once
(about 0.5 GB of RAM each). The swap tests deploy the real ref-exchange 1.9.19 binary, fetched
from testnet and checked by hash ([tests/res/README.md](tests/res/README.md)).

| Suite | File | Tests |
|---|---|---|
| Unit tests (timing edges, callback outcomes, fee math) | [src/tests.rs](src/tests.rs) | 87 |
| Spending, caps, roles | [tests/test_basics.rs](tests/test_basics.rs) | 15 |
| Swaps through the real exchange, fees, J5Mo upgrade | [tests/swap.rs](tests/swap.rs) | 15 |
| Withdrawal lock | [tests/withdrawal_lock.rs](tests/withdrawal_lock.rs) | 3 |
| v1 state survives a code upgrade | [tests/upgrade.rs](tests/upgrade.rs) | 1 |

The swap tests run against the testnet exchange binary (ref-exchange 1.9.19) by default. To run
them against the mainnet binary (1.9.21, `v2.ref-finance.near`), and against the reproducible build
instead of a fresh local build:

```bash
INTATTO_TEST_EXCHANGE=1.9.21 cargo test
INTATTO_TEST_WASM=target/near/intatto.wasm INTATTO_TEST_WASM_SHA256=3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J cargo test
```

The web app's tests run separately:

```bash
cd web && npm ci && npm test        # 90 unit tests (vitest)
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `cargo fmt --check`, clippy and
`cargo test` on every push.

## Prompt-injection attack demo

[agent/](agent/README.md) has an agent that is asked to pay a 0.01 NEAR invoice whose text tells
it to send the vault's whole balance to an attacker. It signs with a function-call key limited to
`agent_spend`; the vault's policy allows one merchant and small caps.

```bash
node agent/injection-demo.mjs --compromised --dry-run   # no key needed; prints the four payments it would make
node --test agent/*.test.mjs                            # the transaction signer, checked against a real testnet transaction
```

- `--compromised` is an agent that obeys the injection.
- `--llm` lets a model on NEAR AI Cloud decide.

Each step is logged, and the vault's rejections (`receiver_not_allowlisted`, `over_per_tx_cap`)
show up on the board. The demo vault goes on vault-v2 and is not set up yet, so only `--dry-run`
works today.

## What the contract guarantees, and where it is checked

The full list of invariants and trust assumptions is in [THREAT_MODEL.md](THREAT_MODEL.md).

| Claim | Evidence |
|---|---|
| The agent can pay only allowlisted receivers | [`agent_spend_rejects_non_allowlisted_receiver`](tests/test_basics.rs); testnet [`5KvqUoMe…`](https://explorer.testnet.near.org/transactions/5KvqUoMeYxPH4cY8fc6t9bPht9ySzPMnwp8r2VchxLhj) |
| Per-transaction and 24-hour caps hold, over an exactly sliding window | [`agent_spend_rejects_over_per_tx_cap`, `agent_spend_rejects_over_daily_cap`, `burst_23h_after_spending_the_cap_is_rejected`, `spends_older_than_24h_are_pruned_and_free_the_cap`](tests/test_basics.rs); testnet [`2ABsykeJ…`](https://explorer.testnet.near.org/transactions/2ABsykeJtQHiuQshzPGTyqW1EDZCwWPAAwSgoS2froVa) |
| A frozen vault rejects every agent call; the owner can still withdraw | [`agent_spend_rejects_when_frozen`, `owner_can_withdraw_while_frozen`](tests/test_basics.rs); testnet [`2Xe4EtgkgW…`](https://explorer.testnet.near.org/transactions/2Xe4EtgkgWyS8ocDhHw4PKVKEcS4Caw7uXaFs3zeP3rP) |
| The agent cannot call owner methods | [`agent_cannot_call_owner_methods`](tests/test_basics.rs) |
| A function-call key on the owner's account can only freeze | [`function_call_key_on_owner_account_can_only_freeze`](tests/test_basics.rs) |
| Swaps go only through allowlisted pools and declared pairs, within caps | [`swap_rejections_are_logged_and_change_nothing`](tests/swap.rs); testnet [`FXecevsj…`](https://explorer.testnet.near.org/transactions/FXecevsjkHDkchGaPoJR2N9pCmEs9CC13jerE5KT9FUU) (pool), [`AyHPvtxV…`](https://explorer.testnet.near.org/transactions/AyHPvtxVVRCuz8UGiXJV3cegz82vq2aCyRmcBNqMN5K1) (cap) |
| `min_amount_out` is checked against the exchange's own quote | [`min_amount_out_of_1_is_rejected_as_slippage_too_loose`, `min_amount_out_at_the_slippage_floor_is_accepted`, `failed_quote_is_rejected_and_deducts_nothing`](tests/swap.rs); testnet [`B8i1pkDT…`](https://explorer.testnet.near.org/transactions/B8i1pkDTAb3HHXxVDHPveyeEFEU1qFCtuQu2ESq9Sw4r) |
| The owner is credited exactly the amount the exchange swapped | [`swap_through_the_real_exchange_credits_the_exact_output`](tests/swap.rs); testnet [`5KeUAq3h…`](https://explorer.testnet.near.org/transactions/5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt) |
| Failed swaps and transfers are refunded exactly once | [`swap_below_min_amount_out_is_refunded`, `swap_whose_deposit_fails_is_refunded`](tests/swap.rs), [`failed_transfer_refund_removes_only_its_own_entry`](tests/test_basics.rs) |
| A reclaim never takes another owner's tokens | [`lostfound_shortfall_refuses_reclaims_and_leaves_the_other_owner_untouched`](tests/swap.rs); [`v1_lets_one_owner_reclaim_another_owners_tokens`](tests/swap.rs) shows the v1 bug this fixed |
| A zero-outflow policy rejects everything the agent can try | [`zero_outflow_policy_rejects_everything_the_agent_can_try`](tests/swap.rs); the live canary (step 4) |
| A withdrawal lock blocks `withdraw`, `withdraw_token` and `set_agent`, and can only be extended | [tests/withdrawal_lock.rs](tests/withdrawal_lock.rs); testnet [`7QqKTXzQ…`](https://explorer.testnet.near.org/transactions/7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA) |
| Each vault pays for its own storage | [`policy_storage_is_charged_and_refunded_to_the_vault`, `token_deposit_credits_the_sender_and_pays_its_storage`, `swap_deducts_records_and_pays_storage_once_quoted`](src/tests.rs) |
| New code reads state written by v1 unchanged | [`v1_state_survives_a_code_upgrade`](tests/upgrade.rs) |

## The agent's function-call key: exact limits

The canary agent's published key, as read on chain with `view_access_key` (step 3):

```json
{"FunctionCall": {"allowance": "1000000000000000000000000", "method_names": ["agent_spend", "agent_swap"], "receiver_id": "vault-v1.intatto-dev.testnet"}}
```

What this key can do, enforced by the NEAR protocol:

- Sign transactions from `canary-agent.intatto-dev.testnet` that call `agent_spend` or
  `agent_swap` on `vault-v1.intatto-dev.testnet`, and nothing else.
- Attach no deposit. A function-call key cannot attach NEAR, so it cannot call any vault method
  that requires 1 yoctoNEAR (every owner method except `freeze`).
- Spend gas only from its allowance (1 NEAR at setup). Gas for failed calls counts too. When the
  allowance runs out the key stops working. Because this key is public, anyone can use up the
  allowance. That costs the canary nothing: the vault's funds are not involved.
- It cannot transfer the agent account's NEAR, add or delete keys, deploy code, stake, or call any
  other contract.

What limits the money is not the key but the vault's policy. The vault checks that the caller is
the registered agent account and applies the owner's policy to every call, whichever key signed
it. `canary-agent.intatto-dev.testnet` also has a full-access key, held by the deployer
(`ed25519:FUyyLtJtgkZMbcMsyjNsWBXVcNauhAwU7D4nBBZrhm8K`). It can do anything with the agent
account's own NEAR, but through the vault it is bound by the same policy as the published key. It
also means the account cannot lock itself out when the published key's allowance runs out.

The canary's private key is published on purpose, as bait, and is the only private key in this
repository. It is a testnet function-call key whose permission is shown above. Every other
`ed25519:` string in the repository is a public key or a transaction signature from recorded
testnet data in `web/src/test/fixtures/`.

## Unit economics

Measured on testnet, where the gas price is 100,000,000 yoctoNEAR per gas unit, the same as on
mainnet when measured on 2026-11-09. Storage costs 10^19 yoctoNEAR (0.00001 NEAR) per byte. NEAR
burnt is the sum over the transaction and all its receipts.

| Action | Paid by | Gas | NEAR burnt | Storage | Transaction |
|---|---|---|---|---|---|
| First `deposit` (creates the vault) | owner | 2.29 Tgas | 0.000206 | 0.00145 NEAR, kept from the deposit; depends on the account id's length (0.00138 for `intatto-dev.testnet`) | [`H47rARra…`](https://explorer.testnet.near.org/transactions/H47rARra7gGZUoBsxhqa9ssDHVhLQanJP7qT5TTCUa59), [`FNBvwqME…`](https://explorer.testnet.near.org/transactions/FNBvwqMELAAgk8LbvKTqQrkvbXMjw1ceijh2bUYeRa4W) |
| `set_agent` | owner | 2.47 Tgas | 0.000224 | charged to the vault balance; with the lock below, 0.00115 NEAR (canary: 0.99855 → 0.9974) | [`J3HaGqnQ…`](https://explorer.testnet.near.org/transactions/J3HaGqnQdrzS8iiHBC8PMzRK4vBpcUENfQU1nbG6JAjU) |
| `lock_withdrawals_until` | owner | 2.51 Tgas | 0.000229 | see `set_agent` | [`7QqKTXzQ…`](https://explorer.testnet.near.org/transactions/7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA) |
| `freeze` | owner | 2.22 Tgas | 0.000200 | none | [`25eHak8i…`](https://explorer.testnet.near.org/transactions/25eHak8ioMzwG1GUw9qbNkFnABAJDMSe7Y2MzAV46KN5) |
| `agent_spend`, completed (v0 deployment) | agent | 5.01 Tgas | 0.000434 | one spend record, charged to the vault | [`5WxoD8BF…`](https://explorer.testnet.near.org/transactions/5WxoD8BFcxvFFhc4Tho3K2MVqUdYv36wXE6DyHJpGfNX) |
| `agent_spend`, rejected (v0 deployment) | agent | 1.93 Tgas | 0.000171 | none | [`5KvqUoMe…`](https://explorer.testnet.near.org/transactions/5KvqUoMeYxPH4cY8fc6t9bPht9ySzPMnwp8r2VchxLhj) |
| `agent_swap`, completed (quote, deposit, swap, withdraw) | agent | 39.33 Tgas | 0.003643 | one spend record, charged to the vault | [`5KeUAq3h…`](https://explorer.testnet.near.org/transactions/5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt) |
| `agent_swap`, rejected before the quote | agent | 2.09 Tgas | 0.000186 | none | [`2Xe4Etgk…`](https://explorer.testnet.near.org/transactions/2Xe4EtgkgWyS8ocDhHw4PKVKEcS4Caw7uXaFs3zeP3rP) |
| `agent_swap`, rejected after the quote (slippage) | agent | 8.44 Tgas | 0.000777 | none | [`B8i1pkDT…`](https://explorer.testnet.near.org/transactions/B8i1pkDTAb3HHXxVDHPveyeEFEU1qFCtuQu2ESq9Sw4r) |
| Contract deployment (code only) | operator | 18.96 Tgas | 0.001874 | 255,271 bytes on the account, 2.55 NEAR staked | [`A3KLQkGa…`](https://explorer.testnet.near.org/transactions/A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc) |

What this means for the operator: every vault pays for its own storage and every caller pays its
own gas, so a new owner or agent costs the operator nothing per call. The operator's fixed cost
is the contract's storage stake (2.55 NEAR for this build) plus deployment gas.

## Business model

**Planned, not deployed yet.** The deployed contract (vault-v1) charges no fee. The fee is written
and tested in this repository ([src/fees.rs](src/fees.rs)) and goes live with a fresh testnet
vault, vault-v2.

The plan is a protocol fee of 0.10% (10 basis points) on the output of agent swaps, fixed in the
contract code as a compile-time constant, with no method that can change it. The fee is taken
from the amount the exchange returns: the owner is credited the output minus the fee, and the fee
accrues to a treasury balance kept separate from owner balances. The treasury account can
withdraw only accrued fees. Spends, deposits, withdrawals and reclaims carry no fee, and neither
does swap output that stays on the exchange because its withdrawal failed. The slippage limit
applies to the gross output, so an owner's worst case per swap is the pool's `max_slippage_bps`
plus 10 bps. Because the
rate is in the code, anyone can verify it from the code hash (step 2).

Per completed swap, the agent pays about 0.0036 NEAR of gas whatever the size (table above). At
0.10%, the fee equals that gas cost on a swap whose output is worth 3.6 NEAR.

## Tracks

- **AI Security & Defense (`security`).** The project is a policy engine for agent spending,
  enforced on chain. The agent signs with a function-call key scoped to one contract; its limits
  are explained above. The public canary invites anyone to break it.
- **Unstoppable DeFi (`defi`).** It is a vault with a trading agent: swaps go through Rhea (Ref
  V1) under on-chain pool, pair, cap and slippage rules. It does not use NEAR Intents yet;
  Intents support is planned for mainnet.
- **Agent Economy (`agents`).** It gives an agent a wallet it can spend from without holding the
  owner's key, within a budget the owner sets and can freeze at any time.

## Built during the hackathon

The hackathon counts code written from the 2026-10-19 announcement onward (HACKATHON.md, Q-001).
The first commit, [`aff5964`](https://github.com/UEddy/Intatto/commit/aff5964) on 2026-11-02, is the
unmodified `cargo near new` project template (its author is `nearprotocol-ci`). Every later commit
is this project's own work, from 2026-11-02 onward (`git log --format='%h %ad %s' --date=iso`).
Nothing was written before the window.

- There is no existing product on another chain (Q-002).
- This is the author's only NEAR Hackathon submission (Q-015).

## Libraries, tools and AI assistance

Built with AI assistance (Claude Code) under the author's direction.

Contract (Rust, toolchain 1.93.0):
- [near-sdk](https://crates.io/crates/near-sdk) 5.29.1
- Build: [cargo-near](https://github.com/near/cargo-near) 0.22.0; the reproducible build uses the image `sourcescan/cargo-near:0.21.1-rust-1.96.0`
- Tests: near-sandbox 0.3.12, near-api 0.8, cargo-near-build 0.11.0, tokio, testresult
- Test binaries from testnet: ref-exchange 1.9.19 (Rhea / Ref V1) and wrap.testnet's wNEAR contract ([tests/res/README.md](tests/res/README.md))

Web app (TypeScript):
- Runtime: React 19.3.1, react-router 8.5.1, TanStack Query 5.107.1, zod 4.6.7, [near-connect](https://github.com/hot-dao/near-selector) (`@hot-labs/near-connect`) 0.12.0
- Fonts: Bodoni Moda, Instrument Sans, JetBrains Mono (Fontsource)
- Build and tests: Vite 8.3.6, TypeScript 6.0.3, Vitest 5.1.0, Playwright 1.65.0, Testing Library, jsdom, fake-indexeddb

Scripts: [near-cli-rs](https://github.com/near/near-cli-rs) 0.30.1, bash, Python 3.

Services: FastNEAR RPC and transactions API, and the NearBlocks API as a fallback indexer.

## Repository layout

| Path | What |
|---|---|
| `src/` | The vault contract: `lib.rs` (deposit, withdraw, views), `policy.rs`, `spend.rs`, `swap.rs`, `callbacks.rs`, `tokens.rs`, `ledger.rs`, `lock.rs`, `storage.rs`, `events.rs`; unit tests in `tests.rs` |
| `tests/` | Sandbox tests and the contract binaries they deploy (`tests/res/`) |
| `web/` | Owner console and canary board (React, Vite) |
| `scripts/` | Testnet smoke tests and canary setup (near-cli-rs) |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Invariants, trust assumptions, what counts as a canary break |
| [CANARY.md](CANARY.md) | The public canary: accounts, key, baseline, how to try |

## Status and known gaps

- The contract has not been audited.
- Not on mainnet yet. Planned before submission: the swap fee above, passkey sign-in, a mainnet
  deployment, and NEAR Intents (mainnet only).
- The web app is not hosted publicly yet; run it locally (step 6).

## License

[MIT](LICENSE).
