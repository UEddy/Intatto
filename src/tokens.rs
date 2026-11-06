//! NEP-141 tokens held for owners: deposits through `ft_on_transfer`, balances and withdrawals.
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Promise, PromiseOrValue, assert_one_yocto, env, ext_contract, near, require,
};

use crate::events::VaultEvent;
use crate::{
    CALLBACK_GAS, Contract, ContractExt, FT_TRANSFER_GAS, ONE_YOCTO, Vault, add_amounts,
    sub_amounts,
};

/// Upper bound on a vault's token balance entries. Entries are never removed, so no swap callback
/// ever has to create one (or pay for its storage).
pub const MAX_TOKEN_BALANCES: usize = 20;

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

impl Vault {
    pub fn token_balance(&self, token_id: &AccountId) -> u128 {
        self.tokens
            .iter()
            .find(|token| &token.token_id == token_id)
            .map_or(0, |token| token.balance.0)
    }

    pub fn token_mut(&mut self, token_id: &AccountId) -> Option<&mut TokenBalance> {
        self.tokens
            .iter_mut()
            .find(|token| &token.token_id == token_id)
    }

    /// The entry for `token_id`, created empty if the vault has none yet. None if the vault
    /// already holds `MAX_TOKEN_BALANCES` tokens.
    pub fn token_entry(&mut self, token_id: &AccountId) -> Option<&mut TokenBalance> {
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
    pub fn swap_token(&mut self, token_id: &AccountId) -> &mut TokenBalance {
        self.token_mut(token_id)
            .unwrap_or_else(|| env::panic_str("Swap token entry missing"))
    }
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

#[near]
impl Contract {
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
}
