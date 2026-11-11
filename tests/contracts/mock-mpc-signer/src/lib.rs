//! A sandbox stand-in for the NEAR MPC signer, `v1.signer` on mainnet (near/mpc 3.18.0, commit
//! e691bdb). It keeps the real contract's interface for everything the vault calls, so the vault
//! cannot tell it apart:
//!
//! - `sign({request: {path, payload_v2: {"Eddsa": "<hex>"}, domain_id}})` needs at least 1
//!   yoctoNEAR and 15 TGas, checks the domain and payload like the real contract, and parks the
//!   request with `promise_yield_create`. Its promise resolves only when the request is answered
//!   or times out.
//! - On an answer, the caller's callback receives the real JSON:
//!   `{"scheme":"Ed25519","signature":[64 bytes]}`.
//! - On a timeout (the protocol's yield timeout, 200 blocks), `fail_on_timeout` panics with the
//!   real message, so the caller's callback sees a failed promise.
//! - `derived_public_key(path, predecessor, domain_id)` returns `"ed25519:<base58>"`.
//!
//! What differs, on purpose: there are no MPC nodes. The account given to `new` (the
//! "responder") plays all of them. It registers the derived public key of each (predecessor,
//! path) it holds the secret for, and answers requests with `respond`, which, like the real
//! contract, refuses a signature that does not verify under that key. `respond_unverified` skips
//! that check, so a test can feed the caller a bad answer. `set_accept_requests(false)` makes
//! `sign` fail the way the real contract does after a failed TEE validation.
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, Value};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError, PromiseOrValue,
    env, near, require,
};

/// The only domain this mock serves: domain 1 is Ed25519 (FROST) on mainnet `v1.signer`.
pub const ED25519_DOMAIN: u64 = 1;
const SIGN_MIN_GAS: Gas = Gas::from_tgas(15);
const RETURN_SIGNATURE_GAS: Gas = Gas::from_tgas(7);
const FAIL_ON_TIMEOUT_GAS: Gas = Gas::from_tgas(2);
const DATA_ID_REGISTER: u64 = 0;
const EDDSA_PAYLOAD_MIN: usize = 32;
const EDDSA_PAYLOAD_MAX: usize = 1232;

/// `sign`'s argument, with the field names the real contract reads.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// The real contract's `Payload`: externally tagged, bytes as hex.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

/// A parked request. The real contract identifies it by (domain, payload, tweak); the tweak is
/// derived from the predecessor and path, so this keeps those two instead.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SignatureRequest {
    pub domain_id: u64,
    pub payload: Payload,
    pub predecessor: AccountId,
    pub path: String,
}

impl SignatureRequest {
    fn key(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| env::panic_str("request serializes"))
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    /// The account that plays the MPC network.
    responder: AccountId,
    accept_requests: bool,
    /// `"<predecessor>,<path>"` → `"ed25519:<base58>"`.
    derived_keys: IterableMap<String, String>,
    /// Request key → yield data ids, oldest first (the real contract queues duplicates too).
    pending: IterableMap<String, Vec<CryptoHash>>,
}

#[near]
impl MockSigner {
    #[init]
    #[allow(clippy::use_self)] // near-sdk re-spans `Self` in #[init]
    pub fn new(responder: AccountId) -> Self {
        Self {
            responder,
            accept_requests: true,
            derived_keys: IterableMap::new(b"k"),
            pending: IterableMap::new(b"p"),
        }
    }

    /// Test setup: the key `derived_public_key(path, predecessor, 1)` reports.
    pub fn set_derived_public_key(
        &mut self,
        predecessor: AccountId,
        path: String,
        public_key: String,
    ) {
        self.require_responder();
        require!(
            public_key.starts_with("ed25519:"),
            "mock: ed25519 keys only"
        );
        self.derived_keys
            .insert(format!("{predecessor},{path}"), public_key);
    }

    /// Test setup: `false` makes every `sign` fail as after a failed TEE validation.
    pub fn set_accept_requests(&mut self, accept: bool) {
        self.require_responder();
        self.accept_requests = accept;
    }

