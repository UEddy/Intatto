//! Owner-set locks on withdrawals.
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, assert_one_yocto, env, near, require};

use crate::events::VaultEvent;
use crate::{Contract, ContractExt};

/// Storage prefix of the withdrawal locks, one entry per owner who ever set one. They are kept
/// outside `Contract` and `Vault` so both Borsh layouts stay exactly as in v1: this code can
/// replace v1 code over existing state without a migration.
const LOCKS_PREFIX: &[u8] = b"l";

/// A handle on the locks. Writes are cached until it is flushed or dropped.
fn withdrawal_locks() -> LookupMap<AccountId, u64> {
    LookupMap::new(LOCKS_PREFIX)
}

/// The block timestamp (ns) until which `owner_id`'s withdrawals are locked, if a lock was ever
/// set. A value in the past means the lock has expired.
pub fn withdrawals_locked_until(owner_id: &AccountId) -> Option<u64> {
    withdrawal_locks().get(owner_id).copied()
}

/// The end of `owner_id`'s lock, if it is still in force at the current block.
pub fn active_lock(owner_id: &AccountId) -> Option<u64> {
    withdrawals_locked_until(owner_id).filter(|&until| env::block_timestamp() < until)
}

/// Panics if `owner_id`'s withdrawals are locked at the current block.
pub fn require_withdrawals_unlocked(owner_id: &AccountId) {
    if let Some(until) = active_lock(owner_id) {
        env::panic_str(&format!(
            "Withdrawals are locked until {until} (block timestamp, ns)"
        ));
    }
}

#[near]
impl Contract {
    /// Blocks `withdraw`, `withdraw_token` and `set_agent` for the caller's vault until block
    /// timestamp `timestamp_ns`; from that timestamp on they work again. A lock can only be
    /// extended: a value earlier than the current lock is rejected, even if that lock has already
    /// expired.
    ///
    /// Nothing else changes: `remove_agent`, `freeze` and `unfreeze` work as before, and the
    /// current agent can still spend and swap within its current policy while withdrawals are
    /// locked. Requires exactly 1 yoctoNEAR (full-access key only). The first lock's storage is
    /// charged to the vault balance.
    #[payable]
    pub fn lock_withdrawals_until(&mut self, timestamp_ns: U64) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let until = timestamp_ns.0;
        let usage_before = env::storage_usage();
        // Only an existing vault can be locked, and it pays for the lock's storage.
        let _ = self.vault_mut(&owner_id);

        let mut locks = withdrawal_locks();
        if let Some(&current) = locks.get(&owner_id) {
            require!(
                until >= current,
                format!(
                    "Withdrawals are already locked until {current}; a lock can only be extended"
                )
            );
        }
        locks.insert(owner_id.clone(), until);
        locks.flush();
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            env::panic_str(&format!(
                "Vault balance cannot cover {} of storage for the lock; deposit more first",
                cost.exact_amount_display()
            ));
        }

        VaultEvent::WithdrawalsLocked {
            owner_id,
            locked_until: timestamp_ns,
        }
        .emit();
    }
}
