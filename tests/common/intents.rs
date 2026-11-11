//! Sandbox pieces for the Chain Signatures path: the vendored intents.near Verifier, the mock MPC
//! signer, and the key the tests hold to play the MPC nodes.

use std::sync::OnceLock;

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::{AccountId, NearGas};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{Value, json};
use sha2::{Digest, Sha256};
use testresult::TestResult;

use intatto::{INTENTS_KEY_PATH, IntentsBalance, IntentsConfig, Policy, TokenPolicy};
use near_api::types::transaction::result::TransactionResult;
use near_sdk::json_types::U128;

use super::{NO_DEPOSIT, ONE_YOCTO, TOKEN_STORAGE, TestEnv, contract_wasm, near, res_wasm};

/// SHA-256 (base58) of tests/res/intents_near_0.4.5.wasm, the code of intents.near on mainnet.
pub const INTENTS_SHA256: &str = "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk";
/// The Ed25519 domain on v1.signer (and on the mock).
pub const ED25519_DOMAIN: u64 = 1;
/// NEP-461 prefix tag of NEP-413: 2^31 + 413.
pub const NEP413_TAG: u32 = (1 << 31) + 413;

static MOCK_SIGNER_WASM: OnceLock<Vec<u8>> = OnceLock::new();

/// tests/contracts/mock-mpc-signer, built once per test binary.
pub fn mock_signer_wasm() -> Vec<u8> {
    MOCK_SIGNER_WASM
        .get_or_init(|| {
            let manifest = format!(
                "{}/tests/contracts/mock-mpc-signer/Cargo.toml",
                env!("CARGO_MANIFEST_DIR")
            );
            let opts = cargo_near_build::BuildOpts {
                manifest_path: Some(manifest.into()),
                no_abi: true,
                ..Default::default()
            };
            let path = cargo_near_build::build_with_cli(opts).expect("mock signer should build");
            std::fs::read(path).expect("mock signer wasm should be readable")
        })
        .clone()
}

/// The secret the mock's responder holds for `predecessor`'s key at `path`: a stand-in for the
/// key the MPC network derives from (predecessor, path).
pub fn derived_signing_key(predecessor: &AccountId, path: &str) -> SigningKey {
    let seed: [u8; 32] =
        Sha256::digest(format!("intatto mock mpc,{predecessor},{path}").as_bytes()).into();
    SigningKey::from_bytes(&seed)
}

/// `"ed25519:<base58>"` of a key, as v1.signer and intents.near print public keys.
pub fn ed25519_string(key: &SigningKey) -> String {
    format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
}

/// SHA-256 of `borsh((NEP413_TAG, Nep413Payload { message, nonce, recipient, callback_url: None }))`,
/// the bytes a NEP-413 signature covers.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    let bytes = near_sdk::borsh::to_vec(&(
        NEP413_TAG,
        message.to_string(),
        *nonce,
        recipient.to_string(),
        Option::<String>::None,
    ))
    .expect("payload serializes");
    Sha256::digest(bytes).into()
}

/// A request parked in the mock signer, as `pending_requests` returns it.
#[derive(Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingRequest {
    pub domain_id: u64,
    pub payload: Value,
    pub predecessor: AccountId,
    pub path: String,
}

impl PendingRequest {
    pub fn payload_bytes(&self) -> Vec<u8> {
        let hex = self.payload["Eddsa"].as_str().expect("EdDSA payload");
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect()
    }

    pub fn as_json(&self) -> Value {
        json!({
            "domain_id": self.domain_id,
            "payload": self.payload,
            "predecessor": self.predecessor,
            "path": self.path,
        })
    }
}

/// The Verifier and the mock signer deployed next to the vault.
pub struct Intents {
    pub intents: AccountId,
    pub wnear: AccountId,
    pub usdt: AccountId,
    /// Holds the DAO role (and super admin) on the Verifier, like intents.sputnik-dao.near.
    pub dao: AccountId,
    pub signer: AccountId,
    /// Plays the MPC nodes on the mock signer.
    pub responder: AccountId,
}

