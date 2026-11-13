import type { ReactNode } from "react";
import type { NetworkId } from "../config/networks";

/**
 * Questions a visitor asks before trying, answered from CANARY.md and THREAT_MODEL.md. Native
 * <details>, so it works with the keyboard and without script; the first one starts open.
 */
export function Faq({ networkId, baselineNear, lockText, rpcHost, rulesUrl }: { networkId: NetworkId; baselineNear: string; lockText: string | null; rpcHost: string; rulesUrl: string | null }) {
  const items: [string, ReactNode][] = [
    [
      "What counts as a break?",
      <>
        Any decrease of the canary vault's balances below the {baselineNear} NEAR baseline, as <code>get_vault</code> reports them, no matter who signs the
        transaction. Burning the key's gas allowance is not a break, and neither is the balance going up.
      </>,
    ],
    [
      "Why publish the agent's key at all?",
      <>
        Because the claim is that the key does not matter. The vault's policy decides what the agent can move, not who holds its key. A public key lets anyone test
        that, at any time, with real transactions.
      </>,
    ],
    [
      "Does trying cost me anything?",
      <>
        No. Transactions signed with the published key pay their gas from the agent account's allowance, not from yours. You need near CLI, not an account of your
        own.
      </>,
    ],
    [
      "If I get the money out, is it mine?",
      networkId === "mainnet" ? (
        <>Yes. It is real NEAR. Please open an issue saying how you did it, so the flaw can be fixed.</>
      ) : (
        <>Yes, though it is testnet NEAR with no monetary value. Please open an issue saying how you did it, so the flaw can be fixed.</>
      ),
    ],
    [
      "Can the owner just take it back?",
      lockText ? (
        <>
          Not before {lockText}. Withdrawals are locked until then, and a lock can only be extended, never shortened. Until it ends not even the owner's key can
          withdraw, change the policy or register another agent.
        </>
      ) : (
        <>The owner's withdrawals are not locked right now. The lock's state is read live from the vault, above.</>
      ),
    ],
    [
      "What if the contract's code changes?",
      <>
        It can: the deployer keeps an upgrade key until an external audit, so that a bug can be fixed instead of leaving funds stuck. A new deployment changes the code hash: the integrity check shows <strong>CODE CHANGED</strong> within 10
        seconds and the current run ends. That is not a break, because a run only tests the code deployed while it ran.
      </>,
    ],
    [
      "Where do these numbers come from?",
      <>
        Straight from the chain over RPC (<span className="mono">{rpcHost}</span>). Each figure's method, arguments, raw value and block are one click away.
        Indexers only list transactions; the vault's own events decide what each attempt did. This page holds no keys.
      </>,
    ],
  ];
  return (
    <div className="faq">
      {items.map(([q, a], i) => (
        <details key={q} className="faq-item" open={i === 0}>
          <summary className="faq-q">
            <span>{q}</span>
            <span className="faq-chevron" aria-hidden="true" />
          </summary>
          <div className="faq-a">
            <p>{a}</p>
          </div>
        </details>
      ))}
      {rulesUrl && (
        <p className="faq-more">
          <a href={rulesUrl} target="_blank" rel="noopener noreferrer">
            Full rules, baseline and key in CANARY.md
          </a>
        </p>
      )}
    </div>
  );
}
