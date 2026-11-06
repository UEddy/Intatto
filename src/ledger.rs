//! The vault-wide ledger of what the vault's own account on the exchange should hold.
//!
//! Every owner's tokens on the exchange sit in that one account, so an owner's `on_exchange`
//! amount is only bookkeeping. If tokens leave the account without the vault knowing (the
//! exchange moving a failed withdrawal to its lostfound, for one), a reclaim that simply
//! withdrew the owner's amount would take tokens that belong to other owners. The ledger lets
//! `reclaim_from_exchange` check first that the account holds everything owners are owed.
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, env, near};

use crate::add_amounts;
use crate::events::VaultEvent;

/// Storage prefix of the ledger, one entry per token that was ever swapped. Kept outside
/// `Contract` and `Vault`, like the withdrawal locks, so both Borsh layouts stay as in v1.
const LEDGER_PREFIX: &[u8] = b"x";

/// The ledger entry of one token.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExchangeLedger {
    /// What the vault's exchange account should hold of this token: every owner's `on_exchange`,
    /// plus whatever swaps in flight have sent to the exchange or received there.
    pub expected: U128,
    /// Swaps and reclaims in flight that move this token into or out of that account.
    pub in_flight: u32,
    /// Bumped each time one of them starts. A reclaim checks it did not change between reading
    /// the exchange's balance and acting on it.
    pub generation: U64,
}

fn ledgers() -> LookupMap<AccountId, ExchangeLedger> {
    LookupMap::new(LEDGER_PREFIX)
}

/// The ledger entry of `token_id`, empty if it was never swapped.
pub fn ledger(token_id: &AccountId) -> ExchangeLedger {
    ledgers().get(token_id).cloned().unwrap_or_default()
}

/// Applies `change` to `token_id`'s entry and writes it, creating the entry if needed. The map
/// handle is dropped, and so flushed, before this returns.
fn update(token_id: &AccountId, change: impl FnOnce(&mut ExchangeLedger)) {
    let mut map = ledgers();
    let mut entry = map.get(token_id).cloned().unwrap_or_default();
    change(&mut entry);
    map.insert(token_id.clone(), entry);
}

/// A swap or reclaim that moves `token_id` starts, sending `amount` of it to the exchange.
/// Only called before the first promise of a swap or a reclaim's withdrawal, where a panic
/// rejects the whole operation.
pub fn start(token_id: &AccountId, amount: u128) {
    update(token_id, |entry| {
        entry.expected = U128(add_amounts(entry.expected.0, amount));
        entry.in_flight = entry
            .in_flight
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Too many exchange operations in flight"));
        entry.generation = U64(entry
            .generation
            .0
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Ledger generation overflow")));
    });
}

/// `amount` more of `token_id` is now in the vault's exchange account (a swap's output).
pub fn expect(token_id: &AccountId, amount: u128) {
    update(token_id, |entry| {
        entry.expected = U128(add_amounts(entry.expected.0, amount));
    });
}

/// `amount` of `token_id` left the vault's exchange account, or never reached it, and nobody is
/// owed it there any more.
///
/// Called from callbacks, which must not panic, so an underflow (the ledger missing something,
/// as for swaps started before the ledger existed) is logged and the entry clamped at zero.
pub fn release(token_id: &AccountId, amount: u128) {
    update(token_id, |entry| {
        entry.expected = U128(entry.expected.0.checked_sub(amount).unwrap_or_else(|| {
            underflow(token_id, "expected", entry.expected.0, amount);
            0
        }));
    });
}

/// A swap or reclaim that moves `token_id` has settled. Never panics, like `release`.
pub fn finish(token_id: &AccountId) {
    update(token_id, |entry| {
        entry.in_flight = entry.in_flight.checked_sub(1).unwrap_or_else(|| {
            underflow(token_id, "in_flight", entry.in_flight.into(), 1);
            0
        });
    });
}

fn underflow(token_id: &AccountId, field: &str, value: u128, decrease: u128) {
    VaultEvent::ExchangeLedgerUnderflow {
        token_id: token_id.clone(),
        field: field.to_string(),
        value: U128(value),
        decrease: U128(decrease),
    }
    .emit();
}
