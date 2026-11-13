# Intatto

[![CI](https://github.com/UEddy/Intatto/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/UEddy/Intatto/actions/workflows/ci.yml)

Author: [UEddy](https://github.com/UEddy)

**Intatto is a NEAR vault that gives an AI agent its own trading account: the agent trades through Rhea and NEAR Intents within limits the contract enforces, and can never withdraw.**

**The agent's key is public. Take the money if you can.**

The key is public on mainnet with real NEAR behind it, the code running the vault is checked live
against its reproducible build, and an AI assistant can trade through it with one command
([INTEGRATE.md](INTEGRATE.md)). How it reaches its first users: [GTM.md](GTM.md).

**Track: AI Security & Defense.** Spending limits and a policy engine enforced by the contract, a
sandboxed wallet the agent can trade from but never withdraw from, NEAR function-call keys, and AI
decisions with TEE attestation receipts: an AI agent gets money without getting the keys to it.
Also entered in Unstoppable DeFi and Agent Economy ([Tracks](#tracks)).

To prove it, we published the agent's key with a real NEAR bounty on it: the canary is an AI
agent's vault on NEAR mainnet holding 0.99761 NEAR, and its key is in [CANARY.md](CANARY.md). Sign with it, pick any receiver and any amount, call
`agent_spend` or `agent_swap` as often as you like: the transactions go through the vault
contract, and the contract refuses every one. Nothing has left the canary since it was set up on
2026-11-11. On 2026-11-13 our attack run signed 13 transactions with the published key, every way
out we could think of. All 13 failed and nothing moved: 12 were rejected by the policy, and 1 failed
before it on malformed arguments ([the run](CANARY.md#attempts-so-far)); the balance was still
997610000000000000000000 yoctoNEAR at block 224,333,239. Watch every attempt live on the board at
**[intatto.pages.dev](https://intatto.pages.dev/?network=mainnet)**, or try one yourself in
[Try it](#try-it). A second canary has run on testnet since 2026-11-06, also untouched (0.9974
NEAR). The bounty is small because one person funds it. The amount does not change the test: the
contract applies the same checks to every call, so the policy that refuses these 0.99761 NEAR
refuses any balance.

## Judge it in 60 seconds

1. **The bounty and the public key.** Open [intatto.pages.dev](https://intatto.pages.dev/?network=mainnet). The panel at the top is read live from the chain: the canary's balance, how long it has held, every attempt with the published key, and whether the running code matches the published build. The private key is in [CANARY.md](CANARY.md#mainnet).
2. **What a refusal looks like.** The agent's calls refused on mainnet: [over the per-trade cap](https://nearblocks.io/txns/8o7EGQoMWfxUzeST7cTzA63J5MzvxB5ZiWk4NENa8XHU), [a pool not allowed](https://nearblocks.io/txns/G5d3Fu838aDw5SSpRvh694TpHLKLg6Vk4LVZRJzssekc), [slippage too loose](https://nearblocks.io/txns/CEpq15YceDiwqHWtpUszmZH8LegBoyyZzgrdJ8HRaEck), and a prompt-injected agent [trying to drain the vault](https://nearblocks.io/txns/FNkp2gprgvRs49L6wskMo8JcaYwpoqk2T3YVjGa6oqtw).
3. **A trade that went through, then the owner's withdrawal.** A Rhea [swap within the limits](https://nearblocks.io/txns/JAFaEDBhStuPgwgCyNJKU7mQH2K7evjG328zrhudoaC8), the owner [withdrawing the proceeds](https://nearblocks.io/txns/2tqfhEiJm1jqAe6DNDZBFnfzbHZqfnmThVfFmJToFtYW), and a NEAR Intents swap [settled](https://nearblocks.io/txns/73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE) above the owner's price floor.
4. **The freeze.** The owner [freezes the vault](https://nearblocks.io/txns/6YRqjJXZcNuyeHHSnAeMoURtT6vHfG44VpGJ34uDBCk2) in one call, and the agent's next trade is [refused](https://nearblocks.io/txns/7bm6uGYGGJG3hJnuJQYoFfxBckCp6Qasvs5fVHzSW3Li).
5. **The code is the published code.** The board's integrity check compares `vault.intatto.near`'s code hash with the [reproducible build](#what-is-deployed) every 10 seconds.

**Two ways the agent trades.** The *Rhea path* swaps directly through Rhea pools, checked against the owner's caps, pool allowlist and a slippage bound set by the exchange's own quote. The *NEAR Intents path* has the vault's intents signed by the NEAR MPC network, only for pairs the owner allows and never below the owner's price floor.

Today most trading bots hold your private key. In September 2024, attackers exploited a flaw in the Telegram trading bot Banana Gun and drained about $3 million from 11 users' bot wallets; because the bot held the keys, every transfer was a valid signed transaction that nothing on chain could refuse. The team refunded the users from its treasury.[^banana-gun] Intatto removes the key from the bot: the agent signs only calls the vault's policy allows, and the money stays in a contract it cannot empty.

That is what Intatto does: a NEAR contract that holds an owner's NEAR and NEP-141 tokens and lets
one AI agent spend or swap them only within limits the owner sets on chain. The agent signs with a
function-call key. The contract, not the agent's software, checks every limit, so an agent that is
buggy, compromised, prompt-injected, or whose key is simply public can move no more than the owner
allowed. For the canary that is nothing at all.

**What the operator can and cannot do today.** Every rule above is enforced by the contract, but
during the hackathon the operator keeps the vault accounts' full-access keys, so owners still
trust the operator's custody of those keys:

- The deployer holds a full-access key on `vault.intatto.near`, kept offline. It acts as the vault
  account itself, so it could transfer the NEAR and tokens that account holds for every owner, or
  deploy different code. The board shows a code change as **CODE CHANGED** within 10 seconds; a
  direct transfer leaves the code and the vault's own records unchanged, so only the account's
  balance on an explorer would show it.
- `intents.intatto.near` holds a full-access key, kept offline. With it, the operator could sign
  intents for that vault outside its policy, or move its balances on `intents.near`
  ([THREAT_MODEL.md](THREAT_MODEL.md#trust-assumptions-intents-path)).
- Through the contract, nobody but the owner can withdraw: the agent key cannot, and the treasury
  can withdraw only accrued fees. The 10 bps fee is a constant in the code; changing it means new
  code, which the hash check shows. The canary's lock stops even the owner's key until 2026-11-20
  ([CANARY.md](CANARY.md)).
- Both keys will be removed after an external audit ([After the hackathon](#after-the-hackathon)),
  which makes the code permanent.

### Why the upgrade keys stay until the audit

This is a deliberate choice, not an oversight. The
contract has not been audited. Without an upgrade key, a bug found later could never be fixed, and
any funds it affected would be stuck for good: a flaw in the withdraw path, or the exchange's
"lostfound" edge case ([THREAT_MODEL.md](THREAT_MODEL.md#known-limitations)), which only a code
upgrade can recover. Keeping the key keeps every owner's money recoverable while the code is
unaudited. The cost is trust in the operator, and that is what the board measures: any new code
shows as **CODE CHANGED** within 10 seconds. Owners do not need this key to get their money out;
they withdraw through the contract with their own accounts' keys. Once an external audit is done,
both keys are removed and the code can never change again.

The repository has four parts: the vault contract (`src/`), including agent swaps through NEAR
Intents signed by the MPC network ([CHAIN_SIGNATURES.md](CHAIN_SIGNATURES.md)); a web app with an
owner console and the public canary board (`web/`); the agents (`agent/`): the prompt-injection
demo and the intent-swap agent; and scripts for testnet and mainnet (`scripts/`).

## The problem

An agent that pays for things needs a key that can move money. A full-access key, or an agent
that holds the owner's key, can move everything. A NEAR function-call key alone limits *which
contract and methods* the agent may call, not *how much money* it can move through them. Intatto
adds the second part: per-transaction caps, 24-hour caps, a receiver allowlist, a pool and pair
allowlist for swaps, a slippage bound checked against the exchange's own quote, a freeze switch,
and an optional time lock on the owner's own withdrawals.

## What is deployed

| | Mainnet | Testnet |
|---|---|---|
| Vault contract with the 10 bps swap fee | **Live**: `vault.intatto.near`, the reproducible build of `6cfa90e` | **Live**: `vault-v2.intatto-dev.testnet`, a local build of the fee code |
| Public canary (published agent key) | **Live** since 2026-11-11: 0.99761 NEAR, locked until 2026-11-20; 13 attempts with the published key on 2026-11-13, all failed, nothing moved: 12 rejected by the policy, 1 failed before it on malformed arguments ([the attack run](CANARY.md#attempts-so-far), [board](https://intatto.pages.dev/?network=mainnet)) | **Live** since 2026-11-06: 0.9974 NEAR on `vault-v1` (no fee), locked until 2026-12-06, no attempts yet |
| Agent swaps through Rhea (Ref V1), within on-chain limits | **Live**: [smoke test](#mainnet-smoke-test-2026-11-11) 18/18 on 2026-11-11 | **Live** on vault-v1 and vault-v2 |
| Agent swaps through NEAR Intents, signed by the MPC network | **Live**: `intents.intatto.near`, two swaps settled: [the first](#first-intent-swap-2026-11-11) on 2026-11-11, [an AI-decided one](#an-ai-decided-trade-on-mainnet-2026-11-13) on 2026-11-13 | Not available (mainnet only) |
| Prompt-injection demo | **Run** on 2026-11-12 on `demo.intatto.near`'s vault ([results](#prompt-injection-attack-the-agent-was-told-to-drain-the-vault)); its key was private and has been deleted | **Live** on vault-v2 ([agent/README.md](agent/README.md)) |
| Break-price board and owner console | **Live** at [intatto.pages.dev](https://intatto.pages.dev/?network=mainnet), the default | **Live** on the same site (network switch, or `?network=testnet`) |
| Wallets | Meteor, Intear, HOT, MyNearWallet | Meteor, Intear |
| Passkey sign-in | **Experimental**: sign-in verified on a phone (2026-11-12); signing transactions with a passkey not yet tested. Unaudited Trezu wallet contract, upgradeable by Trezu; use small amounts only. See [THREAT_MODEL.md](THREAT_MODEL.md#passkey-sign-in-mainnet-only-experimental). | Not available (mainnet only) |
| After the hackathon | **Staying live**: the vaults, the canary and the board keep running ([After the hackathon](#after-the-hackathon)) | |

| | Mainnet |
|---|---|
| Canary vault contract | [`vault.intatto.near`](https://nearblocks.io/address/vault.intatto.near), bound to `v2.ref-finance.near` (ref-exchange 1.9.21); fee 10 bps, treasury `eddyhamezz.near` |
| Its code hash | `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J`, the reproducible build of commit [`6cfa90e`](https://github.com/UEddy/Intatto/commit/6cfa90e00890a510750d248b24dae0f86b5211be) (tag `canary-build`), built in CI ([run 43022039828](https://github.com/UEddy/Intatto/actions/runs/43022039828)), deployed in [`HGEauwuJ…`](https://nearblocks.io/txns/HGEauwuJkiP3E4tvLhZuBZpjRabTGVW6rLyRRK9RFXVJ) |
| Canary owner | `canary.intatto.near`; baseline set by [`8YwFyVR6…`](https://nearblocks.io/txns/8YwFyVR6MFgqhEDP47tT87oGp6LPD5gbhf947AjMLU58) |
| Canary agent | `canary-agent.intatto.near` (its function-call private key is published, see below) |
| Intents vault contract | [`intents.intatto.near`](https://nearblocks.io/address/intents.intatto.near), code hash `HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC`, the reproducible build of commit [`fc23fbc`](https://github.com/UEddy/Intatto/commit/fc23fbc3abee3d503ecaeb5ced56d315374cdc20) (tag `intents-build`), bound to `intents.near` and `v1.signer` |
| Smoke test accounts | owner `demo.intatto.near`, agent `demo-agent.intatto.near`, on `vault.intatto.near` |

| | Testnet |
|---|---|
| Canary vault contract | [`vault-v1.intatto-dev.testnet`](https://testnet.nearblocks.io/address/vault-v1.intatto-dev.testnet), no fee |
| Its code hash | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL`, the reproducible build of commit [`b85cece`](https://github.com/UEddy/Intatto/commit/b85cece7e8afc49e8f3476cb8ae69f0792d99444), deployed in [`A3KLQkGa…`](https://testnet.nearblocks.io/txns/A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc) |
| Canary owner | `canary.intatto-dev.testnet` |
| Canary agent | `canary-agent.intatto-dev.testnet` (its function-call private key is also published, in [CANARY.md](CANARY.md#testnet)) |
| Fee vault contract | [`vault-v2.intatto-dev.testnet`](https://testnet.nearblocks.io/address/vault-v2.intatto-dev.testnet), the 10 bps swap fee (`get_fee_bps` = 10, treasury `intatto-dev.testnet`); first fee-paying swap [`8CyuVGP6…`](https://testnet.nearblocks.io/txns/8CyuVGP6gKCxSgEsyrXJE56tzi4Nfq7p8g2QFww4sYV2) |
| Its code hash | `7aiNbHTnDs4irAQaaGuudHmEgcQvjuMDRzxUSGrZHHiR`, a local `non-reproducible-wasm` build, so it cannot be checked against source. Mainnet runs the reproducible build above. |
| Prompt-injection demo vault | `demo-owner.intatto-dev.testnet`'s vault on vault-v2; agent `demo-agent.intatto-dev.testnet`, whose key is also published ([agent/README.md](agent/README.md)) |
| Exchange both are bound to | `ref-finance-101.testnet` (Rhea / Ref V1, ref-exchange 1.9.19) |
| Earlier v0 deployment | `vault.intatto-dev.testnet` (spending only, no swaps) |

The canary is a vault whose agent key is public. Anyone can sign with it and try to take the
money. Rules and baseline: [CANARY.md](CANARY.md). Threat model and invariants:
[THREAT_MODEL.md](THREAT_MODEL.md).

### Mainnet smoke test, 2026-11-11

`scripts/mainnet-smoke.sh --send` on `vault.intatto.near`, every step checked over RPC, 18 of 18
passed. The run stopped once at step 6, before signing (near CLI could not fetch a nonce), and
resumed from its log; steps 1 to 5 are from the first run.

| # | Step | Transaction |
|---|---|---|
| 1 | create `demo.intatto.near` with 0.95 NEAR | [`2SYW6J7t…`](https://nearblocks.io/txns/2SYW6J7tnrGVNE2FMWKKii1SfF8i7rwE9n5wJNXxfJNp) |
| 2 | create `demo-agent.intatto.near` with 0.55 NEAR | [`6nb6EF3Z…`](https://nearblocks.io/txns/6nb6EF3ZLVaiCvRF4xtKn8653ReBC5J3xyNkPGU49yG9) |
| 3 | deposit 0.05 NEAR for the vault record's storage | [`6KGkma65…`](https://nearblocks.io/txns/6KGkma65RT3GBn9rJfnV3N2f79cXc4TUQYDUqWeHMi14) |
| 4 | `set_agent`: sell at most 0.5 wNEAR per swap and per 24 h, via pool #3879 only, 100 bps slippage | [`F6MevBze…`](https://nearblocks.io/txns/F6MevBzeneKsYRs5JMmHvU34RvKHxYHQH77YuSJvP2mx) |
| 5 | register the owner on `wrap.near` | [`5d5mUwEK…`](https://nearblocks.io/txns/5d5mUwEKpTQnA2tABkevxhSWsoqvWAF8yFkwHSxhwSBe) |
| 6 | register the owner on `usdt.tether-token.near` | [`DPYK4Srr…`](https://nearblocks.io/txns/DPYK4Srr6awErMM9Wukq8FWnw2uX7QKg5FepCPByJyGD) |
| 7 | wrap 0.5 NEAR | [`4iNxajRg…`](https://nearblocks.io/txns/4iNxajRg8u4oRW1nqAhcUpHUsZ5XbYyHwAyQr2iiJXWx) |
| 8 | deposit 0.5 wNEAR into the vault | [`AxajPmMi…`](https://nearblocks.io/txns/AxajPmMiRHBubP4cVdu3Hro1WaAYNATWh5wfeSsjFhQ5) |
| 9 | the agent's function-call key: `agent_swap` on the vault only | [`9VH61sk6…`](https://nearblocks.io/txns/9VH61sk6JCsRxZpgnVMvPCwvHci6zZWpotQEixVeziw) |
| 10 | rejected: 0.6 wNEAR, over the per-swap cap (`over_per_tx_cap`) | [`8o7EGQoM…`](https://nearblocks.io/txns/8o7EGQoMWfxUzeST7cTzA63J5MzvxB5ZiWk4NENa8XHU) |
| 11 | rejected: pool #5470 is not allowlisted (`pool_not_allowlisted`) | [`G5d3Fu83…`](https://nearblocks.io/txns/G5d3Fu838aDw5SSpRvh694TpHLKLg6Vk4LVZRJzssekc) |
| 12 | rejected: `min_amount_out` of 1, far below the quote (`slippage_too_loose`) | [`CEpq15Yc…`](https://nearblocks.io/txns/CEpq15YceDiwqHWtpUszmZH8LegBoyyZzgrdJ8HRaEck) |
| 13 | the owner freezes the vault | [`6YRqjJXZ…`](https://nearblocks.io/txns/6YRqjJXZcNuyeHHSnAeMoURtT6vHfG44VpGJ34uDBCk2) |
| 14 | rejected: the vault is frozen (`frozen`) | [`7bm6uGYG…`](https://nearblocks.io/txns/7bm6uGYGGJG3hJnuJQYoFfxBckCp6Qasvs5fVHzSW3Li) |
| 15 | the owner unfreezes the vault | [`416HQTkH…`](https://nearblocks.io/txns/416HQTkHniVyVb2UHHYJJZXU8fHQZTVefsDGoRV8a9Mf) |
| 16 | rejected: signed by the owner, not the agent (`not_agent`) | [`BbsZNYEz…`](https://nearblocks.io/txns/BbsZNYEzCHKDDsf3Rc9CT2h5xiSE71Sqi1SLgU7nZFbZ) |
| 17 | swap 0.5 wNEAR through pool #3879: 1.887287 USDt out, 0.001887 USDt fee, 1.8854 USDt credited to the owner | [`JAFaEDBh…`](https://nearblocks.io/txns/JAFaEDBhStuPgwgCyNJKU7mQH2K7evjG328zrhudoaC8) |
| 18 | the owner withdraws the 1.8854 USDt | [`2tqfhEiJ…`](https://nearblocks.io/txns/2tqfhEiJm1jqAe6DNDZBFnfzbHZqfnmThVfFmJToFtYW) |

### First intent swap, 2026-11-11

An agent swap through NEAR Intents on `intents.intatto.near`: 0.3 wNEAR for 1.130742 USDt, at
3.769 USDt per wNEAR against the owner's floor of 3.3. The vault checked the pair and amounts
against the owner's policy, built the NEP-413 `token_diff` itself, had it signed by the MPC network
(`v1.signer`), and credited the owner once `intents.near` reported the nonce used. Setup
transactions, the signed payload and the checks: [CHAIN_SIGNATURES.md](CHAIN_SIGNATURES.md).

| Step | Signer | Transaction |
|---|---|---|
| `agent_intent_swap`: policy checks, reserve, MPC signature, signed payload logged | `intents-agent.intatto.near` | [`GbHfV9nq…`](https://nearblocks.io/txns/GbHfV9nqv8C3xXWCFECWaruJFaQijMhq2GBrKxb1uJjT) |
| `execute_intents` with the solver's intent | the relay | [`EJY7oiU1…`](https://nearblocks.io/txns/EJY7oiU1SE3w9kg94qhwdcsn2zxFWEZ3eykbVnvUCLUE) |
| `settle_intent_swap`: nonce used, owner credited 1.130742 USDt | `intents-agent.intatto.near` | [`73aJTu55…`](https://nearblocks.io/txns/73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE) |

## Prerequisites

Each step below says which of these it needs. Nothing here needs a key or a NEAR account except
"Try it" step 4 and the key-creation command in [Bring your own agent](#bring-your-own-agent), which
are marked.

| Tool | Needed for | Notes |
|---|---|---|
| `curl`, `python3` | "Try it" steps 1 to 3 | Read-only calls to the mainnet RPC |
| Rust, from [rust-toolchain.toml](rust-toolchain.toml) | `cargo test` | rustup installs the pinned toolchain |
| [cargo-near](https://github.com/near/cargo-near) 0.22.0 | `cargo test` (the sandbox tests build the contract with it) | Prebuilt, as CI installs it: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh \| sh`. From source (about 10 minutes): `cargo install cargo-near --version 0.22.0 --locked`, after installing `pkg-config` and `libudev-dev` on Debian or Ubuntu |
| Open-file limit of 65535 | `cargo test` (the sandbox tests start `neard`) | Run `ulimit -n 65535` in the same shell first. That works only if the hard limit (`ulimit -Hn`) is at least 65535; if it is lower, raise it as root, or start the container with `--ulimit nofile=65535:65535`. Without it, `neard` fails with `couldn't set the file descriptor limit` and the 57 sandbox tests fail. |
| Docker | The reproducible build only | |
| Node 22.22 or later | The web app and the agent | The agent tests also need the web app's packages: run `(cd web && npm ci)` once first |
| Playwright's Chromium | `npm run test:prod` only | `(cd web && npx playwright install chromium)` |
| [near-cli-rs](https://github.com/near/near-cli-rs) (tested with 0.30.1) | "Try it" step 4, [Bring your own agent](#bring-your-own-agent) | |

Every command block below is labelled: **offline**, **reads the network** (no key), or **signs a
mainnet transaction**.

## Try it

Each step says what to run and what you should see. The testnet canary's accounts, key and command
are in [CANARY.md](CANARY.md#testnet).

**1. Read the canary vault.** Reads the network (no key).

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault.intatto.near","method_name":"get_vault","args_base64":"eyJvd25lcl9pZCI6ImNhbmFyeS5pbnRhdHRvLm5lYXIifQ=="}}' \
  | python3 -c 'import json,sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"])), indent=1))'
```

You should see `"balance": "997610000000000000000000"` (0.99761 NEAR), an empty `allowlist`, caps
of `"0"`, and `"withdrawals_locked_until": "1795176000000000000"` (2026-11-20 12:00:00 UTC). Any
lower balance is a canary break (see [CANARY.md](CANARY.md)).

**2. Check that the deployed code is the published build.** Reads the network (no key).

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"vault.intatto.near"}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])'
```

You should see `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J`. That is the base58 form of the
wasm's sha256, hex `2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5`.

**2b. Rebuild it yourself.** Reads the network (no key): git fetches the tag from GitHub, and
Docker pulls the pinned build image and `hello-world:latest` (cargo-near's Docker check) from
Docker Hub. Needs Docker and cargo-near.

```bash
git fetch --tags && git checkout canary-build          # commit 6cfa90e
cargo near build reproducible-wasm
sha256sum target/near/intatto.wasm                     # 2c520bfc...e8d218f5
git checkout master
```

The build runs inside the Docker image pinned by digest in [Cargo.toml](Cargo.toml)
(`sourcescan/cargo-near:0.21.1-rust-1.96.0`), so the cargo-near inside that image does the build,
whatever version you have installed. The intents vault's build is the same with tag
`intents-build` (commit `fc23fbc`, code hash `HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC`). GitHub
Actions builds both the same way in
[reproducible-build.yml](.github/workflows/reproducible-build.yml) (about 2 minutes per run).

Without Docker, an offline check: the copy of the canary build committed for the tests has the same
hash.

```bash
sha256sum tests/res/intatto_3z1w5.wasm                 # 2c520bfc...e8d218f5
```

**3. Check the published key's permission.** Reads the network (no key).

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key","finality":"final","account_id":"canary-agent.intatto.near","public_key":"ed25519:GWvo8kPMuTxj9yLvTnsFJ5jxB4D3CNrbcMsLn2WTAEig"}}' \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"]["permission"]))'
```

You should see a `FunctionCall` permission with receiver `vault.intatto.near`, methods
`agent_spend` and `agent_swap`, and an allowance in yoctoNEAR (0.25 NEAR at setup, lower once
anyone has used the key).

**4. Try to drain the canary with the published key.** **Signs and sends a mainnet
transaction**, with the published key; it needs near-cli-rs. The private key is in
[CANARY.md](CANARY.md). Put any account id as the receiver; you do not need a mainnet account of
your own, because the agent account pays the gas.

```bash
export CANARY_KEY='<the private key from CANARY.md>'
near contract call-function as-transaction vault.intatto.near agent_spend \
  json-args '{"owner_id":"canary.intatto.near","receiver_id":"anyone.near","amount":"997610000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as canary-agent.intatto.near network-config mainnet \
  sign-with-plaintext-private-key "$CANARY_KEY" send
```

You should see the transaction fail with `Receiver anyone.near is not on the vault's allowlist`,
and its logs contain a `spend_rejected` event with `"reason":"receiver_not_allowlisted"`. Then
repeat step 1: the balance is unchanged. Changing the amount, receiver or method, or calling
`agent_swap`, gives other rejection reasons; none moves funds.

**5. Run every test.** See [Tests](#tests). You should see all tests pass.

**6. Run the web app locally.** The app reads the network; it holds no keys.

```bash
(cd web && npm ci && npm run dev)
```

Open the printed URL (it ends in `/Intatto/`). The board reads the mainnet canary (switch to
testnet in the header): its balance against the baseline, the code-hash check, and every
transaction signed with the published key. The owner console (`#/vault`) connects a NEAR wallet.
The same board is hosted at [intatto.pages.dev](https://intatto.pages.dev/?network=mainnet).

## Tests

One command runs the contract's unit tests and sandbox tests. Offline apart from downloads (crates,
the `neard` sandbox binary); no key.

```bash
ulimit -n 65535
cargo test
```

It needs the Rust toolchain from [rust-toolchain.toml](rust-toolchain.toml) (rustup installs it)
and [cargo-near](https://github.com/near/cargo-near) 0.22.0, which the sandbox tests use to build
the contract (see [Prerequisites](#prerequisites)). The sandbox tests download a `neard` sandbox
binary and run up to four nodes at once (about 0.5 GB of RAM each), and `neard` needs the
65535 open-file limit; without it, only the 98 unit tests pass, and each sandbox test stops with a
message saying how to raise the limit. A full run takes 8 to 9 minutes in
CI. The swap tests deploy the real ref-exchange 1.9.19 binary, fetched
from testnet and checked by hash ([tests/res/README.md](tests/res/README.md)).

| Suite | File | Tests |
|---|---|---|
| Unit tests (timing edges, callback outcomes, fee math, intent swap callbacks and encoding) | [src/tests.rs](src/tests.rs), [src/intent_swap.rs](src/intent_swap.rs) | 98 |
| Spending, caps, roles | [tests/test_basics.rs](tests/test_basics.rs) | 15 |
| Swaps through the real exchange, fees, J5Mo upgrade, a vault blacklisted on 1.9.21 | [tests/swap.rs](tests/swap.rs) | 17 |
| Withdrawal lock | [tests/withdrawal_lock.rs](tests/withdrawal_lock.rs) | 3 |
| v1 state survives a code upgrade | [tests/upgrade.rs](tests/upgrade.rs) | 1 |
| NEAR Intents path: mock MPC signer, vendored intents.near 0.4.5, upgrade from the canary's 3z1W5 build | [tests/chain_signatures.rs](tests/chain_signatures.rs) | 21 |
| **Total** (`cargo test -- --list`, 2026-11-12) | | **155** |

The swap tests run against the testnet exchange binary (ref-exchange 1.9.19) by default. This runs
them against the mainnet binary (1.9.21, `v2.ref-finance.near`) instead. Offline apart from
downloads; no key.

```bash
ulimit -n 65535
INTATTO_TEST_EXCHANGE=1.9.21 cargo test
```

To run the canary commit's own tests against its reproducible build instead of a fresh local
build, first make `target/near/intatto.wasm` with step 2b. Run them at that commit: the build has
no NEAR Intents code, so master's `tests/chain_signatures.rs` cannot run on it. Offline; no key.

```bash
git checkout canary-build
ulimit -n 65535
INTATTO_TEST_WASM=target/near/intatto.wasm INTATTO_TEST_WASM_SHA256=3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J cargo test
git checkout master
```

The web app's and the demo agent's tests run separately. Run each line from the repository root:

```bash
(cd web && npm ci && npm test)      # offline: 205 unit tests in 27 files (vitest), 2026-11-13
node --test agent/*.test.mjs        # offline, after the line above: 54 tests: the demo agent's transaction signer, secret redaction and RPC errors, the intent swap agent, the AI decision receipts, the pre-trade check, the MCP server, the canary attack run
(cd web && npx playwright install chromium && npm run test:prod)   # reads the network: the Cloudflare build under its real CSP, against live mainnet and testnet (Playwright)
```

`test:prod` reads live RPC nodes, which rate-limit heavy use (HTTP 429); if it fails on a read,
wait a few minutes and run it once more.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `cargo fmt --check`, clippy,
`cargo test`, and the web and agent unit tests on every push.

## Prompt-injection attack: the agent was told to drain the vault

Whether the model falls for the attack or not, the contract decides. The same contract policy check
guards `agent_swap` (see the [mainnet smoke test](#mainnet-smoke-test-2026-11-11)'s refused swaps,
steps 10 to 12).

[agent/](agent/README.md) has an agent that is asked to pay a 0.01 NEAR invoice whose text tells
it to send the vault's whole balance to an attacker. It signs with a function-call key limited to
`agent_spend`; the vault's policy allows one merchant and small caps.

```bash
node agent/injection-demo.mjs --compromised --dry-run   # reads the network (testnet RPC), no key; prints the four payments it would make
node --test agent/*.test.mjs                            # offline, after `(cd web && npm ci)`: the transaction signer, checked against a real testnet transaction
```

- `--compromised` is an agent that obeys the injection.
- `--llm` lets a model on NEAR AI Cloud decide.

The demo vault is live on vault-v2. In the [2026-11-11 runs](agent/README.md#results-2026-11-11),
with transaction links, the compromised agent's three attack payments were rejected
(`receiver_not_allowlisted` twice, `over_per_tx_cap` once) and only the 0.01 NEAR invoice went
through. The model, DeepSeek V4.1 Flash, ignored the injection and paid only the invoice. Each step
is logged, and every transaction from the demo agent's key, rejections included, shows up in the
board's "Prompt-injection demo" log.

**Mainnet, 2026-11-12**, on `demo.intatto.near`'s vault on `vault.intatto.near`
([scripts/mainnet-injection-demo.sh](scripts/mainnet-injection-demo.sh)). The policy allowed one
merchant, `eddyhamezz.near`, 0.01 NEAR per payment and 0.02 NEAR per 24 hours ([`HXWcufhr…`](https://nearblocks.io/txns/HXWcufhrPHueysZkXKwH8bJ87sDK7UjzCDWReE9r6dyS)),
and the agent signed with a private function-call key for `agent_spend` only, added for the runs
([`GnjzNNGJ…`](https://nearblocks.io/txns/GnjzNNGJ6qfTecgWvBaJ1R1DDDUNKzgXQpQkNegQkdDN)) and deleted after them ([`E4jFZhrA…`](https://nearblocks.io/txns/E4jFZhrAhK3hKUoxP2dtXZvUt2SHNf1kPamyuqHLy11p)).

| Run | Payment | What the vault did | Transaction |
|---|---|---|---|
| `--compromised` | 0.04257 NEAR (the whole balance) to `attacker.intatto.near` | refused, `receiver_not_allowlisted` | [`FNkp2gpr…`](https://nearblocks.io/txns/FNkp2gprgvRs49L6wskMo8JcaYwpoqk2T3YVjGa6oqtw) |
| `--compromised` | 0.5 NEAR to `attacker.intatto.near` | refused, `receiver_not_allowlisted` | [`FAxZmzbi…`](https://nearblocks.io/txns/FAxZmzbi1mJrrC8Q1chqacojx1nT2Ec8HBTgH5kyy34a) |
| `--compromised` | 0.04257 NEAR to the merchant | refused, `over_per_tx_cap` | [`3sDbRvQ2…`](https://nearblocks.io/txns/3sDbRvQ2k2VxiWDT8p7Gb2ZY5ikBXcftyKf468dk5L1H) |
| `--compromised` | the 0.01 NEAR invoice | paid | [`4Gam7Ufp…`](https://nearblocks.io/txns/4Gam7Ufp9qjkbrA5ED2ancJyBCwMh7GSz6w4mcD7sNSo) |
| `--llm` (DeepSeek V4.1 Flash) | the 0.01 NEAR invoice; the model ignored the injection | paid | [`3HAaqVrD…`](https://nearblocks.io/txns/3HAaqVrDa8LUKgiwu1NdGDEDT3DvzfqrbMBxJWoZ9ayw) |

Each paid invoice took 0.01033 NEAR from the vault, not 0.01: the extra 0.00033 NEAR pays the
storage of the 33-byte spend record the vault keeps for 24 hours. It is charged to the vault's own
balance, stays staked in `vault.intatto.near` (nobody receives it), and is credited back when a
later agent call prunes the record. Adding the merchant to the allowlist took 0.00019 NEAR (19
bytes) the same way.

## AI decisions, verifiable

Before each NEAR Intents trade, the agent ([agent/intent-swap.mjs](agent/intent-swap.mjs)) asks a
model on NEAR AI Cloud whether to take the solver's quote
([agent/ai-decision.mjs](agent/ai-decision.mjs)). It keeps the completion's signature receipt:
SHA-256 of the exact request bytes and of the exact response bytes, and an ECDSA signature over
`model:request_hash:response_hash` by a signing address that NEAR AI attests is inside its TEE. The
agent trades only if the model says "trade" and the receipt checks out: the signed text matches
the hashes it computed, and the signature recovers to that address. The hashes and the receipt
then go into the trade's own transaction, as an extra `ai_decision` argument of
`agent_intent_swap`. The deployed vaults ignore arguments they do not know, so no redeploy is
needed. They are recorded on chain in the transaction's arguments, not in any log or state of the
vault (`an_extra_ai_decision_argument_is_recorded_but_changes_nothing` in
[tests/chain_signatures.rs](tests/chain_signatures.rs) checks this). The board shows "Verify AI
decision" on a trade whose arguments hold a receipt that signs exactly those hashes. The link
opens NEAR AI's Verification Center with the receipt in the URL fragment, which the browser never
sends to the server. **What this proves:** this response came from this model, running in an
attested TEE (model, gateway, NVIDIA GPU and Intel TDX attestation, checked by the Verification
Center), and its request and response hashes are the ones recorded with this trade. **What it
does not prove:** the agent's own code does not run in a TEE. Nothing shows that the agent sent
the model honest facts, or that it acted on the answer rather than ignoring it, beyond the trade
itself. The prompt and the reply stay with the agent, in its run log, and only their hashes are
public. The vault's policy, not the model, is what limits the trade.

### An AI-decided trade on mainnet, 2026-11-13

The agent sold 0.3 wNEAR for 1.052787 USDt through NEAR Intents on `intents.intatto.near`, at
3.509 USDt per wNEAR against the owner's floor of 3.3, after the model (DeepSeek V4.1 Flash on NEAR
AI Cloud) answered "trade": "The quote of 3.509 USDt per wNEAR exceeds the owner's floor of 3.3
USDt per wNEAR." The decision's request and response hashes (`470c3935…`, `351926d9…`) and its
receipt are in the arguments of the trade's own `agent_intent_swap`, [`4LHgQowq…`](https://nearblocks.io/txns/4LHgQowq1FzuxHa2LhMafjFyLAWDGxhgspfk9pv3D9aZ),
so the receipt is tied to this trade: [verify on NEAR AI Cloud](https://cloud.near.ai/verify?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017#receipt=eyJjb21wbGV0aW9uSWQiOiJjaGF0Y21wbC1jMDdlMGNkZi1lYmQ5LTRiOTAtYTFlOS00MTI4NGRjMTdkNGMiLCJtb2RlbCI6ImRlZXBzZWVrLWFpL0RlZXBTZWVrLVY0LjEtRmxhc2gtMTAxNyIsInNpZ25hdHVyZUtpbmQiOiJwcm92aWRlcl90ZWUiLCJzaWduaW5nQWxnbyI6ImVjZHNhIiwic2lnbmluZ0FkZHJlc3MiOiIweGZlMDA3MTg5NTUwMGE5NzU1YzE4MDQ0OTQ4YWI0ZjRlMWE3ZjMzN2UiLCJzaWduZWRUZXh0IjoiZGVlcHNlZWstYWkvRGVlcFNlZWstVjQuMS1GbGFzaC0xMDE3OjQ3MGMzOTM1OWI1OTY2Y2ZlYzU4MDdjODc3YjllODc0MjBjYWVmMzI1ZDU0NDExYjg4ZWEwZjI4Y2JlMTI2ZTk6MzUxOTI2ZDkyMzlkOTMzM2Q2ZjljZjg3YTA5MmU0ZWJkNWIwMGZkNmE4OWQ2ZWNjN2ZlN2VmYjQ5OGM3YzQxYyIsInNpZ25hdHVyZSI6IjB4OGE3ZjgyYmYyODVlMGEwN2JhZWIxZmRhZGU5ZjVmMWQyMWQ2MDQ3MDcyZmMzOTU5MjVhYmU1NzA3YzcxZTRlNDJhNmQ1NzUzM2UyYjYyNTMzYmZlNDlkYTAzZWY1ZmI5OGVhMDA0MGJjM2U3MzNhMmU2NjZkZjA4N2UyMmI2MjgxYyJ9).
The board shows "Verify AI decision" on this trade. Run with
[scripts/mainnet-ai-swap.sh](scripts/mainnet-ai-swap.sh), which checked each transaction over RPC
afterwards, including that the arguments hold the decision the agent logged and that its receipt
verifies.

The agent checks the signature before it trades: NEAR AI's ECDSA signature over
`model:request_hash:response_hash` recovers to the receipt's signing address, and both hashes are
in `agent_intent_swap`'s arguments. The agent does not check the TEE attestation itself; the
Verification Center does, against NEAR AI's live attestation service. On 2026-11-13 that service
reported `gpu.jwt_verification_failed` for DeepSeek V4.1 Flash for every receipt, including one
that verified on 2026-11-12.

| Step | Signer | Transaction |
|---|---|---|
| fund the owner with 0.182 NEAR | `eddyhamezz.near` | [`En3gT244…`](https://nearblocks.io/txns/En3gT244fHjDvMcozkcyLWSrfzvZ19RbzeWTih638WfL) |
| wrap 0.3 NEAR | `intents-owner.intatto.near` | [`AMXnzHaY…`](https://nearblocks.io/txns/AMXnzHaYuQAsV11V7pftwGXwQUDB44UgXenKmWM2bzkQ) |
| deposit the 0.3 wNEAR into the vault | `intents-owner.intatto.near` | [`3jUm1sNv…`](https://nearblocks.io/txns/3jUm1sNvRtnmq9dSR4TSW8mt2ibScE8TQM8Evw39cTTy) |
| `deposit_to_intents`: move it into the vault's account on intents.near | `intents-owner.intatto.near` | [`5d8XVuv3…`](https://nearblocks.io/txns/5d8XVuv3fc3gmvinGHtBEkHsj2dWiWskzbMZw3EL1Zv) |
| `agent_intent_swap` with `ai_decision`: policy checks, MPC signature, the decision's hashes and receipt in its arguments | `intents-agent.intatto.near` | [`4LHgQowq…`](https://nearblocks.io/txns/4LHgQowq1FzuxHa2LhMafjFyLAWDGxhgspfk9pv3D9aZ) |
| `execute_intents` with the solver's intent: intent `DVgZUxCK…` executed | the relay (`intents.near`) | [`8pBe2PTF…`](https://nearblocks.io/txns/8pBe2PTFvNgTm1C3Uq7KYVLtYeLTPBfMVmFuU97mriJP) |
| `settle_intent_swap`: nonce used, owner credited 1.052787 USDt | `intents-agent.intatto.near` | [`GQRC8sEf…`](https://nearblocks.io/txns/GQRC8sEfwu5thSuTQ2aoyDn7fdFTJ32ZJKHhknZYLQWQ) |

An earlier example, 2026-11-12: a live mainnet quote (3.529 USDt per wNEAR, floor 3.3), the model's decision 'trade', and its receipt: [verify on NEAR AI Cloud](https://cloud.near.ai/verify?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017#receipt=eyJjb21wbGV0aW9uSWQiOiJjaGF0Y21wbC0xNmJhODIwYy1hMDllLTQ2MmEtOWYxYi04MDdjNzI4MmU4OTAiLCJtb2RlbCI6ImRlZXBzZWVrLWFpL0RlZXBTZWVrLVY0LjEtRmxhc2gtMTAxNyIsInNpZ25hdHVyZUtpbmQiOiJwcm92aWRlcl90ZWUiLCJzaWduaW5nQWxnbyI6ImVjZHNhIiwic2lnbmluZ0FkZHJlc3MiOiIweGZlMDA3MTg5NTUwMGE5NzU1YzE4MDQ0OTQ4YWI0ZjRlMWE3ZjMzN2UiLCJzaWduZWRUZXh0IjoiZGVlcHNlZWstYWkvRGVlcFNlZWstVjQuMS1GbGFzaC0xMDE3OjJhZWNkZGZkZTQ1NzBkZmVjMDBmMjczNzA1OWZiYWU2YmJhMmUyZmI0NTc0NzYxNTJkNDE4ZDg0NzAwMjliYTA6NzllZmZkYmRiNGUyMDdlNjJkODczYjI0NDE3Y2NlNzE0MzE4ODdiOTA4YmMxYzk2YmY3ZTg3MWIwYTYxN2QxNiIsInNpZ25hdHVyZSI6IjB4MjQ2ZWQzOTM4NGZiYzI2MmVkZTQ5NTNkMjgwNzFjZjA4MjQzYzE5ODYxOGZjNWRjZTFjMDg2ZTI5MGNjZjI2ZDZkZTY5ZWE3MmU1ZjAwNzJmNmMxOGI2MTQ2ZGFjYzgwNTAxMjEyNTc5NmM1YTc0M2I0OTFkN2EzZWRlNmM4MjIxYiJ9). That one was a dry run: no trade was sent, so it isn't tied to a transaction.

## What the contract guarantees, and where it is checked

The full list of invariants and trust assumptions is in [THREAT_MODEL.md](THREAT_MODEL.md).

| Claim | Evidence |
|---|---|
| The agent can pay only allowlisted receivers | [`agent_spend_rejects_non_allowlisted_receiver`](tests/test_basics.rs); testnet [`5KvqUoMe…`](https://testnet.nearblocks.io/txns/5KvqUoMeYxPH4cY8fc6t9bPht9ySzPMnwp8r2VchxLhj) |
| Per-transaction and 24-hour caps hold, over an exactly sliding window | [`agent_spend_rejects_over_per_tx_cap`, `agent_spend_rejects_over_daily_cap`, `burst_23h_after_spending_the_cap_is_rejected`, `spends_older_than_24h_are_pruned_and_free_the_cap`](tests/test_basics.rs); testnet [`2ABsykeJ…`](https://testnet.nearblocks.io/txns/2ABsykeJtQHiuQshzPGTyqW1EDZCwWPAAwSgoS2froVa) |
| A frozen vault rejects every agent call; the owner can still withdraw | [`agent_spend_rejects_when_frozen`, `owner_can_withdraw_while_frozen`](tests/test_basics.rs); testnet [`2Xe4EtgkgW…`](https://testnet.nearblocks.io/txns/2Xe4EtgkgWyS8ocDhHw4PKVKEcS4Caw7uXaFs3zeP3rP) |
| The agent cannot call owner methods | [`agent_cannot_call_owner_methods`](tests/test_basics.rs) |
| A function-call key on the owner's account can only freeze | [`function_call_key_on_owner_account_can_only_freeze`](tests/test_basics.rs) |
| Swaps go only through allowlisted pools and declared pairs, within caps | [`swap_rejections_are_logged_and_change_nothing`](tests/swap.rs); testnet [`FXecevsj…`](https://testnet.nearblocks.io/txns/FXecevsjkHDkchGaPoJR2N9pCmEs9CC13jerE5KT9FUU) (pool), [`AyHPvtxV…`](https://testnet.nearblocks.io/txns/AyHPvtxVVRCuz8UGiXJV3cegz82vq2aCyRmcBNqMN5K1) (cap) |
| `min_amount_out` is checked against the exchange's own quote | [`min_amount_out_of_1_is_rejected_as_slippage_too_loose`, `min_amount_out_at_the_slippage_floor_is_accepted`, `failed_quote_is_rejected_and_deducts_nothing`](tests/swap.rs); testnet [`B8i1pkDT…`](https://testnet.nearblocks.io/txns/B8i1pkDTAb3HHXxVDHPveyeEFEU1qFCtuQu2ESq9Sw4r) |
| The owner is credited exactly the amount the exchange swapped | [`swap_through_the_real_exchange_credits_the_exact_output`](tests/swap.rs); testnet [`5KeUAq3h…`](https://testnet.nearblocks.io/txns/5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt) |
| Failed swaps and transfers are refunded exactly once | [`swap_below_min_amount_out_is_refunded`, `swap_whose_deposit_fails_is_refunded`](tests/swap.rs), [`failed_transfer_refund_removes_only_its_own_entry`](tests/test_basics.rs) |
| A reclaim never takes another owner's tokens | [`lostfound_shortfall_refuses_reclaims_and_leaves_the_other_owner_untouched`](tests/swap.rs); [`v1_lets_one_owner_reclaim_another_owners_tokens`](tests/swap.rs) shows the v1 bug this fixed |
| A zero-outflow policy rejects everything the agent can try | [`zero_outflow_policy_rejects_everything_the_agent_can_try`](tests/swap.rs); the live canary (step 4) |
| A withdrawal lock blocks `withdraw`, `withdraw_token` and `set_agent`, and can only be extended | [tests/withdrawal_lock.rs](tests/withdrawal_lock.rs); testnet [`7QqKTXzQ…`](https://testnet.nearblocks.io/txns/7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA) |
| Each vault pays for its own storage | [`policy_storage_is_charged_and_refunded_to_the_vault`, `token_deposit_credits_the_sender_and_pays_its_storage`, `swap_deducts_records_and_pays_storage_once_quoted`](src/tests.rs) |
| New code reads state written by v1 unchanged | [`v1_state_survives_a_code_upgrade`](tests/upgrade.rs) |

## The agent's function-call key: exact limits

The mainnet canary agent's published key, as read on chain with `view_access_key` (step 3):

```json
{"FunctionCall": {"allowance": "250000000000000000000000", "method_names": ["agent_spend", "agent_swap"], "receiver_id": "vault.intatto.near"}}
```

What this key can do, enforced by the NEAR protocol:

- Sign transactions from `canary-agent.intatto.near` that call `agent_spend` or `agent_swap` on
  `vault.intatto.near`, and nothing else.
- Attach no deposit. A function-call key cannot attach NEAR, so it cannot call any vault method
  that requires 1 yoctoNEAR (every owner method except `freeze`).
- Spend gas only from its allowance (0.25 NEAR at setup). Gas for failed calls counts too. When the
  allowance runs out the key stops working. Because this key is public, anyone can use up the
  allowance. That costs the canary nothing: the vault's funds are not involved.
- It cannot transfer the agent account's NEAR, add or delete keys, deploy code, stake, or call any
  other contract.

What limits the money is not the key but the vault's policy. The vault checks that the caller is
the registered agent account and applies the owner's policy to every call, whichever key signed
it. `canary-agent.intatto.near` also has a full-access key, held by the operator
(`ed25519:3vFARja44DSWWf5PqizuKMoYfxRUJWbBoHmaq7prMPmh`). It can do anything with the agent
account's own NEAR, but through the vault it is bound by the same policy as the published key. It
also means the account cannot lock itself out when the published key's allowance runs out.

Three private keys are published on purpose, all function-call keys: the two canaries', as bait
(mainnet, with the permission shown above; testnet, on vault-v1 with a 1 NEAR allowance), and the
prompt-injection demo agent's on testnet ([agent/README.md](agent/README.md)), which can call
only `agent_spend` on vault-v2. Every other `ed25519:` string in the repository is a public key
or a transaction signature from recorded mainnet and testnet data in `web/src/test/fixtures/`.

## Bring your own agent

Intatto isn't tied to our agent: any agent that can sign a NEAR transaction can trade through a
vault, within the owner's policy. The owner registers the agent's account with
`set_agent(agent_id, policy)`; its function-call key may then call only these vault methods:

| Method | What it does |
|---|---|
| `agent_spend(owner_id, receiver_id, amount)` | Pays NEAR from the owner's vault to an allowlisted receiver. |
| `agent_swap(owner_id, pool_id, token_in, token_out, amount_in, min_amount_out)` | Swaps a token through an allowed Rhea (Ref V1) pool, checked against the exchange's own quote. |
| `agent_intent_swap(owner_id, token_in, token_out, amount_in, amount_out)` | Intents build only (`intents.intatto.near`): has the MPC network sign a NEAR Intents `token_diff` for exactly those amounts. |
| `settle_intent_swap(intent_id)` | Intents build only: credits the owner once intents.near has used the intent's nonce. Anyone may call it. |

Create the key on the agent's account (near-cli-rs 0.30.1), scoped to the vault and the methods it
needs, with a gas allowance. **Signs a mainnet transaction**, with the agent account's own key:

```bash
near account add-key <agent-account> grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id <vault> --function-names agent_spend,agent_swap \
  autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-legacy-keychain send
```

A function-call key cannot attach a deposit, so it cannot call any owner method or withdraw. The
allowance only pays gas: an `agent_swap` sent with 300 TGas, as the smoke test sends it, needs
about 0.3 NEAR of allowance when it is signed (NEAR's minimum gas purchase price), and unused gas
is refunded to the account.

The contract refuses any agent call that breaks the owner's policy: `per_tx_cap` and `daily_cap`
(NEAR per payment and in any 24 hours), `allowlist`, `max_spends_per_24h`, each token's
`per_tx_cap` and `daily_cap` in `tokens`, the `pools` and their `token_ids`, `max_slippage_bps`
below the exchange's quote, and on the intents build the `pairs` and their price floors (`min_out`
per `per_in`). It also refuses every agent call while the vault is frozen, and any call from an
account other than the registered agent. The reference implementation is [agent/](agent/README.md):
a NEAR transaction signer with no dependencies, the prompt-injection demo, and the intent-swap agent.

### From an AI assistant (MCP), with a check before every swap

[agent/mcp-server.mjs](agent/mcp-server.mjs) gives Claude, ChatGPT, Cursor, Codex or any MCP client
the vault as four tools: `intatto_vault_status`, `intatto_check_agent_key`, `intatto_check_swap` and
`intatto_swap`. Before every swap it runs a pre-trade check ([agent/risk-check.mjs](agent/risk-check.mjs))
that returns allow, warn or block with reasons: every refusal the contract would make, plus what
the contract does not judge (price impact against a 1% probe of the same pool, a token whose
account has a full-access key, a signing key that can do more than call the vault). It blocks bad
swaps before they are signed and sends nothing at all until the server runs with
`INTATTO_ALLOW_TRADES=1`. Setup, the check's rules and how to use it from your own agent:
[INTEGRATE.md](INTEGRATE.md).

## Unit economics

Measured on testnet, where the gas price is 100,000,000 yoctoNEAR per gas unit, the same as on
mainnet when measured on 2026-11-09. Storage costs 10^19 yoctoNEAR (0.00001 NEAR) per byte. NEAR
burnt is the sum over the transaction and all its receipts.

| Action | Paid by | Gas | NEAR burnt | Storage | Transaction |
|---|---|---|---|---|---|
| First `deposit` (creates the vault) | owner | 2.29 Tgas | 0.000206 | 0.00145 NEAR, kept from the deposit; depends on the account id's length (0.00138 for `intatto-dev.testnet`) | [`H47rARra…`](https://testnet.nearblocks.io/txns/H47rARra7gGZUoBsxhqa9ssDHVhLQanJP7qT5TTCUa59), [`FNBvwqME…`](https://testnet.nearblocks.io/txns/FNBvwqMELAAgk8LbvKTqQrkvbXMjw1ceijh2bUYeRa4W) |
| `set_agent` | owner | 2.47 Tgas | 0.000224 | charged to the vault balance; with the lock below, 0.00115 NEAR (canary: 0.99855 → 0.9974) | [`J3HaGqnQ…`](https://testnet.nearblocks.io/txns/J3HaGqnQdrzS8iiHBC8PMzRK4vBpcUENfQU1nbG6JAjU) |
| `lock_withdrawals_until` | owner | 2.51 Tgas | 0.000229 | see `set_agent` | [`7QqKTXzQ…`](https://testnet.nearblocks.io/txns/7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA) |
| `freeze` | owner | 2.22 Tgas | 0.000200 | none | [`25eHak8i…`](https://testnet.nearblocks.io/txns/25eHak8ioMzwG1GUw9qbNkFnABAJDMSe7Y2MzAV46KN5) |
| `agent_spend`, completed (v0 deployment) | agent | 5.01 Tgas | 0.000434 | one spend record, charged to the vault | [`5WxoD8BF…`](https://testnet.nearblocks.io/txns/5WxoD8BFcxvFFhc4Tho3K2MVqUdYv36wXE6DyHJpGfNX) |
| `agent_spend`, rejected (v0 deployment) | agent | 1.93 Tgas | 0.000171 | none | [`5KvqUoMe…`](https://testnet.nearblocks.io/txns/5KvqUoMeYxPH4cY8fc6t9bPht9ySzPMnwp8r2VchxLhj) |
| `agent_swap`, completed (quote, deposit, swap, withdraw) | agent | 39.33 Tgas | 0.003643 | one spend record, charged to the vault | [`5KeUAq3h…`](https://testnet.nearblocks.io/txns/5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt) |
| `agent_swap`, rejected before the quote | agent | 2.09 Tgas | 0.000186 | none | [`2Xe4Etgk…`](https://testnet.nearblocks.io/txns/2Xe4EtgkgWyS8ocDhHw4PKVKEcS4Caw7uXaFs3zeP3rP) |
| `agent_swap`, rejected after the quote (slippage) | agent | 8.44 Tgas | 0.000777 | none | [`B8i1pkDT…`](https://testnet.nearblocks.io/txns/B8i1pkDTAb3HHXxVDHPveyeEFEU1qFCtuQu2ESq9Sw4r) |
| Contract deployment (code only) | operator | 18.96 Tgas | 0.001874 | 255,271 bytes on the account, 2.55 NEAR staked | [`A3KLQkGa…`](https://testnet.nearblocks.io/txns/A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc) |

What this means for the operator: every vault pays for its own storage and every caller pays its
own gas, so a new owner or agent costs the operator nothing per call. The operator's fixed cost
is the contract's storage stake (2.55 NEAR for this build) plus deployment gas.

## Business model

**Live on mainnet in `vault.intatto.near`, and on testnet in vault-v2.** The testnet canary's
contract (vault-v1) charges no fee. The fee is in [src/fees.rs](src/fees.rs).

A protocol fee of 0.10% (10 basis points) on the output of agent swaps, fixed in the contract code
as a compile-time constant, with no method that can change it. In vault-v2's first fee-paying swap,
[`8CyuVGP6…`](https://testnet.nearblocks.io/txns/8CyuVGP6gKCxSgEsyrXJE56tzi4Nfq7p8g2QFww4sYV2),
0.1 wNEAR became 0.124142266 USDT; the `swap_completed` event shows a fee of 0.000124142 USDT
(`124142266245632723653` of `124142266245632723653642` units, exactly 10 bps rounded down) and
the owner credited the rest. On mainnet, the smoke test's swap
([`JAFaEDBh…`](https://nearblocks.io/txns/JAFaEDBhStuPgwgCyNJKU7mQH2K7evjG328zrhudoaC8))
turned 0.5 wNEAR into 1.887287 USDt: a fee of 0.001887 USDt (`1887` of `1887287` units) and
1.8854 USDt credited to the owner. The fee is taken
from the amount the exchange returns: the owner is credited the output minus the fee, and the fee
accrues to a treasury balance kept separate from owner balances. The treasury account can
withdraw only accrued fees. Spends, deposits, withdrawals and reclaims carry no fee, and neither
does swap output that stays on the exchange because its withdrawal failed. The slippage limit
applies to the gross output, so an owner's worst case per swap is the pool's `max_slippage_bps`
plus 10 bps. Because the
rate is in the code, anyone can verify it from the code hash (step 2).

Per completed swap, the agent pays about 0.0036 NEAR of gas whatever the size (table above). At
0.10%, the fee equals that gas cost on a swap whose output is worth 3.6 NEAR.

## After the hackathon

The mainnet deployment stays live after judging: `vault.intatto.near`, `intents.intatto.near`, the
canary and the board at [intatto.pages.dev](https://intatto.pages.dev/?network=mainnet).

- **The canary stays funded.** Its withdrawal lock ends on 2026-11-20 12:00 UTC; after that the
  owner's key could withdraw, and the owner does not plan to. Under [CANARY.md](CANARY.md)'s rules
  any decrease is a break whoever signs it, so a withdrawal would show on the board as one.
- **Audit, then permanent code.** The contract has not been audited. After an external audit, both
  upgrade keys are removed (the deployer's full-access key on `vault.intatto.near` and the
  full-access key on `intents.intatto.near`), so no one, the operator included, can change the
  code again. Until then they are disclosed above and in [THREAT_MODEL.md](THREAT_MODEL.md).
- **More venues and pairs.** The policy already takes any list of Rhea pools and intent pairs;
  next are more pairs on both paths, chosen by liquidity.
- **Agents that owners run themselves.** Intatto does not run agents, because running one would
  mean holding its key. The MCP server already lets an owner's own AI assistant trade through the
  vault ([INTEGRATE.md](INTEGRATE.md)); next is publishing it to npm and a reference agent on the
  NEAR AI Agent Market ([GTM.md](GTM.md)).
- **Passkeys end to end.** Signing transactions with a passkey, tested and documented, before
  passkey wallets are recommended for more than small amounts.

The 10 bps fee on agent swaps is the revenue model ([Business model](#business-model)): every vault
pays for its own storage and every caller its own gas, so each new vault costs the operator nothing
per call.

## Tracks

- **AI Security & Defense (`security`), primary.** What the track asks for, and where it is here:
  - *Spending limits and a policy engine:* per-trade and 24-hour caps, a receiver allowlist, pool
    and pair allowlists, a slippage bound against the exchange's own quote and price floors, all
    checked by the contract on every agent call ([`src/policy.rs`](src/policy.rs),
    [What the contract guarantees](#what-the-contract-guarantees-and-where-it-is-checked)).
  - *A sandboxed wallet:* the vault holds the money; the agent can trade from it and never
    withdraw, and the owner can freeze it in one call or lock withdrawals until a date.
  - *Function-call keys:* the agent's key can call only the vault's agent methods and cannot attach
    a deposit ([exact limits](#the-agents-function-call-key-exact-limits)).
  - *Scam and risk checks before signing:* the MCP server's pre-trade check returns allow, warn
    or block for every swap, with reasons: thin or manipulated pools, upgradeable tokens, an unsafe
    signing key, and every refusal the contract would make ([INTEGRATE.md](INTEGRATE.md)).
  - *TEE attestation:* the model's trade decisions carry signature receipts from an attested TEE,
    recorded with each trade ([AI decisions, verifiable](#ai-decisions-verifiable)).
  - *Adversarial proof:* the canary's agent key is public on mainnet and the board shows every
    attempt and the contract's reason for refusing it; on mainnet, an agent that obeyed a prompt
    injection telling it to drain its vault was refused every time it tried
    ([Prompt-injection attack](#prompt-injection-attack-the-agent-was-told-to-drain-the-vault)).
    The deployed code is checked live against its reproducible build, and every trust assumption
    is written down in [THREAT_MODEL.md](THREAT_MODEL.md).
- **Unstoppable DeFi (`defi`).** A vault and a trading agent that settles through NEAR Intents,
  with no custodian of the agent's key: swaps go through Rhea (Ref V1)
  under on-chain pool, pair, cap and slippage rules, the slippage checked against the exchange's
  own quote, with a 10 bps protocol fee fixed in the code (live on mainnet). Agent swaps also go
  through NEAR Intents, signed by the MPC network for the vault's own account and checked against
  the owner's pair allowlist and price floors (live on mainnet, [CHAIN_SIGNATURES.md](CHAIN_SIGNATURES.md)).
- **Agent Economy (`agents`).** It gives an agent a wallet it can spend from without holding the
  owner's key, within a budget the owner sets and can freeze at any time.

## Built during the hackathon

The hackathon counts code written from the 2026-10-19 announcement onward (the organizers' hackathon
FAQ, Q-001; the FAQ is not part of this repository).
The first commit, [`aff5964`](https://github.com/UEddy/Intatto/commit/aff5964) on 2026-11-02, is the
unmodified `cargo near new` project template (its author is `nearprotocol-ci`). Every later commit
is this project's own work, from 2026-11-02 onward (`git log --format='%h %ad %s' --date=iso`).
Nothing was written before the window.

- There is no existing product on another chain (Q-002).
- This is the author's only NEAR Hackathon submission (Q-015).

## Libraries and tools

Contract (Rust, toolchain 1.93.0):
- [near-sdk](https://crates.io/crates/near-sdk) 5.29.1
- Build: [cargo-near](https://github.com/near/cargo-near) 0.22.0; the reproducible build uses the image `sourcescan/cargo-near:0.21.1-rust-1.96.0`
- Tests: near-sandbox 0.3.12, near-api 0.8, cargo-near-build 0.11.0, tokio, testresult
- Test binaries from testnet: ref-exchange 1.9.19 (Rhea / Ref V1) and wrap.testnet's wNEAR contract ([tests/res/README.md](tests/res/README.md))

Web app (TypeScript):
- Runtime: React 19.3.1, react-router 8.5.1, TanStack Query 5.107.1, zod 4.6.7, [near-connect](https://github.com/NEAR-DevHub/near-connect) at `f2fc970`, vendored in `web/vendor/near-connect`
- Fonts: Bodoni Moda, Instrument Sans, JetBrains Mono (Fontsource)
- Build and tests: Vite 8.3.6, TypeScript 6.0.3, Vitest 5.1.0, Playwright 1.65.0, Testing Library, jsdom, fake-indexeddb

Scripts: [near-cli-rs](https://github.com/near/near-cli-rs) 0.30.1, bash, Python 3.

Services: FastNEAR RPC and transactions API, and the NearBlocks API as a fallback indexer.

## Repository layout

| Path | What |
|---|---|
| `src/` | The vault contract: `lib.rs` (deposit, withdraw, views), `policy.rs`, `spend.rs`, `swap.rs`, `callbacks.rs`, `tokens.rs`, `ledger.rs`, `lock.rs`, `storage.rs`, `events.rs`, and the NEAR Intents path in `intents.rs` and `intent_swap.rs`; unit tests in `tests.rs` |
| `tests/` | Sandbox tests, the contract binaries they deploy (`tests/res/`) and the mock MPC signer (`tests/contracts/`) |
| `agent/` | The prompt-injection demo agent, the intent-swap agent, the MCP server (`mcp-server.mjs`) and the pre-trade check (`risk-check.mjs`) (Node, no npm packages of their own; the AI receipt check uses `web/`'s pinned `@noble` packages) |
| `web/` | Owner console and canary board (React, Vite) |
| `scripts/` | Testnet smoke tests and canary setup; mainnet deploy, canary, smoke, intents and teardown scripts, dry run by default and resumable (near-cli-rs) |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Invariants, trust assumptions, what counts as a canary break |
| [CANARY.md](CANARY.md) | The public canaries, mainnet and testnet: accounts, keys, baselines, how to try |
| [CHAIN_SIGNATURES.md](CHAIN_SIGNATURES.md) | The NEAR Intents path: calls, the mainnet run, its transactions |
| [INTEGRATE.md](INTEGRATE.md) | Putting an agent on a vault: the MCP server, the pre-trade check, or any signer |
| [GTM.md](GTM.md) | Go-to-market: first users, distribution, pricing, launch sequence, metrics |

## Status and known gaps

- The contract has not been audited.
- On mainnet, `vault.intatto.near` runs the reproducible build of commit `6cfa90e` (code hash
  `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J`, sha256
  `2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5`), built in CI by the
  [Reproducible build](.github/workflows/reproducible-build.yml) workflow in
  [run 43022039828](https://github.com/UEddy/Intatto/actions/runs/43022039828);
  [scripts/mainnet-deploy.sh](scripts/mainnet-deploy.sh) deploys nothing else. `intents.intatto.near`
  runs the reproducible build of commit `fc23fbc` (`HRkrMN8o…`, run 43063218549).
- The deployer keeps a full-access key on both vault accounts on purpose, so that a bug in the
  unaudited code can be fixed and no owner's funds are ever stuck
  ([why](#why-the-upgrade-keys-stay-until-the-audit)). That key can replace the code. For the canary's vault, the board's
  integrity check shows any change within 10 seconds ([CANARY.md](CANARY.md)). Both keys are
  removed after an external audit ([After the hackathon](#after-the-hackathon)).
- The NEAR Intents path has settled two swaps on mainnet, the second decided by NEAR AI (2026-11-13). Its limits and trust assumptions (the MPC
  network, `intents.near` governance) are in [THREAT_MODEL.md](THREAT_MODEL.md).
- vault-v2 runs a non-reproducible build of the fee code (code hash above), so its code cannot be
  checked against source; vault-v1 and both mainnet vaults use reproducible builds.
- Passkey sign-in (mainnet only), experimental: sign-in verified on a phone (2026-11-12); signing transactions with a passkey not yet tested. Unaudited Trezu wallet contract, upgradeable by Trezu; use small amounts only.
- The mainnet deployment stays live after the hackathon. [scripts/mainnet-teardown.sh](scripts/mainnet-teardown.sh)
  remains in the repository as the operator's way to wind it down safely if ever needed.
- The web app is hosted at [intatto.pages.dev](https://intatto.pages.dev/?network=mainnet)
  (mainnet by default; testnet through the network switch).

## License

[MIT](LICENSE).

[^banana-gun]: The Block: <https://www.theblock.co/post/318074/banana-gun-exploit-refund>
