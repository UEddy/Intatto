# Sandbox test contracts

Real contract binaries the sandbox tests deploy. The tests check each file's SHA-256 against the
hash below before using it.

| File | Source | Version | SHA-256 (base58) |
|---|---|---|---|
| `ref_exchange_v1.9.19.wasm` | Code of `ref-finance-101.testnet`, the Rhea (Ref) V1 exchange on testnet, fetched with RPC `view_code` on 2026-11-02 | ref-exchange 1.9.19 (`metadata().version`) | `AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX` |
| `intatto_v1.wasm` | Code of `vault-v1.intatto-dev.testnet`, fetched with RPC `view_code` on 2026-11-06 (block 276504614) | this repo at commit b597c1f (`cargo near build non-reproducible-wasm`) | `HGa6MDknypEa691JxbEp95zCCW72NQ45MZsWXgy7MNot` |
| `intatto_j5mo.wasm` | Code of `vault-v1.intatto-dev.testnet` since 2026-11-08, fetched with RPC `view_code` on 2026-11-09 (block 276908989) | this repo at commit b85cece (`cargo near build reproducible-wasm`), the build before the swap fee | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL` |
| `w_near.wasm` | Code of `wrap.testnet`, fetched with RPC `view_code` on 2026-11-02 | wrapped NEAR (NEP-141) | `DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa` |

The exchange hash also matches `ref_exchange_release_v1919.wasm` and the 1.9.19 entry in the
release notes of the ref-contracts source (`ref-exchange/release_notes.md`).

The tests deploy `w_near.wasm` twice: once as wNEAR, and once more as a stand-in stablecoin. Its
`near_deposit` mints tokens 1:1 for attached NEAR, which makes it easy to fund pools.

`tests/upgrade.rs` deploys `intatto_v1.wasm`, writes state with it, then replaces it with the
current build to check that the current code reads v1 state unchanged.
`j5mo_state_survives_a_code_upgrade_and_later_swaps_pay_the_fee` in `tests/swap.rs` does the same
from `intatto_j5mo.wasm`, with a swap and a withdrawal lock in the state.
