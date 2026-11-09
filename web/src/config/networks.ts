/**
 * Everything network-specific lives here. Screens and the data layer read the active config and
 * never name an account, endpoint or hash themselves.
 *
 * Every value below was read from the chain or the provider on 2026-11-08; the comments say how.
 */

export type NetworkId = "testnet" | "mainnet";

export interface TokenConfig {
  /** NEP-141 contract. Symbol and decimals are always read from its `ft_metadata`, never stored. */
  readonly contractId: string;
  /** Which of the two supported tokens this is (UI wording only). */
  readonly role: "wnear" | "usdt";
}

export interface CanaryConfig {
  readonly ownerId: string;
  readonly agentId: string;
  /** The agent's function-call key whose private half is published. */
  readonly agentPublicKey: string;
  /** Where the private key is published. The page links to it and never embeds it. */
  readonly privateKeyUrl: string | null;
  /**
   * The vault balance right after setup, and the transaction that set it. The board fetches
   * this transaction and checks its `withdrawals_locked` event, so the baseline is traceable.
   */
  readonly baseline: {
    readonly balanceYocto: string;
    readonly txHash: string;
  };
  /**
   * The current run: the canary tests one build of the vault, and a code change ends a run
   * (THREAT_MODEL.md). The board verifies this deployment transaction on load (signer, receiver,
   * and the deployed code's SHA-256) and counts "intact for" from its block.
   */
  readonly run: {
    readonly deployTxHash: string;
    readonly codeHash: string;
  } | null;
}

export interface ExpectedBuild {
  /** base58 sha256 of the published reproducible build, as NEAR reports `code_hash`. */
  readonly codeHash: string;
  /** Commit the build was made from, for the "verify it yourself" link. */
  readonly commit: string;
  /** cargo-near reproducible-build image, as recorded in Cargo.toml. */
  readonly image: string;
}

export interface NetworkConfig {
  readonly networkId: NetworkId;
  readonly label: string;
  /** JSON-RPC for every live view call: near CLI's `<network>-fastnear` connection. */
  readonly rpcUrl: string;
  /**
   * Archival JSON-RPC (near CLI's default `<network>` connection), only for looking up old
   * transactions such as the canary's setup. It rate-limits bursts much sooner (about 15
   * requests, measured 2026-11-08), so live polling never goes there.
   */
  readonly archivalRpcUrl: string;
  readonly explorer: {
    readonly name: string;
    readonly txUrl: (hash: string) => string;
    readonly accountUrl: (accountId: string) => string;
  };
  readonly indexers: {
    /** FastNEAR Transactions API (keyless). Primary. */
    readonly fastnear: string;
    /** NearBlocks API v3 (keyless, attribution required). Fallback. */
    readonly nearblocks: string;
  };
  /** The vault contract, or null where it is not deployed yet. */
  readonly vaultId: string | null;
  readonly exchangeId: string;
  /** The one pool the console offers for the agent's swaps. */
  readonly pool: { readonly id: number; readonly tokenIds: readonly [string, string] };
  readonly tokens: readonly TokenConfig[];
  readonly canary: CanaryConfig | null;
  readonly expectedBuild: ExpectedBuild | null;
  readonly repoUrl: string;
  /** Average block time measured over 10k blocks, for "about N blocks" estimates only. */
  readonly blockTimeMs: number;
}

const REPO = "https://github.com/UEddy/Intatto";