impl Intents {
    /// Deploys wNEAR, a stand-in USDT (another wNEAR binary), intents.near 0.4.5 and the mock
    /// signer, and registers `vault`'s derived key at `path` with the mock.
    pub async fn deploy(env: &TestEnv, vault: &AccountId, path: &str) -> TestResult<Self> {
        let w_near = || res_wasm("w_near.wasm", super::W_NEAR_SHA256);
        let wnear = env
            .deploy("wrap.sandbox", w_near(), "new", json!({}))
            .await?;
        let usdt = env
            .deploy("usdt.sandbox", w_near(), "new", json!({}))
            .await?;
        let dao = env.create_account("dao.sandbox", near(50)).await?;
        let config = json!({ "config": {
            "wnear_id": wnear,
            // No protocol fee: intents.near charges it on the selling side of a token_diff and
            // collects it from the counterparty, so the vault's own deltas are exact either way;
            // with 0 the sandbox solver's diff is simply the vault's, negated.
            "fees": { "fee": 0, "fee_collector": dao },
            "roles": { "super_admins": [dao], "grantees": { "DAO": [dao] } },
        }});
        let intents = env
            .deploy(
                "intents.sandbox",
                res_wasm("intents_near_0.4.5.wasm", INTENTS_SHA256),
                "new",
                config,
            )
            .await?;
        let responder = env.create_account("mpc-nodes.sandbox", near(50)).await?;
        let signer = env
            .deploy(
                "signer.sandbox",
                mock_signer_wasm(),
                "new",
                json!({ "responder": responder }),
            )
            .await?;
        let it = Self {
            intents,
            wnear,
            usdt,
            dao,
            signer,
            responder,
        };
        it.register_derived_key(env, vault, path).await?;
        Ok(it)
    }

    /// Makes the mock report the harness key for (`predecessor`, `path`).
    pub async fn register_derived_key(
        &self,
        env: &TestEnv,
        predecessor: &AccountId,
        path: &str,
    ) -> TestResult {
        let key = ed25519_string(&derived_signing_key(predecessor, path));
        let args = json!({ "predecessor": predecessor, "path": path, "public_key": key });
        env.call_on(
            &self.signer,
            &self.responder,
            "set_derived_public_key",
            args,
            NO_DEPOSIT,
            NearGas::from_tgas(30),
        )
        .await?
        .assert_success();
        Ok(())
    }

    pub async fn pending_requests(&self, env: &TestEnv) -> TestResult<Vec<PendingRequest>> {
        env.view_on(&self.signer, "pending_requests", json!({}))
            .await
    }

