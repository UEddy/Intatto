//! The Chain Signatures intents path: the vendored intents.near 0.4.5 Verifier, the mock MPC
//! signer, and the vault's agent intent swaps through them.

// Each test holds a sandbox slot (a semaphore permit) for its whole run on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::intents::*;
use common::*;
use ed25519_dalek::{Signature, Verifier as _};
use intatto::{IntentPair, IntentPolicy};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use sha2::Digest as _;
use testresult::TestResult;

const PATH: &str = "mock-test-path";

fn sign_args(payload: &[u8], domain_id: u64) -> Value {
    let hex: String = payload.iter().map(|b| format!("{b:02x}")).collect();
    json!({ "request": { "path": PATH, "payload_v2": { "Eddsa": hex }, "domain_id": domain_id } })
}

/// The vendored binary is intents.near 0.4.5, built from the commit the spike read.
#[tokio::test]
async fn vendored_verifier_is_intents_near_0_4_5() -> TestResult {
    let env = TestEnv::new().await?;
    let it = Intents::deploy(&env, &env.owner, PATH).await?;
    let meta: Value = env
        .view_on(&it.intents, "contract_source_metadata", json!({}))
        .await?;
    assert_eq!(meta["version"], "0.4.5");
    assert!(
        meta["link"]
            .as_str()
            .is_some_and(|link| link.ends_with("16d04f6ec4401263f8914638710260da50bb46b0"))
    );
    let salt: String = env.view_on(&it.intents, "current_salt", json!({})).await?;
    let valid: bool = env
        .view_on(&it.intents, "is_valid_salt", json!({ "salt": salt }))
        .await?;
    assert!(valid);
    Ok(())
}

/// Success: `sign` parks the request; the caller's transaction resolves to the real response
/// shape once the responder answers, and the signature verifies under `derived_public_key`.
#[tokio::test]
async fn mock_signer_answers_with_the_real_response_shape() -> TestResult {
    let env = TestEnv::new().await?;
    let it = Intents::deploy(&env, &env.owner, PATH).await?;
    let derived: String = env
        .view_on(
            &it.signer,
            "derived_public_key",
            json!({ "path": PATH, "predecessor": env.owner, "domain_id": ED25519_DOMAIN }),
        )
        .await?;
    let key = derived_signing_key(&env.owner, PATH);
    assert_eq!(derived, ed25519_string(&key));

    let payload = [7u8; 32];
    let gas = NearGas::from_tgas(50);
    let (signed, answered) = tokio::join!(
        env.call_on(
            &it.signer,
            &env.owner,
            "sign",
            sign_args(&payload, ED25519_DOMAIN),
            ONE_YOCTO,
            gas
        ),
        async {
            let pending = it.wait_for_pending(&env, 1).await?;
            assert_eq!(pending[0].predecessor, env.owner);
            assert_eq!(pending[0].payload_bytes(), payload);
            it.respond(&env, &pending[0]).await
        }
    );
    answered?;
    let response: Value = signed?.assert_success().json()?;
    assert_eq!(response["scheme"], "Ed25519");
    let bytes: Vec<u8> = response["signature"]
        .as_array()
        .expect("signature is a byte array")
        .iter()
        .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("byte"))
        .collect();
    let signature = Signature::from_slice(&bytes)?;
    key.verifying_key().verify(&payload, &signature)?;
    assert!(it.pending_requests(&env).await?.is_empty());
    Ok(())
}

/// Timeout: nobody answers; after the protocol's yield timeout the caller's promise fails with
/// v1.signer's message, and the request is dropped.
#[tokio::test]
async fn mock_signer_times_out_like_v1_signer() -> TestResult {
    let env = TestEnv::new().await?;
    let it = Intents::deploy(&env, &env.owner, PATH).await?;
    let gas = NearGas::from_tgas(50);
    let (signed, timed_out) = tokio::join!(
        env.call_on(
            &it.signer,
            &env.owner,
            "sign",
            sign_args(&[1u8; 32], ED25519_DOMAIN),
            ONE_YOCTO,
            gas
        ),
        async {
            it.wait_for_pending(&env, 1).await?;
            it.time_out_pending(&env).await
        }
    );
    timed_out?;
    assert_fails_with(signed?, "Request has timed out.");
    assert!(it.pending_requests(&env).await?.is_empty());
    Ok(())
}

/// Failure: `sign` itself refuses, as v1.signer does, for a closed network, a wrong domain, a
/// non-EdDSA payload, a missing deposit or too little gas; and `respond` refuses a signature that
/// does not verify.
#[tokio::test]
async fn mock_signer_fails_like_v1_signer() -> TestResult {
    let env = TestEnv::new().await?;
    let it = Intents::deploy(&env, &env.owner, PATH).await?;
    let gas = NearGas::from_tgas(50);
    let sign =
        |args: Value, deposit, gas| env.call_on(&it.signer, &env.owner, "sign", args, deposit, gas);

    assert_fails_with(
        sign(sign_args(&[1u8; 32], 0), ONE_YOCTO, gas).await?,
        "The provided domain ID, 0, was not found.",
    );
    assert_fails_with(
        sign(sign_args(&[1u8; 31], ED25519_DOMAIN), ONE_YOCTO, gas).await?,
        "Payload is not EdDSA",
    );
    let ecdsa = json!({ "request": { "path": PATH, "payload_v2": { "Ecdsa": "00".repeat(32) }, "domain_id": 1 } });
    assert_fails_with(sign(ecdsa, ONE_YOCTO, gas).await?, "Payload is not EdDSA");
    assert_fails_with(
        sign(sign_args(&[1u8; 32], ED25519_DOMAIN), NO_DEPOSIT, gas).await?,
        "Attached deposit is lower than required",
    );
    assert_fails_with(
        sign(
            sign_args(&[1u8; 32], ED25519_DOMAIN),
            ONE_YOCTO,
            NearGas::from_tgas(10),
        )
        .await?,
        "Provided gas is lower than required",
    );
    it.set_accept_requests(&env, false).await?;
    assert_fails_with(
        sign(sign_args(&[1u8; 32], ED25519_DOMAIN), ONE_YOCTO, gas).await?,
        "the network is not accepting new requests",
    );
    it.set_accept_requests(&env, true).await?;

    // A wrong signature is refused and the request stays parked, then times out.
    let (signed, checked) = tokio::join!(
        sign(sign_args(&[2u8; 32], ED25519_DOMAIN), ONE_YOCTO, gas),
        async {
            let pending = it.wait_for_pending(&env, 1).await?;
            let args = json!({ "request": pending[0].as_json(), "signature": vec![0u8; 64] });
            let refused = env
                .call_on(
                    &it.signer,
                    &it.responder,
                    "respond",
                    args,
                    NO_DEPOSIT,
                    NearGas::from_tgas(50),
                )
                .await?;
            assert_fails_with(refused, "Signature could not be verified");
            assert_eq!(it.pending_requests(&env).await?.len(), 1);
            it.time_out_pending(&env).await
        }
    );
    checked?;
    assert_fails_with(signed?, "Request has timed out.");
    Ok(())
}

