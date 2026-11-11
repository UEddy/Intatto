import { describe, expect, it } from "vitest";
import { resolveNetwork } from "./active";
import { MAINNET, NETWORKS, TESTNET } from "./networks";

describe("network selection", () => {
  it("prefers the URL, then the stored choice, then the build default", () => {
    expect(resolveNetwork("?network=mainnet", "testnet", "testnet")).toBe("mainnet");
    expect(resolveNetwork("", "mainnet", "testnet")).toBe("mainnet");
    expect(resolveNetwork("", null, "mainnet")).toBe("mainnet");
    expect(resolveNetwork("?network=testnet", "mainnet", "mainnet")).toBe("testnet");
    // A visitor who chose testnet earlier keeps it; the README's ?network=mainnet links override it
    // for that page load without changing the saved choice.
    expect(resolveNetwork("", "testnet", undefined)).toBe("testnet");
    expect(resolveNetwork("?network=mainnet", "testnet", undefined)).toBe("mainnet");
    expect(resolveNetwork("?network=devnet", "bogus", undefined)).toBe("mainnet");
  });
});

describe("network configs", () => {
  it("never mix networks", () => {
    for (const c of Object.values(NETWORKS)) {
      const suffix = c.networkId === "testnet" ? ".testnet" : ".near";
      const accounts = [c.exchangeId, ...c.pool.tokenIds, ...c.tokens.map((t) => t.contractId), c.vaultId, c.canary?.ownerId, c.canary?.agentId].filter(Boolean);
      for (const a of accounts) expect(a!.endsWith(suffix), `${a} on ${c.networkId}`).toBe(true);
    }
  });
  it("have both supported tokens in the configured pool", () => {
    for (const c of [TESTNET, MAINNET]) {
      expect(c.tokens.map((t) => t.role).sort()).toEqual(["usdt", "wnear"]);
      expect([...c.pool.tokenIds].sort()).toEqual(c.tokens.map((t) => t.contractId).sort());
    }
  });
  it("point mainnet at the deployed vault and its canary, on the published build", () => {
    expect(MAINNET.vaultId).toBe("vault.intatto.near");
    expect(MAINNET.canary?.ownerId).toBe("canary.intatto.near");
    expect(MAINNET.canary?.agentId).toBe("canary-agent.intatto.near");
    expect(MAINNET.canary?.run?.codeHash).toBe(MAINNET.expectedBuild?.codeHash);
  });
});