    /// Polls until the mock has at least `count` parked requests (up to ~20 s).
    pub async fn wait_for_pending(
        &self,
        env: &TestEnv,
        count: usize,
    ) -> TestResult<Vec<PendingRequest>> {
        for _ in 0..200 {
            let pending = self.pending_requests(env).await?;
            if pending.len() >= count {
                return Ok(pending);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("the mock signer never had {count} pending requests")
    }

    /// Plays the MPC nodes: signs `request` with the harness key and calls `respond`.
    pub async fn respond(&self, env: &TestEnv, request: &PendingRequest) -> TestResult {
        let key = derived_signing_key(&request.predecessor, &request.path);
        let signature = key.sign(&request.payload_bytes()).to_bytes().to_vec();
        let args = json!({ "request": request.as_json(), "signature": signature });
        env.call_on(
            &self.signer,
            &self.responder,
            "respond",
            args,
            NO_DEPOSIT,
            NearGas::from_tgas(50),
        )
        .await?
        .assert_success();
        Ok(())
    }

    /// Answers `request` with an arbitrary `response`, unchecked.
    pub async fn respond_unverified(
        &self,
        env: &TestEnv,
        request: &PendingRequest,
        response: Value,
    ) -> TestResult {
        let args = json!({ "request": request.as_json(), "response": response });
        env.call_on(
            &self.signer,
            &self.responder,
            "respond_unverified",
            args,
            NO_DEPOSIT,
            NearGas::from_tgas(50),
        )
        .await?
        .assert_success();
        Ok(())
    }

    pub async fn set_accept_requests(&self, env: &TestEnv, accept: bool) -> TestResult {
        env.call_on(
            &self.signer,
            &self.responder,
            "set_accept_requests",
            json!({ "accept": accept }),
            NO_DEPOSIT,
            NearGas::from_tgas(30),
        )
        .await?
        .assert_success();
        Ok(())
    }

    /// Fast-forwards past the protocol's yield timeout (200 blocks), so parked requests fail.
    pub async fn time_out_pending(&self, env: &TestEnv) -> TestResult {
        env.sandbox.fast_forward(250).await?;
        Ok(())
    }
}

pub const fn tgas(tgas: u64) -> NearGas {
    NearGas::from_tgas(tgas)
}

/// 10^24 smallest units: one whole wNEAR, or one whole stand-in USDT (also a wNEAR binary).
pub const WHOLE: u128 = 1_000_000_000_000_000_000_000_000;

/// The vault next to the Verifier and the mock signer. The owner's vault holds 10 NEAR, and its
/// agent is registered under `standard_policy` plus caps for wNEAR and USDT (1 per swap, 3 per 24
/// hours each). The vault, the Verifier and the owner are registered with both tokens.
/// `setup_intents` has not been called.
pub struct CsEnv {
    pub env: TestEnv,
    pub it: Intents,
}

impl CsEnv {
    pub async fn new() -> TestResult<Self> {
        Self::on_code(contract_wasm()).await
    }

    pub async fn on_code(wasm: Vec<u8>) -> TestResult<Self> {
        let env = TestEnv::with_code(wasm).await?;
        let it = Intents::deploy(&env, env.vault_id(), INTENTS_KEY_PATH).await?;
        let s = Self { env, it };
        s.env
            .deposit(&s.env.owner, near(10))
            .await?
            .assert_success();
        s.env
            .set_agent(&s.env.owner, &s.env.agent, &s.policy())
            .await?
            .assert_success();
        for token in [&s.it.wnear, &s.it.usdt] {
            for account in [s.env.vault_id(), &s.it.intents, &s.env.owner] {
                s.register(token, account).await?;
            }
        }
        Ok(s)
    }

    pub fn policy(&self) -> Policy {
        let caps = |token_id: &AccountId| TokenPolicy {
            token_id: token_id.clone(),
            per_tx_cap: U128(WHOLE),
            daily_cap: U128(3 * WHOLE),
        };
        Policy {
            tokens: vec![caps(&self.it.wnear), caps(&self.it.usdt)],
            ..self.env.standard_policy()
        }
    }

    pub async fn register(&self, token: &AccountId, account: &AccountId) -> TestResult {
        let args = json!({ "account_id": account, "registration_only": true });
        self.env
            .call_on(
                token,
                &self.env.owner,
                "storage_deposit",
                args,
                TOKEN_STORAGE,
                tgas(30),
            )
            .await?
            .assert_success();
        Ok(())
    }

    /// `setup_intents(intents, signer)`, signed by `signer_id`.
    pub async fn setup_intents_as(&self, signer_id: &AccountId) -> TestResult<TransactionResult> {
        let args = json!({ "intents_id": self.it.intents, "signer_id": self.it.signer });
        self.env
            .call_on(
                self.env.vault_id(),
                signer_id,
                "setup_intents",
                args,
                NO_DEPOSIT,
                tgas(30),
            )
            .await
    }

    /// `register_intents_key()`, signed by `signer_id` with 1 yoctoNEAR.
    pub async fn register_key_as(&self, signer_id: &AccountId) -> TestResult<TransactionResult> {
        self.env
            .call_on(
                self.env.vault_id(),
                signer_id,
                "register_intents_key",
                json!({}),
                ONE_YOCTO,
                tgas(150),
            )
            .await
    }

    /// Sets up intents and registers the vault's key, both of which must succeed.
    pub async fn set_up(&self) -> TestResult {
        self.setup_intents_as(self.env.vault_id())
            .await?
            .assert_success();
        let verified: bool = self
            .register_key_as(&self.env.owner)
            .await?
            .assert_success()
            .json()?;
        assert!(verified, "the vault's intents key should check out");
        Ok(())
    }

    pub async fn config(&self) -> TestResult<Option<IntentsConfig>> {
        self.env
            .view_on(self.env.vault_id(), "get_intents_config", json!({}))
            .await
    }

    /// Mints `amount` of `token` to `who` (`near_deposit`) and deposits it into their vault.
    pub async fn fund_vault(&self, who: &AccountId, token: &AccountId, amount: u128) -> TestResult {
        self.env
            .call_on(
                token,
                who,
                "near_deposit",
                json!({}),
                near_api::NearToken::from_yoctonear(amount),
                tgas(30),
            )
            .await?
            .assert_success();
        let args = json!({ "receiver_id": self.env.vault_id(), "amount": U128(amount), "msg": "" });
        self.env
            .call_on(token, who, "ft_transfer_call", args, ONE_YOCTO, tgas(100))
            .await?
            .assert_success();
        Ok(())
    }

    pub async fn deposit_to_intents(
        &self,
        who: &AccountId,
        token: &AccountId,
        amount: u128,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "token_id": token, "amount": U128(amount) });
        self.env
            .call_on(
                self.env.vault_id(),
                who,
                "deposit_to_intents",
                args,
                ONE_YOCTO,
                tgas(150),
            )
            .await
    }