// ---- Step 2: the vault's intents.near account and its one MPC-derived key ----

/// Only the vault account can bind the Verifier and signer, once. The key comes from the
/// signer's `derived_public_key` for the vault, is registered as the vault's only key on the
/// Verifier, and the check that it is the only one passes.
#[tokio::test]
async fn vault_registers_exactly_its_mpc_derived_key() -> TestResult {
    let s = CsEnv::new().await?;
    let vault = s.env.vault_id().clone();
    assert_fails_with(
        s.register_key_as(&s.env.owner).await?,
        "Intents are not set up on this vault",
    );
    assert_fails_with(
        s.setup_intents_as(&s.env.owner).await?,
        "Method setup_intents is private",
    );
    s.setup_intents_as(&vault).await?.assert_success();
    assert_fails_with(
        s.setup_intents_as(&vault).await?,
        "Intents are already set up",
    );
    // Anyone may register the key, but it takes exactly 1 yoctoNEAR.
    let free = s
        .env
        .call_on(
            &vault,
            &s.env.stranger,
            "register_intents_key",
            json!({}),
            NO_DEPOSIT,
            tgas(150),
        )
        .await?;
    assert_fails_with(free, "Requires attached deposit of exactly 1 yoctoNEAR");

    let result = s.register_key_as(&s.env.stranger).await?;
    let checked = events(&result, "intents_key_checked");
    assert!(result.assert_success().json::<bool>()?);
    let expected = ed25519_string(&derived_signing_key(&vault, intatto::INTENTS_KEY_PATH));
    assert_eq!(checked.len(), 1);
    assert_eq!(checked[0]["expected"], expected);
    assert_eq!(checked[0]["found"], json!([expected]));
    let config = s.config().await?.expect("intents are set up");
    assert_eq!(config.public_key.as_deref(), Some(expected.as_str()));
    assert!(config.key_verified);
    assert_eq!(config.intents_id, s.it.intents);
    assert_eq!(config.signer_id, s.it.signer);
    assert_eq!(
        s.public_keys_on_verifier(&vault).await?,
        vec![expected.clone()]
    );

    // Registering again changes nothing.
    assert!(
        s.register_key_as(&s.env.owner)
            .await?
            .assert_success()
            .json::<bool>()?
    );
    assert_eq!(s.public_keys_on_verifier(&vault).await?, vec![expected]);
    Ok(())
}

/// A second key on the vault's Verifier account (here added with the vault account's own
/// full-access key) fails the check, which anyone can run; removing it passes it again.
#[tokio::test]
async fn an_extra_key_on_the_verifier_fails_the_key_check() -> TestResult {
    let s = CsEnv::new().await?;
    s.set_up().await?;
    let vault = s.env.vault_id().clone();
    let verify = || async {
        s.env
            .call_on(
                &vault,
                &s.env.stranger,
                "verify_intents_key",
                json!({}),
                NO_DEPOSIT,
                tgas(60),
            )
            .await
    };
    assert!(verify().await?.assert_success().json::<bool>()?);

    let extra = ed25519_string(&derived_signing_key(&vault, "someone-else"));
    let args = json!({ "public_key": extra });
    s.env
        .call_on(
            &s.it.intents,
            &vault,
            "add_public_key",
            args.clone(),
            ONE_YOCTO,
            tgas(30),
        )
        .await?
        .assert_success();
    let result = verify().await?;
    assert_eq!(events(&result, "intents_key_checked")[0]["verified"], false);
    assert!(!result.assert_success().json::<bool>()?);
    assert!(!s.config().await?.expect("set up").key_verified);

    s.env
        .call_on(
            &s.it.intents,
            &vault,
            "remove_public_key",
            args,
            ONE_YOCTO,
            tgas(30),
        )
        .await?
        .assert_success();
    assert!(verify().await?.assert_success().json::<bool>()?);
    assert!(s.config().await?.expect("set up").key_verified);
    Ok(())
}

/// Once registered, the vault's key never changes: if the signer later derives a different key,
/// registering again fails and the stored key stays.
#[tokio::test]
async fn a_changed_derived_key_is_refused() -> TestResult {
    let s = CsEnv::new().await?;
    s.set_up().await?;
    let vault = s.env.vault_id().clone();
    let before = s.config().await?.expect("set up");
    let other = ed25519_string(&derived_signing_key(&vault, "another-path"));
    let args =
        json!({ "predecessor": vault, "path": intatto::INTENTS_KEY_PATH, "public_key": other });
    s.env
        .call_on(
            &s.it.signer,
            &s.it.responder,
            "set_derived_public_key",
            args,
            NO_DEPOSIT,
            tgas(30),
        )
        .await?
        .assert_success();
    assert_fails_with(s.register_key_as(&s.env.owner).await?, "now derives");
    assert_eq!(s.config().await?.expect("set up"), before);
    assert_eq!(s.public_keys_on_verifier(&vault).await?.len(), 1);
    Ok(())
}

