import type { ReactNode } from "react";
import { Icon } from "../ui/primitives";

/**
 * The three steps in plain words, then the two ways the agent trades, then the full policy
 * surface (closed by default), named by its fields in src/policy.rs (Policy, TokenPolicy,
 * PoolPolicy), src/intent_swap.rs (IntentPair) and the owner methods.
 */
const LIMITS: [string, ReactNode][] = [
  ["per_tx_cap, daily_cap", "The most NEAR one payment may send, and the most in any 24 hours."],
  ["allowlist", "The only accounts the agent may pay."],
  ["max_spends_per_24h", "How many spends and swaps the agent may make in any 24 hours."],
  ["tokens", "Per token, the most the agent may sell in one swap and in any 24 hours."],
  ["pools, max_slippage_bps", "The pools and pairs it may swap through, and how far below the exchange's own quote it may go."],
  ["pairs (intents vault)", "The pairs it may trade through NEAR Intents, each with a price floor."],
  ["freeze, lock_withdrawals_until", "Stop the agent in one call. Lock your own withdrawals until a date."],
];

export function HowItWorks() {
  return (
    <div className="how">
      <ol className="how-steps">
        <li className="how-step">
          <span className="how-num" aria-hidden="true">
            1
          </span>
          <h3 className="how-title">Fund a vault</h3>
          <p>Deposit NEAR and tokens into the vault contract. Only your account can ever withdraw them.</p>
        </li>
        <li className="how-step">
          <span className="how-num" aria-hidden="true">
            2
          </span>
          <h3 className="how-title">Set the limits</h3>
          <p>Caps per trade and per day, the tokens, pools and pairs it may use, a slippage bound and a freeze switch. They live on chain, and the contract checks every agent call against them.</p>
        </li>
        <li className="how-step">
          <span className="how-num" aria-hidden="true">
            3
          </span>
          <h3 className="how-title">Hand the agent a key</h3>
          <p>A key that can only call the vault's trade methods. It can trade within your limits. It cannot withdraw, and it cannot change the rules.</p>
        </li>
      </ol>

      <div className="how-paths" aria-label="The two ways the agent trades">
        <div className="how-path">
          <p className="how-path-name">Rhea path</p>
          <p>Direct swaps through Rhea pools, checked against your caps, pool allowlist and a slippage bound set by the exchange's own quote.</p>
        </div>
        <div className="how-path">
          <p className="how-path-name">NEAR Intents path</p>
          <p>Intents signed for the vault by the NEAR MPC network, only for pairs you allow and never below your price floor.</p>
        </div>
      </div>

      <details className="how-more">
        <summary>Full policy surface</summary>
        <dl className="how-limits">
          {LIMITS.map(([field, what]) => (
            <div key={field}>
              <dt className="mono">{field}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="how-key-detail">
          The agent's key is a NEAR function-call key for <span className="mono">agent_spend</span> and <span className="mono">agent_swap</span>, and on the intents vault{" "}
          <span className="mono">agent_intent_swap</span> and <span className="mono">settle_intent_swap</span>. It signs as the agent's account, not yours, and cannot attach a
          deposit, so it cannot call any owner method.
        </p>
      </details>

      <div className="how-cta">
        <a className="btn btn--ink" href="#/vault">
          Open your vault <Icon name="arrow" size={16} />
        </a>
      </div>
    </div>
  );
}
