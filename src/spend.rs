//! NEAR spends by the agent, and the 24-hour sliding window that spends and swaps share.
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, NearToken, Promise, env, near};

use crate::events::{Attempt, RejectReason, VaultEvent};
use crate::{CALLBACK_GAS, Contract, ContractExt, Vault, add_amounts, add_tokens, sub_tokens};

/// How long a spend counts toward the 24-hour limits, in nanoseconds (block timestamps are ns).
pub const WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

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
    pub fn counts_at(&self, now: u64) -> bool {
        let expires = self
            .timestamp
            .0
            .checked_add(WINDOW_NS)
            .unwrap_or_else(|| env::panic_str("Spend timestamp overflow"));
        now < expires
    }
}

impl Vault {
    /// Drops spends older than 24 hours, then returns how many remain and how much of `token_id`
    /// (None for NEAR) they account for.
    pub fn prune_spends(&mut self, now: u64, token_id: Option<&AccountId>) -> (usize, u128) {
        self.recent_spends.retain(|spend| spend.counts_at(now));
        self.window_usage(now, token_id)
    }

    /// How many spends count at `now` and how much of `token_id` (None for NEAR) they account
    /// for, without pruning anything.
    pub fn window_usage(&self, now: u64, token_id: Option<&AccountId>) -> (usize, u128) {
        self.recent_spends
            .iter()
            .filter(|spend| spend.counts_at(now))
            .fold((0, 0), |(count, total), spend| {
                let total = if spend.token_id.as_ref() == token_id {
                    add_amounts(total, spend.amount.0)
                } else {
                    total
                };
                (count + 1, total)
            })
    }
}

#[near]
impl Contract {
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
}

impl Contract {
    pub fn advance_spend_id(&mut self) {
        self.next_spend_id = self
            .next_spend_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Spend id overflow"));
    }
}
