import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VaultView } from "../contract/abi.gen";
import { addKeyCommand, mcpCommand, NextSteps } from "./NextSteps";

const vault = { agent_id: "demo-agent.intatto.near", recent_spends: [] } as unknown as VaultView;

describe("What happens next", () => {
  it("gives the add-key command for this vault and its agent methods only", () => {
    const cmd = addKeyCommand("demo-agent.intatto.near", "vault.intatto.near", "mainnet");
    expect(cmd).toContain("near account add-key demo-agent.intatto.near grant-function-call-access --allowance '1 NEAR'");
    expect(cmd).toContain("--contract-account-id vault.intatto.near --function-names agent_spend,agent_swap");
    expect(cmd).toContain("network-config mainnet");
    expect(addKeyCommand(null, "vault.intatto.near", "mainnet")).toContain("add-key <agent-account>");
    expect(cmd).not.toMatch(/[–—]/);
  });

  it("gives the MCP command with this vault, owner and agent, and no key", () => {
    const cmd = mcpCommand("owner.near", "agent.near", "vault.intatto.near", "mainnet");
    expect(cmd).toContain("claude mcp add --transport stdio intatto --env INTATTO_NETWORK=mainnet --env INTATTO_VAULT_ID=vault.intatto.near");
    expect(cmd).toContain("--env INTATTO_OWNER_ID=owner.near --env INTATTO_AGENT_ID=agent.near");
    expect(cmd).toContain("--env INTATTO_AGENT_KEY_FILE=<path-to-agent-key.json> -- node ./Intatto/agent/mcp-server.mjs");
    expect(cmd).not.toMatch(/ed25519:/);
    expect(cmd).not.toMatch(/[–—]/);
  });

  it("says why we don't run the agent, and signs nothing: its only button copies", () => {
    render(<NextSteps vault={vault} vaultId="vault.intatto.near" network="mainnet" repoUrl="https://github.com/UEddy/Intatto" readOnly={false} />);
    expect(screen.getByText(/Intatto doesn't run your agent for you\. If we did, we'd hold its key, which is the risk this vault exists to remove\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Bring your own agent/ }).getAttribute("href")).toBe("https://github.com/UEddy/Intatto#bring-your-own-agent");
    expect(screen.getByRole("link", { name: /agent\// }).getAttribute("href")).toBe("https://github.com/UEddy/Intatto/tree/master/agent");
    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["policy", "Copy command", "Copy MCP command"]);
  });

  it("read-only, never says your", () => {
    const { container } = render(<NextSteps vault={vault} vaultId="vault.intatto.near" network="mainnet" repoUrl="https://github.com/UEddy/Intatto" readOnly />);
    expect(container.textContent).not.toMatch(/\byour\b/i);
    expect(container.textContent).toContain("Intatto doesn't run the agent for you.");
  });
});
