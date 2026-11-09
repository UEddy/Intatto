import type { UseQueryResult } from "@tanstack/react-query";
import type { CanaryConfig } from "../config/networks";
import type { AccessKeyPermission, Sourced } from "../near/chain";
import { formatNear } from "../near/units";
import { AccountLink, Badge, CopyButton, Icon, SectionMark, Skeleton, Traceable } from "../ui/primitives";

type KeyData = Sourced<{ nonce: number; permission: AccessKeyPermission }> | null;

export function AgentKeyCard({ query, canary, vaultId }: { query: UseQueryResult<KeyData>; canary: CanaryConfig; vaultId: string }) {
  const key = query.data;
  const perm = key?.value.permission;
  const fc = perm && perm !== "FullAccess" ? perm.FunctionCall : null;
  const scoped = fc !== null && fc.receiver_id === vaultId && fc.method_names.every((m) => m === "agent_spend" || m === "agent_swap");

  return (
    <section className="card key-card" aria-labelledby="key-title">
      <header className="card-head">
        <div>
          <SectionMark>Published agent key</SectionMark>
          <h2 id="key-title" className="card-title">
            Anyone can sign as <AccountLink id={canary.agentId} />
          </h2>
        </div>
      </header>

      <div className="key-block">
        <p className="key mono" aria-label="Public key">
          {canary.agentPublicKey}
        </p>
        <CopyButton text={canary.agentPublicKey} label="Copy public key" />
      </div>

      <Traceable source={key?.source}>
        {query.isPending ? (
          <Skeleton size="l" />
        ) : key === null ? (
          <p className="key-perm">
            <Badge tone="warn">Key removed</Badge> This key is no longer on the account, so nobody can sign with it.
          </p>
        ) : perm === "FullAccess" ? (
          <p className="key-perm">
            <Badge tone="alert">Full access</Badge> This key now has full access to the agent account.
          </p>
        ) : fc ? (
          <ul className="key-facts">
            <li>
              <Badge tone={scoped ? "ok" : "warn"}>{scoped ? "Scoped" : "Changed"}</Badge>
              <span>
                Function calls only, to <span className="mono">{fc.method_names.join(", ")}</span> on <span className="mono">{fc.receiver_id}</span>.
              </span>
            </li>
            <li>
              <Icon name="lock" size={16} />
              <span>
                It cannot transfer the agent account's NEAR, add keys, or call anything else. Every call it can make is checked by the vault's policy.
              </span>
            </li>
            <li>
              <Icon name="shield" size={16} />
              <span>
                Gas allowance left: <span className="mono">{fc.allowance === null ? "unlimited" : `${formatNear(BigInt(fc.allowance), { maxFraction: 4 })} NEAR`}</span>. Spent
                gas is the agent account's, never the vault's.
              </span>
            </li>
          </ul>
        ) : (
          <p className="key-perm">Could not read the key: {String(query.error)}</p>
        )}
      </Traceable>

      <div className="key-private">
        {canary.privateKeyUrl ? (
          <a className="btn btn--ink btn--block" href={canary.privateKeyUrl} target="_blank" rel="noopener noreferrer">
            Get the private key <Icon name="external" size={14} />
          </a>
        ) : (
          <p className="muted">The private key is published separately and is never part of this page.</p>
        )}
      </div>
    </section>
  );
}
