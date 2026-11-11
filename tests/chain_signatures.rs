//! The Chain Signatures intents path: the vendored intents.near 0.4.5 Verifier, the mock MPC
//! signer, and the vault's agent intent swaps through them.

// Each test holds a sandbox slot (a semaphore permit) for its whole run on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::intents::*;
use common::*;
use ed25519_dalek::{Signature, Verifier as _};
use near_api::NearGas;
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
