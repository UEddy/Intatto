// `TestEnv` holds a sandbox slot (a semaphore permit) for the whole test on purpose.
#![allow(clippy::significant_drop_tightening)]

use std::sync::{Arc, OnceLock};

use intatto::{Policy, Spend, Vault, WINDOW_NS};
use near_api::types::transaction::result::TransactionResult;
use near_api::types::{AccessKeyPermission, transaction::actions::FunctionCallPermission};
use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value, json};
use testresult::TestResult;
use tokio::sync::{Semaphore, SemaphorePermit};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SECOND_NS: u64 = 1_000_000_000;
const HOUR_NS: u64 = 60 * 60 * SECOND_NS;

/// Each test boots its own sandbox node (~0.5 GB); cap how many run at once.
static SANDBOX_SLOTS: Semaphore = Semaphore::const_new(4);
static CONTRACT_WASM: OnceLock<Vec<u8>> = OnceLock::new();

/// Built once and shared by every test in this binary.
fn contract_wasm() -> Vec<u8> {
    CONTRACT_WASM
        .get_or_init(|| {
            let path = cargo_near_build::build_with_cli(Default::default())
                .expect("contract should build");
            std::fs::read(path).expect("built wasm should be readable")
        })
        .clone()
}

const fn near(amount: u128) -> NearToken {
    NearToken::from_near(amount)
}

const fn millinear(amount: u128) -> NearToken {
    NearToken::from_millinear(amount)
}

/// What one entry in `Vault::recent_spends` costs in storage, which the vault pays.
fn spend_record_cost() -> NearToken {
    let spend = Spend {
        spend_id: U64(0),
        timestamp: U64(0),
        amount: near(1),
    };
    let bytes = near_sdk::borsh::to_vec(&spend)
        .expect("spend serializes")
        .len() as u128;
    near_sdk::env::storage_byte_cost().saturating_mul(bytes)
}

fn amounts(vault: &Vault) -> Vec<NearToken> {
    vault
        .recent_spends
        .iter()
        .map(|spend| spend.amount)
        .collect()
}

/// A fresh sandbox with the vault deployed (no init call needed) and four funded accounts.
struct TestEnv {
    sandbox: near_sandbox::Sandbox,
    network: NetworkConfig,
    signer: Arc<Signer>,
    contract: near_api::Contract,
    owner: AccountId,
    agent: AccountId,
    merchant: AccountId,
    stranger: AccountId,
    // Declared last so the slot is released only after the sandbox above is dropped.
    _slot: SemaphorePermit<'static>,
}

impl TestEnv {
    async fn new() -> TestResult<Self> {
        let wasm = contract_wasm();
        let slot = SANDBOX_SLOTS.acquire().await?;
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;

        let contract_id = create_account(&sandbox, "vault.sandbox").await?;
        near_api::Contract::deploy(contract_id.clone())
            .use_code(wasm)
            .without_init_call()
            .with_signer(signer.clone())
            .send_to(&network)
            .await?
            .assert_success();

        Ok(Self {
            owner: create_account(&sandbox, "owner.sandbox").await?,
            agent: create_account(&sandbox, "agent.sandbox").await?,
            merchant: create_account(&sandbox, "merchant.sandbox").await?,
            stranger: create_account(&sandbox, "stranger.sandbox").await?,
            contract: near_api::Contract(contract_id),
            sandbox,
            network,
            signer,
            _slot: slot,
        })
    }

    /// `new()` plus a 10 NEAR vault for `owner` with `agent` registered under `standard_policy`.
    async fn with_vault() -> TestResult<Self> {
        let env = Self::new().await?;
        env.deposit(&env.owner, near(10)).await?.assert_success();
        env.set_agent(&env.owner, &env.agent, &env.standard_policy())
            .await?
            .assert_success();
        Ok(env)
    }

    /// 1 NEAR per transaction, 3 NEAR and 5 spends per 24 hours, merchant only.
    fn standard_policy(&self) -> Policy {
        Policy {
            per_tx_cap: near(1),
            daily_cap: near(3),
            max_spends_per_24h: 5,
            allowlist: vec![self.merchant.clone()],
        }
    }

