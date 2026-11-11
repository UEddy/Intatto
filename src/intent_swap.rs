//! Agent swaps through NEAR Intents: the owner's pair and price-floor policy, the NEP-413
//! `token_diff` the vault builds and has the MPC network sign, and settlement.
//!
//! The agent names only the owner, the pair and the two amounts (from a Message Bus quote).
//! Every byte that gets signed is built here: the message (`signer_id` = the vault, a short
//! `deadline`, one `token_diff` intent), a versioned nonce (intents.near's current salt, a long
//! nonce deadline, the swap's id) and the NEP-413 envelope for intents.near. The MPC signer signs
//! its hash under the vault's derived key, and the vault checks that signature against its
//! registered key before storing it and emitting the signed payload for the agent to publish.
//!
//! intents.near executes a `token_diff` exactly: the vault's account there loses `amount_in` of
//! token_in and gains `amount_out` of token_out, or nothing happens. So settlement only has to
//! learn whether the intent executed, which `is_nonce_used(vault, nonce)` answers:
//!
//! - nonce used: it executed; the owner is credited exactly `amount_out`.
//! - nonce unused, the deadline passed before the question was asked, the salt is still valid and
//!   the nonce's own deadline has not passed: it never executed and never can, so `amount_in` is
//!   returned. intents.near only lets its governance clean up (forget) a nonce whose salt was
//!   invalidated or whose deadline passed, and an invalidated salt never becomes valid again, so
//!   under those conditions "unused" cannot be a used nonce that was cleaned up.
//! - anything else: unresolved. The reserved `amount_in` stays reserved; nothing is credited.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, assert_one_yocto, env, near,
    require,
};

use crate::events::{Attempt, RejectReason, VaultEvent};
use crate::intents::{
    self, INTENTS_KEY_PATH, INTENTS_VIEW_TGAS, MPC_ED25519_DOMAIN, SignPayload, SignRequest,
    ext_intents, ext_mpc_signer,
};
use crate::spend::Spend;
use crate::tokens::MAX_TOKEN_BALANCES;
use crate::{Contract, ContractExt, add_amounts, sub_amounts, sub_tokens};

/// Upper bound on an owner's intent pairs.
pub const MAX_INTENT_PAIRS: usize = 4;
/// How long intents.near accepts a signed intent: short, so a signature in the wild is only good
/// for a few minutes.
pub const INTENT_DEADLINE_SECS: u64 = 300;
/// How long past the intent's deadline its nonce stays valid on intents.near, and so cannot be
/// cleaned up: the window in which `settle_intent_swap` gives a definite answer.
pub const NONCE_VALIDITY_SECS: u64 = 30 * 24 * 60 * 60;
/// The deposit v1.signer's `sign` needs, charged to the owner whose swap asks for a signature.
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// NEP-461 prefix tag of NEP-413 off-chain messages: 2^31 + 413.
const NEP413_TAG: u32 = (1 << 31) + 413;
/// First 4 bytes of every versioned nonce (defuse-core `VersionedNonce::VERSIONED_MAGIC_PREFIX`).
const VERSIONED_NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
/// Storage prefixes: owners' intent policies, and intent swaps not yet settled.
const POLICIES_PREFIX: &[u8] = b"q";
const SWAPS_PREFIX: &[u8] = b"s";
const NS_PER_SEC: u64 = 1_000_000_000;
/// Longest signer answer the vault reads.
const MAX_SIGNER_ANSWER_BYTES: usize = 2_048;

// Gas, in TGas. Each callback reserves what the rest of its chain needs.
/// The MPC `sign` call: v1.signer needs at least 15 (7 of them for its resume callback); the
/// rest is headroom for loading its state, which is far larger on mainnet than in the sandbox.
pub const MPC_SIGN_TGAS: u64 = 50;
pub const ON_INTENT_SIGNED_TGAS: u64 = 20;
pub const ON_INTENT_SALT_TGAS: u64 = 30 + MPC_SIGN_TGAS + ON_INTENT_SIGNED_TGAS;
/// Minimum gas an agent must attach to `agent_intent_swap`.
pub const AGENT_INTENT_SWAP_TGAS: u64 = 20 + INTENTS_VIEW_TGAS + ON_INTENT_SALT_TGAS;
const ON_INTENT_SALT_CHECKED_TGAS: u64 = 15;
const ON_INTENT_NONCE_CHECKED_TGAS: u64 = 15 + INTENTS_VIEW_TGAS + ON_INTENT_SALT_CHECKED_TGAS;
/// Minimum gas for `settle_intent_swap`.
pub const SETTLE_INTENT_TGAS: u64 = 10 + INTENTS_VIEW_TGAS + ON_INTENT_NONCE_CHECKED_TGAS;

