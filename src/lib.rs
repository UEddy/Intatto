// Find NEAR documentation at https://docs.near.org
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, StorageUsage,
    assert_one_yocto, env, ext_contract, near, require,
};

/// How long a spend counts toward the 24-hour limits, in nanoseconds (block timestamps are ns).
pub const WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

/// Upper bound on the receiver allowlist, keeping vault records (and the gas to load them) small.
pub const MAX_ALLOWLIST_LEN: usize = 50;

/// Upper bound on `Policy::max_spends_per_24h`, which also bounds each vault's spend list.
pub const MAX_SPENDS_PER_24H_LIMIT: u32 = 100;

/// Upper bounds on the tokens and pools a policy can list.
pub const MAX_POLICY_TOKENS: usize = 10;
pub const MAX_POLICY_POOLS: usize = 20;

/// Upper bound on a vault's token balance entries. Entries are never removed, so no swap callback
/// ever has to create one (or pay for its storage).
pub const MAX_TOKEN_BALANCES: usize = 20;

/// Minimum gas an agent must attach to `agent_swap`, in TGas: the call itself plus every step of
/// the swap's promise chain.
pub const AGENT_SWAP_TGAS: u64 = 20 + FT_TRANSFER_CALL_TGAS + ON_SWAP_DEPOSITED_TGAS;

/// Gas reserved for the callbacks that settle a transfer.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);

// Gas for each step of a swap, in TGas. Each callback reserves what the rest of the chain needs.
const FT_TRANSFER_CALL_TGAS: u64 = 60;
const EXCHANGE_SWAP_TGAS: u64 = 40;
const EXCHANGE_WITHDRAW_TGAS: u64 = 60;
const SWAP_CALLBACK_TGAS: u64 = 15;
const ON_SWAP_WITHDRAWN_TGAS: u64 = SWAP_CALLBACK_TGAS;
const ON_SWAP_EXECUTED_TGAS: u64 =
    SWAP_CALLBACK_TGAS + EXCHANGE_WITHDRAW_TGAS + ON_SWAP_WITHDRAWN_TGAS;
const ON_SWAP_DEPOSITED_TGAS: u64 = SWAP_CALLBACK_TGAS + EXCHANGE_SWAP_TGAS + ON_SWAP_EXECUTED_TGAS;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

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
/// The exchange itself enforces the pool's real pair: a mismatch fails the swap and refunds it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolPolicy {
    pub pool_id: u64,
    pub token_ids: [AccountId; 2],
}

/// One agent spend or swap. It counts toward the 24-hour limits until it is exactly 24 hours old.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spend {
    /// Unique across the contract; lets a callback find exactly this entry.
    pub spend_id: U64,
    /// Block timestamp (ns) of the `agent_spend` or `agent_swap` call.
    pub timestamp: U64,
    /// The token a swap sold, or None for NEAR sent by `agent_spend`.
    pub token_id: Option<AccountId>,
    /// In yoctoNEAR, or in the token's smallest units.
    pub amount: U128,
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

/// An owner's holding of one NEP-141 token.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenBalance {
    pub token_id: AccountId,
    /// Held by the vault and withdrawable with `withdraw_token`.
    pub balance: U128,
    /// The owner's tokens left in the vault's exchange account because withdrawing them from the
    /// exchange failed; `reclaim_from_exchange` retries.
    pub on_exchange: U128,
}

/// A user's vault. Returned as JSON by `get_vault` and stored with Borsh.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Vault {
    /// Spendable NEAR held for the owner.
    pub balance: NearToken,
    /// While true, every `agent_spend` and `agent_swap` is rejected.
    pub frozen: bool,
    /// The only account allowed to call `agent_spend` and `agent_swap` for this vault.
    pub agent_id: Option<AccountId>,
    pub policy: Policy,
    /// Agent spends and swaps from the last 24 hours, oldest first, including ones still in
    /// flight. Entries older than that stay until the next agent call prunes them.
    pub recent_spends: Vec<Spend>,
    /// One entry per token the vault has ever held for this owner.
    pub tokens: Vec<TokenBalance>,
}

