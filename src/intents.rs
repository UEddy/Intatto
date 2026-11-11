//! The vault's own account on the NEAR Intents Verifier (intents.near), and the MPC-derived key
//! that signs for it.
//!
//! The vault holds one account on intents.near, under its own account id. Deposits and
//! withdrawals there are authenticated by predecessor: the vault calls intents.near as itself.
//! Intents (step 3, `intent_swap.rs`) are authenticated by signature: intents.near accepts a
//! NEP-413 payload signed by a key registered for the vault's account. That key is the vault's
//! Ed25519 key derived by the MPC signer (domain 1) from the vault's account id and
//! `INTENTS_KEY_PATH`, so only a `sign` request made by the vault contract itself can produce a
//! signature under it. The vault registers exactly that one key, read from the signer's
//! `derived_public_key` in a callback, and then checks that `public_keys_of(vault)` is exactly
//! that key. Agent intent swaps are refused unless that check passed.
//!
//! Like the exchange, intents.near holds every owner's tokens in the vault's one account there,
//! so each owner's intents balance below is bookkeeping. All of it lives outside `Contract` and
//! `Vault`, so both Borsh layouts stay as in earlier builds.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, Promise, PromiseError, assert_one_yocto, borsh, env, ext_contract, near,
    require,
};

use crate::events::VaultEvent;
use crate::tokens::{MAX_TOKEN_BALANCES, ext_ft};
use crate::{CALLBACK_GAS, Contract, ContractExt, ONE_YOCTO, add_amounts, sub_amounts};

/// The MPC domain of the vault's intents key: Ed25519 (FROST) on v1.signer.
pub const MPC_ED25519_DOMAIN: u64 = 1;
/// Derivation path of the vault's intents key. Fixed: another path is another key.
pub const INTENTS_KEY_PATH: &str = "intatto/intents.near/v1";

/// Storage key of the intents config (raw Borsh, like the treasury id).
const CONFIG_KEY: &[u8] = b"i";
/// Storage prefix of every owner's intents balances.
const BALANCES_PREFIX: &[u8] = b"n";

pub const INTENTS_VIEW_TGAS: u64 = 5;
pub const INTENTS_ADD_KEY_TGAS: u64 = 10;
pub const INTENTS_FT_TRANSFER_CALL_TGAS: u64 = 50;
pub const INTENTS_FT_WITHDRAW_TGAS: u64 = 50;
const ON_KEYS_LISTED_TGAS: u64 = 10;
const ON_KEY_ADDED_TGAS: u64 = 10 + INTENTS_VIEW_TGAS + ON_KEYS_LISTED_TGAS;
const ON_KEY_DERIVED_TGAS: u64 = 10 + INTENTS_ADD_KEY_TGAS + ON_KEY_ADDED_TGAS;
/// Gas `register_intents_key` needs: the call, the signer's view and the chain that follows.
pub const REGISTER_KEY_TGAS: u64 = 10 + INTENTS_VIEW_TGAS + ON_KEY_DERIVED_TGAS;
/// Gas `verify_intents_key` needs.
pub const VERIFY_KEY_TGAS: u64 = 10 + INTENTS_VIEW_TGAS + ON_KEYS_LISTED_TGAS;

/// Where the vault's intents account lives and which key signs for it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentsConfig {
    /// The Verifier contract (intents.near on mainnet).
    pub intents_id: AccountId,
    /// The MPC signer (v1.signer on mainnet).
    pub signer_id: AccountId,
    /// `"ed25519:<base58>"`: the signer's `derived_public_key(INTENTS_KEY_PATH, vault, 1)`, once
    /// read. Never changes after that.
    pub public_key: Option<String>,
    /// Whether `public_keys_of(vault)` on the Verifier was exactly `{public_key}` at the last
    /// check. Agent intent swaps need it.
    pub key_verified: bool,
}

/// An owner's holding of one token in the vault's intents.near account.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentsBalance {
    pub token_id: AccountId,
    /// Available to withdraw back to the vault or to sell in an agent intent swap. Amounts
    /// reserved by intent swaps in flight are not included.
    pub balance: U128,
}

