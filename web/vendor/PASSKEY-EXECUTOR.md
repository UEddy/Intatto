# The passkey executor, self-hosted

`web/public/wallets/passkey-executor-798e9e5.js` is `passkey-executor.js` from
[NEAR-DevHub/near-connect-passkey](https://github.com/NEAR-DevHub/near-connect-passkey) at commit
`798e9e514d2b92365639927f6bbffd448cb15c60` (2026-11-07), unchanged.

| | |
|---|---|
| sha256 | `2d289931d4dcefbbe84ab486616b5002d460cc9dae71f0de99c5aad74fd1a3b9` |
| Size | 402,711 bytes |
| Checked | In a clean worktree of that commit, `cd executor && npm ci --ignore-scripts && npx vite build` rebuilds `passkey-executor.js` byte for byte (2026-11-09). |
| Served at | `<site base>wallets/passkey-executor-798e9e5.js`; the manifest entry is in `src/wallet/passkey.ts` |

What it contacts: only NEAR RPC, through the providers the page passes (the configured mainnet RPC,
already in the CSP), falling back to `free.rpc.fastnear.com` and `rpc.mainnet.near.org` only when
none are passed. Through RPC it reads the registry `passkeys-registry.near`, and sends transactions
to the sponsor `helper.trezu.near` and the registry with the public function-call keys it embeds.
No `eval` or dynamic code. Its `innerHTML` use is inside its own sandboxed iframe.

To change it: rebuild the new commit the same way, compare, copy it under a new file name, and
update `PASSKEY_EXECUTOR_COMMIT` and `PASSKEY_EXECUTOR_SHA256` in `src/wallet/passkey.ts`. The
manifest `version` follows the commit, so browsers drop the cached copy.
