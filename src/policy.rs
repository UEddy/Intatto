//! The owner's rules for their agent, and the owner-only calls that set them or hit the brakes.
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, NearToken, assert_one_yocto, env, near, require};

use crate::events::VaultEvent;
use crate::{Contract, ContractExt};

/// Upper bound on the receiver allowlist, keeping vault records (and the gas to load them) small.
pub const MAX_ALLOWLIST_LEN: usize = 50;

/// Upper bound on `Policy::max_spends_per_24h`, which also bounds each vault's spend list.
pub const MAX_SPENDS_PER_24H_LIMIT: u32 = 100;

/// Upper bounds on the tokens and pools a policy can list.
pub const MAX_POLICY_TOKENS: usize = 10;
pub const MAX_POLICY_POOLS: usize = 20;

/// Upper bound on `PoolPolicy::max_slippage_bps`: an owner may allow at most 10% slippage.
pub const MAX_SLIPPAGE_BPS: u16 = 1_000;

/// Rules the contract enforces on every `agent_spend` and `agent_swap`. Only the vault owner can
/// change them. A cleared policy (new vault, or after `remove_agent`) is empty and allows nothing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Maximum amount a single `agent_spend` may send.
    pub per_tx_cap: NearToken,
    /// Maximum total of NEAR the agent may send within any 24-hour period.
    pub daily_cap: NearToken,
    /// Maximum number of agent spends and swaps within any 24-hour period (1 to 100).
    pub max_spends_per_24h: u32,
    /// The only accounts the agent may send NEAR to.
    pub allowlist: Vec<AccountId>,
    /// NEP-141 tokens this vault accepts, with the caps on how much of each the agent may sell.
    #[serde(default)]
    pub tokens: Vec<TokenPolicy>,
    /// Exchange pools the agent may swap through.
    #[serde(default)]
    pub pools: Vec<PoolPolicy>,
}

/// Caps on how much of one token the agent may sell, in the token's smallest units.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenPolicy {
    pub token_id: AccountId,
    /// Maximum amount a single swap may sell.
    pub per_tx_cap: U128,
    /// Maximum total swaps may sell within any 24-hour period.
    pub daily_cap: U128,
}

/// An exchange pool the agent may swap through, with the token pair the owner declares for it.
/// The exchange itself enforces the pool's real pair: a mismatch fails the quote or the swap.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolPolicy {
    pub pool_id: u64,
    pub token_ids: [AccountId; 2],
    /// How far below the exchange's own quote an agent's `min_amount_out` may be, in basis
    /// points (1 to `MAX_SLIPPAGE_BPS`).
    pub max_slippage_bps: u16,
}

impl Policy {
    /// Normalizes the allowlist and rejects anything inconsistent.
    pub fn validate(&mut self) {
        self.allowlist.sort();
        self.allowlist.dedup();
        require!(
            self.allowlist.len() <= MAX_ALLOWLIST_LEN,
            format!("Allowlist cannot have more than {MAX_ALLOWLIST_LEN} receivers")
        );
        require!(
            !self.allowlist.contains(&env::current_account_id()),
            "Allowlist cannot include the vault contract itself"
        );
        require!(
            self.per_tx_cap <= self.daily_cap,
            "Per-transaction cap cannot exceed the 24-hour cap"
        );
        require!(
            (1..=MAX_SPENDS_PER_24H_LIMIT).contains(&self.max_spends_per_24h),
            format!("max_spends_per_24h must be between 1 and {MAX_SPENDS_PER_24H_LIMIT}")
        );
        require!(
            self.tokens.len() <= MAX_POLICY_TOKENS,
            format!("Policy cannot list more than {MAX_POLICY_TOKENS} tokens")
        );
        for (index, token) in self.tokens.iter().enumerate() {
            require!(
                !self.tokens[..index]
                    .iter()
                    .any(|other| other.token_id == token.token_id),
                format!("Token {} is listed more than once", token.token_id)
            );
            require!(
                token.per_tx_cap.0 <= token.daily_cap.0,
                format!(
                    "Per-transaction cap for {} cannot exceed its 24-hour cap",
                    token.token_id
                )
            );
        }
        require!(
            self.pools.len() <= MAX_POLICY_POOLS,
            format!("Policy cannot list more than {MAX_POLICY_POOLS} pools")
        );
        for (index, pool) in self.pools.iter().enumerate() {
            require!(
                !self.pools[..index]
                    .iter()
                    .any(|other| other.pool_id == pool.pool_id),
                format!("Pool {} is listed more than once", pool.pool_id)
            );
            require!(
                pool.token_ids[0] != pool.token_ids[1],
                format!("Pool {} must list two different tokens", pool.pool_id)
            );
            require!(
                (1..=MAX_SLIPPAGE_BPS).contains(&pool.max_slippage_bps),
                format!(
                    "max_slippage_bps of pool {} must be between 1 and {MAX_SLIPPAGE_BPS}",
                    pool.pool_id
                )
            );
            for token_id in &pool.token_ids {
                require!(
                    self.tokens.iter().any(|token| &token.token_id == token_id),
                    format!(
                        "Pool {} uses {token_id}, which has no caps in the policy",
                        pool.pool_id
                    )
                );
            }
        }
    }
}