/// Deposits and withdrawals move tokens between the owner's vault balance and the vault's own
/// account on the Verifier, as the vault (predecessor auth), and the owner bookkeeping matches
/// what the Verifier holds.
#[tokio::test]
async fn deposits_and_withdrawals_go_through_the_vaults_own_verifier_account() -> TestResult {
    let s = CsEnv::new().await?;
    s.set_up().await?;
    let (owner, vault, wnear) = (
        s.env.owner.clone(),
        s.env.vault_id().clone(),
        s.it.wnear.clone(),
    );
    s.fund_vault(&owner, &wnear, 2 * WHOLE).await?;

    let result = s.deposit_to_intents(&owner, &wnear, 2 * WHOLE).await?;
    assert_eq!(events(&result, "intents_deposit").len(), 1);
    assert_eq!(result.assert_success().json::<U128>()?, U128(2 * WHOLE));
    assert_eq!(s.vault_token(&owner, &wnear).await?, 0);
    assert_eq!(s.intents_balance(&owner, &wnear).await?, 2 * WHOLE);
    assert_eq!(s.on_verifier(&vault, &wnear).await?, 2 * WHOLE);
    assert_eq!(s.on_verifier(&owner, &wnear).await?, 0);

    let result = s.withdraw_from_intents(&owner, &wnear, WHOLE / 2).await?;
    assert_eq!(result.assert_success().json::<U128>()?, U128(WHOLE / 2));
    assert_eq!(s.vault_token(&owner, &wnear).await?, WHOLE / 2);
    assert_eq!(s.intents_balance(&owner, &wnear).await?, 3 * WHOLE / 2);
    assert_eq!(s.on_verifier(&vault, &wnear).await?, 3 * WHOLE / 2);

    // Nobody else can touch it, and nobody can take more than they have.
    assert_fails_with(
        s.withdraw_from_intents(&s.env.stranger, &wnear, 1).await?,
        "exceeds the intents",
    );
    assert_fails_with(
        s.withdraw_from_intents(&owner, &wnear, 2 * WHOLE).await?,
        "exceeds the intents",
    );
    assert_fails_with(
        s.deposit_to_intents(&owner, &wnear, WHOLE).await?,
        "exceeds the vault's",
    );
    // A function-call key cannot attach the yoctoNEAR these need.
    let args = json!({ "token_id": wnear, "amount": U128(1) });
    let free = s
        .env
        .call_on(
            &vault,
            &owner,
            "withdraw_from_intents",
            args,
            NO_DEPOSIT,
            tgas(150),
        )
        .await?;
    assert_fails_with(free, "Requires attached deposit of exactly 1 yoctoNEAR");
    Ok(())
}

/// When the Verifier refuses (paused by its governance), a deposit comes back to the vault
/// balance and a withdrawal back to the intents balance: nothing is lost or credited twice.
#[tokio::test]
async fn a_paused_verifier_refunds_deposits_and_withdrawals() -> TestResult {
    let s = CsEnv::new().await?;
    s.set_up().await?;
    let (owner, vault, wnear) = (
        s.env.owner.clone(),
        s.env.vault_id().clone(),
        s.it.wnear.clone(),
    );
    s.fund_vault(&owner, &wnear, 2 * WHOLE).await?;
    s.deposit_to_intents(&owner, &wnear, WHOLE)
        .await?
        .assert_success();

    s.as_dao("pa_pause_feature", json!({ "key": "ALL" }), NO_DEPOSIT)
        .await?
        .assert_success();
    let result = s.deposit_to_intents(&owner, &wnear, WHOLE).await?;
    assert_eq!(events(&result, "intents_deposit_refunded").len(), 1);
    assert_eq!(result.assert_success().json::<U128>()?, U128(0));
    assert_eq!(s.vault_token(&owner, &wnear).await?, WHOLE);
    assert_eq!(s.intents_balance(&owner, &wnear).await?, WHOLE);

    let result = s.withdraw_from_intents(&owner, &wnear, WHOLE).await?;
    assert_eq!(events(&result, "intents_withdraw_refunded").len(), 1);
    assert_eq!(result.assert_success().json::<U128>()?, U128(0));
    assert_eq!(s.vault_token(&owner, &wnear).await?, WHOLE);
    assert_eq!(s.intents_balance(&owner, &wnear).await?, WHOLE);
    assert_eq!(s.on_verifier(&vault, &wnear).await?, WHOLE);

    s.as_dao("pa_unpause_feature", json!({ "key": "ALL" }), NO_DEPOSIT)
        .await?
        .assert_success();
    s.withdraw_from_intents(&owner, &wnear, WHOLE)
        .await?
        .assert_success();
    assert_eq!(s.vault_token(&owner, &wnear).await?, 2 * WHOLE);
    assert_eq!(s.on_verifier(&vault, &wnear).await?, 0);
    Ok(())
}

// ---- Step 3: agent intent swaps, signed by the MPC network, settled by nonce ----

/// One wNEAR's worth of stand-in USDT the owner's floor demands (the stand-in has 24 decimals).
const FLOOR_USDT_PER_WNEAR: u128 = 3 * WHOLE;

fn pair(token_in: &AccountId, token_out: &AccountId, min_out: u128, per_in: u128) -> IntentPair {
    IntentPair {
        token_in: token_in.clone(),
        token_out: token_out.clone(),
        min_out: U128(min_out),
        per_in: U128(per_in),
    }
}

