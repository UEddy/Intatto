// Find NEAR documentation at https://docs.near.org
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near, require,
};

mod callbacks;
mod events;
mod fees;
mod intents;
mod ledger;
mod lock;
mod policy;
mod spend;
mod storage;
mod swap;
mod tokens;

pub use events::{RejectReason, VaultEvent};
pub use fees::{FEE_BPS, MAX_FEE_BPS, split_fee};
pub use intents::{
    INTENTS_KEY_PATH, IntentsBalance, IntentsConfig, IntentsVerifier, MPC_ED25519_DOMAIN,
    MpcSigner, REGISTER_KEY_TGAS, VERIFY_KEY_TGAS, ext_intents, ext_mpc_signer,
};
pub use ledger::ExchangeLedger;
pub use policy::{
    MAX_ALLOWLIST_LEN, MAX_POLICY_POOLS, MAX_POLICY_TOKENS, MAX_SLIPPAGE_BPS,
    MAX_SPENDS_PER_24H_LIMIT, Policy, PoolPolicy, TokenPolicy,
};
pub use spend::{Spend, WINDOW_NS};
use storage::storage_cost;
pub use swap::{
    AGENT_SWAP_TGAS, Exchange, RECLAIM_TGAS, SwapAction, SwapStep, SwapTicket, ext_exchange,
    slippage_floor,
};
pub use tokens::{FungibleToken, MAX_TOKEN_BALANCES, TokenBalance, ext_ft};

// Names src/tests.rs reaches through `use super::*`, as it did when this was a single file.
#[cfg(test)]
use near_sdk::json_types::U128;
#[cfg(test)]
use near_sdk::{PromiseError, PromiseOrValue};

/// Gas reserved for the callbacks that settle a transfer.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

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

/// What `get_vault` returns: the vault's fields, plus its withdrawal lock.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultView {
    #[serde(flatten)]
    pub vault: Vault,
    /// Block timestamp (ns) until which `withdraw` and `withdraw_token` are blocked; null if the
    /// owner never set a lock. A value in the past means the lock has expired.
    pub withdrawals_locked_until: Option<U64>,
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
    /// `exchange_id` is the exchange every swap goes through; `treasury_id` is the only account
    /// that can withdraw the swap fees. Neither can be changed afterwards.
    #[init]
    // near-sdk's ABI codegen re-spans `Self` here, which trips clippy::use_self.
    #[allow(clippy::use_self)]
    pub fn new(exchange_id: AccountId, treasury_id: AccountId) -> Self {
        fees::init_treasury(treasury_id);
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

    /// Sends `amount` from the caller's vault back to the caller. Works while frozen, but not
    /// while withdrawals are locked. Requires exactly 1 yoctoNEAR (full-access key only).
    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        assert_one_yocto();
        require!(
            !amount.is_zero(),
            "Withdrawal amount must be greater than zero"
        );
        let owner_id = env::predecessor_account_id();
        lock::require_withdrawals_unlocked(&owner_id);
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

    pub fn get_vault(&self, owner_id: AccountId) -> Option<VaultView> {
        self.vaults.get(&owner_id).map(|vault| VaultView {
            vault: vault.clone(),
            withdrawals_locked_until: lock::withdrawals_locked_until(&owner_id).map(U64),
        })
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

/*
 * Unit tests cover the timing edges and callback outcomes the sandbox can't hit precisely. The
 * sandbox tests in tests/ cover the full flows against a real node and the real exchange.
 */
#[cfg(test)]
mod tests;
