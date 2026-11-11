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
   * and the deployed code's SHA-256) and counts "intact for" from the later of its block and the
   * baseline transaction's lock (runStartOf in src/canary/board.ts).
   */
  readonly run: {
    readonly deployTxHash: string;
    readonly codeHash: string;
  } | null;
}

/**
 * The prompt-injection demo (agent/README.md): an owner whose agent may pay one merchant within
 * small caps, with the agent's function-call key published so anyone can rerun the demo.
 */
export interface DemoConfig {
  /** The vault contract the demo owner uses (the fee build, vault-v2). */
  readonly vaultId: string;
  readonly ownerId: string;
  readonly agentId: string;
  /** The agent's published function-call key. */
  readonly agentPublicKey: string;
  /** The only receiver the demo policy allows. */
  readonly merchantId: string;
}

export interface ExpectedBuild {
  /** base58 sha256 of the published reproducible build, as NEAR reports `code_hash`. */
  readonly codeHash: string;
  /** Commit the build was made from, for the "verify it yourself" link. */
  readonly commit: string;
  /** cargo-near reproducible-build image, as recorded in Cargo.toml. */
  readonly image: string;
}

/**
 * The Chain Signatures vault (CHAIN_SIGNATURES.md): a separate vault account whose own account on
 * the NEAR Intents Verifier is signed for by the MPC network. The board shows its build, its one
 * key there, and the agent intent swap that settled, all re-read from the chain.
 */
