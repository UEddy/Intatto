// Find NEAR documentation at https://docs.near.org
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, StorageUsage, assert_one_yocto, env, near,
    require,
};

/// How long a spend counts toward the 24-hour limits, in nanoseconds (block timestamps are ns).
pub const WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

/// Upper bound on the receiver allowlist, keeping vault records (and the gas to load them) small.
pub const MAX_ALLOWLIST_LEN: usize = 50;

/// Upper bound on `Policy::max_spends_per_24h`, which also bounds each vault's spend list.
pub const MAX_SPENDS_PER_24H_LIMIT: u32 = 100;

/// Gas reserved for the callbacks that settle a transfer.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Rules the contract enforces on every `agent_spend`. Only the vault owner can change them.
/// A cleared policy (new vault, or after `remove_agent`) is all zeros and allows nothing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Maximum amount a single `agent_spend` may send.
    pub per_tx_cap: NearToken,
    /// Maximum total the agent may send within any 24-hour period.
    pub daily_cap: NearToken,
    /// Maximum number of agent spends within any 24-hour period (1 to 100).
    pub max_spends_per_24h: u32,
    /// The only accounts the agent may send to.
    pub allowlist: Vec<AccountId>,
}

/// One agent spend. It counts toward the 24-hour limits until it is exactly 24 hours old.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spend {
    /// Unique across the contract; lets the transfer callback find exactly this entry.
    pub spend_id: U64,
    /// Block timestamp (ns) of the `agent_spend` call.
    pub timestamp: U64,
    pub amount: NearToken,
}

impl Spend {
    fn counts_at(&self, now: u64) -> bool {
        let expires = self
            .timestamp
            .0
            .checked_add(WINDOW_NS)
            .unwrap_or_else(|| env::panic_str("Spend timestamp overflow"));
        now < expires
    }
}

/// A user's vault. Returned as JSON by `get_vault` and stored with Borsh.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Vault {
    /// Spendable NEAR held for the owner.
    pub balance: NearToken,
    /// While true, every `agent_spend` is rejected.
    pub frozen: bool,
    /// The only account allowed to call `agent_spend` for this vault.
    pub agent_id: Option<AccountId>,
    pub policy: Policy,
    /// Agent spends from the last 24 hours, oldest first, including transfers still in flight.
    /// Entries older than that stay until the next `agent_spend` prunes them.
    pub recent_spends: Vec<Spend>,
}

/// Why an `agent_spend` was rejected, as reported in `spend_rejected` events.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    NoVault,
    NotAgent,
    ZeroAmount,
    Frozen,
    ReceiverNotAllowlisted,
    OverPerTxCap,
    TooManySpends,
    OverDailyCap,
    InsufficientBalance,
}

