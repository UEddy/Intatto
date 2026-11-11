# Sandbox test contracts

Real contract binaries the sandbox tests deploy. The tests check each file's SHA-256 against the
hash below before using it.

| File | Source | Version | SHA-256 (base58) |
|---|---|---|---|
| `ref_exchange_v1.9.19.wasm` | Code of `ref-finance-101.testnet`, the Rhea (Ref) V1 exchange on testnet, fetched with RPC `view_code` on 2026-11-02 | ref-exchange 1.9.19 (`metadata().version`) | `AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX` |
| `intatto_v1.wasm` | Code of `vault-v1.intatto-dev.testnet`, fetched with RPC `view_code` on 2026-11-06 (block 276504614) | this repo at commit b597c1f (`cargo near build non-reproducible-wasm`) | `HGa6MDknypEa691JxbEp95zCCW72NQ45MZsWXgy7MNot` |
| `ref_exchange_v1.9.21.wasm` | Code of `v2.ref-finance.near`, the Rhea (Ref) V1 exchange on mainnet, fetched with RPC `view_code` on 2026-11-09 (block 223785783) | ref-exchange 1.9.21 (`metadata().version`) | `GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi` |
| `intatto_j5mo.wasm` | Code of `vault-v1.intatto-dev.testnet` since 2026-11-08, fetched with RPC `view_code` on 2026-11-09 (block 276908989) | this repo at commit b85cece (`cargo near build reproducible-wasm`), the build before the swap fee | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL` |
| `w_near.wasm` | Code of `wrap.testnet`, fetched with RPC `view_code` on 2026-11-02 | wrapped NEAR (NEP-141) | `DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa` |
| `intatto_3z1w5.wasm` | Reproducible build of master's mainnet commit `6cfa90e00890a510750d248b24dae0f86b5211be` (the code `scripts/mainnet-deploy.sh` deploys), rebuilt on 2026-11-11 by running cargo-near 0.22.0's container command (`sourcescan/cargo-near:0.21.1-rust-1.96.0`, image pinned by digest in that commit's Cargo.toml, `cargo near build non-reproducible-wasm --locked` with the NEP-330 variables naming that commit) with host networking added for crate downloads; its embedded source metadata names that commit | the swap-fee build, master's current contract | `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J` (sha256 hex `2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5`), the hashes published in README.md and `.github/workflows/reproducible-build.yml` |
| `intents_near_0.4.5.wasm` | Code of `intents.near`, the NEAR Intents Verifier on mainnet, fetched with RPC `view_code` on 2026-11-11 (block 224083628) | defuse 0.4.5, built from near/intents `16d04f6ec4401263f8914638710260da50bb46b0` (`contract_source_metadata`) | `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` (sha256 hex `a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547`) |

The exchange hash also matches `ref_exchange_release_v1919.wasm` and the 1.9.19 entry in the
release notes of the ref-contracts source (`ref-exchange/release_notes.md`).

The swap tests run against 1.9.19 by default, and against the mainnet binary with
`INTATTO_TEST_EXCHANGE=1.9.21`. Compared with 1.9.19, 1.9.21 exports eight more methods, all for a
user blacklist (`extend_blacklisted_users`, `is_blacklisted_user`, ... and its managers), and
changes one error text (E111). Every other test behaves the same on both.
`blacklisted_vault_on_1_9_21_*` in `tests/swap.rs` check what the blacklist does to the vault.

The tests deploy `w_near.wasm` twice: once as wNEAR, and once more as a stand-in stablecoin. Its
`near_deposit` mints tokens 1:1 for attached NEAR, which makes it easy to fund pools.

The Chain Signatures tests (`tests/chain_signatures.rs`) deploy `intents_near_0.4.5.wasm` as the
Verifier, initialized with a sandbox DAO account holding the DAO role, so they can also exercise
what intents.near governance can do to the vault's account there (salt invalidation, nonce
cleanup). The MPC signer has no binary here: `tests/contracts/mock-mpc-signer` is built from
source by the tests. It keeps `v1.signer`'s interface (`sign` with yield-resume,
`derived_public_key`, `fail_on_timeout`), and a sandbox account plays the MPC nodes.

`master_3z1w5_state_survives_the_intents_upgrade` in `tests/chain_signatures.rs` deploys
`intatto_3z1w5.wasm`, writes state with it (two owners, token balances, a spend, a withdrawal
lock), replaces it with the current build, checks that every view reads back unchanged, and then
runs an intent swap end to end on the upgraded vault.

`tests/upgrade.rs` deploys `intatto_v1.wasm`, writes state with it, then replaces it with the
current build to check that the current code reads v1 state unchanged.
`j5mo_state_survives_a_code_upgrade_and_later_swaps_pay_the_fee` in `tests/swap.rs` does the same
from `intatto_j5mo.wasm`, with a swap and a withdrawal lock in the state.