impl CsEnv {
    /// Set up, with 3 wNEAR in the owner's intents balance and both directions of the pair
    /// allowlisted: at least 3 USDT per wNEAR, and at least 0.25 wNEAR per USDT.
    async fn ready() -> TestResult<Self> {
        let s = Self::new().await?;
        s.set_up().await?;
        let owner = s.env.owner.clone();
        s.fund_vault(&owner, &s.it.wnear, 3 * WHOLE).await?;
        s.deposit_to_intents(&owner, &s.it.wnear, 3 * WHOLE)
            .await?
            .assert_success();
        s.set_intent_policy(&owner, &s.both_ways())
            .await?
            .assert_success();
        Ok(s)
    }

    fn both_ways(&self) -> IntentPolicy {
        IntentPolicy {
            pairs: vec![
                pair(&self.it.wnear, &self.it.usdt, FLOOR_USDT_PER_WNEAR, WHOLE),
                pair(&self.it.usdt, &self.it.wnear, WHOLE / 4, WHOLE),
            ],
        }
    }

    async fn set_intent_policy(
        &self,
        who: &AccountId,
        policy: &IntentPolicy,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "policy": policy });
        self.env
            .call(who, "set_intent_policy", args, ONE_YOCTO)
            .await
    }

    /// `agent_intent_swap` signed by `caller`, without anyone answering the signer.
    async fn intent_swap_as(
        &self,
        caller: &AccountId,
        token_in: &AccountId,
        token_out: &AccountId,
        amount_in: u128,
        amount_out: u128,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        let args = json!({
            "owner_id": self.env.owner,
            "token_in": token_in,
            "token_out": token_out,
            "amount_in": U128(amount_in),
            "amount_out": U128(amount_out),
        });
        self.env
            .call_on(
                self.env.vault_id(),
                caller,
                "agent_intent_swap",
                args,
                NO_DEPOSIT,
                gas,
            )
            .await
    }

    /// The agent sells `amount_in` wNEAR for `amount_out` USDT, and the MPC nodes answer.
    async fn sell_wnear_signed(&self, amount_in: u128, amount_out: u128) -> TestResult<Value> {
        let (agent, wnear, usdt) = (&self.env.agent, &self.it.wnear, &self.it.usdt);
        let (result, answered) = tokio::join!(
            self.intent_swap_as(agent, wnear, usdt, amount_in, amount_out, tgas(150)),
            async {
                let pending = self.it.wait_for_pending(&self.env, 1).await?;
                self.it.respond(&self.env, &pending[0]).await
            }
        );
        answered?;
        let result = result?;
        let signed = events(&result, "intent_swap_signed");
        assert!(
            result.assert_success().json::<bool>()?,
            "the swap should be signed"
        );
        assert_eq!(signed.len(), 1);
        let id: String = near_sdk::serde_json::from_value(signed[0]["intent_id"].clone())?;
        self.intent_record(&id)
            .await?
            .ok_or_else(|| "no record".into())
    }

    async fn intent_record(&self, intent_id: &str) -> TestResult<Option<Value>> {
        self.env
            .view_on(
                self.env.vault_id(),
                "get_intent_swap",
                json!({ "intent_id": intent_id }),
            )
            .await
    }

    async fn settle(&self, who: &AccountId, intent_id: &str) -> TestResult<TransactionResult> {
        let args = json!({ "intent_id": intent_id });
        self.env
            .call_on(
                self.env.vault_id(),
                who,
                "settle_intent_swap",
                args,
                NO_DEPOSIT,
                tgas(100),
            )
            .await
    }

    async fn nonce_used(&self, nonce: &Value) -> TestResult<bool> {
        let args = json!({ "account_id": self.env.vault_id(), "nonce": nonce });
        self.env
            .view_on(&self.it.intents, "is_nonce_used", args)
            .await
    }

    /// Owner bookkeeping and the vault's real Verifier account, for both tokens.
    async fn intents_snapshot(&self) -> TestResult<[u128; 4]> {
        let (owner, vault) = (&self.env.owner, self.env.vault_id());
        Ok([
            self.intents_balance(owner, &self.it.wnear).await?,
            self.intents_balance(owner, &self.it.usdt).await?,
            self.on_verifier(vault, &self.it.wnear).await?,
            self.on_verifier(vault, &self.it.usdt).await?,
        ])
    }
}

/// A market maker on the Verifier, with its own key and USDT there.
struct Solver {
    id: AccountId,
    key: ed25519_dalek::SigningKey,
}

impl Solver {
    async fn new(s: &CsEnv, usdt: u128) -> TestResult<Self> {
        let id = s.env.create_account("solver.sandbox", near(100)).await?;
        let key = derived_signing_key(&id, "solver");
        for token in [&s.it.wnear, &s.it.usdt] {
            s.register(token, &id).await?;
        }
        s.env
            .call_on(
                &s.it.usdt,
                &id,
                "near_deposit",
                json!({}),
                near_api::NearToken::from_yoctonear(usdt),
                tgas(30),
            )
            .await?
            .assert_success();
        let args = json!({ "receiver_id": s.it.intents, "amount": U128(usdt), "msg": "" });
        s.env
            .call_on(
                &s.it.usdt,
                &id,
                "ft_transfer_call",
                args,
                ONE_YOCTO,
                tgas(100),
            )
            .await?
            .assert_success();
        let args = json!({ "public_key": ed25519_string(&key) });
        s.env
            .call_on(
                &s.it.intents,
                &id,
                "add_public_key",
                args,
                ONE_YOCTO,
                tgas(30),
            )
            .await?
            .assert_success();
        Ok(Self { id, key })
    }