    async fn call(
        &self,
        signer_id: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<TransactionResult> {
        Ok(self
            .contract
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .with_signer(signer_id.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?)
    }

    async fn deposit(&self, who: &AccountId, amount: NearToken) -> TestResult<TransactionResult> {
        self.call(who, "deposit", json!({}), amount).await
    }

    async fn set_agent(
        &self,
        who: &AccountId,
        agent: &AccountId,
        policy: &Policy,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "agent_id": agent, "policy": policy });
        self.call(who, "set_agent", args, ONE_YOCTO).await
    }

    async fn agent_spend(
        &self,
        caller: &AccountId,
        receiver: &AccountId,
        amount: NearToken,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "owner_id": self.owner, "receiver_id": receiver, "amount": amount });
        self.call(caller, "agent_spend", args, NO_DEPOSIT).await
    }

    /// An `agent_spend` from the registered agent to the merchant that must go through.
    async fn spend_ok(&self, amount: NearToken) -> TestResult {
        let result = self
            .agent_spend(&self.agent, &self.merchant, amount)
            .await?;
        assert!(result.assert_success().json::<bool>()?);
        Ok(())
    }

    async fn vault(&self, owner: &AccountId) -> TestResult<Vault> {
        let vault: Option<Vault> = self
            .contract
            .call_function("get_vault", json!({ "owner_id": owner }))
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data;
        Ok(vault.expect("vault should exist"))
    }

    async fn policy(&self, owner: &AccountId) -> TestResult<Option<Policy>> {
        Ok(self
            .contract
            .call_function("get_policy", json!({ "owner_id": owner }))
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    async fn near_balance(&self, account: &AccountId) -> TestResult<NearToken> {
        Ok(near_api::Account(account.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.network)
            .await?
            .total)
    }

    async fn block_timestamp(&self) -> TestResult<u64> {
        Ok(near_api::Chain::block()
            .fetch_from(&self.network)
            .await?
            .header
            .timestamp)
    }

    /// Fast-forwards the sandbox until block time is past `timestamp_ns`. Each sandbox block adds
    /// ~0.3s of block time, so this is only practical for minutes, not hours.
    async fn advance_past(&self, timestamp_ns: u64) -> TestResult<()> {
        while self.block_timestamp().await? <= timestamp_ns {
            self.sandbox.fast_forward(200).await?;
        }
        Ok(())
    }

    /// Overwrites `owner`'s stored vault record, e.g. to age its spends. Mirrors the contract's
    /// storage layout: `LookupMap` prefix `b"v"` + Borsh owner id as key, Borsh vault as value.
    async fn patch_vault(&self, owner: &AccountId, vault: &Vault) -> TestResult<()> {
        let mut key = b"v".to_vec();
        key.extend(near_sdk::borsh::to_vec(owner)?);
        let value = near_sdk::borsh::to_vec(vault)?;
        self.sandbox
            .patch_state(self.contract.account_id().clone())
            .storage(BASE64.encode(key), BASE64.encode(value))
            .send()
            .await?;
        Ok(())
    }
}

async fn create_account(sandbox: &near_sandbox::Sandbox, name: &str) -> TestResult<AccountId> {
    let account_id: AccountId = name.parse()?;
    sandbox
        .create_account(account_id.clone())
        .initial_balance(near(100))
        .send()
        .await?;
    Ok(account_id)
}

/// The `data` of every `intatto` event called `name` in the transaction's logs, including logs
/// from receipts that failed.
fn events(result: &TransactionResult, name: &str) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|event| serde_json::from_str::<Value>(event).expect("event should be valid JSON"))
        .filter(|event| event["standard"] == "intatto" && event["event"] == name)
        .map(|event| event["data"].clone())
        .collect()
}

#[track_caller]
fn assert_fails_with(result: TransactionResult, message: &str) {
    let failure = result.assert_failure().to_string();
    assert!(
        failure.contains(message),
        "expected failure containing {message:?}, got: {failure}"
    );
}

/// A rejected spend fails with `message` and still leaves a `spend_rejected` event in the logs.
#[track_caller]
fn assert_spend_rejected(result: TransactionResult, reason: &str, message: &str) {
    let rejections = events(&result, "spend_rejected");
    assert_eq!(rejections.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(rejections[0]["reason"], reason);
    assert_fails_with(result, message);
}

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
    };
    assert_fails_with(
        env.set_agent(&env.agent, &env.agent, &loose_policy).await?,
        no_vault,
    );
    for (method, args) in [
        ("unfreeze", json!({})),
        ("remove_agent", json!({})),
        ("withdraw", json!({ "amount": near(1) })),
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
        receiver_id: env.contract.account_id().to_string(),
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
