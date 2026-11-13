# Intatto canaries

Intatto is a NEAR vault that gives an AI agent its own trading account: the agent trades within
limits the contract enforces, and can never withdraw. Each canary is such a vault with its agent's
key published. Anyone may sign with it and try to take the money. The vault contract's policy
says that key can move nothing; the canary tests whether that holds.

Live status: the live bounty board at <https://intatto.pages.dev/?network=mainnet> (for the
testnet canary, use `?network=testnet` instead). Full rules and context:
[THREAT_MODEL.md](THREAT_MODEL.md), section "What counts as a canary break".

There are two, one per network, set up the same way. Mainnet comes first.

## Mainnet

This one holds real NEAR.

### Accounts

| Role | Account |
|---|---|
| Vault contract | `vault.intatto.near` |
| Canary owner (its key signs nothing after setup) | `canary.intatto.near` |
| Canary agent (key below) | `canary-agent.intatto.near` |
| Exchange the vault is bound to | `v2.ref-finance.near` |

### The agent key

This is a **function-call key** on `canary-agent.intatto.near`. As read on chain with
`view_access_key` at block 224,088,367 (2026-11-11), its permission is:

```json
{"FunctionCall": {"allowance": "250000000000000000000000", "method_names": ["agent_spend", "agent_swap"], "receiver_id": "vault.intatto.near"}}
```

It can call only `agent_spend` and `agent_swap` on the vault, cannot attach deposits, and pays
gas from a 0.25 NEAR allowance. It cannot transfer the agent account's NEAR or add keys.

```text
public key:  ed25519:GWvo8kPMuTxj9yLvTnsFJ5jxB4D3CNrbcMsLn2WTAEig
private key: ed25519:53VWGubUsKbFUjDDCRf8ngaju79BpTDsfnCGqroK26rh3FSep12CqzbeVV5uWSNDmLcVaPqdus3wmDJgCXjQJvVA
```

Check the permission yourself before relying on it:

```bash
near account get-public-key from-plaintext-private-key "$CANARY_KEY"   # must print the public key above
near account list-keys canary-agent.intatto.near network-config mainnet now
```

### How to try

```bash
export CANARY_KEY='<the private key above>'
export YOUR_ACCOUNT='<your mainnet account>'
near contract call-function as-transaction vault.intatto.near agent_spend \
  json-args '{"owner_id":"canary.intatto.near","receiver_id":"'"$YOUR_ACCOUNT"'","amount":"997610000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as canary-agent.intatto.near network-config mainnet \
  sign-with-plaintext-private-key "$CANARY_KEY" send
```

Change anything: the amount, the receiver, `agent_swap` instead of `agent_spend`, other owners'
vaults. Every attempt shows up on the board with the reason the contract gave. Gas comes out of
the key's allowance; your account only appears as the receiver.

Or run the whole set at once: `node agent/canary-attack.mjs` (Node 22, from a clone of this
repository) lists 13 attacks the vault must refuse on chain and 6 the key cannot even make, and
sends nothing; `--send` signs them with this key, reports the vault's reason for each, and checks
the canary's balance afterwards.

One limit of this key, by its allowance: `agent_swap` needs 255 Tgas before it checks the policy,
and NEAR charges a function-call key's allowance upfront for all prepaid gas at a pessimistic
price, about 0.3 NEAR for that much gas, more than the key's 0.25 NEAR allowance. So a swap signed
with this key stops at `insufficient_gas` or an earlier check; the swap path's policy checks are
tested in the sandbox suite and in the mainnet smoke test instead ([README.md](README.md)).

### What counts as a break

**A break is any decrease of the canary vault's balances, as returned by
`get_vault("canary.intatto.near")` on `vault.intatto.near`, below the baseline.** That means its
`balance`, or the `balance` or `on_exchange` of any token entry. It is a break no matter who
signed the transaction that caused it.

Not breaks:

- `canary-agent`'s own NEAR going down, or the key's allowance running out: that is gas paid by
  whoever uses the key.
