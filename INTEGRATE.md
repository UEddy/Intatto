# Integrating an agent with Intatto

Three ways to put an agent on an Intatto vault, from least to most code. In all three, the agent
holds a key that can only call the vault's agent methods, and the vault contract enforces the
owner's policy on every call.

## Before you start (the owner, once)

1. Open the owner console at [intatto.pages.dev/#/vault](https://intatto.pages.dev/?network=mainnet#/vault),
   connect the owner's wallet and deposit. The console's setup checklist shows each step.
2. Name the agent account and its limits (`set_agent`): per-trade and daily caps per token, the
   pools it may use, and the slippage it may accept against the exchange's quote.
3. Give the agent account a function-call key for the vault's agent methods only. **Signs a mainnet
   transaction**, with the agent account's own key (near-cli-rs 0.30.1):

```bash
near account add-key <agent-account> grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id vault.intatto.near --function-names agent_spend,agent_swap \
  autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-legacy-keychain send
```

The new key's file is the agent's credential. It can trade within the policy; it cannot withdraw
or change the rules.

## 1. From an AI assistant: the MCP server

[agent/mcp-server.mjs](agent/mcp-server.mjs) gives any MCP client (Claude Code, Claude Desktop,
ChatGPT, Cursor, Codex) four tools:

| Tool | What it does | Signs |
|---|---|---|
| `intatto_vault_status` | Balances, freeze, withdrawal lock, policy, and what is left of today's caps | No |
| `intatto_check_agent_key` | Whether the configured key can only call the vault's agent methods | No |
| `intatto_check_swap` | Allow, warn or block for a planned swap, with reasons and a suggested minimum output | No |
| `intatto_swap` | Runs the check, then signs `agent_swap`; refuses on block, needs `acknowledge_warnings` on warn | Only with `INTATTO_ALLOW_TRADES=1` |

Node 22 or later, no packages to install. From a clone of this repository, in Claude Code. Reads
the network when a tool runs; signs only through `intatto_swap` with trades enabled:

```bash
claude mcp add --transport stdio intatto --env INTATTO_NETWORK=mainnet --env INTATTO_VAULT_ID=vault.intatto.near \
  --env INTATTO_OWNER_ID=<owner-account> --env INTATTO_AGENT_ID=<agent-account> \
  --env INTATTO_AGENT_KEY_FILE=<path-to-agent-key.json> -- node ./Intatto/agent/mcp-server.mjs
```

Other clients take the same command and environment in their MCP configuration. Without
`INTATTO_ALLOW_TRADES=1`, `intatto_swap` returns the exact call it would make and sends nothing;
start that way. The key file stays on your machine: no tool returns it, and the server runs every
output through the same redaction as the demo agent ([agent/secrets.mjs](agent/secrets.mjs)).

The server speaks MCP over stdio in both eras: clients that open with `initialize` (protocol
2025-11-25 and earlier) and clients that send the protocol version on every request (2026-07-28),
with `server/discover`. Tests: [agent/mcp-server.test.mjs](agent/mcp-server.test.mjs).

## 2. From your own agent: the pre-trade check

[agent/risk-check.mjs](agent/risk-check.mjs) is the check the MCP server runs, as a library with no
dependencies. Call it before you sign:

```js
import { Chain } from "./agent/intent-swap.mjs";
import { assessSwap, gatherSwapFacts } from "./agent/risk-check.mjs";

const chain = new Chain("https://rpc.mainnet.fastnear.com/");
const facts = await gatherSwapFacts(chain, {
  vaultId: "vault.intatto.near", ownerId, agentId, agentPublicKey,
  poolId, tokenIn: "wrap.near", tokenOut: "usdt.tether-token.near",
  amountIn: "500000000000000000000000", minAmountOut: "1",
});
// With no minimum of your own, take the check's suggestion: at most 0.5% under the exchange's quote.
const minAmountOut = wanted ?? assessSwap({ ...facts, minAmountOut: "1" }).suggestedMinOut;
const { verdict, reasons } = assessSwap({ ...facts, minAmountOut });
if (verdict === "block") throw new Error(reasons.map((r) => r.message).join(" "));
```

| Verdict | Means |
|---|---|
| `block` | The vault would refuse it (not the agent, frozen, pool or pair not allowed, over a cap or the 24-hour count, slippage past the policy, no quote, not enough balance), or the risk is too high: price impact over 5% against a 1% probe of the same pool, or a signing key that is a full-access key |
| `warn` | It would go through, but: price impact over 1%, a minimum output looser than half the policy's slippage, a cap or count over 80% used, or a token whose account has a full-access key (whoever holds it can replace the token's code) |
| `allow` | None of the above |

The check reads state that can change before the swap lands, so the contract stays the last word:
a swap the check allows can still be refused on chain, with the reason in a `swap_rejected` event.
Tests: [agent/risk-check.test.mjs](agent/risk-check.test.mjs).

## 3. Any signer: call the vault directly

Any code that can sign a NEAR transaction can call `agent_swap` (and `agent_spend`) with the agent's
function-call key. The methods, their arguments and every refusal are in the README's
[Bring your own agent](README.md#bring-your-own-agent). The reference signer, with no dependencies,
is [agent/near-tx.mjs](agent/near-tx.mjs).

## What Intatto does not do

It does not run your agent. If it did, it would hold the agent's key, which is the risk the vault
exists to remove.
