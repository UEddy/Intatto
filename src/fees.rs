//! The protocol fee on agent swaps, and the treasury it accrues to.
//!
//! The fee is a compile-time constant: no method sets or changes it, so the code hash alone says
//! what it is. It is taken only from a swap's output, and only when that output reaches the vault:
//! the owner is credited `amount_out - fee` and the treasury `fee`, so the two always add up to
//! exactly what the exchange returned. Output left on the exchange (a failed withdrawal) carries no
//! fee: the treasury balance only ever holds tokens the vault itself holds.
//!
//! The treasury account is set once by `new` and cannot be changed. Its balances are kept apart
//! from every owner's and move only through `withdraw_fees`, which only the treasury can call.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, Promise, PromiseError, assert_one_yocto, borsh, env, near, require};

use crate::events::VaultEvent;
use crate::tokens::ext_ft;
use crate::{
    CALLBACK_GAS, Contract, ContractExt, FT_TRANSFER_GAS, ONE_YOCTO, add_amounts, sub_amounts,
};

/// The fee on agent swap output, in basis points: 10 = 0.10%.
pub const FEE_BPS: u16 = 10;
/// The most `FEE_BPS` may ever be. Checked when the contract compiles.
pub const MAX_FEE_BPS: u16 = 10;
const _: () = assert!(FEE_BPS <= MAX_FEE_BPS, "FEE_BPS exceeds MAX_FEE_BPS");

const BPS_DENOMINATOR: u128 = 10_000;

/// Storage key of the treasury account id. Like the locks and the ledger, it lives outside
/// `Contract` and `Vault`, so both Borsh layouts stay as in v1.
const TREASURY_KEY: &[u8] = b"t";
/// Storage prefix of the treasury's balance per token, one entry per token a swap ever output.
const FEES_PREFIX: &[u8] = b"f";

fn fee_balances() -> LookupMap<AccountId, U128> {
    LookupMap::new(FEES_PREFIX)
}

/// Writes the treasury account. Only `new` calls this, once.
pub fn init_treasury(treasury_id: AccountId) {
    require!(
        treasury_id != env::current_account_id(),
        "The treasury cannot be the vault contract itself"
    );
    // Raw storage rather than `store::LazyOption`: `LazyOption::new(key, None)` starts with a
    // cached `None` and never reads the stored value (near-sdk 5.29.1, store/lazy_option).
    let bytes = borsh::to_vec(&treasury_id)
        .unwrap_or_else(|_| env::panic_str("Cannot serialize the treasury id"));
    env::storage_write(TREASURY_KEY, &bytes);
}

/// The treasury account, or None on a contract that was upgraded from code without one.
pub fn treasury_id() -> Option<AccountId> {
    env::storage_read(TREASURY_KEY).map(|bytes| {
        borsh::from_slice(&bytes)
            .unwrap_or_else(|_| env::panic_str("Cannot deserialize the treasury id"))
    })
}

/// The treasury's accrued fees in `token_id`.
pub fn accrued(token_id: &AccountId) -> u128 {
    fee_balances().get(token_id).map_or(0, |fees| fees.0)
}

/// Creates `token_id`'s fee entry at zero if there is none, so the callback that later credits
/// it never adds storage. Called in `begin_swap`, where the owner pays for the entry.
pub fn ensure_entry(token_id: &AccountId) {
    let mut map = fee_balances();
    if !map.contains_key(token_id) {
        map.insert(token_id.clone(), U128(0));
    }
}

/// Adds `amount` to the treasury's `token_id` balance.
fn credit(token_id: &AccountId, amount: u128) {
    let mut map = fee_balances();
    let current = map.get(token_id).map_or(0, |fees| fees.0);
    map.insert(token_id.clone(), U128(add_amounts(current, amount)));
}

/// Splits a swap's output into `(net, fee)`: `fee = floor(amount_out * FEE_BPS / 10000)` and
/// `net = amount_out - fee`, so `net + fee == amount_out` always.
///
/// Computed as whole multiples of 10000 plus a remainder, like `slippage_floor`, so it never forms
/// `amount_out * FEE_BPS`. With `FEE_BPS <= 10` no step can overflow even at `u128::MAX`. It runs
/// in a callback, which must not panic, so if a step ever did fail the whole output goes to the
/// owner and the fee is 0.
pub fn split_fee(amount_out: u128) -> (u128, u128) {
    let bps = u128::from(FEE_BPS);
    let fee = (amount_out / BPS_DENOMINATOR)
        .checked_mul(bps)
        .and_then(|whole| {
            (amount_out % BPS_DENOMINATOR)
                .checked_mul(bps)
                .map(|part| part / BPS_DENOMINATOR)
                .and_then(|part| whole.checked_add(part))
        });
    fee.and_then(|fee| amount_out.checked_sub(fee).map(|net| (net, fee)))
        .unwrap_or((amount_out, 0))
}

/// Credits a delivered swap output: the owner's share is returned for the caller to add to the
/// owner's balance, and the fee goes to the treasury.
pub fn take_fee(token_id: &AccountId, amount_out: u128) -> (u128, u128) {
    let (net, fee) = split_fee(amount_out);
    if fee > 0 {
        credit(token_id, fee);
    }
    (net, fee)
}

#[near]
impl Contract {
    /// Sends `amount` of the treasury's accrued `token_id` fees to the treasury account. Only the
    /// treasury may call it, with exactly 1 yoctoNEAR (full-access key only). It can never take
    /// more than the fees accrued in that token, and touches no owner's balance. If the transfer
    /// fails (for example, the treasury is not registered with the token), the amount is credited
    /// back to the treasury's balance.
    #[payable]
    pub fn withdraw_fees(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "Withdrawal amount must be greater than zero");
        let caller_id = env::predecessor_account_id();
        let Some(treasury_id) = treasury_id() else {
            env::panic_str("This vault has no treasury account");
        };
        require!(
            caller_id == treasury_id,
            "Only the treasury account can withdraw fees"
        );
        let held = accrued(&token_id);
        require!(
            amount.0 <= held,
            format!(
                "Withdrawal of {} exceeds the accrued {token_id} fees of {held}",
                amount.0
            )
        );
        // The entry exists (held > 0) and keeps its size, so no storage changes.
        fee_balances().insert(token_id.clone(), U128(sub_amounts(held, amount.0)));

        VaultEvent::FeesWithdrawn {
            treasury_id: treasury_id.clone(),
            token_id: token_id.clone(),
            amount,
        }
        .emit();

        ext_ft::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(treasury_id.clone(), amount, None)
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_fees_withdraw_complete(treasury_id, token_id, amount),
            )
    }

    /// Settles a `withdraw_fees` transfer, crediting the treasury back if it failed.
    #[private]
    pub fn on_fees_withdraw_complete(
        &mut self,
        treasury_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            credit(&token_id, amount.0);
            VaultEvent::FeesWithdrawRefunded {
                treasury_id,
                token_id,
                amount,
            }
            .emit();
        }
        result.is_ok()
    }

    /// The fee on agent swap output, in basis points.
    pub const fn get_fee_bps(&self) -> u16 {
        FEE_BPS
    }

    /// The account that may withdraw accrued fees; null on a vault upgraded from code without one.
    pub fn get_treasury_id(&self) -> Option<AccountId> {
        treasury_id()
    }

    /// The treasury's accrued fees in `token_id` (0 if none).
    pub fn get_fees(&self, token_id: AccountId) -> U128 {
        U128(accrued(&token_id))
    }
}