impl Vault {
    /// Drops spends older than 24 hours, then returns how many remain and how much of `token_id`
    /// (None for NEAR) they account for.
    fn prune_spends(&mut self, now: u64, token_id: Option<&AccountId>) -> (usize, u128) {
        self.recent_spends.retain(|spend| spend.counts_at(now));
        let total = self
            .recent_spends
            .iter()
            .filter(|spend| spend.token_id.as_ref() == token_id)
            .fold(0, |total, spend| add_amounts(total, spend.amount.0));
        (self.recent_spends.len(), total)
    }

    fn token_balance(&self, token_id: &AccountId) -> u128 {
        self.tokens
            .iter()
            .find(|token| &token.token_id == token_id)
            .map_or(0, |token| token.balance.0)
    }

    fn token_mut(&mut self, token_id: &AccountId) -> Option<&mut TokenBalance> {
        self.tokens
            .iter_mut()
            .find(|token| &token.token_id == token_id)
    }

    /// The entry for `token_id`, created empty if the vault has none yet. None if the vault
    /// already holds `MAX_TOKEN_BALANCES` tokens.
    fn token_entry(&mut self, token_id: &AccountId) -> Option<&mut TokenBalance> {
        let index = match self
            .tokens
            .iter()
            .position(|token| &token.token_id == token_id)
        {
            Some(index) => index,
            None if self.tokens.len() < MAX_TOKEN_BALANCES => {
                self.tokens.push(TokenBalance {
                    token_id: token_id.clone(),
                    balance: U128(0),
                    on_exchange: U128(0),
                });
                self.tokens.len() - 1
            }
            None => return None,
        };
        Some(&mut self.tokens[index])
    }

    /// The entry a swap callback settles into. `agent_swap` creates both of a swap's entries
    /// before its first promise and entries are never removed, so it always exists.
    fn swap_token(&mut self, token_id: &AccountId) -> &mut TokenBalance {
        self.token_mut(token_id)
            .unwrap_or_else(|| env::panic_str("Swap token entry missing"))
    }
}

impl Policy {
    /// Normalizes the allowlist and rejects anything inconsistent.
    fn validate(&mut self) {
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

/// One `agent_swap`, carried through every step of its promise chain.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SwapTicket {
    pub spend_id: U64,
    pub owner_id: AccountId,
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
}

/// Which step of a refunded swap failed.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapStep {
    /// Depositing token_in into the vault's exchange account.
    Deposit,
    /// The exchange's swap itself, e.g. output below `min_amount_out`.
    Swap,
}

/// A swap action as the exchange's `swap` method takes it (ref-exchange `SwapAction`).
#[near(serializers = [json])]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

/// NEP-141 methods the vault calls on token contracts.
#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
}

/// Rhea (Ref) V1 exchange methods the vault calls, as defined in ref-exchange 1.9.19. Both act on
/// the vault's own deposit account on the exchange.
#[ext_contract(ext_exchange)]
pub trait Exchange {
    /// Returns the amount out of the last action.
    fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<AccountId>) -> U128;
    /// Resolves to `amount` once the tokens reached the vault, or 0 if sending them failed and
    /// the exchange put them back in the vault's deposit account.
    fn withdraw(
        &mut self,
        token_id: AccountId,
        amount: U128,
        unregister: Option<bool>,
        skip_unwrap_near: Option<bool>,
    ) -> U128;
}