/// A pair the agent may trade through intents, in one direction, with the owner's price floor:
/// at least `min_out` of token_out for every `per_in` of token_in.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentPair {
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub min_out: U128,
    pub per_in: U128,
}

/// The owner's rules for agent intent swaps, on top of `Policy`: the agent may sell token_in
/// only through a listed pair, at or above its floor, within token_in's caps in `Policy::tokens`
/// and the shared 24-hour window. Empty (the default) allows nothing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntentPolicy {
    pub pairs: Vec<IntentPair>,
}

/// What an agent asked for, carried to the callback that accepts it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IntentTicket {
    pub owner_id: AccountId,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub amount_out: U128,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentSwapStatus {
    /// The MPC signature is requested.
    Signing,
    /// Signed; `signed_data` can be published until `deadline`.
    Signed,
}

/// How a settlement ended.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentOutcome {
    /// intents.near executed the intent; the owner was credited `amount_out`.
    Executed,
    /// It never executed and no longer can; `amount_in` went back to the owner.
    Refunded,
    /// The Verifier's answer is not conclusive (salt invalidated, or nonce deadline passed);
    /// nothing changed.
    Unresolved,
}

/// Why an intent swap's `amount_in` went back to the owner.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentRefundReason {
    /// The MPC signer failed or timed out.
    SignFailed,
    /// It answered with something that is not a valid signature under the vault's key.
    BadSignature,
    /// Signed, but not executed by its deadline.
    Expired,
}

/// One intent swap from acceptance to settlement. Deleted when it settles.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentSwap {
    /// The swap's spend id; also part of its nonce.
    pub intent_id: U64,
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub amount_out: U128,
    /// Block timestamp (ns, a whole second) after which intents.near refuses the intent.
    pub deadline: U64,
    /// Until when (ns) the nonce is valid on intents.near and cannot be cleaned up.
    pub nonce_deadline: U64,
    /// intents.near salt in the nonce (hex).
    pub salt: String,
    /// The 32-byte versioned nonce (base64).
    pub nonce: String,
    /// The NEP-413 `message`: exactly the JSON string that is signed.
    pub message: String,
    /// SHA-256 of the NEP-413 envelope (hex): what the MPC network signs.
    pub payload_hash: String,
    /// The 64-byte Ed25519 signature in hex; 128 zeros until signed. Fixed-size, so signing
    /// does not change the record's storage, which the owner paid for when it was created.
    pub signature: String,
    pub status: IntentSwapStatus,
}

impl IntentSwap {
    /// The `MultiPayload` intents.near and the Message Bus take, once signed.
    pub fn signed_data(&self, intents_id: &AccountId, public_key: &str) -> Option<Value> {
        if self.status != IntentSwapStatus::Signed {
            return None;
        }
        let signature = format!(
            "ed25519:{}",
            near_sdk::bs58::encode(decode_hex(&self.signature)?).into_string()
        );
        Some(json!({
            "standard": "nep413",
            "payload": {
                "message": self.message,
                "nonce": self.nonce,
                "recipient": intents_id,
            },
            "public_key": public_key,
            "signature": signature,
        }))
    }
}

/// `get_intent_swap`: the record, plus its signed payload once there is one.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IntentSwapView {
    #[serde(flatten)]
    pub swap: IntentSwap,
    pub signed_data: Option<Value>,
}

fn policies() -> LookupMap<AccountId, IntentPolicy> {
    LookupMap::new(POLICIES_PREFIX)
}

fn swaps() -> LookupMap<u64, IntentSwap> {
    LookupMap::new(SWAPS_PREFIX)
}

pub fn policy_of(owner_id: &AccountId) -> IntentPolicy {
    policies().get(owner_id).cloned().unwrap_or_default()
}

/// Clears `owner_id`'s intent policy (`remove_agent` calls it). The map is written on return.
pub fn clear_policy(owner_id: &AccountId) {
    policies().remove(owner_id);
}

fn swap(intent_id: u64) -> Option<IntentSwap> {
    swaps().get(&intent_id).cloned()
}

