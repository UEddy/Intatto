//! The Chain Signatures intents path: the vendored intents.near 0.4.5 Verifier, the mock MPC
//! signer, and the vault's agent intent swaps through them.

// Each test holds a sandbox slot (a semaphore permit) for its whole run on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::intents::*;
use common::*;
use ed25519_dalek::{Signature, Verifier as _};
use near_api::NearGas;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
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