    /// Same signature and return format as the real view. Only domain 1.
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        require!(
            domain_id == Some(ED25519_DOMAIN),
            "The provided domain was not found."
        );
        self.derived_keys
            .get(&format!("{predecessor},{path}"))
            .cloned()
            .unwrap_or_else(|| {
                env::panic_str("mock: no derived key registered for this predecessor and path")
            })
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) {
        require!(
            request.domain_id == ED25519_DOMAIN,
            format!(
                "The provided domain ID, {}, was not found.",
                request.domain_id
            )
        );
        let Payload::Eddsa(hex) = &request.payload_v2 else {
            env::panic_str("Payload is not EdDSA");
        };
        let bytes = decode_hex(hex);
        require!(
            (EDDSA_PAYLOAD_MIN..=EDDSA_PAYLOAD_MAX).contains(&bytes.len()),
            "Payload is not EdDSA"
        );
        let prepaid = env::prepaid_gas();
        require!(
            prepaid >= SIGN_MIN_GAS,
            format!(
                "Provided gas is lower than required. Provided: {}, required: {}",
                prepaid.as_gas(),
                SIGN_MIN_GAS.as_gas()
            )
        );
        let attached = env::attached_deposit();
        require!(
            attached >= NearToken::from_yoctonear(1),
            format!(
                "Attached deposit is lower than required. Attached: {}, required: 1",
                attached.as_yoctonear()
            )
        );
        require!(
            self.accept_requests,
            "Due to previously failed TEE validation, the network is not accepting new requests at this point in time. Try again later."
        );

        let request = SignatureRequest {
            domain_id: request.domain_id,
            payload: request.payload_v2,
            predecessor: env::predecessor_account_id(),
            path: request.path,
        };
        let args = serde_json::to_vec(&(&request,)).unwrap_or_else(|_| env::panic_str("args"));
        let index = env::promise_yield_create(
            "return_signature_and_clean_state_on_success",
            &args,
            RETURN_SIGNATURE_GAS,
            GasWeight(0),
            DATA_ID_REGISTER,
        );
        let data_id: CryptoHash = env::read_register(DATA_ID_REGISTER)
            .and_then(|id| id.try_into().ok())
            .unwrap_or_else(|| env::panic_str("read_register failed"));
        self.pending.entry(request.key()).or_default().push(data_id);
        env::log_str(&format!("mock sign: {}", request.key()));
        env::promise_return(index);
    }

    /// Answers every parked copy of `request`, as the real `respond` does, after checking that
    /// `signature` verifies over the payload under the registered derived key.
    pub fn respond(&mut self, request: SignatureRequest, signature: Vec<u8>) {
        self.require_responder();
        let public_key = self.registered_key(&request);
        let Payload::Eddsa(hex) = &request.payload else {
            env::panic_str("mock: EdDSA only");
        };
        let signature: [u8; 64] = signature
            .try_into()
            .unwrap_or_else(|_| env::panic_str("mock: a signature is 64 bytes"));
        require!(
            env::ed25519_verify(&signature, decode_hex(hex), &public_key),
            "Signature could not be verified"
        );
        let response = serde_json::json!({ "scheme": "Ed25519", "signature": signature.to_vec() });
        self.resume_all(&request, &response);
    }

    /// Answers `request` with `response` as given, unchecked: a stand-in for a signer that
    /// returns something wrong, to test that the caller checks what it gets.
    pub fn respond_unverified(&mut self, request: SignatureRequest, response: Value) {
        self.require_responder();
        self.resume_all(&request, &response);
    }

    /// The yield-resume callback, as in the real contract: the signature on success; on a
    /// timeout, drop the oldest parked copy and fail the caller's promise.
    #[private]
    pub fn return_signature_and_clean_state_on_success(
        &mut self,
        request: SignatureRequest,
        #[callback_result] signature: Result<Value, PromiseError>,
    ) -> PromiseOrValue<Value> {
        match signature {
            Ok(signature) => PromiseOrValue::Value(signature),
            Err(_) => {
                let key = request.key();
                if let Some(queue) = self.pending.get_mut(&key) {
                    if !queue.is_empty() {
                        queue.remove(0);
                    }
                    if queue.is_empty() {
                        self.pending.remove(&key);
                    }
                }
                PromiseOrValue::Promise(
                    Self::ext(env::current_account_id())
                        .with_static_gas(FAIL_ON_TIMEOUT_GAS)
                        .with_unused_gas_weight(0)
                        .fail_on_timeout()
                        .as_return(),
                )
            }
        }
    }

    #[private]
    pub fn fail_on_timeout(&self) {
        env::panic_str("Request has timed out.");
    }

    /// Every parked request, so the responder knows what to sign.
    pub fn pending_requests(&self) -> Vec<SignatureRequest> {
        self.pending
            .keys()
            .map(|key| serde_json::from_str(key).unwrap_or_else(|_| env::panic_str("key")))
            .collect()
    }
}

impl MockSigner {
    fn require_responder(&self) {
        require!(
            env::predecessor_account_id() == self.responder,
            "mock: only the responder"
        );
    }

    /// The 32 raw bytes of the derived key registered for the request's predecessor and path.
    fn registered_key(&self, request: &SignatureRequest) -> [u8; 32] {
        let key = self
            .derived_keys
            .get(&format!("{},{}", request.predecessor, request.path))
            .unwrap_or_else(|| env::panic_str("mock: no derived key registered"));
        let encoded = key.strip_prefix("ed25519:").unwrap_or(key);
        near_sdk::bs58::decode(encoded)
            .into_vec()
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| env::panic_str("mock: bad registered key"))
    }

    fn resume_all(&mut self, request: &SignatureRequest, response: &Value) {
        let data = serde_json::to_vec(response).unwrap_or_else(|_| env::panic_str("response"));
        let queue = self.pending.remove(&request.key()).unwrap_or_else(|| {
            env::panic_str("This sign request has timed out, was completed, or never existed.")
        });
        for data_id in queue {
            env::promise_yield_resume(&data_id, &data);
        }
    }
}

fn decode_hex(hex: &str) -> Vec<u8> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => env::panic_str("Payload is not valid hex"),
    };
    let bytes = hex.as_bytes();
    require!(bytes.len().is_multiple_of(2), "Payload is not valid hex");
    bytes
        .chunks(2)
        .map(|pair| (digit(pair[0]) << 4) | digit(pair[1]))
        .collect()
}
