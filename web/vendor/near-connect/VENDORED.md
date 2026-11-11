# near-connect, vendored

| | |
|---|---|
| Source | [NEAR-DevHub/near-connect](https://github.com/NEAR-DevHub/near-connect), branch `passkeys-20261104` |
| Commit | `f2fc9706262b70bd4cc0901e20cc3757c882fb5c` (2026-11-06), package version 0.11.5 |
| Why | The WebAuthn bridge the passkey wallet needs is on this branch only; no npm release has it. |
| Replaces | `@hot-labs/near-connect` 0.12.0 from npm (upstream `hot-dao/near-selector`, commit `5385297`) |
| What is here | `build/` (the 29 `.js` files and their `.d.ts`), source maps dropped; `package.json` |
| License | MIT, as declared in the upstream `package.json`; the repository has no LICENSE file |

## How it was checked (2026-11-09)

1. `build/` is what the source compiles to: in a clean worktree of `f2fc970`,
   `npm install --ignore-scripts` and `npx tsc` (TypeScript 5.8.3, the repository's `tsconfig.json`)
   produce `.js` and `.d.ts` files identical to the committed `build/`. Only source-map paths
   differ.
2. sha256 over the sorted `sha256sum` lines of `build/**/*.js`:
   `d1f20487d7241be0a7f168f027db85e8551c4a4ab23084fc21ee919cf1de44d6`.
3. `package.json` is the upstream one with `scripts` and `devDependencies` removed (npm can run
   lifecycle scripts when installing a local package), the version marked `0.11.5-f2fc970`, and the
   four runtime dependencies pinned to the versions the check above resolved: `@noble/curves`
   2.4.0, `@noble/hashes` 2.4.0, `@noble/post-quantum` 0.7.1, `@scure/base` 1.2.6. Release 0.12.0
   had no runtime dependencies.

`web/package.json` depends on `file:vendor/near-connect`; `web/.npmrc` sets `install-links=true`,
so npm copies it into `node_modules` instead of symlinking it.

## Review: `src/` from 0.12.0 (`5385297`) to `f2fc970`

`f2fc970` does not descend from 0.12.0: it is 16 files, +1,105/−188 lines in `src/` against it.
The rest of the branch's 27,000-line diff is wallet executors (`near-wallets/`, `repository/`),
the example app and build output, none of which this site ships.

Security-relevant changes:

| Change | Effect | What we do |
|---|---|---|
| `webauthn.create` / `webauthn.get` bridge (`SandboxedWallet/executor.ts`) | A sandboxed wallet with the `webauthn` permission can run `navigator.credentials.create/get` in **our page**, with options it chooses: it can ask for an assertion over any challenge from passkeys scoped to our domain. Its iframe also gets `publickey-credentials-create/get` in its `allow` attribute. | Only the passkey entry has `webauthn` (`wallet/passkey.test.ts`). Its executor is served from this site, pinned (see `../PASSKEY-EXECUTOR.md`). |
| `allowsOpen` widened | A wallet with the `walletConnect` permission may `window.open` any URL except `javascript:`, `data:`, `blob:`, `file:` and `about:`. | No offered wallet has `walletConnect` (tested). |
| `ethereum.*` bridge | A wallet with `walletConnect` can send any JSON-RPC `request` to the page's injected Ethereum provider (MetaMask). | Same: no offered wallet has `walletConnect`. |
| `keepAlive` permission | A wallet's iframe stays alive, hidden, between calls. | No offered wallet has it (tested). |
| Default manifest list | A mutable `raw.githubusercontent.com/NEAR-DevHub/near-connect/refs/heads/passkeys-20261104/...` manifest is first. It is fetched only when no manifest is passed. | We always pass the pinned manifest object, so no manifest is fetched. |
| `postMessage` lost its `disposed` guard (`iframe.ts`) | A late message to a closed wallet iframe throws instead of being dropped. Robustness, not security. | None needed; noted. |
| Gas-key support removed (`actions/gas-keys.ts`, `assertGasKeyActionsSupported`) | 0.12.0 refused gas-key actions for wallets that do not declare them; this build passes them through. | The vault never sends gas-key actions. |
| `verifyResolveAuth` (new, NEP-641) | Verifies authorizations, fetching from an RPC URL its caller passes, with ML-DSA-65 support (`@noble/post-quantum`). | Not called by this site. |
| Proxy-window message forwarder | No longer echoes `"null"`-origin messages back into the wallet iframe. | An improvement. |

Unchanged from 0.12.0, but riskier once a wallet can hold `webauthn`:

- **`debug-wallets`.** The connector reads that key from its storage on load and registers every
  wallet in it, with any executor URL and permissions. Our storage (`src/wallet/connectorStorage.ts`)
  never returns or writes that key, and namespaces the rest.
- **`near-wallet-injected` messages.** A `message` listener without an origin check registers a
  parent-frame wallet, and auto-connects it, for any window holding a reference to ours (a parent
  frame, or a popup we opened). On Cloudflare Pages, `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` stop framing. A popup could still send it. Such a wallet talks to the
  page's parent frame, and gets no WebAuthn bridge.
- **Executor code is cached and run first.** It is stored in IndexedDB under `<id>:<version>` and
  used before the fresh copy is checked. A new executor therefore needs a new manifest `version`;
  ours is the executor's commit.

No new `eval`, `new Function` or dynamic `import()`. No change to `localStorage`, `innerHTML` or
`srcdoc` use. The only new network call is `verifyResolveAuth`'s RPC `fetch`.

The CSP nonce (`cspNonce`) works as in 0.12.0.