    /// The solver's side of the vault's intent `record`: the opposite diff, signed.
    async fn counter_intent(&self, s: &CsEnv, record: &Value) -> TestResult<Value> {
        let token_in = record["token_in"].as_str().expect("token_in");
        let token_out = record["token_out"].as_str().expect("token_out");
        let amount_in = record["amount_in"].as_str().expect("amount_in");
        let amount_out = record["amount_out"].as_str().expect("amount_out");
        let deadline = intatto::rfc3339(s.env.block_timestamp().await? / SECOND_NS + 3_600);
        let message = json!({
            "signer_id": self.id,
            "deadline": deadline,
            "intents": [{ "intent": "token_diff", "diff": {
                format!("nep141:{token_in}"): amount_in,
                format!("nep141:{token_out}"): format!("-{amount_out}"),
            }}],
        })
        .to_string();
        let nonce: [u8; 32] = sha2::Sha256::digest(format!("solver {record}")).into();
        let hash = nep413_hash(&message, &nonce, s.it.intents.as_str());
        let signature = ed25519_dalek::Signer::sign(&self.key, &hash);
        Ok(json!({
            "standard": "nep413",
            "payload": {
                "message": message,
                "nonce": near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, nonce),
                "recipient": s.it.intents,
            },
            "public_key": ed25519_string(&self.key),
            "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()),
        }))
    }

    /// What the Message Bus would do: submit both signed intents to the Verifier together.
    async fn execute(&self, s: &CsEnv, signed: Vec<Value>) -> TestResult<TransactionResult> {
        s.env
            .call_on(
                &s.it.intents,
                &self.id,
                "execute_intents",
                json!({ "signed": signed }),
                NO_DEPOSIT,
                tgas(300),
            )
            .await
    }
}

/// The full path. The agent names only the pair and amounts; the vault builds the token_diff,
/// gets it signed by the MPC network under its registered key, and logs the signed payload. The
/// real intents.near accepts that signature and executes the diff exactly, once. Settlement
/// credits exactly `amount_out`, once, even when two settlements race.
#[tokio::test]
async fn intent_swap_is_signed_executed_and_settled_exactly_once() -> TestResult {
    let s = CsEnv::ready().await?;
    let (owner, vault) = (s.env.owner.clone(), s.env.vault_id().clone());
    let (wnear, usdt) = (s.it.wnear.clone(), s.it.usdt.clone());
    let (amount_in, amount_out) = (WHOLE / 2, 2 * WHOLE);
    assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);

    let record = s.sell_wnear_signed(amount_in, amount_out).await?;
    let id = record["intent_id"].as_str().expect("id").to_string();
    assert_eq!(record["status"], "signed");
    // Reserved in the bookkeeping only: the Verifier still holds it for the vault.
    assert_eq!(
        s.intents_snapshot().await?,
        [5 * WHOLE / 2, 0, 3 * WHOLE, 0]
    );
    assert_eq!(amounts(&s.env.vault(&owner).await?).len(), 1);

    // Everything signed was built by the vault: exactly this message, for this account.
    let signed = &record["signed_data"];
    assert_eq!(signed["standard"], "nep413");
    assert_eq!(signed["payload"]["recipient"], s.it.intents.as_str());
    let message: Value =
        near_sdk::serde_json::from_str(signed["payload"]["message"].as_str().expect("message"))?;
    assert_eq!(message["signer_id"], vault.as_str());
    assert_eq!(
        message["intents"],
        json!([{ "intent": "token_diff", "diff": {
            format!("nep141:{wnear}"): format!("-{amount_in}"),
            format!("nep141:{usdt}"): amount_out.to_string(),
        }}])
    );
    let deadline_ns: u64 = record["deadline"].as_str().expect("deadline").parse()?;
    assert_eq!(
        message["deadline"],
        intatto::rfc3339(deadline_ns / SECOND_NS)
    );
    let now = s.env.block_timestamp().await?;
    assert!(deadline_ns > now && deadline_ns <= now + intatto::INTENT_DEADLINE_SECS * SECOND_NS);
    // A versioned nonce with the Verifier's current salt and a long validity.
    let nonce = near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        signed["payload"]["nonce"].as_str().expect("nonce"),
    )?;
    let salt: String = s
        .env
        .view_on(&s.it.intents, "current_salt", json!({}))
        .await?;
    assert_eq!(nonce[..4], [0x56, 0x28, 0xf6, 0xc6]);
    assert_eq!(
        format!(
            "{:02x}{:02x}{:02x}{:02x}",
            nonce[5], nonce[6], nonce[7], nonce[8]
        ),
        salt
    );
    let nonce_deadline = i64::from_le_bytes(nonce[9..17].try_into()?) as u64;
    assert_eq!(
        nonce_deadline,
        deadline_ns + intatto::NONCE_VALIDITY_SECS * SECOND_NS
    );
    // The signature is over the NEP-413 hash, under the registered key.
    let hash = nep413_hash(
        signed["payload"]["message"].as_str().expect("message"),
        &nonce.clone().try_into().expect("32 bytes"),
        s.it.intents.as_str(),
    );
    let key = derived_signing_key(&vault, intatto::INTENTS_KEY_PATH);
    assert_eq!(signed["public_key"], ed25519_string(&key));
    let sig = bs58::decode(
        signed["signature"]
            .as_str()
            .expect("sig")
            .trim_start_matches("ed25519:"),
    )
    .into_vec()?;
    key.verifying_key()
        .verify(&hash, &Signature::from_slice(&sig)?)?;

    // Not executed yet, deadline ahead: settling is refused and changes nothing.
    assert_fails_with(
        s.settle(&s.env.stranger, &id).await?,
        "has not executed and its deadline",
    );

    // A solver fills it on the real intents.near.
    let solver = Solver::new(&s, 5 * WHOLE).await?;
    let counter = solver.counter_intent(&s, &record).await?;
    solver
        .execute(&s, vec![signed.clone(), counter.clone()])
        .await?
        .assert_success();
    assert!(s.nonce_used(&signed["payload"]["nonce"]).await?);
    assert_eq!(
        s.intents_snapshot().await?,
        [5 * WHOLE / 2, 0, 5 * WHOLE / 2, amount_out]
    );
    // It cannot be replayed.
    assert_fails_with(
        solver.execute(&s, vec![signed.clone(), counter]).await?,
        "nonce was already used",
    );

    // Two settlements race: exactly one credits.
    let (first, second) = tokio::join!(s.settle(&s.env.stranger, &id), s.settle(&s.env.agent, &id));
    let (first, second) = (first?, second?);
    let settled =
        events(&first, "intent_swap_settled").len() + events(&second, "intent_swap_settled").len();
    assert_eq!(settled, 1, "logs: {:?} {:?}", first.logs(), second.logs());
    assert_eq!(
        s.intents_snapshot().await?,
        [5 * WHOLE / 2, amount_out, 5 * WHOLE / 2, amount_out]
    );
    assert!(s.intent_record(&id).await?.is_none());
    assert_fails_with(
        s.settle(&s.env.stranger, &id).await?,
        "No unsettled intent swap",
    );
    // The swap counts toward the 24-hour window like any other.
    assert_eq!(amounts(&s.env.vault(&owner).await?).len(), 1);

    // And the output comes home.
    s.withdraw_from_intents(&owner, &usdt, amount_out)
        .await?
        .assert_success();
    assert_eq!(s.vault_token(&owner, &usdt).await?, amount_out);
    assert_eq!(
        s.intents_snapshot().await?,
        [5 * WHOLE / 2, 0, 5 * WHOLE / 2, 0]
    );
    Ok(())
}

