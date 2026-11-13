# Intatto: go-to-market plan

Status on 2026-11-13: live on NEAR mainnet (`vault.intatto.near`, `intents.intatto.near`), one
public canary, fee collection proven on mainnet, no outside users yet. This plan says who the first
users are, how they find Intatto, what it costs them, and what I measure. Every number below that
describes the product today links to a transaction or a file; everything else is a target and says
so.

## The problem, for one user

A trading agent needs a key to trade. Today that is the key to its whole wallet: one bug, one
leaked environment file or one prompt injection and the wallet is gone. Intatto gives the agent its
own trading account instead: a vault it can trade from, inside limits the contract enforces, and
can never withdraw from. The agent's key can be stolen and the money stays.

## First customer

**Builders who run trading agents on NEAR today**, with a hot full-access key, through Rhea or NEAR
Intents. Solo developers and small teams running bots for themselves or a few clients.

Why them first:

- They already hold the exact risk Intatto removes, and already trade the venues it supports
  (Rhea pools, NEAR Intents).
- Switching costs them almost nothing: their strategy stays the same; only the signer changes, from
  a full-access key to a vault-only function-call key.
- They are findable: in the NEAR builder channels, the NEAR AI Agent Market, and the repositories of
  this hackathon's agent tracks.

**Second segment: teams putting AI agents in charge of a treasury** (DAOs, agent-run businesses,
payroll and payment agents). Same product, `agent_spend` instead of `agent_swap`, with the receiver
allowlist doing the work.

**Not now:** retail users who want a managed trading bot. Running their agent would mean holding its
key, which is the risk Intatto exists to remove.

## Why they switch

