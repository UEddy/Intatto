// `TestEnv` holds a sandbox slot (a semaphore permit) for the whole test on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::*;
use intatto::{Policy, WINDOW_NS};
use near_api::types::{AccessKeyPermission, transaction::actions::FunctionCallPermission};
use near_api::{AccountId, NearToken, Signer};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

#[tokio::test]
async fn happy_path_deposit_set_agent_and_spend_within_caps() -> TestResult {
    let env = TestEnv::new().await?;

    let result = env.deposit(&env.owner, near(10)).await?;
    let deposit_event = events(&result, "deposit");
    result.assert_success();
    let vault = env.vault(&env.owner).await?;
    // The first deposit keeps back the (small) storage cost of the vault record.
    assert!(vault.balance < near(10) && vault.balance > millinear(9_990));
    assert_eq!(deposit_event[0]["amount"], json!(vault.balance));
    assert!(!vault.frozen);
    assert_eq!(vault.agent_id, None);

    let policy = env.standard_policy();
    env.set_agent(&env.owner, &env.agent, &policy)
        .await?
        .assert_success();
    assert_eq!(env.policy(&env.owner).await?, Some(policy));
    let vault = env.vault(&env.owner).await?;
    assert_eq!(vault.agent_id.as_ref(), Some(&env.agent));
    let balance_before = vault.balance;
    let merchant_before = env.near_balance(&env.merchant).await?;

    // Exactly the per-transaction cap is allowed.
    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    let initiated = events(&result, "spend_initiated");
    let completed = events(&result, "spend_completed");
    assert_eq!(initiated.len(), 1);
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0]["spend_id"], initiated[0]["spend_id"]);
    assert!(result.assert_success().json::<bool>()?);

    env.spend_ok(millinear(500)).await?;

    let vault = env.vault(&env.owner).await?;
    assert_eq!(amounts(&vault), [near(1), millinear(500)]);
    // Each recorded spend also pays for its own entry's storage.
    let expected = balance_before
        .saturating_sub(millinear(1_500))
        .saturating_sub(spend_record_cost().saturating_mul(2));
    assert_eq!(vault.balance, expected);
    assert_eq!(
        env.near_balance(&env.merchant).await?,
        merchant_before.saturating_add(millinear(1_500))
    );
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_non_agent_caller() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let before = env.vault(&env.owner).await?;

    let result = env
        .agent_spend(&env.stranger, &env.merchant, near(1))
        .await?;
    assert_spend_rejected(
        result,
        "not_agent",
        "stranger.sandbox is not the registered agent for owner.sandbox's vault",
    );
    // The owner isn't the agent either.
    let result = env.agent_spend(&env.owner, &env.merchant, near(1)).await?;
    assert_spend_rejected(result, "not_agent", "is not the registered agent");

    let after = env.vault(&env.owner).await?;
    assert_eq!(after.balance, before.balance);
    assert!(after.recent_spends.is_empty());
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_when_frozen() -> TestResult {
    let env = TestEnv::with_vault().await?;

    env.call(&env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    assert!(env.vault(&env.owner).await?.frozen);

    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    assert_spend_rejected(
        result,
        "frozen",
        "Vault is frozen; agent spending is disabled",
    );
    assert!(env.vault(&env.owner).await?.recent_spends.is_empty());

    // The same spend goes through once the owner unfreezes.
    env.call(&env.owner, "unfreeze", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    env.spend_ok(near(1)).await?;
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_non_allowlisted_receiver() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let before = env.vault(&env.owner).await?;

    let result = env.agent_spend(&env.agent, &env.stranger, near(1)).await?;
    assert_spend_rejected(
        result,
        "receiver_not_allowlisted",
        "Receiver stranger.sandbox is not on the vault's allowlist",
    );
    assert_eq!(env.vault(&env.owner).await?.balance, before.balance);
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_over_per_tx_cap() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let over_cap = near(1).saturating_add(ONE_YOCTO);

    let result = env.agent_spend(&env.agent, &env.merchant, over_cap).await?;
    assert_spend_rejected(
        result,
        "over_per_tx_cap",
        "exceeds the per-transaction cap of 1 NEAR",
    );
    assert!(env.vault(&env.owner).await?.recent_spends.is_empty());
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_over_daily_cap() -> TestResult {
    let env = TestEnv::with_vault().await?;
    for _ in 0..3 {
        env.spend_ok(near(1)).await?;
    }

    // 3 NEAR spent against a 3 NEAR cap: even 1 yoctoNEAR more is refused.
    let result = env
        .agent_spend(&env.agent, &env.merchant, ONE_YOCTO)
        .await?;
    assert_spend_rejected(
        result,
        "over_daily_cap",
        "would exceed the 24-hour cap of 3 NEAR (3 NEAR already spent in the last 24 hours)",
    );
    assert_eq!(env.vault(&env.owner).await?.recent_spends.len(), 3);
    Ok(())
}

#[tokio::test]
async fn agent_spend_rejects_over_max_spends_per_24h() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let policy = Policy {
        max_spends_per_24h: 2,
        ..env.standard_policy()
    };
    env.set_agent(&env.owner, &env.agent, &policy)
        .await?
        .assert_success();
    env.spend_ok(millinear(100)).await?;
    env.spend_ok(millinear(100)).await?;

    // Well under the 3 NEAR cap, but the third spend in 24 hours is over the count limit.
    let result = env
        .agent_spend(&env.agent, &env.merchant, millinear(100))
        .await?;
    assert_spend_rejected(
        result,
        "too_many_spends",
        "The agent has made 2 spends in the last 24 hours; the policy allows 2",
    );
    assert_eq!(env.vault(&env.owner).await?.recent_spends.len(), 2);
    Ok(())
}

#[tokio::test]
async fn burst_23h_after_spending_the_cap_is_rejected() -> TestResult {
    let env = TestEnv::with_vault().await?;
    for _ in 0..3 {
        env.spend_ok(near(1)).await?;
    }

    // Advancing 23 hours of sandbox blocks would take ~35 min, so age the recorded spends by
    // 23 hours instead: to the contract that is the same as block time moving forward.
    let mut vault = env.vault(&env.owner).await?;
    for spend in &mut vault.recent_spends {
        spend.timestamp.0 -= 23 * HOUR_NS;
    }
    env.patch_vault(&env.owner, &vault).await?;

    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    assert_spend_rejected(
        result,
        "over_daily_cap",
        "would exceed the 24-hour cap of 3 NEAR (3 NEAR already spent in the last 24 hours)",
    );
    assert_eq!(
        env.vault(&env.owner).await?.recent_spends,
        vault.recent_spends
    );
    Ok(())
}

#[tokio::test]
async fn spends_older_than_24h_are_pruned_and_free_the_cap() -> TestResult {
    let env = TestEnv::with_vault().await?;
    for _ in 0..3 {
        env.spend_ok(near(1)).await?;
    }

    // Fast-forwarding a real 24 hours takes ~288k sandbox blocks (~40 min), so age the first two
    // spends to 2 minutes short of 24 hours, then let real block time carry them past it.
    let mut vault = env.vault(&env.owner).await?;
    let aged_to = env.block_timestamp().await? - WINDOW_NS + 120 * SECOND_NS;
    vault.recent_spends[0].timestamp = U64(aged_to);
    vault.recent_spends[1].timestamp = U64(aged_to);
    env.patch_vault(&env.owner, &vault).await?;
    let still_counted = "(3 NEAR already spent in the last 24 hours)";
    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    assert_spend_rejected(result, "over_daily_cap", still_counted);

    env.advance_past(aged_to + WINDOW_NS).await?;
    let balance_before = env.vault(&env.owner).await?.balance;
    // The two aged-out spends free 2 NEAR; the third is recent and still counts.
    env.spend_ok(near(1)).await?;
    env.spend_ok(near(1)).await?;
    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    assert_spend_rejected(result, "over_daily_cap", still_counted);

    let after = env.vault(&env.owner).await?;
    assert_eq!(after.recent_spends.len(), 3);
    assert_eq!(after.recent_spends[0], vault.recent_spends[2]);
    // Pruning credited back two entries' storage and the two new spends paid for two.
    assert_eq!(after.balance, balance_before.saturating_sub(near(2)));
    Ok(())
}

#[tokio::test]
async fn owner_can_withdraw_while_frozen() -> TestResult {
    let env = TestEnv::with_vault().await?;
    env.call(&env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    let vault_before = env.vault(&env.owner).await?;
    let owner_before = env.near_balance(&env.owner).await?;

    let result = env
        .call(
            &env.owner,
            "withdraw",
            json!({ "amount": near(2) }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(events(&result, "withdraw").len(), 1);
    assert!(result.assert_success().json::<bool>()?);

    let vault_after = env.vault(&env.owner).await?;
    assert!(vault_after.frozen);
    assert_eq!(
        vault_after.balance,
        vault_before.balance.saturating_sub(near(2))
    );
    // The owner paid a little gas, so allow for that.
    let owner_after = env.near_balance(&env.owner).await?;
    assert!(owner_after > owner_before.saturating_add(millinear(1_990)));

    let too_much = vault_after.balance.saturating_add(ONE_YOCTO);
    let result = env
        .call(
            &env.owner,
            "withdraw",
            json!({ "amount": too_much }),
            ONE_YOCTO,
        )
        .await?;
    assert_fails_with(result, "exceeds the vault balance");
    Ok(())
}

#[tokio::test]
async fn agent_cannot_call_owner_methods() -> TestResult {
    let env = TestEnv::with_vault().await?;
    env.call(&env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    let before = env.vault(&env.owner).await?;

    // Owner-only methods act on the caller's own vault, and the agent has none.
    let no_vault = "No vault found for agent.sandbox; call deposit first";
    let loose_policy = Policy {
        per_tx_cap: near(100),
        daily_cap: near(100),
        max_spends_per_24h: 100,
        allowlist: vec![env.agent.clone()],
        ..Default::default()
    };
    assert_fails_with(
        env.set_agent(&env.agent, &env.agent, &loose_policy).await?,
        no_vault,
    );
    for (method, args) in [
        ("unfreeze", json!({})),
        ("remove_agent", json!({})),
        ("withdraw", json!({ "amount": near(1) })),
        (
            "withdraw_token",
            json!({ "token_id": "wnear.sandbox", "amount": "1" }),
        ),
        (
            "reclaim_from_exchange",
            json!({ "token_id": "wnear.sandbox" }),
        ),
    ] {
        assert_fails_with(
            env.call(&env.agent, method, args, ONE_YOCTO).await?,
            no_vault,
        );
    }
    assert_fails_with(
        env.call(&env.agent, "freeze", json!({}), NO_DEPOSIT)
            .await?,
        no_vault,
    );

    // Even with a vault of its own, the agent only ever changes that vault.
    env.deposit(&env.agent, near(1)).await?.assert_success();
    env.set_agent(&env.agent, &env.agent, &loose_policy)
        .await?
        .assert_success();
    env.call(&env.agent, "unfreeze", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    env.call(&env.agent, "remove_agent", json!({}), ONE_YOCTO)
        .await?
        .assert_success();

    let after = env.vault(&env.owner).await?;
    assert!(after.frozen);
    assert_eq!(after.agent_id, before.agent_id);
    assert_eq!(after.policy, before.policy);
    assert_eq!(after.balance, before.balance);
    assert_spend_rejected(
        env.agent_spend(&env.agent, &env.agent, near(1)).await?,
        "frozen",
        "Vault is frozen",
    );
    Ok(())
}

/// The agent might instead hold a function-call access key on the owner's own account. Those
/// keys cannot attach deposits, so the 1-yoctoNEAR owner methods stay out of reach while
/// `freeze` keeps working.
#[tokio::test]
async fn function_call_key_on_owner_account_can_only_freeze() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let fc_key = near_api::signer::generate_secret_key()?;
    let permission = AccessKeyPermission::FunctionCall(FunctionCallPermission {
        allowance: None,
        receiver_id: env.vault_id().to_string(),
        method_names: vec![],
    });
    near_api::Account(env.owner.clone())
        .add_key(permission, fc_key.public_key())
        .with_signer(env.signer.clone())
        .send_to(&env.network)
        .await?
        .assert_success();
    let fc_signer = Signer::from_secret_key(fc_key)?;
    let call_with_fc_key = async |method: &str, args: Value, deposit: NearToken| {
        env.contract
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .with_signer(env.owner.clone(), fc_signer.clone())
            .send_to(&env.network)
            .await
    };

    call_with_fc_key("freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    assert!(env.vault(&env.owner).await?.frozen);

    let one_yocto_message = "Requires attached deposit of exactly 1 yoctoNEAR";
    let policy_args = json!({ "agent_id": env.agent, "policy": env.standard_policy() });
    for (method, args) in [
        ("unfreeze", json!({})),
        ("withdraw", json!({ "amount": near(1) })),
        ("set_agent", policy_args),
        ("remove_agent", json!({})),
        (
            "withdraw_token",
            json!({ "token_id": "wnear.sandbox", "amount": "1" }),
        ),
        (
            "reclaim_from_exchange",
            json!({ "token_id": "wnear.sandbox" }),
        ),
    ] {
        // Without the deposit the contract refuses...
        let result = call_with_fc_key(method, args.clone(), NO_DEPOSIT).await?;
        assert_fails_with(result, one_yocto_message);
        // ...and with it the protocol refuses: function-call keys cannot attach deposits.
        let rejected = call_with_fc_key(method, args, ONE_YOCTO)
            .await
            .map_or(true, |result| result.is_failure());
        assert!(
            rejected,
            "{method} with a deposit should not be signable by a function-call key"
        );
    }
    let after = env.vault(&env.owner).await?;
    assert!(after.frozen);
    assert_eq!(after.agent_id.as_ref(), Some(&env.agent));
    Ok(())
}

#[tokio::test]
async fn failed_transfer_refund_removes_only_its_own_entry() -> TestResult {
    let env = TestEnv::with_vault().await?;
    // Named accounts that don't exist can't receive transfers.
    let ghost: AccountId = "ghost.sandbox".parse()?;
    let mut policy = env.standard_policy();
    policy.allowlist.push(ghost.clone());
    env.set_agent(&env.owner, &env.agent, &policy)
        .await?
        .assert_success();
    let before = env.vault(&env.owner).await?;

    env.spend_ok(near(1)).await?;

    let result = env.agent_spend(&env.agent, &ghost, millinear(700)).await?;
    let failed_id = events(&result, "spend_initiated")[0]["spend_id"].clone();
    let refunded = events(&result, "spend_refunded");
    assert_eq!(refunded.len(), 1);
    assert_eq!(refunded[0]["spend_id"], failed_id);
    assert!(events(&result, "spend_completed").is_empty());
    // The agent's transaction resolves to the callback's verdict.
    assert!(!result.assert_success().json::<bool>()?);

    env.spend_ok(millinear(500)).await?;

    // The entries made before and after the failed spend are untouched; only its own is gone.
    let after = env.vault(&env.owner).await?;
    assert_eq!(amounts(&after), [near(1), millinear(500)]);
    assert!(
        after
            .recent_spends
            .iter()
            .all(|spend| json!(spend.spend_id) != failed_id)
    );
    assert_eq!(
        after.recent_spends[1].spend_id.0,
        after.recent_spends[0].spend_id.0 + 2
    );
    // The failed 0.7 NEAR and its entry's storage came back; the two live spends paid for theirs.
    let expected = before
        .balance
        .saturating_sub(millinear(1_500))
        .saturating_sub(spend_record_cost().saturating_mul(2));
    assert_eq!(after.balance, expected);
    Ok(())
}

#[tokio::test]
async fn remove_agent_then_agent_spend_is_rejected() -> TestResult {
    let env = TestEnv::with_vault().await?;
    let before = env.vault(&env.owner).await?;

    let result = env
        .call(&env.owner, "remove_agent", json!({}), ONE_YOCTO)
        .await?;
    let removed = events(&result, "agent_removed");
    result.assert_success();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0]["agent_id"], json!(env.agent));

    let after = env.vault(&env.owner).await?;
    assert_eq!(after.agent_id, None);
    assert_eq!(after.policy, Policy::default());
    assert!(after.balance > before.balance); // the freed storage is credited back

    let result = env.agent_spend(&env.agent, &env.merchant, near(1)).await?;
    assert_spend_rejected(
        result,
        "not_agent",
        "agent.sandbox is not the registered agent for owner.sandbox's vault",
    );
    Ok(())
}

#[tokio::test]
async fn remove_agent_without_deposit_fails() -> TestResult {
    let env = TestEnv::with_vault().await?;

    let result = env
        .call(&env.owner, "remove_agent", json!({}), NO_DEPOSIT)
        .await?;
    assert_fails_with(result, "Requires attached deposit of exactly 1 yoctoNEAR");

    let vault = env.vault(&env.owner).await?;
    assert_eq!(vault.agent_id.as_ref(), Some(&env.agent));
    assert_eq!(vault.policy, env.standard_policy());
    env.spend_ok(near(1)).await?;
    Ok(())
}