    pub async fn withdraw_from_intents(
        &self,
        who: &AccountId,
        token: &AccountId,
        amount: u128,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "token_id": token, "amount": U128(amount) });
        self.env
            .call_on(
                self.env.vault_id(),
                who,
                "withdraw_from_intents",
                args,
                ONE_YOCTO,
                tgas(150),
            )
            .await
    }

    /// The owner's intents bookkeeping of `token` on the vault.
    pub async fn intents_balance(&self, who: &AccountId, token: &AccountId) -> TestResult<u128> {
        let balances: Vec<IntentsBalance> = self
            .env
            .view_on(
                self.env.vault_id(),
                "get_intents_balances",
                json!({ "owner_id": who }),
            )
            .await?;
        Ok(balances
            .iter()
            .find(|entry| &entry.token_id == token)
            .map_or(0, |entry| entry.balance.0))
    }

    /// What the Verifier itself holds for `account` in `token` (`mt_balance_of`).
    pub async fn on_verifier(&self, account: &AccountId, token: &AccountId) -> TestResult<u128> {
        let balance: U128 = self
            .env
            .view_on(
                &self.it.intents,
                "mt_balance_of",
                json!({ "account_id": account, "token_id": format!("nep141:{token}") }),
            )
            .await?;
        Ok(balance.0)
    }

    /// The owner's vault balance of `token`.
    pub async fn vault_token(&self, who: &AccountId, token: &AccountId) -> TestResult<u128> {
        Ok(self.env.vault(who).await?.token_balance(token))
    }

    pub async fn public_keys_on_verifier(&self, account: &AccountId) -> TestResult<Vec<String>> {
        self.env
            .view_on(
                &self.it.intents,
                "public_keys_of",
                json!({ "account_id": account }),
            )
            .await
    }

    /// Calls the Verifier as its DAO.
    pub async fn as_dao(
        &self,
        method: &str,
        args: Value,
        deposit: near_api::NearToken,
    ) -> TestResult<TransactionResult> {
        self.env
            .call_on(
                &self.it.intents,
                &self.it.dao,
                method,
                args,
                deposit,
                tgas(100),
            )
            .await
    }
}
