import { useServices } from "../app/services";
import type { CanaryConfig } from "../config/networks";
import { CopyButton, SectionMark } from "../ui/primitives";

/**
 * One command, near-cli-rs 0.30.1 syntax (checked against its --help): an agent_spend of the
 * whole bounty to the caller's own account, signed with the published key read from $CANARY_KEY.
 * The page never holds that key; the command reads it from the shell.
 */
export function trySnippet(opts: { vaultId: string; ownerId: string; agentId: string; network: string; amountYocto: string }): string {
  const args = `'{"owner_id":"${opts.ownerId}","receiver_id":"'"$YOUR_ACCOUNT"'","amount":"${opts.amountYocto}"}'`;
  return [
    `near contract call-function as-transaction ${opts.vaultId} agent_spend \\`,
    `  json-args ${args} \\`,
    `  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \\`,
    `  sign-as ${opts.agentId} network-config ${opts.network} \\`,
    `  sign-with-plaintext-private-key "$CANARY_KEY" send`,
  ].join("\n");
}

export function TryItSnippet({ canary, vaultId, amountYocto }: { canary: CanaryConfig; vaultId: string; amountYocto: string }) {
  const { config } = useServices();
  const snippet = trySnippet({ vaultId, ownerId: canary.ownerId, agentId: canary.agentId, network: config.networkId, amountYocto });
  return (
    <section className="card try-it" id="try-it" aria-labelledby="try-title">
      <header className="card-head">
        <div>
          <SectionMark>Try it</SectionMark>
          <h2 id="try-title" className="card-title">
            One command to take the bounty
          </h2>
        </div>
      </header>
      <ol className="try-steps">
        <li>
          Install <a href="https://near.cli.rs" target="_blank" rel="noopener noreferrer">near CLI</a>.
        </li>
        <li>
          Put the published private key in <code>CANARY_KEY</code> and your {config.label.toLowerCase()} account in <code>YOUR_ACCOUNT</code>.
        </li>
        <li>Run it. Change anything you like: amount, method, a swap instead of a spend.</li>
      </ol>
      <div className="snippet">
        <pre className="mono" tabIndex={0} aria-label="Command">
          {snippet}
        </pre>
        <div className="snippet-copy">
          <CopyButton text={snippet} label="Copy command" />
        </div>
      </div>
      <p className="muted small">
        If the contract holds, it refuses the call and logs why; either way your attempt shows up in the log here. Gas comes out of the key's allowance, not your account.
      </p>
    </section>
  );
}
