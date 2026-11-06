//! This build can replace the v1 code running on vault-v1.intatto-dev.testnet without a
//! migration: vault records and contract state written by v1 read back unchanged, and every
//! method keeps working, including the new withdrawal lock. tests/res/intatto_v1.wasm is that
//! account's code, fetched from testnet (see tests/res/README.md).

// The test holds a sandbox slot (a semaphore permit) for its whole run on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::*;
use intatto::{ExchangeLedger, Policy, PoolPolicy, TokenPolicy};
use near_api::{AccountId, NearGas};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

#[tokio::test]
async fn v1_state_survives_a_code_upgrade() -> TestResult {
    let env = TestEnv::new().await?;
    let v1 = env
        .deploy(
            "vault-v1.sandbox",
            res_wasm("intatto_v1.wasm", V1_SHA256),
            "new",
            json!({ "exchange_id": EXCHANGE }),
        )
        .await?;
    let gas = NearGas::from_tgas(100);
    let call = |signer: AccountId, method: &'static str, args: Value, deposit| {
        let env = &env;
        let v1 = v1.clone();
        async move { env.call_on(&v1, &signer, method, args, deposit, gas).await }
    };
    let get_vault = || async {
        env.view_on::<Value>(&v1, "get_vault", json!({ "owner_id": env.owner }))
            .await
    };

    // A real token, so the v1 vault holds a token balance entry too.
    let wnear = env
        .deploy(
            "wnear.sandbox",
            res_wasm("w_near.wasm", W_NEAR_SHA256),
            "new",
            json!({}),
        )
        .await?;
    let on_wnear = |signer: AccountId, method: &'static str, args: Value, deposit| {
        let env = &env;
        let wnear = wnear.clone();
        async move {
            env.call_on(&wnear, &signer, method, args, deposit, gas)
                .await
        }
    };

    // State written by v1: a vault with a policy that uses every field, a token balance, and one
    // spend.
    let policy = Policy {
        tokens: vec![
            TokenPolicy {
                token_id: "wnear.sandbox".parse()?,
                per_tx_cap: U128(5),
                daily_cap: U128(10),
            },
            TokenPolicy {
                token_id: "usdt.sandbox".parse()?,
                per_tx_cap: U128(0),
                daily_cap: U128(0),
            },
        ],
        pools: vec![PoolPolicy {
            pool_id: 3,
            token_ids: ["wnear.sandbox".parse()?, "usdt.sandbox".parse()?],
            max_slippage_bps: 25,
        }],
        ..env.standard_policy()
    };
    call(env.owner.clone(), "deposit", json!({}), near(10))
        .await?
        .assert_success();
    let args = json!({ "agent_id": env.agent, "policy": policy });
    call(env.owner.clone(), "set_agent", args, ONE_YOCTO)
        .await?
        .assert_success();
    for account in [&v1, &env.owner] {
        let args = json!({ "account_id": account, "registration_only": true });
        on_wnear(env.owner.clone(), "storage_deposit", args, TOKEN_STORAGE)
            .await?
            .assert_success();
    }
    on_wnear(env.owner.clone(), "near_deposit", json!({}), near(1))
        .await?
        .assert_success();
    let deposit =
        json!({ "receiver_id": v1, "amount": near(1).as_yoctonear().to_string(), "msg": "" });
    on_wnear(env.owner.clone(), "ft_transfer_call", deposit, ONE_YOCTO)
        .await?
        .assert_success();
    let spend =
        json!({ "owner_id": env.owner, "receiver_id": env.merchant, "amount": millinear(100) });
    assert!(
        call(env.agent.clone(), "agent_spend", spend.clone(), NO_DEPOSIT)
            .await?
            .assert_success()
            .json::<bool>()?
    );
    let before = get_vault().await?;
    assert!(before.get("withdrawals_locked_until").is_none()); // v1 has no lock
    assert_eq!(
        before["tokens"][0]["balance"],
        json!(near(1).as_yoctonear().to_string())
    );

    // Replace the code only, as a redeploy of vault-v1 would.
    near_api::Contract::deploy(v1.clone())
        .use_code(contract_wasm())
        .without_init_call()
        .with_signer(env.signer.clone())
        .send_to(&env.network)
        .await?
        .assert_success();

    // The record reads back field for field, and the root state too.
    let mut after = get_vault().await?;
    assert_eq!(after["withdrawals_locked_until"], Value::Null);
    after
        .as_object_mut()
        .expect("vault is an object")
        .remove("withdrawals_locked_until");
    assert_eq!(after, before);
    let exchange: AccountId = env.view_on(&v1, "get_exchange_id", json!({})).await?;
    assert_eq!(exchange.as_str(), EXCHANGE);
    // The exchange ledger starts empty: v1 kept no record of it.
    let ledger: ExchangeLedger = env
        .view_on(&v1, "get_exchange_ledger", json!({ "token_id": wnear }))
        .await?;
    assert_eq!(ledger, ExchangeLedger::default());

    // Spend ids continue where v1 left off, and the policy still applies.
    let result = call(env.agent.clone(), "agent_spend", spend, NO_DEPOSIT).await?;
    assert_eq!(events(&result, "spend_initiated")[0]["spend_id"], "1");
    assert!(result.assert_success().json::<bool>()?);

    // The new lock works on the upgraded vault.
    let until = env.block_timestamp().await? + HOUR_NS;
    let args = json!({ "timestamp_ns": U64(until) });
    call(env.owner.clone(), "lock_withdrawals_until", args, ONE_YOCTO)
        .await?
        .assert_success();
    assert_eq!(
        get_vault().await?["withdrawals_locked_until"],
        json!(until.to_string())
    );
    let withdraw = json!({ "amount": near(1) });
    assert_fails_with(
        call(env.owner.clone(), "withdraw", withdraw, ONE_YOCTO).await?,
        &format!("Withdrawals are locked until {until}"),
    );
    let args = json!({ "agent_id": env.stranger, "policy": env.standard_policy() });
    assert_fails_with(
        call(env.owner.clone(), "set_agent", args, ONE_YOCTO).await?,
        "set_agent is disabled until then",
    );
    Ok(())
}
