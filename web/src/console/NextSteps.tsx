import type { VaultView } from "../contract/abi.gen";
import type { NetworkId } from "../config/networks";
import { CopyButton, Icon } from "../ui/primitives";
import { Panel } from "./fields";

/**
 * The near CLI (near-cli-rs 0.30.1) command for the agent's function-call key: scoped to this
 * vault and its agent methods, with a gas allowance. The form scripts/mainnet-smoke.sh uses. The
 * console's vault runs the canary build (3z1W5), whose agent methods are agent_spend and
 * agent_swap; agent_intent_swap and settle_intent_swap exist only on the intents vault.
 */
export function addKeyCommand(agentId: string | null, vaultId: string, network: NetworkId): string {
  return [
    `near account add-key ${agentId ?? "<agent-account>"} grant-function-call-access --allowance '1 NEAR' \\`,
    `  --contract-account-id ${vaultId} --function-names agent_spend,agent_swap \\`,
    `  autogenerate-new-keypair save-to-legacy-keychain network-config ${network} sign-with-legacy-keychain send`,
  ].join("\n");
}

/**
 * What happens next, once the vault exists: set the rules here, give the agent a key, run an
 * agent. It signs nothing; the command is for the agent account's own near CLI. Read-only (someone
 * else's vault), it speaks of "the agent" instead of "your agent".
 */
/**
 * The command that adds the Intatto MCP server to Claude Code, so an AI agent can check and make
 * vault swaps from any MCP client. It runs from a clone of the repo; the key file stays local.
 */
export function mcpCommand(ownerId: string | null, agentId: string | null, vaultId: string, network: NetworkId): string {
  return [
    `claude mcp add --transport stdio intatto --env INTATTO_NETWORK=${network} --env INTATTO_VAULT_ID=${vaultId} \\`,
    `  --env INTATTO_OWNER_ID=${ownerId ?? "<owner-account>"} --env INTATTO_AGENT_ID=${agentId ?? "<agent-account>"} \\`,
    `  --env INTATTO_AGENT_KEY_FILE=<path-to-agent-key.json> -- node ./Intatto/agent/mcp-server.mjs`,
  ].join("\n");
}

export function NextSteps({ vault, vaultId, network, repoUrl, readOnly, ownerId = null }: { vault: VaultView; vaultId: string; network: NetworkId; repoUrl: string; readOnly: boolean; ownerId?: string | null }) {
  const who = readOnly ? "the" : "your";
  const command = addKeyCommand(vault.agent_id ?? null, vaultId, network);
  const mcp = mcpCommand(ownerId, vault.agent_id ?? null, vaultId, network);
  return (
    <Panel id="next" mark="What happens next" title="Three steps to a working agent">
      <ol className="next-steps">
        <li>
          <h3 className="next-title">Set the rules</h3>
          <p>
            Done on this page: the{" "}
            <button type="button" className="linklike" onClick={() => document.getElementById("policy")?.scrollIntoView({ block: "start" })}>
              policy
            </button>{" "}
            decides what {who} agent may pay and trade, and how much.
          </p>
        </li>
        <li>
          <h3 className="next-title">Give {who} agent a key</h3>
          <p>
            Run this with the agent account's own key. It adds a function-call key that can call only <span className="mono">agent_spend</span> and{" "}
            <span className="mono">agent_swap</span> on <span className="mono">{vaultId}</span>, with a 1 NEAR gas allowance.
          </p>
          <div className="snippet">
            <pre className="mono" tabIndex={0} aria-label="Command to add the agent's key">
              {command}
            </pre>
            <div className="snippet-copy">
              <CopyButton text={command} label="Copy command" />
            </div>
          </div>
        </li>
        <li>
          <h3 className="next-title">Run an agent</h3>
          <p>
            Any agent that can sign a NEAR transaction works:{" "}
            <a href={`${repoUrl}#bring-your-own-agent`} target="_blank" rel="noopener noreferrer">
              {readOnly ? "the README's guide to bringing an agent" : "Bring your own agent"} <Icon name="external" size={12} />
            </a>
            . The reference implementation is{" "}
            <a href={`${repoUrl}/tree/master/agent`} target="_blank" rel="noopener noreferrer">
              agent/ <Icon name="external" size={12} />
            </a>
            .
          </p>
          <p>
            Or give an AI assistant the vault as tools: the MCP server in <span className="mono">agent/mcp-server.mjs</span> checks every swap before it signs (allow,
            warn or block) and sends nothing until you allow trades. For Claude Code:
          </p>
          <div className="snippet">
            <pre className="mono" tabIndex={0} aria-label="Command to add the Intatto MCP server">
              {mcp}
            </pre>
            <div className="snippet-copy">
              <CopyButton text={mcp} label="Copy MCP command" />
            </div>
          </div>
        </li>
      </ol>
      <p className="next-why">
        Intatto doesn't run {who} agent for you. If we did, we'd hold its key, which is the risk this vault exists to remove.
      </p>
    </Panel>
  );
}