pub fn config() -> Option<IntentsConfig> {
    env::storage_read(CONFIG_KEY).map(|bytes| {
        borsh::from_slice(&bytes)
            .unwrap_or_else(|_| env::panic_str("Cannot deserialize the intents config"))
    })
}

/// The config, or a panic naming what is missing.
pub fn require_config() -> IntentsConfig {
    config().unwrap_or_else(|| env::panic_str("Intents are not set up on this vault"))
}

fn write_config(config: &IntentsConfig) {
    let bytes = borsh::to_vec(config)
        .unwrap_or_else(|_| env::panic_str("Cannot serialize the intents config"));
    env::storage_write(CONFIG_KEY, &bytes);
}

/// The 32 key bytes of an `"ed25519:<base58>"` string, if that is what it is.
pub fn ed25519_bytes(key: &str) -> Option<[u8; 32]> {
    let encoded = key.strip_prefix("ed25519:")?;
    near_sdk::bs58::decode(encoded)
        .into_vec()
        .ok()?
        .try_into()
        .ok()
}

fn balances() -> LookupMap<AccountId, Vec<IntentsBalance>> {
    LookupMap::new(BALANCES_PREFIX)
}

/// `owner_id`'s intents balances.
pub fn balances_of(owner_id: &AccountId) -> Vec<IntentsBalance> {
    balances().get(owner_id).cloned().unwrap_or_default()
}

/// `owner_id`'s available intents balance of `token_id`.
pub fn balance_of(owner_id: &AccountId, token_id: &AccountId) -> u128 {
    balances_of(owner_id)
        .iter()
        .find(|entry| &entry.token_id == token_id)
        .map_or(0, |entry| entry.balance.0)
}

/// Applies `change` to `owner_id`'s `token_id` entry, creating it at zero first if needed (at
/// most `MAX_TOKEN_BALANCES` entries). Returns false, changing nothing, if there is no room.
/// Writes and drops the map, so the caller can settle storage right after.
pub fn update_balance(
    owner_id: &AccountId,
    token_id: &AccountId,
    change: impl FnOnce(u128) -> u128,
) -> bool {
    let mut map = balances();
    let mut entries = map.get(owner_id).cloned().unwrap_or_default();
    let index = match entries.iter().position(|entry| &entry.token_id == token_id) {
        Some(index) => index,
        None if entries.len() < MAX_TOKEN_BALANCES => {
            entries.push(IntentsBalance {
                token_id: token_id.clone(),
                balance: U128(0),
            });
            entries.len() - 1
        }
        None => return false,
    };
    entries[index].balance = U128(change(entries[index].balance.0));
    map.insert(owner_id.clone(), entries);
    true
}

/// Credits `amount` to an entry that exists. Used by callbacks, which must never add storage:
/// every call that starts a flow ending here creates the entry first.
pub fn credit_existing(owner_id: &AccountId, token_id: &AccountId, amount: u128) {
    let mut map = balances();
    let mut entries = map.get(owner_id).cloned().unwrap_or_default();
    let entry = entries
        .iter_mut()
        .find(|entry| &entry.token_id == token_id)
        .unwrap_or_else(|| env::panic_str("Intents balance entry missing"));
    entry.balance = U128(add_amounts(entry.balance.0, amount));
    map.insert(owner_id.clone(), entries);
}

/// intents.near (defuse 0.4.5) methods the vault calls, as defined in near/intents 16d04f6
/// (`contracts/defuse/src/accounts.rs`, `tokens/nep141`, `salts.rs`). Public keys are
/// `"ed25519:<base58>"`, nonces base64, salts hex.
#[ext_contract(ext_intents)]
pub trait IntentsVerifier {
    /// Registers `public_key` for the predecessor's account. Needs exactly 1 yoctoNEAR.
    fn add_public_key(&mut self, public_key: String);
    /// View: every key registered for `account_id`.
    fn public_keys_of(&self, account_id: AccountId) -> Vec<String>;
    /// Sends `amount` of NEP-141 `token` from the predecessor's account to `receiver_id`.
    /// Needs exactly 1 yoctoNEAR. Resolves to the amount delivered; anything not delivered is
    /// credited back to the predecessor's account there.
    fn ft_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: Option<String>,
    ) -> U128;
    /// View: the salt new versioned nonces should use.
    fn current_salt(&self) -> String;
    /// View: whether nonces with `salt` are still accepted.
    fn is_valid_salt(&self, salt: String) -> bool;
    /// View: whether `account_id` has used `nonce` (base64).
    fn is_nonce_used(&self, account_id: AccountId, nonce: String) -> bool;
}