impl IntentPolicy {
    /// Rejects anything inconsistent, including a token_in with no caps in `caps_for`.
    pub fn validate(&self, has_caps: impl Fn(&AccountId) -> bool) {
        require!(
            self.pairs.len() <= MAX_INTENT_PAIRS,
            format!("Intent policy cannot list more than {MAX_INTENT_PAIRS} pairs")
        );
        for (index, pair) in self.pairs.iter().enumerate() {
            require!(
                pair.token_in != pair.token_out,
                "An intent pair must have two different tokens"
            );
            require!(
                pair.min_out.0 > 0 && pair.per_in.0 > 0,
                format!(
                    "The price floor of {} to {} must be positive",
                    pair.token_in, pair.token_out
                )
            );
            require!(
                !self.pairs[..index]
                    .iter()
                    .any(|other| other.token_in == pair.token_in
                        && other.token_out == pair.token_out),
                format!(
                    "Intent pair {} to {} is listed more than once",
                    pair.token_in, pair.token_out
                )
            );
            require!(
                has_caps(&pair.token_in),
                format!(
                    "Intent pair sells {}, which has no caps in the policy",
                    pair.token_in
                )
            );
        }
    }
}

#[near]
impl Contract {
    /// Sets (or replaces) the caller's intent pairs and price floors. Every token_in needs caps
    /// in the caller's `Policy::tokens`. Requires exactly 1 yoctoNEAR (full-access key only), and
    /// is refused while withdrawals are locked, like `set_agent`. `remove_agent` clears it.
    #[payable]
    pub fn set_intent_policy(&mut self, policy: IntentPolicy) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        if let Some(locked_until) = crate::lock::active_lock(&owner_id) {
            env::panic_str(&format!(
                "Withdrawals are locked until {locked_until} (block timestamp, ns); set_intent_policy is disabled until then"
            ));
        }
        let usage_before = env::storage_usage();
        let tokens = self.vault_mut(&owner_id).policy.tokens.clone();
        policy.validate(|token_id| tokens.iter().any(|caps| &caps.token_id == token_id));
        policies().insert(owner_id.clone(), policy.clone());
        if let Err(cost) = self.settle_storage(&owner_id, usage_before) {
            env::panic_str(&format!(
                "Vault balance is too low to pay {} for this policy's storage; deposit more first",
                cost.exact_amount_display()
            ));
        }
        VaultEvent::IntentPolicySet { owner_id, policy }.emit();
    }

    pub fn get_intent_policy(&self, owner_id: AccountId) -> IntentPolicy {
        policy_of(&owner_id)
    }

    /// Sells `amount_in` of `token_in` from `owner_id`'s intents balance for exactly
    /// `amount_out` of `token_out`, through a NEAR Intents `token_diff` signed for the vault's
    /// intents account by the MPC network. Only the vault's agent may call it, within the
    /// owner's policy and intent policy; it needs at least `AGENT_INTENT_SWAP_TGAS`.
    ///
    /// This call checks the policy and asks intents.near for its current salt; it changes
    /// nothing. `on_intent_salt` checks again, reserves `amount_in`, records the swap and asks
    /// the MPC signer to sign. `on_intent_signed` stores the signature and logs the signed
    /// payload (`intent_swap_signed`) for the agent to publish, or returns `amount_in` if
    /// signing failed. `settle_intent_swap` settles it.
    pub fn agent_intent_swap(
        &mut self,
        owner_id: AccountId,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        amount_out: U128,
    ) -> Promise {
        let caller_id = env::predecessor_account_id();
        let ticket = IntentTicket {
            owner_id,
            token_in,
            token_out,
            amount_in,
            amount_out,
        };
        let attempt = Attempt::IntentSwap {
            caller_id: &caller_id,
            ticket: &ticket,
        };
        self.check_intent_swap(&attempt, env::block_timestamp(), true);
        let config = intents::require_config();
        ext_intents::ext(config.intents_id)
            .with_static_gas(Gas::from_tgas(INTENTS_VIEW_TGAS))
            .current_salt()
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_INTENT_SALT_TGAS))
                    .on_intent_salt(caller_id, ticket),
            )
    }

    /// Intent step 1: intents.near reported its current salt. Every check runs again against
    /// the vault as it is now; any rejection panics and changes nothing. Then `amount_in` is
    /// reserved, the swap recorded and its NEP-413 payload sent to the MPC signer.
    #[private]
    pub fn on_intent_salt(
        &mut self,
        caller_id: AccountId,
        ticket: IntentTicket,
        #[callback_result] salt: Result<String, PromiseError>,
    ) -> Promise {
        let now = env::block_timestamp();
        let attempt = Attempt::IntentSwap {
            caller_id: &caller_id,
            ticket: &ticket,
        };
        self.check_intent_swap(&attempt, now, false);
        let Some((salt_hex, salt)) = salt
            .ok()
            .and_then(|hex| decode_salt(&hex).map(|s| (hex, s)))
        else {
            attempt.reject(
                RejectReason::SaltUnavailable,
                "intents.near did not report a usable salt",
            );
        };
        let config = intents::require_config();
        let IntentTicket {
            owner_id,
            token_in,
            token_out,
            amount_in,
            amount_out,
        } = &ticket;
        let intent_id = self.next_spend_id;
        let usage_before = env::storage_usage();

        intents::update_balance(owner_id, token_in, |balance| {
            sub_amounts(balance, amount_in.0)
        });
        // The entry settlement credits, created now so no callback adds storage.
        if !intents::update_balance(owner_id, token_out, |balance| balance) {
            attempt.reject(
                RejectReason::TooManyTokens,
                &format!(
                    "Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens on intents"
                ),
            );
        }
        let vault = self.vault_mut(owner_id);
        vault.prune_spends(now, None);
        vault.recent_spends.push(Spend {
            spend_id: U64(intent_id),
            timestamp: U64(now),
            token_id: Some(token_in.clone()),
            amount: *amount_in,
        });
        // v1.signer keeps the yoctoNEAR `sign` needs; this owner pays it.
        let has_deposit = vault.balance >= SIGN_DEPOSIT;
        attempt.require(has_deposit, RejectReason::InsufficientBalance, || {
            "Vault NEAR balance cannot cover the signer's 1 yoctoNEAR deposit".to_string()
        });
        vault.balance = sub_tokens(vault.balance, SIGN_DEPOSIT);
        self.advance_spend_id();

        let deadline_secs = now / NS_PER_SEC + INTENT_DEADLINE_SECS;
        let nonce_deadline_secs = deadline_secs + NONCE_VALIDITY_SECS;
        let nonce = versioned_nonce(salt, nonce_deadline_secs * NS_PER_SEC, intent_id);
        let message = intent_message(
            &env::current_account_id(),
            &rfc3339(deadline_secs),
            token_in,
            amount_in.0,
            token_out,
            amount_out.0,
        );
        let hash = nep413_hash(&message, &nonce, &config.intents_id);
        let record = IntentSwap {
            intent_id: U64(intent_id),
            owner_id: owner_id.clone(),
            agent_id: caller_id.clone(),
            token_in: token_in.clone(),
            token_out: token_out.clone(),
            amount_in: *amount_in,
            amount_out: *amount_out,
            deadline: U64(deadline_secs * NS_PER_SEC),
            nonce_deadline: U64(nonce_deadline_secs * NS_PER_SEC),
            salt: salt_hex,
            nonce: near_sdk::base64::Engine::encode(
                &near_sdk::base64::engine::general_purpose::STANDARD,
                nonce,
            ),
            message,
            payload_hash: to_hex(&hash),
            signature: "0".repeat(128),
            status: IntentSwapStatus::Signing,
        };
        swaps().insert(intent_id, record.clone());
        if let Err(cost) = self.settle_storage(owner_id, usage_before) {
            attempt.reject(
                RejectReason::InsufficientBalance,
                &format!(
                    "Vault NEAR balance cannot cover {} of storage for this swap's record",
                    cost.exact_amount_display()
                ),
            );
        }

        VaultEvent::IntentSwapInitiated {
            swap: record.clone(),
        }
        .emit();

        let request = SignRequest {
            path: INTENTS_KEY_PATH.to_string(),
            payload_v2: SignPayload::Eddsa(record.payload_hash),
            domain_id: MPC_ED25519_DOMAIN,
        };
        ext_mpc_signer::ext(config.signer_id)
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(Gas::from_tgas(MPC_SIGN_TGAS))
            .sign(request)
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_INTENT_SIGNED_TGAS))
                    .on_intent_signed(U64(intent_id)),
            )
    }

    /// Intent step 2: the MPC signer answered, failed or timed out. A signature that verifies
    /// over the payload under the vault's registered key is stored and its signed payload
    /// logged; anything else returns `amount_in` to the owner. Never panics on the answer.
    #[private]
    pub fn on_intent_signed(&mut self, intent_id: U64) -> bool {
        let Some(mut record) = swap(intent_id.0) else {
            return false;
        };
        if record.status != IntentSwapStatus::Signing {
            return false;
        }
        let config = intents::require_config();
        let public_key = config.public_key.clone().unwrap_or_default();
        // The answer is ~250 bytes of JSON; anything longer is not a signature.
        let answer = env::promise_result_checked(0, MAX_SIGNER_ANSWER_BYTES).ok();
        let Some(answer) = answer else {
            self.refund_intent_swap(&record, IntentRefundReason::SignFailed);
            return false;
        };
        let signature = parse_ed25519_response(&answer).filter(|signature| {
            let (Some(key), Some(hash)) = (
                intents::ed25519_bytes(&public_key),
                decode_hex32(&record.payload_hash),
            ) else {
                return false;
            };
            env::ed25519_verify(signature, hash, &key)
        });
        let Some(signature) = signature else {
            self.refund_intent_swap(&record, IntentRefundReason::BadSignature);
            return false;
        };
        record.signature = to_hex(&signature);
        record.status = IntentSwapStatus::Signed;
        // Same size as the record the owner paid for: no storage changes here.
        swaps().insert(intent_id.0, record.clone());
        let signed_data = record.signed_data(&config.intents_id, &public_key);
        VaultEvent::IntentSwapSigned {
            intent_id,
            owner_id: record.owner_id,
            deadline: record.deadline,
            signed_data: signed_data.unwrap_or(Value::Null),
        }
        .emit();
        true
    }

    /// Settles a signed intent swap: asks intents.near whether its nonce was used. Anyone may
    /// call it, with at least `SETTLE_INTENT_TGAS`. Before the deadline, an unused nonce means
    /// "not yet" and the call fails without changing anything.
    pub fn settle_intent_swap(&mut self, intent_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(SETTLE_INTENT_TGAS),
            format!("settle_intent_swap needs at least {SETTLE_INTENT_TGAS} TGas")
        );
        let record = swap(intent_id.0).unwrap_or_else(|| {
            env::panic_str(&format!(
                "No unsettled intent swap {}; it was settled already or never existed",
                intent_id.0
            ))
        });
        require!(
            record.status == IntentSwapStatus::Signed,
            format!("Intent swap {} is still being signed", intent_id.0)
        );
        let past_deadline = env::block_timestamp() > record.deadline.0;
        let config = intents::require_config();
        ext_intents::ext(config.intents_id)
            .with_static_gas(Gas::from_tgas(INTENTS_VIEW_TGAS))
            .is_nonce_used(env::current_account_id(), record.nonce)
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_INTENT_NONCE_CHECKED_TGAS))
                    .on_intent_nonce_checked(intent_id, past_deadline),
            )
    }

    /// Settle step 2. `past_deadline`: the deadline had passed when `settle_intent_swap` ran, so
    /// also when intents.near answered, so an unused nonce can no longer be used.
    #[private]
    pub fn on_intent_nonce_checked(
        &mut self,
        intent_id: U64,
        past_deadline: bool,
        #[callback_result] used: Result<bool, PromiseError>,
    ) -> PromiseOrValue<IntentOutcome> {
        let Some(record) = swap(intent_id.0).filter(|r| r.status == IntentSwapStatus::Signed)
        else {
            // Settled by a concurrent call: settle once.
            return PromiseOrValue::Value(IntentOutcome::Unresolved);
        };
        let Ok(used) = used else {
            env::panic_str("intents.near did not answer is_nonce_used; retry");
        };
        if used {
            self.settle_executed(&record);
            return PromiseOrValue::Value(IntentOutcome::Executed);
        }
        require!(
            past_deadline,
            format!(
                "Intent swap {} has not executed and its deadline ({} ns) has not passed; settle again after it",
                intent_id.0, record.deadline.0
            )
        );
        let config = intents::require_config();
        ext_intents::ext(config.intents_id)
            .with_static_gas(Gas::from_tgas(INTENTS_VIEW_TGAS))
            .is_valid_salt(record.salt)
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_INTENT_SALT_CHECKED_TGAS))
                    .on_intent_salt_checked(intent_id),
            )
            .into()
    }

    /// Settle step 3: the nonce was unused after the deadline. Refund only if that answer was
    /// conclusive: the salt is still valid and the nonce's deadline has not passed, so
    /// intents.near could not have cleaned the nonce up before it answered.
    #[private]
    pub fn on_intent_salt_checked(
        &mut self,
        intent_id: U64,
        #[callback_result] valid: Result<bool, PromiseError>,
    ) -> IntentOutcome {
        let Some(record) = swap(intent_id.0).filter(|r| r.status == IntentSwapStatus::Signed)
        else {
            return IntentOutcome::Unresolved;
        };
        let Ok(salt_valid) = valid else {
            env::panic_str("intents.near did not answer is_valid_salt; retry");
        };
        let nonce_live = env::block_timestamp() <= record.nonce_deadline.0;
        if salt_valid && nonce_live {
            self.refund_intent_swap(&record, IntentRefundReason::Expired);
            return IntentOutcome::Refunded;
        }
        VaultEvent::IntentSwapUnresolved {
            intent_id,
            owner_id: record.owner_id,
            salt_valid,
            nonce_deadline: record.nonce_deadline,
        }
        .emit();
        IntentOutcome::Unresolved
    }

    /// An intent swap not yet settled, with its signed payload once signed.
    pub fn get_intent_swap(&self, intent_id: U64) -> Option<IntentSwapView> {
        let record = swap(intent_id.0)?;
        let signed_data = intents::config().and_then(|config| {
            record.signed_data(&config.intents_id, config.public_key.as_deref()?)
        });
        Some(IntentSwapView {
            swap: record,
            signed_data,
        })
    }
}