#[near]
impl Contract {
    /// Registers (or replaces) the caller's agent and policy. Requires exactly 1 yoctoNEAR so it
    /// can only be signed with a full-access key, never a function-call key handed to an app or agent.
    ///
    /// Rejected while the caller's withdrawals are locked: a new agent or policy would be a way
    /// around the lock. `remove_agent`, `freeze` and `unfreeze` still work.
    ///
    /// Leaves the frozen flag, token balances and the record of recent spends unchanged.
    #[payable]
    pub fn set_agent(&mut self, agent_id: AccountId, policy: Policy) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        if let Some(locked_until) = crate::lock::active_lock(&owner_id) {
            VaultEvent::SetAgentRejected {
                owner_id,
                agent_id,
                locked_until: U64(locked_until),
            }
            .emit();
            env::panic_str(&format!(
                "Withdrawals are locked until {locked_until} (block timestamp, ns); set_agent is disabled until then"
            ));
        }
        let mut policy = policy;
        policy.validate();

        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&owner_id);
        vault.agent_id = Some(agent_id.clone());
        vault.policy = policy.clone();
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            env::panic_str(&format!(
                "Vault balance is too low to pay {} for this policy's storage; deposit more first",
                cost.exact_amount_display()
            ));
        }

        VaultEvent::AgentSet {
            owner_id,
            agent_id,
            policy,
        }
        .emit();
    }

    /// Clears the caller's agent, policy and intent policy. Requires exactly 1 yoctoNEAR
    /// (full-access key only).
    ///
    /// Leaves the frozen flag, token balances and the record of recent spends unchanged, so a
    /// newly registered agent still sees the last 24 hours of spending.
    #[payable]
    pub fn remove_agent(&mut self) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&owner_id);
        let Some(agent_id) = vault.agent_id.take() else {
            env::panic_str("No agent is registered for this vault");
        };
        vault.policy = Policy::default();
        crate::intent_swap::clear_policy(&owner_id);
        // Clearing only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&owner_id, usage_before);

        VaultEvent::AgentRemoved { owner_id, agent_id }.emit();
    }

    /// Blocks all agent spending and swapping from the caller's vault, starting with the next
    /// agent call. Deliberately needs no deposit, so any key on the owner's account can hit the brakes.
    pub fn freeze(&mut self) {
        let owner_id = env::predecessor_account_id();
        self.vault_mut(&owner_id).frozen = true;
        VaultEvent::Frozen { owner_id }.emit();
    }

    /// Re-enables agent spending and swapping. Requires exactly 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn unfreeze(&mut self) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        self.vault_mut(&owner_id).frozen = false;
        VaultEvent::Unfrozen { owner_id }.emit();
    }

    pub fn get_policy(&self, owner_id: AccountId) -> Option<Policy> {
        self.vaults.get(&owner_id).map(|vault| vault.policy.clone())
    }
}