| Today | With Intatto |
|---|---|
| The agent's key can withdraw everything | The key can only call the vault's agent methods; it cannot attach a deposit, so it cannot withdraw ([exact limits](README.md#the-agents-function-call-key-exact-limits)) |
| Limits live in the agent's own code, which the attacker controls | Limits live in the contract: caps per trade and per day, pools, pairs, slippage against the exchange's own quote, price floors |
| A compromised agent is found after the money left | The owner freezes the vault in one call; every refused call is on chain with its reason |
| "Trust our code" | The running code is checked live against its reproducible build, and the agent's key is public on mainnet with real NEAR behind it |

## Distribution, cheapest first

1. **Where agents are built.** The MCP server ([agent/mcp-server.mjs](agent/mcp-server.mjs)) puts the
   vault into Claude, ChatGPT, Cursor, Codex and any MCP client as four tools, with a pre-trade
   check that blocks bad swaps before they are signed. No package to install: one command adds it.
   Next: publish it to npm and to the MCP registries.
2. **The canary as the standing proof.** "The key is public. The money is still here." A live page,
   a counter of refused attempts, and a reason for anyone to come and try. Each new refusal is a
   post.
3. **NEAR AI Agent Market.** List a reference Intatto trading agent, so agents hired there can
   trade with a vault instead of a key.
4. **Build in public on X** from the project account: each mainnet milestone with its transaction
   link (first outside vault, first outside attack refused, audit, key removal).
5. **Hand onboarding of design partners.** Ten trading-bot builders, set up one by one, in exchange
   for feedback and a public case study.
6. **Owners from any chain (planned, not built).** An owner whose money is on an EVM chain or
   Solana today has to bridge before opening a vault. NEAR Intents' 1Click API removes that step: the owner asks for
   a quote (for example USDC on Base in, wNEAR out, to the owner's NEAR account), gets a deposit
   address for that quote, and sends from any wallet; solvers swap it and deliver wNEAR, or refund
   the deposit to an address the owner sets if the swap fails
   ([1Click API](https://docs.near-intents.org/near-intents/1click-api)). The owner then deposits
   the wNEAR into the vault as today. Aurora's persistent deposit addresses
   ([Intents Connect](https://docs.intents.aurora.dev/intents-deposits/persistent-addresses)) could
   make that address reusable; their docs do not yet confirm a NEAR account as the recipient, so
   1Click comes first. It is held back on purpose: a page that shows an address to send money to
   is the most phishing-sensitive screen the product could have, so it ships only after the same
   mainnet test as every other path into the vault, with a cap and the address re-fetched and
   checked against 1Click before it is shown. The owner account stays a NEAR account.
7. **Bounties.** The canary is the funded bounty today: whoever takes its NEAR keeps it. Bugs
   reported privately instead are credited publicly. A paid disclosure bounty and a "Break
   Intatto" week follow once there is a funded pool to pay from; no amounts are promised before
   then.

## Pricing

- **0.10% (10 bps) of the output of every agent swap**, taken by the contract and fixed in its code
  ([src/fees.rs](src/fees.rs)); no method can change it. Proven on mainnet: the smoke test's swap
  [`JAFaEDBh…`](https://nearblocks.io/txns/JAFaEDBhStuPgwgCyNJKU7mQH2K7evjG328zrhudoaC8) paid
  0.001887 USDt to the treasury.
- No subscription, no fee on deposits, withdrawals, payments or refused calls.
- Costs, stated plainly: the owner pays the vault's storage (about 0.0015 NEAR to open one) and the
  agent pays its own gas (about 0.0036 NEAR per completed swap). The operator's fixed cost is the
  contract's storage stake, about 2.55 NEAR ([Unit economics](README.md#unit-economics)). Each new
  vault costs the operator nothing per call.
- What it means: at 10 bps, 1,000,000 USD of monthly agent swap volume pays 1,000 USD a month. The
  fee only matters at volume, which is why distribution goes where agents are built.

## Launch sequence

| When | What | Done when |
|---|---|---|
| Hackathon (to 2026-11-14) | Mainnet proof: canary, smoke test, intent swap, MCP server, pre-trade check | Live (this repository) |
| Weeks 1 to 4 | Ten design-partner bots onboarded by hand; MCP server on npm | Ten outside vaults with an agent that has traded |
| Weeks 4 to 8 | External audit of the contract | Audit report published |
| After the audit | Both upgrade keys removed; the canary's bounty raised; public launch | `list-keys` shows no full-access key on either vault |
| Next | More Rhea pairs and intent pairs, chosen by liquidity; a reference agent on the Agent Market | Listed |
| Next | Fund a vault from any chain through NEAR Intents 1Click (distribution item 6) | A vault funded from another chain on mainnet, its transactions published |

## What I measure

| Metric | Why |
|---|---|
| Value under policy (all vault balances) | The money that is no longer one key away from gone |
| Agent swap volume, and fee revenue | The business |
| Outside vaults with an agent that has traded | Real adoption, not sign-ups |
| Refused calls, by reason | The product working; each is a loss that did not happen |
| Time from connect to first agent trade | Onboarding; target under 10 minutes |
| Canary attempts, and breaks (target: 0) | The public proof |

All of these are on chain or derived from the vault's own events; the board already shows the
canary's.

## Partners, and what is in it for them

| Partner | Their gain |
|---|---|
| Rhea | Agent swap volume through its pools, from agents that would otherwise not be trusted with keys |
| NEAR Intents | Volume through solvers, signed for the vault by the MPC network, and later the owners' deposits from other chains through 1Click |
| NEAR AI | Trade decisions signed inside its TEE, with the receipt recorded on chain with each trade, as a showcase |
| NEAR AI Agent Market | Agents that can be hired to trade without being handed a wallet key |

## Risks

| Risk | Answer |
|---|---|
| A contract bug | The public canary, an external audit before keys are removed, and caps that bound what any bug can lose per day |
| Low trading-agent volume on NEAR | The treasury segment uses the same vault with `agent_spend`; the intents path reaches other chains' assets, and funding from any chain (distribution item 6) brings owners whose money is not on NEAR yet |
| Copies of the spending-limit idea | Intatto's edges are the trading policy (slippage against the exchange's quote, intent price floors, MPC-signed intents) and the proof (public key on mainnet, reproducible build checked live), not the idea of limits |
| Upgrade keys today | Disclosed in the README and THREAT_MODEL.md, checked live on the board, removed after the audit |