impl Contract {
    /// Every check of an agent intent swap, in order; rejects the attempt on the first that
    /// fails. Changes no state. `at_entry` adds the gas check only `agent_intent_swap` can make.
    pub fn check_intent_swap(&self, attempt: &Attempt, now: u64, at_entry: bool) {
        let Attempt::IntentSwap { caller_id, ticket } = attempt else {
            env::panic_str("check_intent_swap takes an intent swap attempt");
        };
        let IntentTicket {
            owner_id,
            token_in,
            token_out,
            amount_in,
            amount_out,
        } = ticket;
        let caller_id = *caller_id;

        let Some(vault) = self.vaults.get(owner_id) else {
            attempt.reject(
                RejectReason::NoVault,
                &format!("No vault exists for {owner_id}"),
            );
        };
        attempt.require(
            vault.agent_id.as_ref() == Some(caller_id),
            RejectReason::NotAgent,
            || format!("{caller_id} is not the registered agent for {owner_id}'s vault"),
        );
        attempt.require(
            amount_in.0 > 0 && amount_out.0 > 0,
            RejectReason::ZeroAmount,
            || "Intent swap amounts must be greater than zero".to_string(),
        );
        attempt.require(
            i128::try_from(amount_in.0).is_ok() && i128::try_from(amount_out.0).is_ok(),
            RejectReason::AmountTooLarge,
            || "Intent swap amounts must fit a token_diff (at most 2^127 - 1)".to_string(),
        );
        attempt.require(
            !at_entry || env::prepaid_gas() >= Gas::from_tgas(AGENT_INTENT_SWAP_TGAS),
            RejectReason::InsufficientGas,
            || format!("agent_intent_swap needs at least {AGENT_INTENT_SWAP_TGAS} TGas"),
        );
        attempt.require(!vault.frozen, RejectReason::Frozen, || {
            "Vault is frozen; agent swapping is disabled".to_string()
        });
        let ready = intents::config().is_some_and(|config| {
            config.key_verified
                && config
                    .public_key
                    .as_deref()
                    .is_some_and(|key| intents::ed25519_bytes(key).is_some())
        });
        attempt.require(ready, RejectReason::IntentsNotReady, || {
            "The vault's intents key is not registered and verified; intent swaps are disabled"
                .to_string()
        });
        let policy = policy_of(owner_id);
        let Some(pair) = policy
            .pairs
            .iter()
            .find(|pair| &pair.token_in == token_in && &pair.token_out == token_out)
        else {
            attempt.reject(
                RejectReason::PairNotAllowlisted,
                &format!("{token_in} to {token_out} is not on the vault's intent pair allowlist"),
            );
        };
        attempt.require(
            meets_floor(amount_in.0, amount_out.0, pair.min_out.0, pair.per_in.0),
            RejectReason::BelowPriceFloor,
            || {
                format!(
                    "{} {token_out} for {} {token_in} is below the owner's floor of {} per {}",
                    amount_out.0, amount_in.0, pair.min_out.0, pair.per_in.0
                )
            },
        );
        let Some(caps) = vault
            .policy
            .tokens
            .iter()
            .find(|token| &token.token_id == token_in)
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
        let (spend_count, sold) = vault.window_usage(now, Some(token_in));
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
        let held = intents::balance_of(owner_id, token_in);
        attempt.require(
            amount_in.0 <= held,
            RejectReason::InsufficientBalance,
            || {
                format!(
                    "Amount {} exceeds the intents {token_in} balance of {held}",
                    amount_in.0
                )
            },
        );
    }