/// The argument of v1.signer's `sign`: `{"path", "payload_v2": {"Eddsa": "<hex>"}, "domain_id"}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: SignPayload,
    pub domain_id: u64,
}

/// v1.signer's `Payload`, externally tagged; EdDSA payloads are 32 to 1232 bytes in hex.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum SignPayload {
    Eddsa(String),
}

/// The MPC signer's (v1.signer, near/mpc 3.18.0) views and calls the vault uses.
#[ext_contract(ext_mpc_signer)]
pub trait MpcSigner {
    /// View: `"ed25519:<base58>"` for domain 1.
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
    /// Needs at least 1 yoctoNEAR and 15 TGas. Resolves, through yield-resume, to
    /// `{"scheme":"Ed25519","signature":[64 bytes]}` once the MPC network answers, or fails
    /// ("Request has timed out.") after the protocol's yield timeout of 200 blocks.
    fn sign(&mut self, request: SignRequest);
}

#[near]
impl Contract {
    /// Sets the Verifier and the MPC signer the vault's intents account uses. Only the vault
    /// account itself can call it (its full-access key, i.e. whoever deploys the code), and only
    /// once: like the exchange, they cannot be changed afterwards.
    #[private]
    pub fn setup_intents(&mut self, intents_id: AccountId, signer_id: AccountId) {
        require!(config().is_none(), "Intents are already set up");
        let config = IntentsConfig {
            intents_id,
            signer_id,
            public_key: None,
            key_verified: false,
        };
        write_config(&config);
        VaultEvent::IntentsSetup {
            intents_id: config.intents_id,
            signer_id: config.signer_id,
        }
        .emit();
    }

