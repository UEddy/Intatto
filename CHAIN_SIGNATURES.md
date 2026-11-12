# Chain Signatures intents path (branch `chain-signatures`)

An agent swap through NEAR Intents. The vault's own account on `intents.near` is signed for by
the MPC network (`v1.signer`, domain 1, Ed25519). The agent picks a pair and two amounts. The
vault checks them against the owner's policy, then builds the NEP-413 `token_diff` itself, has
it signed, and settles it by asking `intents.near` whether the nonce was used. Master does not
depend on any of this.

Invariants 14 to 18 and the trust assumptions (MPC 11-of-16, intents.near governance, the vault
account's full-access key) are in
[THREAT_MODEL.md](THREAT_MODEL.md#chain-signatures-intents-path-branch-chain-signatures-live-on-mainnet).

## Live on mainnet, 2026-11-11

One real agent intent swap settled on mainnet: **0.3 wNEAR for 1.130742 USDt**. That is 3.769
USDt per wNEAR, against the owner's floor of 3.3, which is a floor, not a target (see
THREAT_MODEL.md).

| | |
|---|---|
| Vault | `intents.intatto.near`, a new account. The canary's `vault.intatto.near` was not touched and still runs `3z1W5Sfh…`. |
| Its code | commit `fc23fbc3abee3d503ecaeb5ced56d315374cdc20`, code hash `HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC`, built by the Reproducible build workflow (run 43063218549) and checked by `scripts/mainnet-intents.sh` before deploy |
| Bound to | `intents.near` (defuse 0.4.5) and `v1.signer` (3.18.0), via `setup_intents`, for good |
| Its key on intents.near | `ed25519:5kYTxFESA4ciqDeFz5j5YqsY2sSC9WN2YN5hBNRpCgWi`, the only key, equal to `v1.signer` `derived_public_key(intatto/intents.near/v1, intents.intatto.near, 1)` |
| Owner | `intents-owner.intatto.near`. Its policy moves no NEAR and allows selling at most 0.3 wNEAR per swap and per 24 h. Its intent policy allows wNEAR → USDt only, at ≥ 3.3 USDt per wNEAR. |
| Agent | `intents-agent.intatto.near`, with a function-call key for `agent_intent_swap` and `settle_intent_swap` on the vault only (1 NEAR gas allowance) |
| Funder, treasury | `intatto.near`; `eddyhamezz.near` |

What happened, all at 17:46 UTC:
- **:06** The agent took the Message Bus's quote (`4N12BfiR…`), then called `agent_intent_swap`
  with exactly that pair and those amounts. In the same transaction, the vault:
  - checked the policy and reserved the 0.3 wNEAR;
  - built the NEP-413 payload, asked `v1.signer` to sign it, and checked the answer against its
    registered key;
  - logged the signed payload.
- **:15** The relay submitted it with the solver's intent (`intentfolio-vault.near`).
- **:18** The settle call found the nonce used and credited the owner.

The signed message, byte for byte:

```json
{"signer_id":"intents.intatto.near","deadline":"2026-11-11T17:51:07Z","intents":[{"intent":"token_diff","diff":{"nep141:wrap.near":"-300000000000000000000000","nep141:usdt.tether-token.near":"1130742"}}]}
```

Its nonce (`Vij2xgAlKBKzAK7Wg2hE8BgAAAAAAAAAAHfXH7YqrrM=`) is a V1 versioned nonce:
intents.near's salt `252812b3`, a nonce deadline 30 days after the intent's deadline, and swap
id 0. The NEP-413 hash of that payload, recomputed independently, is
`5aGuMWbXy1QM5ocroB2mkvTagtHmYvxze5KY1jLvwmUi`: the intent hash intents.near executed and the
relay reported.

intents.near's `token_diff` event for `intents.intatto.near` is exactly the signed diff: wNEAR
`-300000000000000000000000`, USDt `+1130742`. The protocol fee (1 pip, 0.0000003 wNEAR) came out
of the solver's side.

Gas: `agent_intent_swap` burnt 21.83 TGas (0.002049 NEAR), `v1.signer`'s receipts included;
`settle_intent_swap` burnt 8.59 TGas (0.000792 NEAR).

`scripts/mainnet-intents.sh check` after the swap passes 18 of 18 checks. intents.near holds
1.130742 USDt and 0 wNEAR for the vault, all of it credited to the owner, and nothing is
unsettled.

### Transactions

Setup (`scripts/mainnet-intents.sh --send`, every step PASS):

| # | Step | Transaction |
|---|---|---|
| 1 | create intents.intatto.near with 4.19254 NEAR | [`4hmHDx2t…`](https://nearblocks.io/txns/4hmHDx2tRSUunBX7UJpt9muhrkr6UNAchdHTnho1FxhE) |
| 2 | deploy HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC (commit fc23fbc) to intents.intatto.near with new({"exchange_id":"v2.ref-finance.near","treasury_id":"eddyhamezz.near"}) | [`6vcbjSzE…`](https://nearblocks.io/txns/6vcbjSzEWVpamvF42zxSga4P66pgpEf1Zpe4CMVGRoxd) |
| 3 | create intents-owner.intatto.near with 0.7 NEAR | [`FCCx7oEv…`](https://nearblocks.io/txns/FCCx7oEve7iAFewh7k7ehy2wdS9bKNaTLT8DYS5CBJsK) |
| 4 | create intents-agent.intatto.near with 0.35 NEAR | [`8NB17xx6…`](https://nearblocks.io/txns/8NB17xx6tpsH32Ss4bdvMQpC9MijQa1bKEpozcU3JB5L) |
| 5 | bind intents.intatto.near to intents.near and v1.signer (once, for good) | [`8q32sfmL…`](https://nearblocks.io/txns/8q32sfmLfrpDuHkcJzNdFccHsU4Fwdzb78hCwNyP7stM) |
| 6 | register the vault's key: v1.signer derived_public_key(intatto/intents.near/v1, intents.intatto.near, 1) on intents.near, then check it is the only key | [`7DTFZe3w…`](https://nearblocks.io/txns/7DTFZe3w6y8DCEH5iCm4FCBKnKiPB4VSdaXHN5MHc6rp) |
| 7 | register intents.intatto.near on wrap.near | [`6x24zkvU…`](https://nearblocks.io/txns/6x24zkvUvoNzG5gC8DdHhQWLFv6HZiT8GdJ6jzMNSFU7) |
| 8 | register intents.intatto.near on usdt.tether-token.near | [`FYYHdCJh…`](https://nearblocks.io/txns/FYYHdCJhfi1kJYmyYZHx4LFGspLRrEMgiv3DCw9Yz3kU) |
| 9 | intents-owner.intatto.near deposits 0.1 NEAR (its records' storage and the signer's deposits) | [`3DBv3D2D…`](https://nearblocks.io/txns/3DBv3D2DAsiPZdRe9T6jcTKxX63HCc8pwHYnchD6joi9) |
| 10 | set_agent(intents-agent.intatto.near): no NEAR out; sell at most 0.3 wNEAR per swap and per 24h | [`5n5BeBUW…`](https://nearblocks.io/txns/5n5BeBUWaWugsPueYTgUfLazX4em1sxEUaC7KK38mWye) |
| 11 | register intents-owner.intatto.near on wrap.near | [`5niT2C7B…`](https://nearblocks.io/txns/5niT2C7BzNPhXHp7jAiU3dN56XYHZUoW4ccpfJXXvDF9) |
| 12 | register intents-owner.intatto.near on usdt.tether-token.near | [`EMTdkPQg…`](https://nearblocks.io/txns/EMTdkPQgf81XR2qhuRhTH9UmBh6c6qYWg1neiiPZqfHi) |
| 13 | wrap 0.3 NEAR | [`Djx47Wxe…`](https://nearblocks.io/txns/Djx47WxeNsGxLdZS867BaYd1PsTqHb7BvvhQtuiVrd6D) |
| 14 | deposit 0.3 wNEAR into intents.intatto.near | [`9J2Ngcts…`](https://nearblocks.io/txns/9J2NgctsL2oZxotVGqqrCrSJUW1CSdtXE3LFvQewjGux) |
| 15 | move 0.3 wNEAR into the vault's account on intents.near (ft_transfer_call as the vault) | [`8h9pYfRe…`](https://nearblocks.io/txns/8h9pYfReowgUk84gPPxF4oMfUbomypAEa9A3MNoazmDD) |
| 16 | set_intent_policy: wNEAR -> USDt only, at no less than 3.3 USDt per wNEAR | [`97GtBwrJ…`](https://nearblocks.io/txns/97GtBwrJVuLVN8kUedSQEFZEjZtDDQeHujjDofmA45pm) |
| 17 | add a function-call key to intents-agent.intatto.near: agent_intent_swap,settle_intent_swap on intents.intatto.near, 1 NEAR allowance | [`97zDDovC…`](https://nearblocks.io/txns/97zDDovC8wyBnvobdjxaY9LKQVhp2Hhxon2yEPqbwFP1) |

Swap (`scripts/mainnet-intents.sh swap --send`, which ran `agent/intent-swap.mjs`):

| Step | Signer | Transaction |
|---|---|---|
| `agent_intent_swap`: checks, reserve, MPC signature, signed payload logged | `intents-agent.intatto.near` | [`GbHfV9nq…`](https://nearblocks.io/txns/GbHfV9nqv8C3xXWCFECWaruJFaQijMhq2GBrKxb1uJjT) |
| `execute_intents` with the solver's intent: intent `5aGuMWbXy1QM5ocroB2mkvTagtHmYvxze5KY1jLvwmUi` executed | the relay (`intents.near` relayer key) | [`EJY7oiU1…`](https://nearblocks.io/txns/EJY7oiU1SE3w9kg94qhwdcsn2zxFWEZ3eykbVnvUCLUE) |
| `settle_intent_swap`: nonce used, owner credited 1.130742 USDt (`intent_swap_settled`) | `intents-agent.intatto.near` | [`73aJTu55…`](https://nearblocks.io/txns/73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE) |

All 20 were checked over RPC on 2026-11-11: every one succeeded, with no failed receipt.

## Calls

| Call | Who | What |
|---|---|---|
| `setup_intents(intents_id, signer_id)` | vault account only, once | binds the Verifier and the MPC signer for good |
| `register_intents_key()` | anyone, 1 yoctoNEAR, 150 TGas | reads `derived_public_key(intatto/intents.near/v1, vault, 1)` from the signer, `add_public_key` on the Verifier, then checks `public_keys_of(vault)` is exactly that key |
| `verify_intents_key()` | anyone, 60 TGas | re-runs that check; a second key stops intent swaps |
| `deposit_to_intents(token_id, amount)` | owner, 1 yoctoNEAR | vault balance → the vault's intents account (`ft_transfer_call`, as the vault) |
| `withdraw_from_intents(token_id, amount)` | owner, 1 yoctoNEAR | back (`ft_withdraw`, as the vault, to the vault) |
| `set_intent_policy({pairs: [{token_in, token_out, min_out, per_in}]})` | owner, 1 yoctoNEAR, not while locked | the pair allowlist and price floors; token_in also needs caps in `Policy::tokens` |
| `agent_intent_swap(owner_id, token_in, token_out, amount_in, amount_out)` | agent, 150 TGas | checks, salt, reserve, MPC signature; logs `intent_swap_signed` with the `MultiPayload` |
| `settle_intent_swap(intent_id)` | anyone, 100 TGas | `is_nonce_used` → credit `amount_out`; after the deadline, `is_valid_salt` → refund or leave unresolved |
| `get_intents_config()`, `get_intents_balances(owner_id)`, `get_intent_policy(owner_id)`, `get_intent_swap(intent_id)` | views | |

Signed intents expire 300 s after they are accepted. Their nonces stay valid 30 days longer,
which is the window in which settlement gives a definite answer.

## Tests

`cargo test` runs everything. `tests/chain_signatures.rs` deploys the vendored mainnet
`intents.near` 0.4.5 binary, checked by code hash, and `tests/contracts/mock-mpc-signer`, which
keeps v1.signer's `sign` / yield-resume / `derived_public_key` interface. A sandbox account plays
the MPC nodes. The end-to-end test has a sandbox solver fill the vault's signed intent on the real
Verifier. `master_3z1w5_state_survives_the_intents_upgrade` writes state with master's
reproducible build (code hash `3z1W5Sfh…`), upgrades the code in place, and then runs an intent
swap on that vault.

```bash
cargo test --test chain_signatures
node --test agent/*.test.mjs
```

## Mainnet run: `scripts/mainnet-intents.sh`

The operator runs it; nothing runs it automatically. It is built on `scripts/lib/mainnet.sh`, as
the other mainnet scripts are:
- **Dry run by default.** It reads live state and prints every transaction and its cost.
- **Typed confirmation** before anything is sent.
- **Live costs.** Static fees and the account creation charge come from the live protocol
  config, and the gas each signer must hold at once is priced at the purchase price.
- **Fit checks.** Every signer's balance and every function-call key's allowance is checked;
  `--send` refuses a plan that does not fit.
- **Safe resume.** Each step is skipped when already done. An existing account is accepted only
  if it is exactly what the plan left.

The script also refuses `vault.intatto.near` (the canary stays on `3z1W5Sfh…`) and any account
already running other code. It refuses intents.near or v1.signer if their code or version
differ from what the sandbox suite ran against.

**The wasm comes only from the Reproducible build workflow.** Run
[Reproducible build](.github/workflows/reproducible-build.yml) (Actions → Reproducible build →
Run workflow) with commit `fc23fbc3abee3d503ecaeb5ced56d315374cdc20`, then download its
`intatto-wasm-…` artifact. The script deploys only a wasm with exactly these values, recorded in
the script and not overridable:

| | |
|---|---|
| code hash | `HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC` |
| sha256 | `f41283390697530c7a446a9509dd73269e34e12932a1e76e2ac2895ddf191bd7` |
| size | 394,254 bytes |

The wasm's source metadata must also name that commit.

These values come from the same build reproduced locally on 2026-11-11. It ran in the workflow's
pinned image, `sourcescan/cargo-near:0.21.1-rust-1.96.0` by digest, with host networking for
crate downloads, because Docker on that WSL host could not resolve crates.io. That exact binary
passes `cargo test` (154 tests). If the workflow's artifact differs, the script refuses it: the
build is then not reproducible, and that needs looking into, not overriding.

```bash
# 1. Setup: intents.intatto.near, its owner and agent, all paid by intatto.near.
TREASURY_ID=eddyhamezz.near WASM=<artifact>/intatto.wasm scripts/mainnet-intents.sh          # dry run
TREASURY_ID=eddyhamezz.near WASM=<artifact>/intatto.wasm scripts/mainnet-intents.sh --send   # type 'send intents.intatto.near'
# 2. The swap: the agent sells 0.3 wNEAR for USDt through NEAR Intents.
TREASURY_ID=eddyhamezz.near scripts/mainnet-intents.sh swap          # plans, fit-checks, and runs the agent's own --dry-run
TREASURY_ID=eddyhamezz.near scripts/mainnet-intents.sh swap --send   # type 'send swap 0.3'
```

The setup stage creates three accounts:
- `intents.intatto.near`, funded for its code storage;
- `intents-owner.intatto.near`, which wraps 0.3 NEAR, moves it into the vault's intents account,
  and allows only wNEAR → USDt at no less than 3.3 USDt per wNEAR;
- `intents-agent.intatto.near`, with a function-call key limited to `agent_intent_swap` and
  `settle_intent_swap` on the vault, 1 NEAR of gas allowance.

It then checks the result:
- the code hash, exchange, treasury and fee;
- that the vault is bound to intents.near and v1.signer;
- exactly one key on intents.near for the vault, equal to v1.signer's
  `derived_public_key(intatto/intents.near/v1, intents.intatto.near, 1)`;
- both policies, the four token registrations and the agent key;
- that `vault.intatto.near` still runs `3z1W5Sfh…`.

The swap stage first settles any intent swap left unsettled by an earlier run. It then runs
`agent/intent-swap.mjs` with the agent's key file. It passes the agent the file path, never the
key itself, through argv or the environment. Done means the
check "the intent swap settled" passes.

The dry run of 2026-11-11 (gas price 1e8, purchase price 1e9) planned 17 setup steps.
`intatto.near` must hold **5.2678649686125 NEAR** at once and spends at most 5.2660449686125 NEAR;
it held 1.5906550313875 NEAR, so it needed **3.677209937225 NEAR** more. Every other signer, and
the agent key's allowance, fit what the plan gives them. Rerun the dry run before sending: it
prints the exact figure for that moment.

The Message Bus key (`~/.config/intatto/intents.env`, `NEAR_INTENTS_JWT`, mode 600) is a
Partner Portal **Distribution Channel** key. The docs document Message Bus access for KYC'd
market-maker keys only. The live swap's `publish_intent`, sent with this key, returned OK and the
relay settled it. But earlier probes found the relay answering `quote`, `publish_intent` and
`get_status` identically with this key, a malformed key and no key. So whether the key was
required, or recognized, is still unverified. If
the relay starts enforcing keys and refuses this type, the fallback is a market-maker key from
the Partner Portal.