/// NEP-297 events for the activity feed, logged as
/// `EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"<name>","data":{...}}`.
#[near(event_json(standard = "intatto"))]
pub enum VaultEvent {
    /// `amount` is what was credited; `storage_cost` is the part of the first deposit kept to
    /// pay for the vault record's storage.
    #[event_version("1.0.0")]
    Deposit {
        owner_id: AccountId,
        amount: NearToken,
        storage_cost: NearToken,
    },
    #[event_version("1.0.0")]
    AgentSet {
        owner_id: AccountId,
        agent_id: AccountId,
        policy: Policy,
    },
    #[event_version("1.0.0")]
    AgentRemoved {
        owner_id: AccountId,
        agent_id: AccountId,
    },
    #[event_version("1.0.0")]
    Frozen { owner_id: AccountId },
    #[event_version("1.0.0")]
    Unfrozen { owner_id: AccountId },
    #[event_version("1.0.0")]
    Withdraw {
        owner_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    WithdrawRefunded {
        owner_id: AccountId,
        amount: NearToken,
    },
    /// Logged right before the panic, so it survives in the failed receipt's outcome.
    #[event_version("1.0.0")]
    SpendRejected {
        owner_id: AccountId,
        caller_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
        reason: RejectReason,
    },
    /// The spend passed every check; the balance is deducted, the spend is recorded and the
    /// transfer is in flight.
    #[event_version("1.0.0")]
    SpendInitiated {
        spend_id: U64,
        owner_id: AccountId,
        agent_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    SpendCompleted {
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
    /// The transfer failed; the amount went back to the vault and the spend's record was removed.
    #[event_version("1.0.0")]
    SpendRefunded {
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
}

#[near(contract_state)]
pub struct Contract {
    vaults: LookupMap<AccountId, Vault>,
    next_spend_id: u64,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            vaults: LookupMap::new(b"v"),
            next_spend_id: 0,
        }
    }
}

#[near]
impl Contract {
    /// Credits the attached NEAR to the caller's vault, creating the vault on first deposit.
    #[payable]
    pub fn deposit(&mut self) {
        let owner_id = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(!attached.is_zero(), "Deposit must be greater than zero");

        let storage_cost = if self.vaults.contains_key(&owner_id) {
            NearToken::from_yoctonear(0)
        } else {
            // Storage is staked from this contract's balance, which also holds every vault's
            // funds, so the first deposit pays for the new record instead of other users.
            let usage_before = env::storage_usage();
            self.vaults.insert(owner_id.clone(), Vault::default());
            self.vaults.flush();
            let added = env::storage_usage()
                .checked_sub(usage_before)
                .unwrap_or_else(|| env::panic_str("Storage usage underflow"));
            let cost = storage_cost(added);
            require!(
                attached > cost,
                format!(
                    "First deposit must exceed the vault storage cost of {}",
                    cost.exact_amount_display()
                )
            );
            cost
        };

        let amount = sub_tokens(attached, storage_cost);
        let vault = self.vault_mut(&owner_id);
        vault.balance = add_tokens(vault.balance, amount);

        VaultEvent::Deposit {
            owner_id,
            amount,
            storage_cost,
        }
        .emit();
    }

    /// Registers (or replaces) the caller's agent and policy. Requires exactly 1 yoctoNEAR so it
    /// can only be signed with a full-access key, never a function-call key handed to an app or agent.
    ///
    /// Leaves the frozen flag and the record of recent spends unchanged.
    #[payable]
    pub fn set_agent(&mut self, agent_id: AccountId, policy: Policy) {
        assert_one_yocto();
        let mut policy = policy;
        policy.allowlist.sort();
        policy.allowlist.dedup();
        require!(
            policy.allowlist.len() <= MAX_ALLOWLIST_LEN,
            format!("Allowlist cannot have more than {MAX_ALLOWLIST_LEN} receivers")
        );
        require!(
            !policy.allowlist.contains(&env::current_account_id()),
            "Allowlist cannot include the vault contract itself"
        );
        require!(
            policy.per_tx_cap <= policy.daily_cap,
            "Per-transaction cap cannot exceed the 24-hour cap"
        );
        require!(
            (1..=MAX_SPENDS_PER_24H_LIMIT).contains(&policy.max_spends_per_24h),
            format!("max_spends_per_24h must be between 1 and {MAX_SPENDS_PER_24H_LIMIT}")
        );

        let owner_id = env::predecessor_account_id();
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

    /// Clears the caller's agent and policy. Requires exactly 1 yoctoNEAR (full-access key only).
    ///
    /// Leaves the frozen flag and the record of recent spends unchanged, so a newly registered
    /// agent still sees the last 24 hours of spending.
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
        // Clearing only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&owner_id, usage_before);

        VaultEvent::AgentRemoved { owner_id, agent_id }.emit();
    }

    /// Blocks all agent spending from the caller's vault, starting with the next `agent_spend`.
    /// Deliberately needs no deposit, so any key on the owner's account can hit the brakes.
    pub fn freeze(&mut self) {
        let owner_id = env::predecessor_account_id();
        self.vault_mut(&owner_id).frozen = true;
        VaultEvent::Frozen { owner_id }.emit();
    }

    /// Re-enables agent spending. Requires exactly 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn unfreeze(&mut self) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        self.vault_mut(&owner_id).frozen = false;
        VaultEvent::Unfrozen { owner_id }.emit();
    }

    /// Sends `amount` from the caller's vault back to the caller. Works while frozen.
    /// Requires exactly 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        assert_one_yocto();
        require!(
            !amount.is_zero(),
            "Withdrawal amount must be greater than zero"
        );
        let owner_id = env::predecessor_account_id();
        let vault = self.vault_mut(&owner_id);
        require!(
            amount <= vault.balance,
            format!(
                "Withdrawal of {} exceeds the vault balance of {}",
                amount.exact_amount_display(),
                vault.balance.exact_amount_display()
            )
        );
        vault.balance = sub_tokens(vault.balance, amount);

        VaultEvent::Withdraw {
            owner_id: owner_id.clone(),
            amount,
        }
        .emit();

        Promise::new(owner_id.clone()).transfer(amount).then(
            Self::ext_self()
                .with_static_gas(CALLBACK_GAS)
                .on_withdraw_complete(owner_id, amount),
        )
    }