    /// Reads the vault's derived key from the MPC signer, registers it on the Verifier for the
    /// vault's account, then checks that it is the only key there. Anyone may call it, with
    /// exactly 1 yoctoNEAR (forwarded to `add_public_key`) and at least `REGISTER_KEY_TGAS`.
    #[payable]
    pub fn register_intents_key(&mut self) -> Promise {
        assert_one_yocto();
        require!(
            env::prepaid_gas() >= Gas::from_tgas(REGISTER_KEY_TGAS),
            format!("register_intents_key needs at least {REGISTER_KEY_TGAS} TGas")
        );
        let config = require_config();
        ext_mpc_signer::ext(config.signer_id)
            .with_static_gas(Gas::from_tgas(INTENTS_VIEW_TGAS))
            .derived_public_key(
                INTENTS_KEY_PATH.to_string(),
                Some(env::current_account_id()),
                Some(MPC_ED25519_DOMAIN),
            )
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_KEY_DERIVED_TGAS))
                    .on_intents_key_derived(),
            )
    }

    /// Checks again that `public_keys_of(vault)` on the Verifier is exactly the registered key,
    /// and records the answer. Anyone may call it, with at least `VERIFY_KEY_TGAS`. If the
    /// Verifier ever lists another key for the vault (only its governance can add one), this
    /// stops agent intent swaps until the key set is right again.
    pub fn verify_intents_key(&mut self) -> Promise {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(VERIFY_KEY_TGAS),
            format!("verify_intents_key needs at least {VERIFY_KEY_TGAS} TGas")
        );
        let config = require_config();
        require!(
            config.public_key.is_some(),
            "No intents key is registered yet; call register_intents_key"
        );
        Self::list_intents_keys(&config)
    }

    /// Key step 2: the signer reported the vault's derived key. Stores it the first time (and
    /// refuses a different one later), then registers it on the Verifier.
    #[private]
    pub fn on_intents_key_derived(
        &mut self,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> Promise {
        let Ok(key) = key else {
            env::panic_str("The MPC signer did not return the vault's derived public key");
        };
        require!(
            ed25519_bytes(&key).is_some(),
            format!("The MPC signer returned {key}, not an ed25519 key")
        );
        let mut config = require_config();
        match &config.public_key {
            Some(stored) => require!(
                stored == &key,
                format!("The MPC signer now derives {key}, but the vault registered {stored}")
            ),
            None => {
                config.public_key = Some(key.clone());
                write_config(&config);
            }
        }
        ext_intents::ext(config.intents_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(INTENTS_ADD_KEY_TGAS))
            .add_public_key(key.clone())
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_KEY_ADDED_TGAS))
                    .on_intents_key_added(key),
            )
    }

    /// Key step 3: `add_public_key` ran. Whatever it did, check the Verifier's key set.
    #[private]
    pub fn on_intents_key_added(
        &mut self,
        public_key: String,
        #[callback_result] added: Result<(), PromiseError>,
    ) -> Promise {
        VaultEvent::IntentsKeyAdded {
            public_key,
            succeeded: added.is_ok(),
        }
        .emit();
        Self::list_intents_keys(&require_config())
    }

    /// Key step 4: the Verifier listed the vault's keys. Verified only if the list is exactly
    /// the registered key. Returns the answer.
    #[private]
    pub fn on_intents_keys_listed(
        &mut self,
        #[callback_result] keys: Result<Vec<String>, PromiseError>,
    ) -> bool {
        let mut config = require_config();
        let Ok(keys) = keys else {
            // No answer is not an answer: keep what the last check found.
            return config.key_verified;
        };
        let expected = config.public_key.as_deref().and_then(ed25519_bytes);
        let verified = expected.is_some()
            && keys.len() == 1
            && keys.iter().all(|key| ed25519_bytes(key) == expected);
        config.key_verified = verified;
        write_config(&config);
        VaultEvent::IntentsKeyChecked {
            expected: config.public_key,
            found: keys,
            verified,
        }
        .emit();
        verified
    }

    /// Moves `amount` of the caller's `token_id` from their vault balance into the vault's
    /// intents.near account (an `ft_transfer_call` to the Verifier, deposited to the vault
    /// itself). Requires exactly 1 yoctoNEAR (full-access key only). The first deposit of a token
    /// pays for its balance entry from the vault's NEAR balance.
    #[payable]
    pub fn deposit_to_intents(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "Deposit amount must be greater than zero");
        let config = require_config();
        let owner_id = env::predecessor_account_id();
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&owner_id);
        let entry = vault
            .token_mut(&token_id)
            .unwrap_or_else(|| env::panic_str(&format!("Vault holds no {token_id}")));
        require!(
            amount.0 <= entry.balance.0,
            format!(
                "Deposit of {} exceeds the vault's {token_id} balance of {}",
                amount.0, entry.balance.0
            )
        );
        entry.balance = U128(sub_amounts(entry.balance.0, amount.0));
        require!(
            update_balance(&owner_id, &token_id, |balance| balance),
            format!("Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens on intents")
        );
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            env::panic_str(&format!(
                "Vault NEAR balance cannot cover {} of storage for this intents balance; deposit NEAR first",
                cost.exact_amount_display()
            ));
        }

        VaultEvent::IntentsDeposit {
            owner_id: owner_id.clone(),
            token_id: token_id.clone(),
            amount,
        }
        .emit();

        ext_ft::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(INTENTS_FT_TRANSFER_CALL_TGAS))
            .ft_transfer_call(config.intents_id, amount, None, String::new())
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_intents_deposited(owner_id, token_id, amount),
            )
    }

    /// Moves `amount` of the caller's `token_id` from the vault's intents.near account back to
    /// their vault balance (`ft_withdraw` as the vault, to the vault). The tokens stay in the
    /// vault, so this works while frozen and while withdrawals are locked. Requires exactly 1
    /// yoctoNEAR (full-access key only).
    #[payable]
    pub fn withdraw_from_intents(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "Withdrawal amount must be greater than zero");
        let config = require_config();
        let owner_id = env::predecessor_account_id();
        let usage_before = env::storage_usage();
        let held = balance_of(&owner_id, &token_id);
        require!(
            amount.0 <= held,
            format!(
                "Withdrawal of {} exceeds the intents {token_id} balance of {held}",
                amount.0
            )
        );
        update_balance(&owner_id, &token_id, |balance| {
            sub_amounts(balance, amount.0)
        });
        // The vault entry the callback credits, created now so the callback adds no storage.
        if self.vault_mut(&owner_id).token_entry(&token_id).is_none() {
            env::panic_str(&format!(
                "Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens"
            ));
        }
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            env::panic_str(&format!(
                "Vault NEAR balance cannot cover {} of storage for this token; deposit NEAR first",
                cost.exact_amount_display()
            ));
        }

        VaultEvent::IntentsWithdraw {
            owner_id: owner_id.clone(),
            token_id: token_id.clone(),
            amount,
        }
        .emit();

        ext_intents::ext(config.intents_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(INTENTS_FT_WITHDRAW_TGAS))
            .ft_withdraw(
                token_id.clone(),
                env::current_account_id(),
                amount,
                None,
                None,
            )
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_intents_withdrawn(owner_id, token_id, amount),
            )
    }

    /// Settles `deposit_to_intents`: the Verifier kept `used`; the rest came back to the vault.
    #[private]
    pub fn on_intents_deposited(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        // A failed ft_transfer_call refunds everything; NEP-141 never reports more than sent.
        let used = used.map_or(0, |used| used.0.min(amount.0));
        if used > 0 {
            credit_existing(&owner_id, &token_id, used);
        }
        let returned = sub_amounts(amount.0, used);
        if returned > 0 {
            let entry = self.vault_mut(&owner_id).swap_token(&token_id);
            entry.balance = U128(add_amounts(entry.balance.0, returned));
            VaultEvent::IntentsDepositRefunded {
                owner_id,
                token_id,
                amount: U128(returned),
            }
            .emit();
        }
        U128(used)
    }

    /// Settles `withdraw_from_intents`: `delivered` reached the vault; the Verifier kept the rest
    /// in the vault's account there, so it goes back to the owner's intents balance.
    #[private]
    pub fn on_intents_withdrawn(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] delivered: Result<U128, PromiseError>,
    ) -> U128 {
        // An ft_withdraw that failed outright moved nothing.
        let delivered = delivered.map_or(0, |delivered| delivered.0.min(amount.0));
        if delivered > 0 {
            let entry = self.vault_mut(&owner_id).swap_token(&token_id);
            entry.balance = U128(add_amounts(entry.balance.0, delivered));
        }
        let kept = sub_amounts(amount.0, delivered);
        if kept > 0 {
            credit_existing(&owner_id, &token_id, kept);
            VaultEvent::IntentsWithdrawRefunded {
                owner_id,
                token_id,
                amount: U128(kept),
            }
            .emit();
        }
        U128(delivered)
    }

    /// The vault's intents setup: Verifier, signer, registered key and whether it checked out.
    pub fn get_intents_config(&self) -> Option<IntentsConfig> {
        config()
    }

    /// `owner_id`'s balances in the vault's intents.near account (excluding amounts reserved by
    /// intent swaps in flight).
    pub fn get_intents_balances(&self, owner_id: AccountId) -> Vec<IntentsBalance> {
        balances_of(&owner_id)
    }
}

impl Contract {
    fn list_intents_keys(config: &IntentsConfig) -> Promise {
        ext_intents::ext(config.intents_id.clone())
            .with_static_gas(Gas::from_tgas(INTENTS_VIEW_TGAS))
            .public_keys_of(env::current_account_id())
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_KEYS_LISTED_TGAS))
                    .on_intents_keys_listed(),
            )
    }
}
