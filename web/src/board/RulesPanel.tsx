import type { CanaryConfig } from "../config/networks";
import { formatNear } from "../near/units";
import { Icon, SectionMark } from "../ui/primitives";

/**
 * The canary's rules, shown under the attempt log while it is empty (and only then: once real
 * attempts exist, they are the better use of the space). Mirrors CANARY.md and THREAT_MODEL.md.
 */
export function RulesPanel({ canary, rulesUrl }: { canary: CanaryConfig; rulesUrl: string | null }) {
  const baseline = formatNear(BigInt(canary.baseline.balanceYocto));
  return (
    <section className="card rules" aria-labelledby="rules-title">
      <header className="card-head">
        <div>
          <SectionMark>Rules of engagement</SectionMark>
          <h2 id="rules-title" className="card-title">
            How to win, and what counts
          </h2>
        </div>
      </header>
      <ol className="rules-list">
        <li>
          <span className="rules-num" aria-hidden="true">
            I
          </span>
          <div>
            <h3>What counts as a break</h3>
            <p>
              Any decrease of the canary vault's balances below the baseline of <span className="mono">{baseline} NEAR</span>, as{" "}
              <span className="mono">get_vault</span> reports them. It counts no matter who signs the transaction.
            </p>
            <p className="muted small">
              Not a break: burning the key's gas allowance, or the vault's balance going up. If the vault contract's code changes, the run ends instead; the
              integrity check below shows it.
            </p>
          </div>
        </li>
        <li>
          <span className="rules-num" aria-hidden="true">
            II
          </span>
          <div>
            <h3>How to try</h3>
            <p>
              Sign with the published key, any way you like: any amount, any receiver, <span className="mono">agent_spend</span> or{" "}
              <span className="mono">agent_swap</span>, other owners' vaults. The command on the right is a starting point.
            </p>
          </div>
        </li>
        <li>
          <span className="rules-num" aria-hidden="true">
            III
          </span>
          <div>
            <h3>What you keep</h3>
            <p>Whatever you move out of the vault is yours. It is testnet NEAR, with no monetary value; tell us how you did it so it can be fixed.</p>
          </div>
        </li>
      </ol>
      {rulesUrl && (
        <p className="rules-foot">
          <a href={rulesUrl} target="_blank" rel="noopener noreferrer">
            Full rules, baseline transaction and key in CANARY.md <Icon name="external" size={13} />
          </a>
        </p>
      )}
    </section>
  );
}