    /// Sends `amount` from `owner_id`'s vault to `receiver_id`. Only the vault's registered agent
    /// may call this, and only within the vault's policy. The balance is deducted and the spend
    /// recorded before the transfer is created; `on_spend_complete` reverses both if it fails.
    pub fn agent_spend(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    ) -> Promise {
        let caller_id = env::predecessor_account_id();
        let attempt = SpendAttempt {
            owner_id: &owner_id,
            caller_id: &caller_id,
            receiver_id: &receiver_id,
            amount,
        };
        let now = env::block_timestamp();
        let spend_id = self.next_spend_id;
        let usage_before = env::storage_usage();

        let Some(vault) = self.vaults.get_mut(&owner_id) else {
            attempt.reject(
                RejectReason::NoVault,
                &format!("No vault exists for {owner_id}"),
            );
        };
        attempt.require(
            vault.agent_id.as_ref() == Some(&caller_id),
            RejectReason::NotAgent,
            || format!("{caller_id} is not the registered agent for {owner_id}'s vault"),
        );
        attempt.require(!amount.is_zero(), RejectReason::ZeroAmount, || {
            "Spend amount must be greater than zero".to_string()
        });
        attempt.require(!vault.frozen, RejectReason::Frozen, || {
            "Vault is frozen; agent spending is disabled".to_string()
        });
        attempt.require(
            vault.policy.allowlist.contains(&receiver_id),
            RejectReason::ReceiverNotAllowlisted,
            || format!("Receiver {receiver_id} is not on the vault's allowlist"),
        );
        attempt.require(
            amount <= vault.policy.per_tx_cap,
            RejectReason::OverPerTxCap,
            || {
                format!(
                    "Amount {} exceeds the per-transaction cap of {}",
                    amount.exact_amount_display(),
                    vault.policy.per_tx_cap.exact_amount_display()
                )
            },
        );

        // Exact sliding window: only spends made in the 24 hours before `now` count.
        vault.recent_spends.retain(|spend| spend.counts_at(now));
        let spend_count = vault.recent_spends.len();
        let max_spends = vault.policy.max_spends_per_24h;
        attempt.require(
            spend_count < max_spends as usize,
            RejectReason::TooManySpends,
            || {
                format!(
                    "The agent has made {spend_count} spends in the last 24 hours; the policy allows {max_spends}"
                )
            },
        );
        let spent = vault
            .recent_spends
            .iter()
            .fold(NearToken::from_yoctonear(0), |total, spend| {
                add_tokens(total, spend.amount)
            });
        attempt.require(
            add_tokens(spent, amount) <= vault.policy.daily_cap,
            RejectReason::OverDailyCap,
            || {
                format!(
                    "Amount {} would exceed the 24-hour cap of {} ({} already spent in the last 24 hours)",
                    amount.exact_amount_display(),
                    vault.policy.daily_cap.exact_amount_display(),
                    spent.exact_amount_display()
                )
            },
        );
        attempt.require(
            amount <= vault.balance,
            RejectReason::InsufficientBalance,
            || {
                format!(
                    "Amount {} exceeds the vault balance of {}",
                    amount.exact_amount_display(),
                    vault.balance.exact_amount_display()
                )
            },
        );

        vault.balance = sub_tokens(vault.balance, amount);
        vault.recent_spends.push(Spend {
            spend_id: U64(spend_id),
            timestamp: U64(now),
            amount,
        });
        self.next_spend_id = spend_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Spend id overflow"));
        // Pruning freed storage and the new entry needs some; settle the difference like any
        // other change to the record.
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            attempt.reject(
                RejectReason::InsufficientBalance,
                &format!(
                    "Vault balance cannot cover {} of storage for this spend's record",
                    cost.exact_amount_display()
                ),
            );
        }

        VaultEvent::SpendInitiated {
            spend_id: U64(spend_id),
            owner_id: owner_id.clone(),
            agent_id: caller_id,
            receiver_id: receiver_id.clone(),
            amount,
        }
        .emit();

