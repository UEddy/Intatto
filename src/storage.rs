//! Storage staking: every vault pays for the bytes its own record takes.
use near_sdk::{AccountId, NearToken, StorageUsage, env};

use crate::{Contract, add_tokens};

impl Contract {
    /// Writes pending changes to `owner_id`'s record, then charges the storage they added since
    /// `usage_before` to the vault balance, or credits back the storage they freed. Storage is
    /// staked from the contract balance that holds everyone's funds, so each vault pays its own.
    ///
    /// Returns the cost, charging nothing, if the balance cannot cover new storage.
    pub fn settle_storage(
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

pub fn storage_cost(bytes: StorageUsage) -> NearToken {
    env::storage_byte_cost()
        .checked_mul(bytes.into())
        .unwrap_or_else(|| env::panic_str("Storage cost overflow"))
}