/// Signed but never executed: before the deadline settling is refused; after it, the reserved
/// amount comes back exactly once, the spend record goes, and the Verifier refuses the intent.
#[tokio::test]
async fn unexecuted_intent_is_refunded_once_after_its_deadline() -> TestResult {
    let s = CsEnv::ready().await?;
    let record = s.sell_wnear_signed(WHOLE, 3 * WHOLE).await?;
    let id = record["intent_id"].as_str().expect("id").to_string();
    assert_eq!(s.intents_snapshot().await?, [2 * WHOLE, 0, 3 * WHOLE, 0]);
    assert_fails_with(
        s.settle(&s.env.stranger, &id).await?,
        "has not executed and its deadline",
    );

    let deadline: u64 = record["deadline"].as_str().expect("deadline").parse()?;
    s.env.advance_past(deadline).await?;
    let result = s.settle(&s.env.stranger, &id).await?;
    let refunded = events(&result, "intent_swap_refunded");
    assert_eq!(result.assert_success().json::<String>()?, "refunded");
    assert_eq!(refunded.len(), 1);
    assert_eq!(refunded[0]["reason"], "expired");
    assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    assert!(s.intent_record(&id).await?.is_none());
    assert_fails_with(
        s.settle(&s.env.stranger, &id).await?,
        "No unsettled intent swap",
    );

    let solver = Solver::new(&s, 5 * WHOLE).await?;
    let counter = solver.counter_intent(&s, &record).await?;
    assert_fails_with(
        solver
            .execute(&s, vec![record["signed_data"].clone(), counter])
            .await?,
        "deadline has expired",
    );
    assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
    Ok(())
}

/// The signer never answers: after the yield timeout the swap is refunded and leaves no trace.
#[tokio::test]
async fn signer_timeout_refunds_the_swap() -> TestResult {
    let s = CsEnv::ready().await?;
    let (agent, wnear, usdt) = (&s.env.agent, &s.it.wnear, &s.it.usdt);
    let (result, timed_out) = tokio::join!(
        s.intent_swap_as(agent, wnear, usdt, WHOLE, 3 * WHOLE, tgas(150)),
        async {
            s.it.wait_for_pending(&s.env, 1).await?;
            assert_eq!(s.intents_snapshot().await?, [2 * WHOLE, 0, 3 * WHOLE, 0]);
            s.it.time_out_pending(&s.env).await
        }
    );
    timed_out?;
    let result = result?;
    let initiated = events(&result, "intent_swap_initiated");
    let refunded = events(&result, "intent_swap_refunded");
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(refunded.len(), 1);
    assert_eq!(refunded[0]["reason"], "sign_failed");
    let id = initiated[0]["swap"]["intent_id"].as_str().expect("id");
    assert!(s.intent_record(id).await?.is_none());
    assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    Ok(())
}

/// The signer refuses at once (v1.signer after a failed TEE validation): refunded.
#[tokio::test]
async fn signer_failure_refunds_the_swap() -> TestResult {
    let s = CsEnv::ready().await?;
    s.it.set_accept_requests(&s.env, false).await?;
    let result = s
        .intent_swap_as(
            &s.env.agent,
            &s.it.wnear,
            &s.it.usdt,
            WHOLE,
            3 * WHOLE,
            tgas(150),
        )
        .await?;
    let refunded = events(&result, "intent_swap_refunded");
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(refunded[0]["reason"], "sign_failed");
    assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    Ok(())
}

/// The signer answers with something that is not a valid signature under the vault's key: a
/// zero signature, another scheme, or a real signature by another key. Each is refunded.
#[tokio::test]
async fn a_bad_signer_answer_is_refunded() -> TestResult {
    let s = CsEnv::ready().await?;
    let other = derived_signing_key(s.env.vault_id(), "not-the-registered-path");
    type Answer = Box<dyn Fn(&PendingRequest) -> Value>;
    let answers: Vec<Answer> = vec![
        Box::new(|_| json!({ "scheme": "Ed25519", "signature": vec![0u8; 64] })),
        Box::new(
            |_| json!({ "scheme": "Secp256k1", "big_r": { "affine_point": "02" }, "s": { "scalar": "00" }, "recovery_id": 0 }),
        ),
        Box::new(move |request| {
            let sig = ed25519_dalek::Signer::sign(&other, &request.payload_bytes());
            json!({ "scheme": "Ed25519", "signature": sig.to_bytes().to_vec() })
        }),
    ];
    for answer in answers {
        let (result, answered) = tokio::join!(
            s.intent_swap_as(
                &s.env.agent,
                &s.it.wnear,
                &s.it.usdt,
                WHOLE,
                3 * WHOLE,
                tgas(150)
            ),
            async {
                let pending = s.it.wait_for_pending(&s.env, 1).await?;
                s.it.respond_unverified(&s.env, &pending[0], answer(&pending[0]))
                    .await
            }
        );
        answered?;
        let result = result?;
        let refunded = events(&result, "intent_swap_refunded");
        assert!(!result.assert_success().json::<bool>()?);
        assert_eq!(refunded[0]["reason"], "bad_signature");
        assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
    }
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    Ok(())
}