        Promise::new(receiver_id.clone()).transfer(amount).then(
            Self::ext_self()
                .with_static_gas(CALLBACK_GAS)
                .on_spend_complete(U64(spend_id), owner_id, receiver_id, amount),
        )
    }

    /// Settles an `agent_spend` transfer. Returns whether the transfer succeeded, which also
    /// becomes the result of the agent's transaction.
    #[private]
    pub fn on_spend_complete(
        &mut self,
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            VaultEvent::SpendCompleted {
                spend_id,
                owner_id,
                receiver_id,
                amount,
            }
            .emit();
            return true;
        }

        // The failed transfer's NEAR is refunded to this contract: return it to the vault and
        // delete exactly this spend's entry so it stops counting toward the 24-hour limits.
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&owner_id);
        vault.balance = add_tokens(vault.balance, amount);
        vault
            .recent_spends
            .retain(|spend| spend.spend_id != spend_id);
        // Removing an entry only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&owner_id, usage_before);

        VaultEvent::SpendRefunded {
            spend_id,
            owner_id,
            receiver_id,
            amount,
        }
        .emit();
        false
    }

    /// Settles a `withdraw` transfer, crediting the vault back if it failed.
    #[private]
    pub fn on_withdraw_complete(
        &mut self,
        owner_id: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            let vault = self.vault_mut(&owner_id);
            vault.balance = add_tokens(vault.balance, amount);
            VaultEvent::WithdrawRefunded { owner_id, amount }.emit();
        }
        result.is_ok()
    }

    pub fn get_vault(&self, owner_id: AccountId) -> Option<Vault> {
        self.vaults.get(&owner_id).cloned()
    }

    pub fn get_policy(&self, owner_id: AccountId) -> Option<Policy> {
        self.vaults.get(&owner_id).map(|vault| vault.policy.clone())
    }
}

impl Contract {
    /// The vault owned by `owner_id`. Owner-only methods always pass the predecessor here, so
    /// no caller can reach anyone else's vault through them.
    fn vault_mut(&mut self, owner_id: &AccountId) -> &mut Vault {
        self.vaults.get_mut(owner_id).unwrap_or_else(|| {
            env::panic_str(&format!(
                "No vault found for {owner_id}; call deposit first"
            ))
        })
    }

    /// Writes pending changes to `owner_id`'s record, then charges the storage they added since
    /// `usage_before` to the vault balance, or credits back the storage they freed. Storage is
    /// staked from the contract balance that holds everyone's funds, so each vault pays its own.
    ///
    /// Returns the cost, charging nothing, if the balance cannot cover new storage.
    fn settle_storage(
        &mut self,
        owner_id: &AccountId,
        usage_before: StorageUsage,
    ) -> Result<(), NearToken> {
        self.vaults.flush();
        let usage_after = env::storage_usage();
        let vault = self.vault_mut(owner_id);
        let change = storage_cost(usage_after.abs_diff(usage_before));
        if usage_after >= usage_before {
            vault.balance = vault.balance.checked_sub(change).ok_or(change)?;
        } else {
            vault.balance = add_tokens(vault.balance, change);
        }
        Ok(())
    }
}

/// The arguments of one `agent_spend` call, kept so every rejection can be logged.
struct SpendAttempt<'a> {
    owner_id: &'a AccountId,
    caller_id: &'a AccountId,
    receiver_id: &'a AccountId,
    amount: NearToken,
}

impl SpendAttempt<'_> {
    /// `require!` for `agent_spend`: logs a `spend_rejected` event before panicking.
    fn require(&self, condition: bool, reason: RejectReason, message: impl FnOnce() -> String) {
        if !condition {
            self.reject(reason, &message());
        }
    }

    /// Logs survive a panic in the failed receipt's outcome (state changes do not), so indexers
    /// still see the rejected attempt.
    fn reject(&self, reason: RejectReason, message: &str) -> ! {
        VaultEvent::SpendRejected {
            owner_id: self.owner_id.clone(),
            caller_id: self.caller_id.clone(),
            receiver_id: self.receiver_id.clone(),
            amount: self.amount,
            reason,
        }
        .emit();
        env::panic_str(message)
    }
}

fn add_tokens(a: NearToken, b: NearToken) -> NearToken {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("NEAR amount overflow"))
}

fn sub_tokens(a: NearToken, b: NearToken) -> NearToken {
    a.checked_sub(b)
        .unwrap_or_else(|| env::panic_str("NEAR amount underflow"))
}