- `vault.intatto.near`'s account balance changing. It holds every vault and receives the protocol's share of the gas its calls burn.
- Increases of the canary's balances.

If you move funds out of the canary vault, they are yours to keep. Please open an issue on the
repository saying how, so the flaw can be fixed.

### Baseline

| | |
|---|---|
| Baseline balance | `997610000000000000000000` yoctoNEAR (0.99761 NEAR), no tokens |
| Source | `get_vault` right after the last setup transaction |
| Last setup transaction | [`8YwFyVR6MFgqhEDP47tT87oGp6LPD5gbhf947AjMLU58`](https://nearblocks.io/txns/8YwFyVR6MFgqhEDP47tT87oGp6LPD5gbhf947AjMLU58) (`lock_withdrawals_until`, block 224,088,065; its `withdrawals_locked` event is in block 224,088,066) |
| Earlier setup | [`BwZNfjiHdqngLwgpupS7xEUXKxGkCVMD7Kup7MwNtx4B`](https://nearblocks.io/txns/BwZNfjiHdqngLwgpupS7xEUXKxGkCVMD7Kup7MwNtx4B) (`deposit` of 1 NEAR), [`CkwXsrt5k4ftXffduLfbYXe8TvTXXuxKEi3HwcvbsoBH`](https://nearblocks.io/txns/CkwXsrt5k4ftXffduLfbYXe8TvTXXuxKEi3HwcvbsoBH) (`set_agent`) |
| Agent key added | [`53fLiHqXahkjXEKP7shVQZXC2J6HVfnFHcJNhFYRVhac`](https://nearblocks.io/txns/53fLiHqXahkjXEKP7shVQZXC2J6HVfnFHcJNhFYRVhac), on `canary-agent.intatto.near` after the lock; it does not touch the vault |

The storage of the vault record, the policy and the lock was charged to the vault, which is why
the baseline is 0.00239 NEAR below the deposit.

The policy is zero-outflow: nobody to pay, no pools, no tokens, NEAR caps of zero.

```json
{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":1,"allowlist":[],"tokens":[],"pools":[]}
```

### The current run

`vault.intatto.near` was deployed with the published reproducible build, and the canary was set
up on it afterwards, so the run starts with the canary's setup:

| | |
|---|---|
| Deployment | [`HGEauwuJkiP3E4tvLhZuBZpjRabTGVW6rLyRRK9RFXVJ`](https://nearblocks.io/txns/HGEauwuJkiP3E4tvLhZuBZpjRabTGVW6rLyRRK9RFXVJ) (`DeployContract` and `new`), signed by `vault.intatto.near`, block 224,086,630, 2026-11-11 15:58:25 UTC |
| Code deployed | `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J` (hex `2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5`) |
| Run start | the lock's `withdrawals_locked` event above, block 224,088,066, 2026-11-11 16:12:10 UTC |

The board counts "intact for" from the later of the deployment and the setup, after checking on
load that the deployment was signed by the vault account and deployed exactly this code, and that
the setup transaction was signed by the canary owner and logged the lock.

### Attempts so far

On 2026-11-13, from 06:27 to 06:32 UTC, the attack run (`node agent/canary-attack.mjs --send`)
signed 13 transactions with the published key `ed25519:GWvo8kPM…`. The vault refused every one, and
the canary's balance was still the baseline, 997610000000000000000000 yoctoNEAR, at block
224,333,239. They used 0.00235 NEAR of the key's allowance. The board lists every attempt with the
contract's reason.

| Time (UTC) | Attack | Refused with | Transaction |
|---|---|---|---|
| 06:27:35 | Drain the whole vault to an attacker | `receiver_not_allowlisted` | [`Hj5kDfAG…`](https://nearblocks.io/txns/Hj5kDfAGLMp756gQYk3Y49v15WPWaHcytmHNSfqxoFEh) |
| 06:27:38 | Send the maximum u128 amount | `receiver_not_allowlisted` | [`Ai9zzvVu…`](https://nearblocks.io/txns/Ai9zzvVu2GubztsD88eegrfzHsFAVnzJ1nxG9DXbwMtG) |
| 06:27:40 | Pay the owner | `receiver_not_allowlisted` | [`2WgEkeKr…`](https://nearblocks.io/txns/2WgEkeKrBF78t7KfQGPK8A8ubT5F8WusjjuajR9wfKkW) |
| 06:27:44 | Spend zero | `zero_amount` | [`AUgDy78A…`](https://nearblocks.io/txns/AUgDy78AYacKxwQ1PZGBPARLpsGQtCAYcvBCvRGkbbS3) |
| 06:27:47 | Spend from a vault that does not exist | `no_vault` | [`6BYTSdQ9…`](https://nearblocks.io/txns/6BYTSdQ94vucLhqnKm4YLfyeerVMYZj4UiZ5YaarxKJR) |
| 06:27:50 | Swap with no minimum output | `zero_min_amount_out` | [`4inW1Tn4…`](https://nearblocks.io/txns/4inW1Tn49QMtFXbht4FSZGswo8h4bop3aEgA2T1Q6G8B) |
| 06:32:26 | Take 1 yoctoNEAR | `receiver_not_allowlisted` | [`GLQ417uh…`](https://nearblocks.io/txns/GLQ417uhSpo4it5YHrwYqD8rA4KqhENcbeXKHZQx1Bv6) |
| 06:32:28 | Pay the agent's own account | `receiver_not_allowlisted` | [`BbBaSxuM…`](https://nearblocks.io/txns/BbBaSxuMoMbhLdSkF6YcjSXg535vDapr5opGgjPZW4oG) |
| 06:32:31 | Pay the vault contract itself | `receiver_not_allowlisted` | [`9KoJ8KoN…`](https://nearblocks.io/txns/9KoJ8KoNf7DC6TPcCyJnQiQDdjVsoAzMxzM9K2qYerC) |
| 06:32:33 | Spend from another owner's vault | `not_agent` | [`FSFLvXvq…`](https://nearblocks.io/txns/FSFLvXvqkyHeXQkJ93MhbBrSG8muEdxDrQRLeSe6hAoF) |
| 06:32:35 | Malformed amount (negative number) | panic: the amount does not parse | [`Anzfe7Py…`](https://nearblocks.io/txns/Anzfe7PytfcEGvQAg7z3LLSk33QmwYTbbsgWXZ9YPkLi) |
| 06:32:37 | Swap with too little gas to finish | `insufficient_gas` | [`36YbyHFi…`](https://nearblocks.io/txns/36YbyHFiVbNvqcdtjXZk6hn44pHvKCW7YYfPsFJAkUiY) |
| 06:32:39 | Swap another owner's vault | `not_agent` | [`2ueHrcCa…`](https://nearblocks.io/txns/2ueHrcCaEAtsDeAmC2j4zUZQPtPPFuzLYTPP3jjBeLn2) |

The run's other 6 attacks (owner methods, NEAR Intents, a callback spoof, another contract) are
calls the key's permission forbids: NEAR refuses them before execution, so nothing is recorded.

### The lock

Withdrawals are locked until block timestamp `1795176000000000000` (2026-11-20 12:00:00 UTC),
set at 2026-11-11 16:12:10 UTC. Until then even the owner's key cannot withdraw, register another
agent or change the policy. A lock can only be extended, never shortened. A decrease during the
lock therefore means a flaw in the contract, the NEAR runtime or the exchange.

### The deployer's upgrade key, and the integrity check

The deployer keeps a full-access key on `vault.intatto.near` on purpose: the contract is not audited yet,
and without an upgrade key a bug found later could never be fixed, leaving any funds it affected
stuck for good. Owners withdraw with their own keys, not this one; it is removed after an external
audit. That key can replace the contract's code, and with it any rule above.
Everyone using the vault, the canary included, trusts whoever holds it.

So the canary is tied to a code hash. **If vault.intatto.near's code hash changes, the current
canary run ends rather than breaks:** it only tests the code that was deployed while it ran.

The board checks this live. It reads `view_account("vault.intatto.near").code_hash` every 10
seconds and compares it with the published reproducible build:

| | |
|---|---|
| Expected code hash | `3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J` (hex `2c520bfc1173c903cede94259a9f0884927a97983aeef5cc55202537e8d218f5`) |
| Built from | commit [`6cfa90e`](https://github.com/UEddy/Intatto/commit/6cfa90e00890a510750d248b24dae0f86b5211be) with `cargo near build reproducible-wasm` |
| Build image | `sourcescan/cargo-near:0.21.1-rust-1.96.0@sha256:ccb22bb4e677ed022d8b9d1aa1b32f0af52dd0471ef1c32e48dedbf68ee6ee17` |

Any other hash shows as **CODE CHANGED**, and the board stops counting the run. To check it
yourself, build that commit, run `sha256sum target/near/intatto.wasm`, and compare with the "Local
Contract (SHA-256 checksum hex)" line of
`near account view-account-summary vault.intatto.near network-config mainnet now`.

## Testnet

### Accounts

| Role | Account |
|---|---|
| Vault contract | `vault-v1.intatto-dev.testnet` |
| Canary owner (its key signs nothing after setup) | `canary.intatto-dev.testnet` |
| Canary agent (key below) | `canary-agent.intatto-dev.testnet` |
| Exchange the vault is bound to | `ref-finance-101.testnet` |

### The agent key

This is a **function-call key** on `canary-agent.intatto-dev.testnet`. As read on chain with
`view_access_key` at block 276,747,968 (2026-11-08), its permission is:

```json
{"FunctionCall": {"allowance": "1000000000000000000000000", "method_names": ["agent_spend", "agent_swap"], "receiver_id": "vault-v1.intatto-dev.testnet"}}
```

It can call only `agent_spend` and `agent_swap` on the vault, cannot attach deposits, and pays
gas from a 1 NEAR allowance. It cannot transfer the agent account's NEAR or add keys.

```text
public key:  ed25519:EHqQpQk85svJoeAWkJugoCGUXGMaVg77hak6pkiteZqr
private key: ed25519:2VzDYHpnhqxQoNvSxQSVotRJAFphNG3ofF8cm57uTftG4RmfN9K4dDwAaaNCzh4CdQkPp4v48d9gExhTmnbQEr3S
```

Check the permission yourself before relying on it:

```bash
near account get-public-key from-plaintext-private-key "$CANARY_KEY"   # must print the public key above
near account list-keys canary-agent.intatto-dev.testnet network-config testnet now
```

### How to try

```bash
export CANARY_KEY='<the private key above>'
export YOUR_ACCOUNT='<your testnet account>'
near contract call-function as-transaction vault-v1.intatto-dev.testnet agent_spend \
  json-args '{"owner_id":"canary.intatto-dev.testnet","receiver_id":"'"$YOUR_ACCOUNT"'","amount":"997400000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as canary-agent.intatto-dev.testnet network-config testnet \
  sign-with-plaintext-private-key "$CANARY_KEY" send
```

Change anything: the amount, the receiver, `agent_swap` instead of `agent_spend`, other owners'
vaults. Every attempt shows up on the board with the reason the contract gave.

### What counts as a break

**A break is any decrease of the canary vault's balances, as returned by
`get_vault("canary.intatto-dev.testnet")` on `vault-v1.intatto-dev.testnet`, below the
baseline.** That means its `balance`, or the `balance` or `on_exchange` of any token entry. It is
a break no matter who signed the transaction that caused it.

Not breaks:

- `canary-agent`'s own NEAR going down, or the key's allowance running out: that is gas paid by
  whoever uses the key.
- `vault-v1`'s account balance changing. It holds every vault and receives the protocol's share of the gas its calls burn.
- Increases of the canary's balances.

If you move funds out of the canary vault, they are yours to keep. They are testnet NEAR with no
monetary value; please open an issue on the repository saying how, so the flaw can be fixed.

### Baseline

| | |
|---|---|
| Baseline balance | `997400000000000000000000` yoctoNEAR (0.9974 NEAR), no tokens |
| Source | `get_vault` right after the last setup transaction |
| Last setup transaction | [`7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA`](https://testnet.nearblocks.io/txns/7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA) (`lock_withdrawals_until`, block 276,514,425; its `withdrawals_locked` event is in block 276,514,426) |
| Earlier setup | [`H47rARra7gGZUoBsxhqa9ssDHVhLQanJP7qT5TTCUa59`](https://testnet.nearblocks.io/txns/H47rARra7gGZUoBsxhqa9ssDHVhLQanJP7qT5TTCUa59) (`deposit` of 1 NEAR, 0.00145 NEAR kept for storage), [`J3HaGqnQdrzS8iiHBC8PMzRK4vBpcUENfQU1nbG6JAjU`](https://testnet.nearblocks.io/txns/J3HaGqnQdrzS8iiHBC8PMzRK4vBpcUENfQU1nbG6JAjU) (`set_agent`) |

The lock's storage was charged to the vault, which is why the baseline is below the deposit.

The policy is zero-outflow: nobody to pay, no pools, no tokens, NEAR caps of zero.

```json
{"per_tx_cap":"0","daily_cap":"0","max_spends_per_24h":1,"allowlist":[],"tokens":[],"pools":[]}
```

### The current run

The current run started when vault-v1 was upgraded, code only, to the published reproducible build:

| | |
|---|---|
| Deployment | [`A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc`](https://testnet.nearblocks.io/txns/A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc), signed by `vault-v1.intatto-dev.testnet` |
| Block | 276,779,119, 2026-11-08 13:01:35 UTC |
| Code deployed | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL` (hex `fdb4855d004545633f78479a1600abaae429b0562e6d37a962fc2737b0fb4999`) |

The upgrade did not touch the canary vault: same balance, policy, agent and lock. The board
counts "intact for" from this deployment, after checking on load that the transaction was signed
by the vault account and deployed exactly this code.

### The lock

Withdrawals are locked until block timestamp `1796577187277683986` (2026-12-06 17:13:07 UTC),
set at 2026-11-06 17:13:14 UTC. Until then even the owner's key cannot withdraw, register another
agent or change the policy. A lock can only be extended, never shortened. A decrease during the
lock therefore means a flaw in the contract, the NEAR runtime or the exchange.

### The deployer's upgrade key, and the integrity check

The deployer keeps a full-access key on `vault-v1.intatto-dev.testnet` on purpose: the contract is not audited yet,
and without an upgrade key a bug found later could never be fixed, leaving any funds it affected
stuck for good. Owners withdraw with their own keys, not this one; it is removed after an external
audit. That key can replace the contract's code, and with it any
rule above. Everyone using the vault, the canary included, trusts whoever holds it.

So the canary is tied to a code hash. **If vault-v1's code hash changes, the current canary run
ends rather than breaks:** it only tests the code that was deployed while it ran. The run before
this one covered the earlier, non-reproducible build (`FevckYG3RhhFYhj21xvC2nufv1z5vYmuG6P9nrK3hHCa`)
from setup until the upgrade above.

The board checks this live. It reads `view_account("vault-v1.intatto-dev.testnet").code_hash`
every 10 seconds and compares it with the published reproducible build:

| | |
|---|---|
| Expected code hash | `J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL` (hex `fdb4855d004545633f78479a1600abaae429b0562e6d37a962fc2737b0fb4999`) |
| Built from | commit [`b85cece`](https://github.com/UEddy/Intatto/commit/b85cece7e8afc49e8f3476cb8ae69f0792d99444) with `cargo near build reproducible-wasm` |
| Build image | `sourcescan/cargo-near:0.21.1-rust-1.96.0@sha256:ccb22bb4e677ed022d8b9d1aa1b32f0af52dd0471ef1c32e48dedbf68ee6ee17` |

Any other hash shows as **CODE CHANGED**, and the board stops counting the run. To check it yourself, build that commit, run
`sha256sum target/near/intatto.wasm`, and compare with the "Local Contract (SHA-256 checksum
hex)" line of `near account view-account-summary vault-v1.intatto-dev.testnet network-config testnet now`.