export const TESTNET: NetworkConfig = {
  networkId: "testnet",
  label: "Testnet",
  // ~/.config/near-cli/config.toml: network_connection.testnet-fastnear / .testnet
  rpcUrl: "https://test.rpc.fastnear.com/",
  archivalRpcUrl: "https://archival-rpc.testnet.fastnear.com/",
  explorer: {
    name: "NEAR Explorer",
    // network_connection.testnet.explorer_transaction_url
    txUrl: (hash) => `https://explorer.testnet.near.org/transactions/${encodeURIComponent(hash)}`,
    accountUrl: (id) => `https://explorer.testnet.near.org/accounts/${encodeURIComponent(id)}`,
  },
  indexers: {
    fastnear: "https://tx.test.fastnear.com",
    nearblocks: "https://api-testnet.nearblocks.io",
  },
  vaultId: "vault-v1.intatto-dev.testnet",
  // get_exchange_id on vault-v1
  exchangeId: "ref-finance-101.testnet",
  // get_pool(1084) on ref-finance-101.testnet: SIMPLE_POOL, 0.3% fee
  pool: { id: 1084, tokenIds: ["usdt.itachicara.testnet", "wrap.testnet"] },
  tokens: [
    { contractId: "wrap.testnet", role: "wnear" },
    { contractId: "usdt.itachicara.testnet", role: "usdt" },
  ],
  canary: {
    ownerId: "canary.intatto-dev.testnet",
    agentId: "canary-agent.intatto-dev.testnet",
    // view_access_key_list(canary-agent): FunctionCall agent_spend, agent_swap on vault-v1, 1 NEAR
    agentPublicKey: "ed25519:EHqQpQk85svJoeAWkJugoCGUXGMaVg77hak6pkiteZqr",
    // CANARY.md at the repository root holds the function-call key's private half (it is not
    // part of this site). The link works once the file is pushed to master.
    privateKeyUrl: "https://github.com/UEddy/Intatto/blob/master/CANARY.md",
    baseline: {
      // get_vault(canary).balance after lock_withdrawals_until charged the lock's storage
      balanceYocto: "997400000000000000000000",
      // the last setup transaction: lock_withdrawals_until, block 276514425
      txHash: "7QqKTXzQVAnH8xq9QKoZQcFThJJhYc6EY1Qs3GicezEA",
    },
    // The code-only upgrade of vault-v1 to the reproducible build (2026-11-08, block 276,779,119).
    run: {
      deployTxHash: "A3KLQkGa4GQ5Uwsdzv6cKZJ8MFiMMGCTAy3Mzs13QxTc",
      codeHash: "J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL",
    },
  },
  // `cargo near build reproducible-wasm` of the pushed commit below, in a fresh clone
  // (2026-11-08); vault-v1 runs it since the upgrade in canary.run.
  expectedBuild: {
    codeHash: "J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL",
    commit: "b85cece7e8afc49e8f3476cb8ae69f0792d99444",
    image: "sourcescan/cargo-near:0.21.1-rust-1.96.0",
  },
  repoUrl: REPO,
  blockTimeMs: 617,
};

export const MAINNET: NetworkConfig = {
  networkId: "mainnet",
  label: "Mainnet",
  // ~/.config/near-cli/config.toml: network_connection.mainnet-fastnear / .mainnet
  rpcUrl: "https://rpc.mainnet.fastnear.com/",
  archivalRpcUrl: "https://archival-rpc.mainnet.fastnear.com/",
  explorer: {
    name: "NEAR Explorer",
    txUrl: (hash) => `https://explorer.near.org/transactions/${encodeURIComponent(hash)}`,
    accountUrl: (id) => `https://explorer.near.org/accounts/${encodeURIComponent(id)}`,
  },
  indexers: {
    fastnear: "https://tx.main.fastnear.com",
    nearblocks: "https://api.nearblocks.io",
  },
  // Not deployed yet.
  vaultId: null,
  // metadata(): ref-exchange 1.9.21
  exchangeId: "v2.ref-finance.near",
  // get_pool(3879): SIMPLE_POOL, 0.3% fee
  pool: { id: 3879, tokenIds: ["wrap.near", "usdt.tether-token.near"] },
  tokens: [
    { contractId: "wrap.near", role: "wnear" },
    { contractId: "usdt.tether-token.near", role: "usdt" },
  ],
  // Not set up yet.
  canary: null,
  expectedBuild: null,
  repoUrl: REPO,
  blockTimeMs: 581,
};

export const NETWORKS: Record<NetworkId, NetworkConfig> = { testnet: TESTNET, mainnet: MAINNET };