fn storage_cost(bytes: StorageUsage) -> NearToken {
    env::storage_byte_cost()
        .checked_mul(bytes.into())
        .unwrap_or_else(|| env::panic_str("Storage cost overflow"))
}

/*
 * Unit tests cover the timing edges the sandbox can't hit precisely. The sandbox tests in
 * tests/ cover the full flows against a real node.
 */
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const T0: u64 = 1_700_000_000_000_000_000;
    const HOUR_NS: u64 = 60 * 60 * 1_000_000_000;

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn agent() -> AccountId {
        "agent.near".parse().unwrap()
    }
    fn merchant() -> AccountId {
        "merchant.near".parse().unwrap()
    }
    fn contract_id() -> AccountId {
        "vault.near".parse().unwrap()
    }

    fn set_context(predecessor: AccountId, deposit: NearToken, timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(contract_id())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .account_balance(NearToken::from_near(1_000))
            .attached_deposit(deposit)
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn policy(allowlist: Vec<AccountId>) -> Policy {
        Policy {
            per_tx_cap: NearToken::from_near(1),
            daily_cap: NearToken::from_near(3),
            max_spends_per_24h: 5,
            allowlist,
        }
    }

    /// A vault holding ~10 NEAR whose agent may send up to 1 NEAR per tx, and 3 NEAR in at most
    /// 5 spends per 24 hours.
    fn setup() -> Contract {
        let mut contract = Contract::default();
        set_context(owner(), NearToken::from_near(10), T0);
        contract.deposit();
        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(agent(), policy(vec![merchant()]));
        contract
    }

    fn spend(contract: &mut Contract, timestamp: u64) {
        set_context(agent(), NearToken::from_yoctonear(0), timestamp);
        contract
            .agent_spend(owner(), merchant(), NearToken::from_near(1))
            .detach();
    }

    fn fail_transfer(contract: &mut Contract, spend_id: u64, timestamp: u64) {
        set_context(contract_id(), NearToken::from_yoctonear(0), timestamp);
        let ok = contract.on_spend_complete(
            U64(spend_id),
            owner(),
            merchant(),
            NearToken::from_near(1),
            Err(PromiseError::Failed),
        );
        assert!(!ok);
    }

    fn vault(contract: &Contract) -> Vault {
        contract.get_vault(owner()).unwrap()
    }

    fn spend_ids(contract: &Contract) -> Vec<u64> {
        vault(contract)
            .recent_spends
            .iter()
            .map(|spend| spend.spend_id.0)
            .collect()
    }

    /// What one entry in `recent_spends` costs in storage.
    fn spend_record_cost() -> NearToken {
        let spend = Spend {
            spend_id: U64(0),
            timestamp: U64(0),
            amount: NearToken::from_near(1),
        };
        storage_cost(near_sdk::borsh::to_vec(&spend).unwrap().len() as u64)
    }

    #[test]
    #[should_panic(expected = "would exceed the 24-hour cap")]
    fn burst_23h_after_spending_the_cap_is_rejected() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + 1);
        spend(&mut contract, T0 + 2);
        spend(&mut contract, T0 + 23 * HOUR_NS);
    }

    #[test]
    #[should_panic(expected = "would exceed the 24-hour cap")]
    fn spend_still_counts_one_ns_before_24h() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + HOUR_NS);
        spend(&mut contract, T0 + 2 * HOUR_NS);
        spend(&mut contract, T0 + WINDOW_NS - 1);
    }

    #[test]
    fn spend_ages_out_exactly_24h_later() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + HOUR_NS);
        spend(&mut contract, T0 + 2 * HOUR_NS);
        spend(&mut contract, T0 + WINDOW_NS);

        let timestamps: Vec<u64> = vault(&contract)
            .recent_spends
            .iter()
            .map(|spend| spend.timestamp.0)
            .collect();
        assert_eq!(timestamps, [T0 + HOUR_NS, T0 + 2 * HOUR_NS, T0 + WINDOW_NS]);
    }

    /// A fixed window opened at T0 would have reset at T0 + 24h and allowed 3 more NEAR.
    #[test]
    #[should_panic(expected = "would exceed the 24-hour cap")]
    fn only_aged_out_spends_free_the_cap() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + 23 * HOUR_NS);
        spend(&mut contract, T0 + 23 * HOUR_NS + 1);
        spend(&mut contract, T0 + WINDOW_NS);
        assert_eq!(spend_ids(&contract), [1, 2, 3]); // only the T0 spend aged out
        spend(&mut contract, T0 + WINDOW_NS + 1);
    }

    #[test]
    #[should_panic(expected = "has made 5 spends in the last 24 hours; the policy allows 5")]
    fn spend_count_is_limited_per_24h() {
        let mut contract = setup();
        for i in 0..6 {
            set_context(agent(), NearToken::from_yoctonear(0), T0 + i);
            contract
                .agent_spend(owner(), merchant(), NearToken::from_millinear(100))
                .detach();
        }
    }

    #[test]
    fn spend_records_are_charged_to_the_vault() {
        let mut contract = setup();
        let start = vault(&contract).balance;

        spend(&mut contract, T0);
        let after_first = vault(&contract).balance;
        assert_eq!(
            after_first,
            start
                .checked_sub(NearToken::from_near(1))
                .and_then(|b| b.checked_sub(spend_record_cost()))
                .unwrap()
        );

        // The T0 entry is pruned as the new one is added, so storage nets to zero.
        spend(&mut contract, T0 + WINDOW_NS);
        assert_eq!(
            vault(&contract).balance,
            after_first.checked_sub(NearToken::from_near(1)).unwrap()
        );
    }

    #[test]
    fn failed_transfer_removes_only_its_own_entry() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + 1);
        spend(&mut contract, T0 + 2);
        assert_eq!(spend_ids(&contract), [0, 1, 2]);
        let before_refund = vault(&contract).balance;

        fail_transfer(&mut contract, 1, T0 + 3);

        assert_eq!(spend_ids(&contract), [0, 2]);
        assert_eq!(
            vault(&contract).balance,
            before_refund
                .checked_add(NearToken::from_near(1))
                .and_then(|b| b.checked_add(spend_record_cost()))
                .unwrap()
        );
        // The refunded 1 NEAR is spendable again within the same 24 hours.
        spend(&mut contract, T0 + 4);
        assert_eq!(spend_ids(&contract), [0, 2, 3]);
    }

    #[test]
    fn refund_after_its_entry_aged_out_only_restores_the_balance() {
        let mut contract = setup();
        spend(&mut contract, T0);
        spend(&mut contract, T0 + WINDOW_NS); // prunes spend 0
        let before_refund = vault(&contract).balance;

        fail_transfer(&mut contract, 0, T0 + WINDOW_NS);

        assert_eq!(spend_ids(&contract), [1]);
        assert_eq!(
            vault(&contract).balance,
            before_refund.checked_add(NearToken::from_near(1)).unwrap()
        );
    }

    #[test]
    fn policy_storage_is_charged_and_refunded_to_the_vault() {
        let mut contract = Contract::default();
        set_context(owner(), NearToken::from_near(10), T0);
        contract.deposit();
        let after_deposit = vault(&contract).balance;
        assert!(after_deposit < NearToken::from_near(10));

        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(
            agent(),
            policy(vec![merchant(), "shop.near".parse().unwrap()]),
        );
        let after_big_policy = vault(&contract).balance;
        assert!(after_big_policy < after_deposit);

        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(agent(), policy(vec![]));
        let after_small_policy = vault(&contract).balance;
        assert!(after_small_policy > after_big_policy);
        assert!(after_small_policy < after_deposit); // still pays for the agent id

        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.remove_agent();
        assert_eq!(vault(&contract).balance, after_deposit);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn set_agent_requires_one_yocto() {
        let mut contract = Contract::default();
        set_context(owner(), NearToken::from_near(10), T0);
        contract.deposit();
        set_context(owner(), NearToken::from_yoctonear(0), T0);
        contract.set_agent(agent(), policy(vec![]));
    }

    #[test]
    #[should_panic(expected = "max_spends_per_24h must be between 1 and 100")]
    fn set_agent_rejects_zero_max_spends() {
        let mut contract = setup();
        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(
            agent(),
            Policy {
                max_spends_per_24h: 0,
                ..policy(vec![])
            },
        );
    }

    #[test]
    #[should_panic(expected = "max_spends_per_24h must be between 1 and 100")]
    fn set_agent_rejects_more_than_100_max_spends() {
        let mut contract = setup();
        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(
            agent(),
            Policy {
                max_spends_per_24h: 101,
                ..policy(vec![])
            },
        );
    }
}