/// Why an agent call was rejected, as reported in `spend_rejected` and `swap_rejected` events.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    NoVault,
    NotAgent,
    ZeroAmount,
    ZeroMinAmountOut,
    InsufficientGas,
    Frozen,
    ReceiverNotAllowlisted,
    PoolNotAllowlisted,
    PairMismatch,
    OverPerTxCap,
    TooManySpends,
    OverDailyCap,
    InsufficientBalance,
    TooManyTokens,
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
    #[event_version("1.0.0")]
    TokenDeposit {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    TokenWithdraw {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    TokenWithdrawRefunded {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
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
    /// Logged right before the panic, so it survives in the failed receipt's outcome.
    #[event_version("1.0.0")]
    SwapRejected {
        owner_id: AccountId,
        caller_id: AccountId,
        pool_id: u64,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        min_amount_out: U128,
        reason: RejectReason,
    },
    /// The swap passed every check; token_in is deducted, the swap is recorded and its promise
    /// chain has started.
    #[event_version("1.0.0")]
    SwapInitiated {
        agent_id: AccountId,
        swap: SwapTicket,
    },
    /// The exchange swapped `amount_in` for exactly `amount_out`, now credited to the owner (or
    /// recorded as `on_exchange` if withdrawing it from the exchange failed).
    #[event_version("1.0.0")]
    SwapCompleted {
        swap: SwapTicket,
        amount_out: U128,
        held_on_exchange: bool,
    },
    /// The swap did not happen; `amount_in` went back to the owner (or is recorded as
    /// `on_exchange`) and the swap's record was removed.
    #[event_version("1.0.0")]
    SwapRefunded {
        swap: SwapTicket,
        failed_step: SwapStep,
        held_on_exchange: bool,
    },
    #[event_version("1.0.0")]
    ExchangeReclaim {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        succeeded: bool,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    vaults: LookupMap<AccountId, Vault>,
    next_spend_id: u64,
    /// The exchange every swap goes through. It is fixed at init because the vault credits
    /// whatever amounts it reports: an exchange chosen per owner could report made-up output and
    /// mint balances of real tokens out of other owners' funds.
    exchange_id: AccountId,
}

#[near]
impl Contract {
    #[init]
    // near-sdk's ABI codegen re-spans `Self` here, which trips clippy::use_self.
    #[allow(clippy::use_self)]
    pub fn new(exchange_id: AccountId) -> Self {
        Self {
            vaults: LookupMap::new(b"v"),
            next_spend_id: 0,
            exchange_id,
        }
    }

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

    /// NEP-141 receiver: credits tokens sent with `ft_transfer_call` to the sender's vault. The
    /// token must be in the sender's policy and `msg` must be empty; otherwise this panics and
    /// the token contract refunds the transfer.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_id = env::predecessor_account_id();
        require!(msg.is_empty(), "Token deposits take an empty msg");
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&sender_id);
        require!(
            vault
                .policy
                .tokens
                .iter()
                .any(|token| token.token_id == token_id),
            format!("Token {token_id} is not allowlisted in this vault's policy")
        );
        let entry = vault.token_entry(&token_id).unwrap_or_else(|| {
            env::panic_str(&format!(
                "Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens"
            ))
        });
        entry.balance = U128(add_amounts(entry.balance.0, amount.0));
        if let Err(cost) = self.settle_storage(&sender_id, usage_before) {
            env::panic_str(&format!(
                "Vault NEAR balance cannot cover {} of storage for this token; deposit NEAR first",
                cost.exact_amount_display()
            ));
        }

        VaultEvent::TokenDeposit {
            owner_id: sender_id,
            token_id,
            amount,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    /// Registers (or replaces) the caller's agent and policy. Requires exactly 1 yoctoNEAR so it
    /// can only be signed with a full-access key, never a function-call key handed to an app or agent.
    ///
    /// Leaves the frozen flag, token balances and the record of recent spends unchanged.
    #[payable]
    pub fn set_agent(&mut self, agent_id: AccountId, policy: Policy) {
        assert_one_yocto();
        let mut policy = policy;
        policy.validate();

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

    /// Sends `amount` of `token_id` from the caller's vault to the caller, who must be registered
    /// with the token. Works while frozen. Requires exactly 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn withdraw_token(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "Withdrawal amount must be greater than zero");
        let owner_id = env::predecessor_account_id();
        let vault = self.vault_mut(&owner_id);
        let entry = vault
            .token_mut(&token_id)
            .unwrap_or_else(|| env::panic_str(&format!("Vault holds no {token_id}")));
        require!(
            amount.0 <= entry.balance.0,
            format!(
                "Withdrawal of {} exceeds the vault's {token_id} balance of {}",
                amount.0, entry.balance.0
            )
        );
        entry.balance = U128(sub_amounts(entry.balance.0, amount.0));

        VaultEvent::TokenWithdraw {
            owner_id: owner_id.clone(),
            token_id: token_id.clone(),
            amount,
        }
        .emit();

        ext_ft::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(owner_id.clone(), amount, None)
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_token_withdraw_complete(owner_id, token_id, amount),
            )
    }

    /// Retries withdrawing the caller's `token_id` left in the vault's exchange account after an
    /// earlier withdrawal from the exchange failed. Works while frozen. Requires exactly
    /// 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn reclaim_from_exchange(&mut self, token_id: AccountId) -> Promise {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let exchange_id = self.exchange_id.clone();
        let vault = self.vault_mut(&owner_id);
        let entry = vault
            .token_mut(&token_id)
            .filter(|entry| entry.on_exchange.0 > 0)
            .unwrap_or_else(|| {
                env::panic_str(&format!("Vault has no {token_id} left on the exchange"))
            });
        let amount = entry.on_exchange;
        entry.on_exchange = U128(0);

        ext_exchange::ext(exchange_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
            .withdraw(token_id.clone(), amount, Some(false), Some(true))
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_reclaim_complete(owner_id, token_id, amount),
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
        let attempt = Attempt::Spend {
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
        let (spend_count, spent) = vault.prune_spends(now, None);
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
        let spent = NearToken::from_yoctonear(spent);
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
            token_id: None,
            amount: U128(amount.as_yoctonear()),
        });
        self.advance_spend_id();
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

    /// Swaps `amount_in` of `token_in` from `owner_id`'s vault for `token_out` through exchange
    /// pool `pool_id`. Only the vault's registered agent may call this, and only within the
    /// vault's policy; it needs at least `AGENT_SWAP_TGAS` of gas.
    ///
    /// token_in is deducted and the swap recorded before any promise. The chain then deposits
    /// token_in into the vault's exchange account, swaps it there (learning the exact output from
    /// the exchange's return value), and withdraws the output to the vault, crediting the owner
    /// exactly that amount. If the deposit or swap fails, token_in is refunded and the record
    /// removed.
    pub fn agent_swap(
        &mut self,
        owner_id: AccountId,
        pool_id: u64,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        min_amount_out: U128,
    ) -> Promise {
        let caller_id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let usage_before = env::storage_usage();
        let exchange_id = self.exchange_id.clone();
        let ticket = SwapTicket {
            spend_id: U64(self.next_spend_id),
            owner_id,
            pool_id,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
        };
        let attempt = Attempt::Swap {
            caller_id: &caller_id,
            ticket: &ticket,
        };
        let SwapTicket {
            owner_id,
            token_in,
            token_out,
            ..
        } = &ticket;

        let Some(vault) = self.vaults.get_mut(owner_id) else {
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
        attempt.require(amount_in.0 > 0, RejectReason::ZeroAmount, || {
            "Swap amount must be greater than zero".to_string()
        });
        attempt.require(min_amount_out.0 > 0, RejectReason::ZeroMinAmountOut, || {
            "Minimum amount out must be greater than zero".to_string()
        });
        attempt.require(
            env::prepaid_gas() >= Gas::from_tgas(AGENT_SWAP_TGAS),
            RejectReason::InsufficientGas,
            || format!("agent_swap needs at least {AGENT_SWAP_TGAS} TGas"),
        );
        attempt.require(!vault.frozen, RejectReason::Frozen, || {
            "Vault is frozen; agent swapping is disabled".to_string()
        });
        let Some(pool) = vault
            .policy
            .pools
            .iter()
            .find(|pool| pool.pool_id == pool_id)
        else {
            attempt.reject(
                RejectReason::PoolNotAllowlisted,
                &format!("Pool {pool_id} is not on the vault's pool allowlist"),
            );
        };
        attempt.require(
            token_in != token_out
                && pool.token_ids.contains(token_in)
                && pool.token_ids.contains(token_out),
            RejectReason::PairMismatch,
            || {
                format!(
                    "Pool {pool_id} trades {} and {}, not {token_in} for {token_out}",
                    pool.token_ids[0], pool.token_ids[1]
                )
            },
        );
        // The policy guarantees caps for every token of an allowlisted pool.
        let Some(caps) = vault
            .policy
            .tokens
            .iter()
            .find(|token| &token.token_id == token_in)
            .cloned()
        else {
            attempt.reject(
                RejectReason::PairMismatch,
                &format!("Token {token_in} has no caps in the policy"),
            );
        };
        attempt.require(
            amount_in.0 <= caps.per_tx_cap.0,
            RejectReason::OverPerTxCap,
            || {
                format!(
                    "Amount {} of {token_in} exceeds its per-transaction cap of {}",
                    amount_in.0, caps.per_tx_cap.0
                )
            },
        );

        // Swaps share the sliding window and spend count with NEAR spends; caps are per token.
        let (spend_count, sold) = vault.prune_spends(now, Some(token_in));
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
        attempt.require(
            add_amounts(sold, amount_in.0) <= caps.daily_cap.0,
            RejectReason::OverDailyCap,
            || {
                format!(
                    "Amount {} of {token_in} would exceed its 24-hour cap of {} ({sold} already sold in the last 24 hours)",
                    amount_in.0, caps.daily_cap.0
                )
            },
        );
        let balance_in = vault.token_balance(token_in);
        attempt.require(
            amount_in.0 <= balance_in,
            RejectReason::InsufficientBalance,
            || {
                format!(
                    "Amount {} exceeds the vault's {token_in} balance of {balance_in}",
                    amount_in.0
                )
            },
        );

        let entry_in = vault.swap_token(token_in);
        entry_in.balance = U128(sub_amounts(entry_in.balance.0, amount_in.0));
        // Create the output's entry now, so no callback ever changes the record's size.
        if vault.token_entry(token_out).is_none() {
            attempt.reject(
                RejectReason::TooManyTokens,
                &format!("Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens"),
            );
        }
        vault.recent_spends.push(Spend {
            spend_id: ticket.spend_id,
            timestamp: U64(now),
            token_id: Some(token_in.clone()),
            amount: amount_in,
        });
        self.advance_spend_id();
        if let Err(cost) = self.settle_storage(owner_id, usage_before) {
            attempt.reject(
                RejectReason::InsufficientBalance,
                &format!(
                    "Vault NEAR balance cannot cover {} of storage for this swap's record",
                    cost.exact_amount_display()
                ),
            );
        }

        VaultEvent::SwapInitiated {
            agent_id: caller_id.clone(),
            swap: ticket.clone(),
        }
        .emit();

        ext_ft::ext(token_in.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(FT_TRANSFER_CALL_TGAS))
            .ft_transfer_call(exchange_id, amount_in, None, String::new())
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_SWAP_DEPOSITED_TGAS))
                    .on_swap_deposited(ticket),
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

    /// Settles a `withdraw_token` transfer, crediting the vault back if it failed.
    #[private]
    pub fn on_token_withdraw_complete(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            let entry = self.vault_mut(&owner_id).swap_token(&token_id);
            entry.balance = U128(add_amounts(entry.balance.0, amount.0));
            VaultEvent::TokenWithdrawRefunded {
                owner_id,
                token_id,
                amount,
            }
            .emit();
        }
        result.is_ok()
    }

    /// Swap step 2: token_in's `ft_transfer_call` into the vault's exchange account resolved to
    /// the amount the exchange kept. All of it: swap it. None: the token refunded it, so refund
    /// the owner.
    #[private]
    pub fn on_swap_deposited(
        &mut self,
        ticket: SwapTicket,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let used = used.map_or(0, |used| used.0);
        let amount_in = ticket.amount_in.0;
        // NEP-141 never reports more than was sent; treating it as "all" keeps the callback
        // panic-free even for a token that does.
        if used >= amount_in {
            let action = SwapAction {
                pool_id: ticket.pool_id,
                token_in: ticket.token_in.clone(),
                amount_in: Some(ticket.amount_in),
                token_out: ticket.token_out.clone(),
                min_amount_out: ticket.min_amount_out,
            };
            return ext_exchange::ext(self.exchange_id.clone())
                .with_static_gas(Gas::from_tgas(EXCHANGE_SWAP_TGAS))
                .swap(vec![action], None)
                .then(
                    Self::ext_self()
                        .with_static_gas(Gas::from_tgas(ON_SWAP_EXECUTED_TGAS))
                        .on_swap_executed(ticket),
                )
                .into();
        }
        if used == 0 {
            self.refund_swap(&ticket, amount_in, true, SwapStep::Deposit);
            return PromiseOrValue::Value(false);
        }
        // A plain deposit is all or nothing, but if the exchange ever kept only part, return the
        // rest now and withdraw what it kept before refunding.
        let entry = self
            .vault_mut(&ticket.owner_id)
            .swap_token(&ticket.token_in);
        entry.balance = U128(add_amounts(entry.balance.0, sub_amounts(amount_in, used)));
        self.withdraw_refund(ticket, used, SwapStep::Deposit).into()
    }

    /// Swap step 3: the exchange's `swap` returned the exact amount out, or failed (for example
    /// below `min_amount_out`) and left token_in in the vault's exchange account.
    #[private]
    pub fn on_swap_executed(
        &mut self,
        ticket: SwapTicket,
        #[callback_result] amount_out: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        match amount_out {
            Ok(amount_out) if amount_out.0 > 0 => ext_exchange::ext(self.exchange_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
                .withdraw(
                    ticket.token_out.clone(),
                    amount_out,
                    Some(false),
                    Some(true),
                )
                .then(
                    Self::ext_self()
                        .with_static_gas(Gas::from_tgas(ON_SWAP_WITHDRAWN_TGAS))
                        .on_swap_output_withdrawn(ticket, amount_out),
                )
                .into(),
            // Zero output needs a zero `min_amount_out`, which agent_swap rejects. Never withdraw
            // it: the exchange reads an amount of 0 as "everything".
            Ok(amount_out) => {
                VaultEvent::SwapCompleted {
                    swap: ticket,
                    amount_out,
                    held_on_exchange: false,
                }
                .emit();
                PromiseOrValue::Value(true)
            }
            Err(_) => {
                let amount_in = ticket.amount_in.0;
                self.withdraw_refund(ticket, amount_in, SwapStep::Swap)
                    .into()
            }
        }
    }

    /// Swap step 4: the output's withdrawal from the exchange resolved to `amount_out` if it
    /// reached the vault. Credits the owner exactly that, or records it as left on the exchange.
    #[private]
    pub fn on_swap_output_withdrawn(
        &mut self,
        ticket: SwapTicket,
        amount_out: U128,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount_out);
        let entry = self
            .vault_mut(&ticket.owner_id)
            .swap_token(&ticket.token_out);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount_out.0));
        } else {
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount_out.0));
        }

        VaultEvent::SwapCompleted {
            swap: ticket,
            amount_out,
            held_on_exchange: !delivered,
        }
        .emit();
        true
    }

    /// Refund step: token_in's withdrawal from the exchange resolved to `amount` if it reached
    /// the vault.
    #[private]
    pub fn on_swap_refund_withdrawn(
        &mut self,
        ticket: SwapTicket,
        amount: U128,
        failed_step: SwapStep,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount);
        self.refund_swap(&ticket, amount.0, delivered, failed_step);
        false
    }

    /// Settles `reclaim_from_exchange`.
    #[private]
    pub fn on_reclaim_complete(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount);
        let entry = self.vault_mut(&owner_id).swap_token(&token_id);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount.0));
        } else {
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount.0));
        }

        VaultEvent::ExchangeReclaim {
            owner_id,
            token_id,
            amount,
            succeeded: delivered,
        }
        .emit();
        delivered
    }

    pub fn get_vault(&self, owner_id: AccountId) -> Option<Vault> {
        self.vaults.get(&owner_id).cloned()
    }

    pub fn get_policy(&self, owner_id: AccountId) -> Option<Policy> {
        self.vaults.get(&owner_id).map(|vault| vault.policy.clone())
    }

    pub fn get_exchange_id(&self) -> AccountId {
        self.exchange_id.clone()
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

    fn advance_spend_id(&mut self) {
        self.next_spend_id = self
            .next_spend_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Spend id overflow"));
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

    /// Withdraws `amount` of a swap's token_in from the vault's exchange account so it can be
    /// refunded.
    fn withdraw_refund(&self, ticket: SwapTicket, amount: u128, failed_step: SwapStep) -> Promise {
        ext_exchange::ext(self.exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
            .withdraw(
                ticket.token_in.clone(),
                U128(amount),
                Some(false),
                Some(true),
            )
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_SWAP_WITHDRAWN_TGAS))
                    .on_swap_refund_withdrawn(ticket, U128(amount), failed_step),
            )
    }

    /// Ends a swap that did not happen: returns `amount` of token_in to the owner's balance (or
    /// records it as left on the exchange if it could not be withdrawn) and deletes exactly this
    /// swap's spend entry.
    fn refund_swap(
        &mut self,
        ticket: &SwapTicket,
        amount: u128,
        delivered: bool,
        failed_step: SwapStep,
    ) {
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&ticket.owner_id);
        let entry = vault.swap_token(&ticket.token_in);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount));
        } else {
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount));
        }
        vault
            .recent_spends
            .retain(|spend| spend.spend_id != ticket.spend_id);
        // Removing an entry only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&ticket.owner_id, usage_before);

        VaultEvent::SwapRefunded {
            swap: ticket.clone(),
            failed_step,
            held_on_exchange: !delivered,
        }
        .emit();
    }
}