    /// The intent executed: credit `amount_out` and delete the record.
    fn settle_executed(&mut self, record: &IntentSwap) {
        let usage_before = env::storage_usage();
        intents::credit_existing(&record.owner_id, &record.token_out, record.amount_out.0);
        swaps().remove(&record.intent_id.0);
        // Deleting the record only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&record.owner_id, usage_before);
        VaultEvent::IntentSwapSettled {
            intent_id: record.intent_id,
            owner_id: record.owner_id.clone(),
            token_in: record.token_in.clone(),
            amount_in: record.amount_in,
            token_out: record.token_out.clone(),
            amount_out: record.amount_out,
        }
        .emit();
    }

    /// The intent did not and will not execute: return `amount_in`, drop its spend entry and
    /// delete the record.
    fn refund_intent_swap(&mut self, record: &IntentSwap, reason: IntentRefundReason) {
        let usage_before = env::storage_usage();
        intents::credit_existing(&record.owner_id, &record.token_in, record.amount_in.0);
        swaps().remove(&record.intent_id.0);
        self.vault_mut(&record.owner_id)
            .recent_spends
            .retain(|spend| spend.spend_id != record.intent_id);
        let _ = self.settle_storage(&record.owner_id, usage_before);
        VaultEvent::IntentSwapRefunded {
            intent_id: record.intent_id,
            owner_id: record.owner_id.clone(),
            token_in: record.token_in.clone(),
            amount_in: record.amount_in,
            reason,
        }
        .emit();
    }
}

