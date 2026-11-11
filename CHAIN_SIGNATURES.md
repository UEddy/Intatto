# Chain Signatures intents path (branch `chain-signatures`)

An agent swap through NEAR Intents. The vault's own account on `intents.near` is signed for by
the MPC network (`v1.signer`, domain 1, Ed25519). The agent picks a pair and two amounts. The
vault checks them against the owner's policy, then builds the NEP-413 `token_diff` itself, has
it signed, and settles it by asking `intents.near` whether the nonce was used. Master does not
depend on any of this.

Invariants 14 to 18 and the trust assumptions (MPC 11-of-16, intents.near governance) are in
[THREAT_MODEL.md](THREAT_MODEL.md#chain-signatures-intents-path-branch-chain-signatures-not-deployed).

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
market-maker keys only. On 2026-11-11 the relay answered `quote`, `publish_intent` and
`get_status` identically with this key, a malformed key and no key, so it did not enforce keys,
and whether it accepts this key type is unverified. A real `publish_intent` has not been sent. If
the relay starts enforcing keys and refuses this type, the fallback is a market-maker key from
the Partner Portal.