export interface IntentsConfig {
  readonly vaultId: string;
  /** The Verifier (defuse) the vault is bound to by setup_intents. */
  readonly verifierId: string;
  /** The MPC signer, and the path and domain the vault's key is derived with. */
  readonly signerId: string;
  readonly keyPath: string;
  readonly keyDomain: number;
  readonly ownerId: string;
  readonly agentId: string;
  readonly expectedBuild: ExpectedBuild & {
    /** The git tag on the commit, and the Reproducible build workflow run that built the wasm. */
    readonly tag: string;
    readonly workflowRun: number;
  };
  /** The one agent intent swap to show. Every field is checked against the transactions' logs. */
  readonly swap: {
    readonly intentId: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly amountIn: string;
    readonly amountOut: string;
    /** agent_intent_swap, signed by the agent. */
    readonly signTxHash: string;
    /** execute_intents on the Verifier, sent by its relayer key. */
    readonly executeTxHash: string;
    /** settle_intent_swap. */
    readonly settleTxHash: string;
  };
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
  /** Null until the demo vault is set up (scripts/canary-testnet.sh with PROFILE=demo). */
  readonly demo: DemoConfig | null;
  readonly expectedBuild: ExpectedBuild | null;
  /** Null where no Chain Signatures vault runs. */
  readonly intents: IntentsConfig | null;
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
  // Set up by `PROFILE=demo scripts/canary-testnet.sh` on vault-v2. get_vault(demo-owner) on
  // 2026-11-11: agent demo-agent, allowlist [demo-merchant], 0.01 NEAR per payment, 0.03 NEAR and
  // 5 payments per 24 hours.
  demo: {
    vaultId: "vault-v2.intatto-dev.testnet",
    ownerId: "demo-owner.intatto-dev.testnet",
    agentId: "demo-agent.intatto-dev.testnet",
    // view_access_key_list(demo-agent): FunctionCall agent_spend on vault-v2, 0.5 NEAR
    agentPublicKey: "ed25519:CTLx5YMheDj5LdCYLGG62k2PnZ7CznRasdbnKBuFVtd3",
    merchantId: "demo-merchant.intatto-dev.testnet",
  },
  // `cargo near build reproducible-wasm` of the pushed commit below, in a fresh clone
  // (2026-11-08); vault-v1 runs it since the upgrade in canary.run.
  expectedBuild: {
    codeHash: "J5MoUAHacL2CRDPT4zHGfr9WYotQ5eXNfRXhsjtQCZCL",
    commit: "b85cece7e8afc49e8f3476cb8ae69f0792d99444",
    image: "sourcescan/cargo-near:0.21.1-rust-1.96.0",
  },
  intents: null,
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
  // Deployed by scripts/mainnet-deploy.sh (2026-11-11): view_account code_hash is the published
  // build below; get_exchange_id v2.ref-finance.near, get_treasury_id eddyhamezz.near, 10 bps.
  vaultId: "vault.intatto.near",
  // metadata() (2026-11-09): ref-exchange 1.9.21, Running; code hash
  // GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi, the binary the sandbox suite runs against with
  // INTATTO_TEST_EXCHANGE=1.9.21 (tests/res/README.md).
  exchangeId: "v2.ref-finance.near",
  // get_pool(3879) (2026-11-09, block 223,788,029): SIMPLE_POOL, total_fee 30 (0.3%), reserves
  // 523.2 wNEAR / 1,903.48 USDt. The deepest simple wNEAR/USDt pool; get_return for 0.5 wNEAR was
  // 1.816902 USDt.
  pool: { id: 3879, tokenIds: ["wrap.near", "usdt.tether-token.near"] },
  // ft_metadata (2026-11-09): wNEAR 24 decimals; USDt ("Tether USD") 6 decimals.
  tokens: [
    { contractId: "wrap.near", role: "wnear" },
    { contractId: "usdt.tether-token.near", role: "usdt" },
  ],
  // Set up by scripts/mainnet-canary.sh with BOUNTY=1 on 2026-11-11.
  canary: {
    ownerId: "canary.intatto.near",
    agentId: "canary-agent.intatto.near",
    // view_access_key (block 224,088,367): FunctionCall agent_spend, agent_swap on
    // vault.intatto.near, 0.25 NEAR allowance
    agentPublicKey: "ed25519:GWvo8kPMuTxj9yLvTnsFJ5jxB4D3CNrbcMsLn2WTAEig",
    // CANARY.md, section "Mainnet" (not part of this site).
    privateKeyUrl: "https://github.com/UEddy/Intatto/blob/master/CANARY.md#mainnet",
    baseline: {
      // get_vault(canary.intatto.near).balance after lock_withdrawals_until: the 1 NEAR deposit
      // less the storage of the record, policy and lock
      balanceYocto: "997610000000000000000000",
      // the last setup transaction: lock_withdrawals_until(2026-11-20T12:00:00Z); its
      // withdrawals_locked receipt is in block 224,088,066 (2026-11-11 16:12:10 UTC), where the run
      // starts, since it came after the deployment below
      txHash: "8YwFyVR6MFgqhEDP47tT87oGp6LPD5gbhf947AjMLU58",
    },
    // The deployment of vault.intatto.near with the published build and new() (block 224,086,630,
    // 2026-11-11 15:58:25 UTC; DeployContract code SHA-256 2c520bfc...e8d218f5).
    run: {
      deployTxHash: "HGEauwuJkiP3E4tvLhZuBZpjRabTGVW6rLyRRK9RFXVJ",
      codeHash: "3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J",
    },
  },
  demo: null,
  // `cargo near build reproducible-wasm` of commit 6cfa90e in a fresh clone (2026-11-09), the
  // build scripts/mainnet-deploy.sh refuses to deploy anything but; vault.intatto.near runs it.
  expectedBuild: {
    codeHash: "3z1W5SfhYy2XoDCpbE1uDNFjnPdEbcX7nPov8jLac97J",
    commit: "6cfa90e00890a510750d248b24dae0f86b5211be",
    image: "sourcescan/cargo-near:0.21.1-rust-1.96.0",
  },
  // Set up by scripts/mainnet-intents.sh on 2026-11-11 (CHAIN_SIGNATURES.md). Read on mainnet
  // 2026-11-11, block 224,115,640: view_account code_hash HRkrMN8o…; get_intents_config bound to
  // intents.near and v1.signer, key_verified; intents.near public_keys_of is exactly
  // [ed25519:5kYTxFES…], which v1.signer derived_public_key(intatto/intents.near/v1, vault, 1) returns.
  intents: {
    vaultId: "intents.intatto.near",
    verifierId: "intents.near",
    signerId: "v1.signer",
    keyPath: "intatto/intents.near/v1",
    keyDomain: 1,
    ownerId: "intents-owner.intatto.near",
    agentId: "intents-agent.intatto.near",
    // Tag intents-build: the Reproducible build workflow's wasm of commit fc23fbc, the only wasm
    // scripts/mainnet-intents.sh deploys; contract_source_metadata names the same commit.
    expectedBuild: {
      codeHash: "HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC",
      commit: "fc23fbc3abee3d503ecaeb5ced56d315374cdc20",
      image: "sourcescan/cargo-near:0.21.1-rust-1.96.0",
      tag: "intents-build",
      workflowRun: 43063218549,
    },
    // The swap of 2026-11-11 17:46 UTC: 0.3 wNEAR for 1.130742 USDt (intent id 0).
    swap: {
      intentId: "0",
      tokenIn: "wrap.near",
      tokenOut: "usdt.tether-token.near",
      amountIn: "300000000000000000000000",
      amountOut: "1130742",
      signTxHash: "GbHfV9nqv8C3xXWCFECWaruJFaQijMhq2GBrKxb1uJjT",
      executeTxHash: "EJY7oiU1SE3w9kg94qhwdcsn2zxFWEZ3eykbVnvUCLUE",
      settleTxHash: "73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE",
    },
  },
  repoUrl: REPO,
  blockTimeMs: 581,
};

export const NETWORKS: Record<NetworkId, NetworkConfig> = { testnet: TESTNET, mainnet: MAINNET };