/// Whether `amount_out / amount_in >= min_out / per_in`, compared exactly in 256 bits.
pub fn meets_floor(amount_in: u128, amount_out: u128, min_out: u128, per_in: u128) -> bool {
    mul_wide(amount_out, per_in) >= mul_wide(amount_in, min_out)
}

/// The full 256-bit product of two u128, as (high, low).
const fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = u64::MAX as u128;
    let (a_hi, a_lo) = (a >> 64, a & MASK);
    let (b_hi, b_lo) = (b >> 64, b & MASK);
    let lo_lo = a_lo * b_lo;
    let lo_hi = a_lo * b_hi;
    let hi_lo = a_hi * b_lo;
    let hi_hi = a_hi * b_hi;
    let mid = (lo_lo >> 64) + (lo_hi & MASK) + (hi_lo & MASK);
    let low = (lo_lo & MASK) | (mid << 64);
    let high = hi_hi + (lo_hi >> 64) + (hi_lo >> 64) + (mid >> 64);
    (high, low)
}

/// `"YYYY-MM-DDTHH:MM:SSZ"` (RFC 3339, UTC) for `secs` since the Unix epoch.
pub fn rfc3339(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days, for days >= 0.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// A V1 versioned nonce: magic, version 0, salt, nonce deadline (i64 ns, little-endian), then
/// the swap's id and 7 bytes of the block's random seed in place of 15 random bytes.
pub fn versioned_nonce(salt: [u8; 4], nonce_deadline_ns: u64, intent_id: u64) -> [u8; 32] {
    let deadline = i64::try_from(nonce_deadline_ns)
        .unwrap_or_else(|_| env::panic_str("Nonce deadline overflow"));
    let mut nonce = [0u8; 32];
    nonce[..4].copy_from_slice(&VERSIONED_NONCE_MAGIC);
    nonce[4] = 0;
    nonce[5..9].copy_from_slice(&salt);
    nonce[9..17].copy_from_slice(&deadline.to_le_bytes());
    nonce[17..25].copy_from_slice(&intent_id.to_be_bytes());
    nonce[25..].copy_from_slice(&env::random_seed_array()[..7]);
    nonce
}

/// The NEP-413 `message` of a one-pair `token_diff` intent for `signer_id`, byte for byte.
///
/// Built with `format!` rather than a JSON map, so the signed bytes never depend on a serializer
/// feature (key order). Nothing in it needs escaping: account ids are `[a-z0-9._-]`, amounts are
/// digits and the deadline is `rfc3339`'s fixed form.
pub fn intent_message(
    signer_id: &AccountId,
    deadline: &str,
    token_in: &AccountId,
    amount_in: u128,
    token_out: &AccountId,
    amount_out: u128,
) -> String {
    format!(
        r#"{{"signer_id":"{signer_id}","deadline":"{deadline}","intents":[{{"intent":"token_diff","diff":{{"nep141:{token_in}":"-{amount_in}","nep141:{token_out}":"{amount_out}"}}}}]}}"#
    )
}

/// SHA-256 of the NEP-413 envelope: `borsh((2^31 + 413, message, nonce, recipient, None))`.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &AccountId) -> [u8; 32] {
    let bytes = near_sdk::borsh::to_vec(&(
        NEP413_TAG,
        message.to_string(),
        *nonce,
        recipient.to_string(),
        Option::<String>::None,
    ))
    .unwrap_or_else(|_| env::panic_str("Cannot serialize the NEP-413 payload"));
    env::sha256_array(&bytes)
}

