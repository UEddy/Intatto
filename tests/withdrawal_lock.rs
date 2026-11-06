//! `lock_withdrawals_until` on a real node: it blocks `withdraw` and `withdraw_token` until the
//! lock's block timestamp, can only be extended, and leaves the agent's policy as it was.

// `LockEnv` holds a sandbox slot (a semaphore permit) for the whole test on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use common::*;
use intatto::{Policy, TokenPolicy};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

/// The vault from `TestEnv::with_vault`, plus a wNEAR token the owner holds 1 wNEAR of in the vault.
struct LockEnv {
    env: TestEnv,
    wnear: AccountId,
}

impl LockEnv {
    async fn new() -> TestResult<Self> {
        let env = TestEnv::with_vault().await?;
        let w_near = res_wasm("w_near.wasm", W_NEAR_SHA256);
        let wnear = env
            .deploy("wnear.sandbox", w_near, "new", json!({}))
            .await?;
        let s = Self { env, wnear };
        let vault = s.env.vault_id().clone();
        for account in [&vault, &s.env.owner] {
            let args = json!({ "account_id": account, "registration_only": true });
            s.token_call("storage_deposit", args, TOKEN_STORAGE).await?;
        }
        let policy = Policy {
            tokens: vec![TokenPolicy {
                token_id: s.wnear.clone(),
                per_tx_cap: U128(0),
                daily_cap: U128(0),
            }],
            ..s.env.standard_policy()
        };
        s.env
            .set_agent(&s.env.owner, &s.env.agent, &policy)
            .await?
            .assert_success();
        s.token_call("near_deposit", json!({}), near(1)).await?;
        let args = json!({ "receiver_id": vault, "amount": units(near(1)).to_string(), "msg": "" });
        s.token_call("ft_transfer_call", args, ONE_YOCTO).await?;
        assert_eq!(s.wnear_in_vault().await?, units(near(1)));
        Ok(s)
    }

    /// A call on the wNEAR contract, signed by the owner, that must succeed.
    async fn token_call(&self, method: &str, args: Value, deposit: NearToken) -> TestResult {
        let gas = NearGas::from_tgas(100);
        self.env
            .call_on(&self.wnear, &self.env.owner, method, args, deposit, gas)
            .await?
            .assert_success();
        Ok(())
    }

    async fn lock(&self, until: u64) -> TestResult<TransactionResult> {
        let args = json!({ "timestamp_ns": U64(until) });
        self.env
            .call(&self.env.owner, "lock_withdrawals_until", args, ONE_YOCTO)
            .await
    }

    async fn locked_until(&self) -> TestResult<Value> {
        Ok(self.env.vault_json(&self.env.owner).await?["withdrawals_locked_until"].clone())
    }

    async fn withdraw(&self, amount: NearToken) -> TestResult<TransactionResult> {
        let args = json!({ "amount": amount });
        self.env
            .call(&self.env.owner, "withdraw", args, ONE_YOCTO)
            .await
    }

    async fn withdraw_token(&self, amount: u128) -> TestResult<TransactionResult> {
        let args = json!({ "token_id": self.wnear, "amount": amount.to_string() });
        self.env
            .call(&self.env.owner, "withdraw_token", args, ONE_YOCTO)
            .await
    }

    async fn wnear_in_vault(&self) -> TestResult<u128> {
        let vault = self.env.vault(&self.env.owner).await?;
        Ok(vault
            .tokens
            .iter()
            .find(|token| token.token_id == self.wnear)
            .map_or(0, |token| token.balance.0))
    }

    async fn owner_wnear(&self) -> TestResult<u128> {
        let args = json!({ "account_id": self.env.owner });
        let balance: U128 = self.env.view_on(&self.wnear, "ft_balance_of", args).await?;
        Ok(balance.0)
    }
}

const fn units(amount: NearToken) -> u128 {
    amount.as_yoctonear()
}

