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

## Mainnet run (done by the operator, not by any script here)

Nothing in this repository deploys or signs on mainnet for this path. These are the steps for
the one real swap the cutoff asks for, with the values used in the tests. `<vault>` is a **new**
account, not master's vault. `<owner>`, `<agent>` and `<treasury>` are accounts you control.
Commands are near-cli-rs 0.30.1, as in the README.

1. **Build and check.** Run `cargo near build reproducible-wasm` at the commit you deploy, then
   `INTATTO_TEST_WASM=target/near/intatto.wasm cargo test`. The code is ~400 KB, so the account
   needs about 4 NEAR staked for it, plus gas.

   Commit `fc23fbc3abee3d503ecaeb5ced56d315374cdc20` has already been built in the pinned image
   and passes `cargo test` (154 tests) as that exact binary:

   | | |
   |---|---|
   | code hash | `HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC` |
   | sha256 | `f41283390697530c7a446a9509dd73269e34e12932a1e76e2ac2895ddf191bd7` |
   | bytes | 394,254 |

   The build ran the container command cargo-near 0.22.0 prints for `reproducible-wasm`
   (`sourcescan/cargo-near:0.21.1-rust-1.96.0` by digest, with the NEP-330 variables naming that
   commit), plus `--network host`, because Docker on this WSL host cannot resolve crates.io
   otherwise. Its source metadata links to GitHub, so push the commit before anyone verifies it.
2. **Deploy to a fresh account** with `new(exchange_id: "v2.ref-finance.near", treasury_id: "<treasury>")`.
3. **Bind the Verifier and signer, as the vault account:**
   `near contract call-function as-transaction <vault> setup_intents json-args '{"intents_id":"intents.near","signer_id":"v1.signer"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as <vault> network-config mainnet sign-with-keychain send`
4. **Register the key (anyone):**
   `... <vault> register_intents_key json-args '{}' prepaid-gas '150.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> ...`.
   Then check that `get_intents_config` shows `"key_verified": true`, and that
   `intents.near public_keys_of {"account_id":"<vault>"}` lists exactly that one key.
5. **Register the vault with both tokens:** `storage_deposit` on `usdt.tether-token.near` and
   `wrap.near` for `<vault>`, 0.00125 NEAR each.
6. **As the owner:**
   - `deposit` 0.5 NEAR.
   - `set_agent` with `agent_id: <agent>` and a policy with no NEAR outflow (`per_tx_cap`
     `"0"`, `daily_cap` `"0"`, empty `allowlist`, `max_spends_per_24h` 5). Its `tokens` give
     USDT `per_tx_cap` `"1000000"` / `daily_cap` `"2000000"`, and wNEAR
     `"300000000000000000000000"` / `"600000000000000000000000"`.
   - Send 1 USDT to `<vault>` (`ft_transfer_call`, `msg ""`), then
     `deposit_to_intents {"token_id":"usdt.tether-token.near","amount":"1000000"}`.
   - `set_intent_policy` with USDT→wNEAR at a floor of 0.25 wNEAR per USDT
     (`min_out` `"250000000000000000000000"`, `per_in` `"1000000"`), and wNEAR→USDT at 3.3 USDT
     per wNEAR (`min_out` `"3300000"`, `per_in` `"1000000000000000000000000"`). Set the floors
     from the market on the day.
7. **Give the agent a function-call key** for `<vault>` only, methods `agent_intent_swap` and
   `settle_intent_swap`, allowance 0.25 NEAR. Put its private key in `agent/.env` as
   `INTENT_AGENT_KEY=ed25519:...` (gitignored).
8. **Run the agent:** first with `--dry-run`, which quotes and checks everything but sends
   nothing, then without it:
   `node agent/intent-swap.mjs --vault <vault> --owner <owner> --agent <agent> --token-in usdt.tether-token.near --token-out wrap.near --amount-in 1000000`.
   The run is logged to `agent/runs/` (gitignored, secrets redacted). Done means the
   `settle_intent_swap` step logs `intent_swap_settled`, and `get_intents_balances` shows the
   wNEAR.
9. **Bring the output home** with `withdraw_from_intents`, then `withdraw_token`.

The Message Bus key (`~/.config/intatto/intents.env`, `NEAR_INTENTS_JWT`, mode 600) is a
Partner Portal **Distribution Channel** key. The docs document Message Bus access for KYC'd
market-maker keys only. On 2026-11-11 the relay answered `quote`, `publish_intent` and
`get_status` identically with this key, a malformed key and no key, so it did not enforce keys,
and whether it accepts this key type is unverified. A real `publish_intent` has not been sent. If
the relay starts enforcing keys and refuses this type, the fallback is a market-maker key from
the Partner Portal.