/// The 64 signature bytes of a v1.signer Ed25519 answer, `{"scheme":"Ed25519","signature":[..]}`.
/// None for anything else, so a malformed answer can never make the callback panic.
pub fn parse_ed25519_response(bytes: &[u8]) -> Option<[u8; 64]> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value.get("scheme")?.as_str()? != "Ed25519" {
        return None;
    }
    let bytes = value
        .get("signature")?
        .as_array()?
        .iter()
        .map(|byte| byte.as_u64().and_then(|byte| u8::try_from(byte).ok()))
        .collect::<Option<Vec<u8>>>()?;
    bytes.try_into().ok()
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    decode_hex(hex)?.try_into().ok()
}

fn decode_salt(hex: &str) -> Option<[u8; 4]> {
    decode_hex(hex)?.try_into().ok()
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        // From defuse-time's own round-trip test, whole seconds.
        assert_eq!(rfc3339(1_782_395_622), "2026-06-25T13:53:42Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(4_107_542_399), "2100-02-28T23:59:59Z");
        assert_eq!(rfc3339(1_794_441_600), "2026-11-12T00:00:00Z");
    }

    #[test]
    fn price_floor_is_exact_in_256_bits() {
        // 1 wNEAR (1e24) for 3.7 USDT (3.7e6), floor 3.5 USDT per wNEAR.
        assert!(meets_floor(
            10u128.pow(24),
            3_700_000,
            3_500_000,
            10u128.pow(24)
        ));
        assert!(meets_floor(
            10u128.pow(24),
            3_500_000,
            3_500_000,
            10u128.pow(24)
        ));
        assert!(!meets_floor(
            10u128.pow(24),
            3_499_999,
            3_500_000,
            10u128.pow(24)
        ));
        // Products far beyond u128.
        let big = u128::MAX / 3;
        assert!(meets_floor(big, big, u128::MAX, u128::MAX));
        assert!(!meets_floor(big, big - 1, u128::MAX, u128::MAX));
        assert_eq!(mul_wide(u128::MAX, u128::MAX), (u128::MAX - 1, 1));
        assert_eq!(mul_wide(1 << 64, 1 << 64), (1, 0));
    }

    #[test]
    fn message_is_the_token_diff_intents_near_expects() {
        let vault: AccountId = "vault.near".parse().unwrap();
        let message = intent_message(
            &vault,
            "2026-11-12T00:05:00Z",
            &"wrap.near".parse().unwrap(),
            10u128.pow(24),
            &"usdt.tether-token.near".parse().unwrap(),
            3_700_000,
        );
        // Valid JSON, and exactly these bytes.
        let parsed: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(
            parsed["intents"][0]["diff"]["nep141:wrap.near"],
            "-1000000000000000000000000"
        );
        assert_eq!(
            message,
            r#"{"signer_id":"vault.near","deadline":"2026-11-12T00:05:00Z","intents":[{"intent":"token_diff","diff":{"nep141:wrap.near":"-1000000000000000000000000","nep141:usdt.tether-token.near":"3700000"}}]}"#
        );
    }

    #[test]
    fn nonce_has_the_versioned_layout() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let nonce = versioned_nonce([1, 2, 3, 4], 1_797_033_900_000_000_000, 7);
        assert_eq!(nonce[..4], VERSIONED_NONCE_MAGIC);
        assert_eq!(nonce[4], 0);
        assert_eq!(nonce[5..9], [1, 2, 3, 4]);
        assert_eq!(
            i64::from_le_bytes(nonce[9..17].try_into().unwrap()),
            1_797_033_900_000_000_000
        );
        assert_eq!(u64::from_be_bytes(nonce[17..25].try_into().unwrap()), 7);
    }

    #[test]
    fn only_a_well_formed_ed25519_answer_parses() {
        let good = serde_json::to_vec(&json!({ "scheme": "Ed25519", "signature": vec![9u8; 64] }))
            .unwrap();
        assert_eq!(parse_ed25519_response(&good), Some([9u8; 64]));
        for bad in [
            json!({ "scheme": "Secp256k1", "signature": vec![9u8; 64] }),
            json!({ "scheme": "Ed25519", "signature": vec![9u8; 63] }),
            json!({ "scheme": "Ed25519", "signature": vec![300u64; 64] }),
            json!({ "scheme": "Ed25519" }),
            json!("Ed25519"),
        ] {
            assert_eq!(
                parse_ed25519_response(&serde_json::to_vec(&bad).unwrap()),
                None
            );
        }
        assert_eq!(parse_ed25519_response(b"not json"), None);
    }
}