/// Every policy rejection is logged with its reason, fails the call, reserves nothing and asks
/// the signer for nothing.
#[tokio::test]
async fn intent_swap_rejections_are_logged_and_change_nothing() -> TestResult {
    let s = CsEnv::ready().await?;
    let owner = s.env.owner.clone();
    let (agent, stranger) = (s.env.agent.clone(), s.env.stranger.clone());
    let (wnear, usdt) = (s.it.wnear.clone(), s.it.usdt.clone());
    let gas = tgas(150);
    let unchanged = || async {
        assert_eq!(s.intents_snapshot().await?, [3 * WHOLE, 0, 3 * WHOLE, 0]);
        assert!(s.it.pending_requests(&s.env).await?.is_empty());
        TestResult::Ok(())
    };
    let rejected =
        |result, reason, message| assert_rejected(result, "intent_swap_rejected", reason, message);

    rejected(
        s.intent_swap_as(&stranger, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "not_agent",
        "is not the registered agent",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, 0, 3 * WHOLE, gas)
            .await?,
        "zero_amount",
        "must be greater than zero",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 0, gas)
            .await?,
        "zero_amount",
        "must be greater than zero",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, u128::MAX, gas)
            .await?,
        "amount_too_large",
        "must fit a token_diff",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, tgas(60))
            .await?,
        "insufficient_gas",
        "agent_intent_swap needs at least",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &wnear, WHOLE, 3 * WHOLE, gas)
            .await?,
        "pair_not_allowlisted",
        "is not on the vault's intent pair allowlist",
    );
    let other: AccountId = "other-token.sandbox".parse()?;
    rejected(
        s.intent_swap_as(&agent, &wnear, &other, WHOLE, 3 * WHOLE, gas)
            .await?,
        "pair_not_allowlisted",
        "is not on the vault's intent pair allowlist",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE - 1, gas)
            .await?,
        "below_price_floor",
        "below the owner's floor",
    );
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE + 1, 4 * WHOLE, gas)
            .await?,
        "over_per_tx_cap",
        "exceeds its per-transaction cap",
    );
    // The owner holds no USDT on intents.
    rejected(
        s.intent_swap_as(&agent, &usdt, &wnear, WHOLE, WHOLE, gas)
            .await?,
        "insufficient_balance",
        "exceeds the intents",
    );
    unchanged().await?;

    // The 24-hour window is shared with every other agent action.
    let now = s.env.block_timestamp().await?;
    let mut vault = s.env.vault(&owner).await?;
    let spend = |id, token: &AccountId, amount| intatto::Spend {
        spend_id: near_sdk::json_types::U64(id),
        timestamp: near_sdk::json_types::U64(now),
        token_id: Some(token.clone()),
        amount: U128(amount),
    };
    vault.recent_spends = vec![spend(1000, &wnear, 5 * WHOLE / 2)];
    s.env.patch_vault(&owner, &vault).await?;
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "over_daily_cap",
        "would exceed its 24-hour cap",
    );
    vault.recent_spends = (0..5).map(|i| spend(1000 + i, &usdt, 1)).collect();
    s.env.patch_vault(&owner, &vault).await?;
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "too_many_spends",
        "spends in the last 24 hours",
    );
    vault.recent_spends = vec![];
    s.env.patch_vault(&owner, &vault).await?;

    s.env
        .call(&owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "frozen",
        "Vault is frozen",
    );
    s.env
        .call(&owner, "unfreeze", json!({}), ONE_YOCTO)
        .await?
        .assert_success();

    // A second key on the vault's Verifier account stops intent swaps once anyone checks.
    let extra = json!({ "public_key": ed25519_string(&derived_signing_key(&owner, "extra")) });
    s.env
        .call_on(
            &s.it.intents,
            s.env.vault_id(),
            "add_public_key",
            extra,
            ONE_YOCTO,
            tgas(30),
        )
        .await?
        .assert_success();
    s.env
        .call_on(
            s.env.vault_id(),
            &stranger,
            "verify_intents_key",
            json!({}),
            NO_DEPOSIT,
            tgas(60),
        )
        .await?
        .assert_success();
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "intents_not_ready",
        "intent swaps are disabled",
    );

    // Removing the agent clears the intent policy too.
    s.env
        .call(&owner, "remove_agent", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    let policy: IntentPolicy = s
        .env
        .view_on(
            s.env.vault_id(),
            "get_intent_policy",
            json!({ "owner_id": owner }),
        )
        .await?;
    assert!(policy.pairs.is_empty());
    rejected(
        s.intent_swap_as(&agent, &wnear, &usdt, WHOLE, 3 * WHOLE, gas)
            .await?,
        "not_agent",
        "is not the registered agent",
    );
    unchanged().await?;
    assert!(s.env.vault(&owner).await?.recent_spends.is_empty());
    Ok(())
}

/// A vault whose intents are not set up rejects intent swaps before anything else happens.
#[tokio::test]
async fn intent_swaps_need_a_verified_intents_key() -> TestResult {
    let s = CsEnv::new().await?;
    let result = s
        .intent_swap_as(
            &s.env.agent,
            &s.it.wnear,
            &s.it.usdt,
            WHOLE,
            3 * WHOLE,
            tgas(150),
        )
        .await?;
    assert_rejected(
        result,
        "intent_swap_rejected",
        "intents_not_ready",
        "intent swaps are disabled",
    );
    Ok(())
}