/// What an agent asked for, kept so every rejection can be logged.
enum Attempt<'a> {
    Spend {
        owner_id: &'a AccountId,
        caller_id: &'a AccountId,
        receiver_id: &'a AccountId,
        amount: NearToken,
    },
    Swap {
        caller_id: &'a AccountId,
        ticket: &'a SwapTicket,
    },
}

impl Attempt<'_> {
    /// `require!` for agent calls: logs a rejection event before panicking.
    fn require(&self, condition: bool, reason: RejectReason, message: impl FnOnce() -> String) {
        if !condition {
            self.reject(reason, &message());
        }
    }

    /// Logs survive a panic in the failed receipt's outcome (state changes do not), so indexers
    /// still see the rejected attempt.
    fn reject(&self, reason: RejectReason, message: &str) -> ! {
        match self {
            Self::Spend {
                owner_id,
                caller_id,
                receiver_id,
                amount,
            } => VaultEvent::SpendRejected {
                owner_id: (*owner_id).clone(),
                caller_id: (*caller_id).clone(),
                receiver_id: (*receiver_id).clone(),
                amount: *amount,
                reason,
            }
            .emit(),
            Self::Swap { caller_id, ticket } => VaultEvent::SwapRejected {
                owner_id: ticket.owner_id.clone(),
                caller_id: (*caller_id).clone(),
                pool_id: ticket.pool_id,
                token_in: ticket.token_in.clone(),
                token_out: ticket.token_out.clone(),
                amount_in: ticket.amount_in,
                min_amount_out: ticket.min_amount_out,
                reason,
            }
            .emit(),
        }
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

fn add_amounts(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("Token amount overflow"))
}

fn sub_amounts(a: u128, b: u128) -> u128 {
    a.checked_sub(b)
        .unwrap_or_else(|| env::panic_str("Token amount underflow"))
}

fn storage_cost(bytes: StorageUsage) -> NearToken {
    env::storage_byte_cost()
        .checked_mul(bytes.into())
        .unwrap_or_else(|| env::panic_str("Storage cost overflow"))
}

/*
 * Unit tests cover the timing edges and callback outcomes the sandbox can't hit precisely. The
 * sandbox tests in tests/ cover the full flows against a real node and the real exchange.
 */
#[cfg(test)]
mod tests;
