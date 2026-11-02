# Sandbox test contracts

Real contract binaries the sandbox tests deploy. The tests check each file's SHA-256 against the
hash below before using it.

| File | Source | Version | SHA-256 (base58) |
|---|---|---|---|
| `ref_exchange_v1.9.19.wasm` | Code of `ref-finance-101.testnet`, the Rhea (Ref) V1 exchange on testnet, fetched with RPC `view_code` on 2026-11-02 | ref-exchange 1.9.19 (`metadata().version`) | `AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX` |
| `w_near.wasm` | Code of `wrap.testnet`, fetched with RPC `view_code` on 2026-11-02 | wrapped NEAR (NEP-141) | `DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa` |

The exchange hash also matches `ref_exchange_release_v1919.wasm` and the 1.9.19 entry in the
release notes of the ref-contracts source (`ref-exchange/release_notes.md`).

The tests deploy `w_near.wasm` twice: once as wNEAR, and once more as a stand-in stablecoin. Its
`near_deposit` mints tokens 1:1 for attached NEAR, which makes it easy to fund pools.