/// The owner's intent policy: validated, owner-only with 1 yoctoNEAR, refused under a
/// withdrawal lock, and its storage charged to the vault.
#[tokio::test]
async fn intent_policy_is_validated_and_owner_only() -> TestResult {
    let s = CsEnv::new().await?;
    let owner = s.env.owner.clone();
    let (wnear, usdt) = (s.it.wnear.clone(), s.it.usdt.clone());
    let other: AccountId = "other-token.sandbox".parse()?;
    let with = |pairs| IntentPolicy { pairs };
    let cases = [
        (
            with(vec![pair(&other, &usdt, 1, 1)]),
            "which has no caps in the policy",
        ),
        (
            with(vec![pair(&wnear, &wnear, 1, 1)]),
            "two different tokens",
        ),
        (with(vec![pair(&wnear, &usdt, 0, 1)]), "must be positive"),
        (with(vec![pair(&wnear, &usdt, 1, 0)]), "must be positive"),
        (
            with(vec![pair(&wnear, &usdt, 1, 1), pair(&wnear, &usdt, 2, 1)]),
            "listed more than once",
        ),
        (
            with(vec![pair(&wnear, &usdt, 1, 1); 5]),
            "cannot list more than 4 pairs",
        ),
    ];
    for (policy, message) in cases {
        assert_fails_with(s.set_intent_policy(&owner, &policy).await?, message);
    }
    let policy = s.both_ways();
    assert_fails_with(
        s.set_intent_policy(&s.env.stranger, &policy).await?,
        "No vault found",
    );
    let free = s
        .env
        .call(
            &owner,
            "set_intent_policy",
            json!({ "policy": policy }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(free, "Requires attached deposit of exactly 1 yoctoNEAR");

    let before = s.env.vault(&owner).await?.balance;
    let result = s.set_intent_policy(&owner, &policy).await?;
    assert_eq!(events(&result, "intent_policy_set").len(), 1);
    result.assert_success();
    assert!(
        s.env.vault(&owner).await?.balance < before,
        "the vault pays the policy's storage"
    );
    let stored: IntentPolicy = s
        .env
        .view_on(
            s.env.vault_id(),
            "get_intent_policy",
            json!({ "owner_id": owner }),
        )
        .await?;
    assert_eq!(stored, policy);

    let until = s.env.block_timestamp().await? + HOUR_NS;
    let args = json!({ "timestamp_ns": near_sdk::json_types::U64(until) });
    s.env
        .call(&owner, "lock_withdrawals_until", args, ONE_YOCTO)
        .await?
        .assert_success();
    assert_fails_with(
        s.set_intent_policy(&owner, &policy).await?,
        "set_intent_policy is disabled until then",
    );
    Ok(())
}

/// After execution, intents.near governance can invalidate the salt and clean the nonce up, so
/// `is_nonce_used` turns false. Settlement must not take that as "never executed": it leaves
/// the swap unresolved instead of refunding tokens that already left.
#[tokio::test]
async fn a_cleaned_up_nonce_is_never_mistaken_for_an_unexecuted_intent() -> TestResult {
    let s = CsEnv::ready().await?;
    let record = s.sell_wnear_signed(WHOLE, 3 * WHOLE).await?;
    let id = record["intent_id"].as_str().expect("id").to_string();
    let signed = record["signed_data"].clone();
    let solver = Solver::new(&s, 5 * WHOLE).await?;
    let counter = solver.counter_intent(&s, &record).await?;
    solver
        .execute(&s, vec![signed.clone(), counter])
        .await?
        .assert_success();
    assert_eq!(
        s.intents_snapshot().await?,
        [2 * WHOLE, 0, 2 * WHOLE, 3 * WHOLE]
    );

    let salt = record["salt"].clone();
    s.as_dao("invalidate_salts", json!({ "salts": [salt] }), ONE_YOCTO)
        .await?
        .assert_success();
    let nonce = signed["payload"]["nonce"].clone();
    s.as_dao(
        "cleanup_nonces",
        json!({ "nonces": [[s.env.vault_id(), [nonce.clone()]]] }),
        ONE_YOCTO,
    )
    .await?
    .assert_success();
    assert!(
        !s.nonce_used(&nonce).await?,
        "governance cleaned the used nonce up"
    );

    let deadline: u64 = record["deadline"].as_str().expect("deadline").parse()?;
    s.env.advance_past(deadline).await?;
    let result = s.settle(&s.env.stranger, &id).await?;
    let unresolved = events(&result, "intent_swap_unresolved");
    assert_eq!(result.assert_success().json::<String>()?, "unresolved");
    assert_eq!(unresolved[0]["salt_valid"], false);
    // Nothing refunded, nothing credited: the 1 wNEAR stays reserved.
    assert_eq!(
        s.intents_snapshot().await?,
        [2 * WHOLE, 0, 2 * WHOLE, 3 * WHOLE]
    );
    assert_eq!(
        s.intent_record(&id).await?.expect("still recorded")["status"],
        "signed"
    );
    Ok(())
}

/// Signed but never executed, and the salt invalidated: the answer is not conclusive, so
/// settlement leaves it unresolved rather than guess.
#[tokio::test]
async fn an_invalidated_salt_leaves_an_unexecuted_swap_unresolved() -> TestResult {
    let s = CsEnv::ready().await?;
    let record = s.sell_wnear_signed(WHOLE, 3 * WHOLE).await?;
    let id = record["intent_id"].as_str().expect("id").to_string();
    s.as_dao(
        "invalidate_salts",
        json!({ "salts": [record["salt"]] }),
        ONE_YOCTO,
    )
    .await?
    .assert_success();
    let deadline: u64 = record["deadline"].as_str().expect("deadline").parse()?;
    s.env.advance_past(deadline).await?;
    let result = s.settle(&s.env.stranger, &id).await?;
    assert_eq!(result.assert_success().json::<String>()?, "unresolved");
    assert_eq!(s.intents_snapshot().await?, [2 * WHOLE, 0, 3 * WHOLE, 0]);
    Ok(())
}