#[tokio::test]
async fn withdrawals_are_blocked_until_the_lock_ends() -> TestResult {
    let s = LockEnv::new().await?;
    assert_eq!(s.locked_until().await?, Value::Null);
    let until = s.env.block_timestamp().await? + 30 * SECOND_NS;

    let result = s.lock(until).await?;
    let locked = events(&result, "withdrawals_locked");
    assert_eq!(locked.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(locked[0]["owner_id"], json!(s.env.owner));
    assert_eq!(locked[0]["locked_until"], json!(until.to_string()));
    result.assert_success();
    assert_eq!(s.locked_until().await?, json!(until.to_string()));

    // Both kinds of withdrawal are blocked, and nothing moves.
    let balance = s.env.vault(&s.env.owner).await?.balance;
    let message = format!("Withdrawals are locked until {until}");
    assert_fails_with(s.withdraw(near(1)).await?, &message);
    assert_fails_with(s.withdraw_token(1).await?, &message);
    assert_eq!(s.env.vault(&s.env.owner).await?.balance, balance);
    assert_eq!(s.wnear_in_vault().await?, units(near(1)));

    // The lock doesn't touch the agent's policy: it still spends within it.
    s.env.spend_ok(millinear(100)).await?;
    let balance = s.env.vault(&s.env.owner).await?.balance;

    // Once block time reaches the lock, both work again.
    s.env.advance_past(until).await?;
    assert!(s.withdraw(near(1)).await?.assert_success().json::<bool>()?);
    assert!(
        s.withdraw_token(units(near(1)))
            .await?
            .assert_success()
            .json::<bool>()?
    );
    assert_eq!(
        s.env.vault(&s.env.owner).await?.balance,
        balance.saturating_sub(near(1))
    );
    assert_eq!(s.wnear_in_vault().await?, 0);
    assert_eq!(s.owner_wnear().await?, units(near(1)));
    Ok(())
}

#[tokio::test]
async fn lock_can_be_extended_but_not_shortened() -> TestResult {
    let s = LockEnv::new().await?;
    let now = s.env.block_timestamp().await?;
    let first = now + 20 * SECOND_NS;
    let extended = now + HOUR_NS;

    s.lock(first).await?.assert_success();
    s.lock(extended).await?.assert_success();
    assert_eq!(s.locked_until().await?, json!(extended.to_string()));

    let result = s.lock(first).await?;
    assert!(events(&result, "withdrawals_locked").is_empty());
    assert_fails_with(
        result,
        &format!("Withdrawals are already locked until {extended}; a lock can only be extended"),
    );
    assert_eq!(s.locked_until().await?, json!(extended.to_string()));

    // Past the first lock, the extended one still holds.
    s.env.advance_past(first).await?;
    assert_fails_with(
        s.withdraw(near(1)).await?,
        &format!("Withdrawals are locked until {extended}"),
    );
    assert_fails_with(
        s.withdraw_token(1).await?,
        &format!("Withdrawals are locked until {extended}"),
    );
    Ok(())
}

#[tokio::test]
async fn set_agent_is_blocked_while_locked_but_the_brakes_are_not() -> TestResult {
    let s = LockEnv::new().await?;
    let owner = s.env.owner.clone();
    let until = s.env.block_timestamp().await? + 30 * SECOND_NS;
    s.lock(until).await?.assert_success();

    // A new agent or policy could route the funds out, so set_agent is refused, on record.
    let thief_policy = Policy {
        per_tx_cap: near(1),
        daily_cap: near(10),
        allowlist: vec![s.env.stranger.clone()],
        ..s.env.standard_policy()
    };
    let result = s
        .env
        .set_agent(&owner, &s.env.stranger, &thief_policy)
        .await?;
    let rejected = events(&result, "set_agent_rejected");
    assert_eq!(rejected.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(rejected[0]["owner_id"], json!(owner));
    assert_eq!(rejected[0]["agent_id"], json!(s.env.stranger));
    assert_eq!(rejected[0]["locked_until"], json!(until.to_string()));
    assert_fails_with(
        result,
        &format!(
            "Withdrawals are locked until {until} (block timestamp, ns); set_agent is disabled until then"
        ),
    );
    let vault = s.env.vault(&owner).await?;
    assert_eq!(vault.agent_id.as_ref(), Some(&s.env.agent));

    // Freeze, unfreeze and remove_agent still work.
    for (method, deposit) in [("freeze", NO_DEPOSIT), ("unfreeze", ONE_YOCTO)] {
        s.env
            .call(&owner, method, json!({}), deposit)
            .await?
            .assert_success();
    }
    s.env
        .call(&owner, "remove_agent", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    let vault = s.env.vault(&owner).await?;
    assert_eq!(vault.agent_id, None);
    assert!(!vault.frozen);

    // Once the lock ends, set_agent works again.
    s.env.advance_past(until).await?;
    s.env
        .set_agent(&owner, &s.env.agent, &s.env.standard_policy())
        .await?
        .assert_success();
    let vault = s.env.vault(&owner).await?;
    assert_eq!(vault.agent_id.as_ref(), Some(&s.env.agent));
    Ok(())
}
