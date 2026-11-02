//! Sandbox harness shared by the integration tests. Each test binary uses part of it.
#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use intatto::{Policy, Spend, Vault};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, CryptoHash, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, Value, json};
use testresult::TestResult;
use tokio::sync::{Semaphore, SemaphorePermit};

pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const SECOND_NS: u64 = 1_000_000_000;
pub const HOUR_NS: u64 = 60 * 60 * SECOND_NS;
/// The exchange every vault in these tests is initialized with. Only the swap tests deploy it.
pub const EXCHANGE: &str = "exchange.sandbox";

/// Each test boots its own sandbox node (~0.5 GB); cap how many run at once.
static SANDBOX_SLOTS: Semaphore = Semaphore::const_new(4);
static CONTRACT_WASM: OnceLock<Vec<u8>> = OnceLock::new();

/// Built once and shared by every test in this binary.
pub fn contract_wasm() -> Vec<u8> {
    CONTRACT_WASM
        .get_or_init(|| {
            let path = cargo_near_build::build_with_cli(Default::default())
                .expect("contract should build");
            std::fs::read(path).expect("built wasm should be readable")
        })
        .clone()
}

/// A contract binary from tests/res, checked against its documented SHA-256.
pub fn res_wasm(file: &str, sha256_base58: &str) -> Vec<u8> {
    let path = format!("{}/tests/res/{file}", env!("CARGO_MANIFEST_DIR"));
    let wasm = std::fs::read(&path).unwrap_or_else(|err| panic!("reading {path}: {err}"));
    assert_eq!(
        CryptoHash::hash(&wasm).to_string(),
        sha256_base58,
        "{file} is not the documented binary"
    );
    wasm
}

pub const fn near(amount: u128) -> NearToken {
    NearToken::from_near(amount)
}

pub const fn millinear(amount: u128) -> NearToken {
    NearToken::from_millinear(amount)
}

/// What one NEAR spend's entry in `Vault::recent_spends` costs in storage, which the vault pays.
pub fn spend_record_cost() -> NearToken {
    let spend = Spend {
        spend_id: U64(0),
        timestamp: U64(0),
        token_id: None,
        amount: U128(0),
    };
    let bytes = near_sdk::borsh::to_vec(&spend)
        .expect("spend serializes")
        .len() as u128;
    near_sdk::env::storage_byte_cost().saturating_mul(bytes)
}

/// The amounts of a vault's recent spends, in yoctoNEAR or token units.
pub fn amounts(vault: &Vault) -> Vec<NearToken> {
    vault
        .recent_spends
        .iter()
        .map(|spend| NearToken::from_yoctonear(spend.amount.0))
        .collect()
}

/// A fresh sandbox with the vault deployed and four funded accounts.
pub struct TestEnv {
    pub sandbox: near_sandbox::Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
    pub contract: near_api::Contract,
    pub owner: AccountId,
    pub agent: AccountId,
    pub merchant: AccountId,
    pub stranger: AccountId,
    // Declared last so the slot is released only after the sandbox above is dropped.
    _slot: SemaphorePermit<'static>,
}

impl TestEnv {
    pub async fn new() -> TestResult<Self> {
        let wasm = contract_wasm();
        let slot = SANDBOX_SLOTS.acquire().await?;
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;

        let contract_id = create_account(&sandbox, "vault.sandbox", near(100)).await?;
        near_api::Contract::deploy(contract_id.clone())
            .use_code(wasm)
            .with_init_call("new", json!({ "exchange_id": EXCHANGE }))?
            .with_signer(signer.clone())
            .send_to(&network)
            .await?
            .assert_success();

        Ok(Self {
            owner: create_account(&sandbox, "owner.sandbox", near(100)).await?,
            agent: create_account(&sandbox, "agent.sandbox", near(100)).await?,
            merchant: create_account(&sandbox, "merchant.sandbox", near(100)).await?,
            stranger: create_account(&sandbox, "stranger.sandbox", near(100)).await?,
            contract: near_api::Contract(contract_id),
            sandbox,
            network,
            signer,
            _slot: slot,
        })
    }

    /// `new()` plus a 10 NEAR vault for `owner` with `agent` registered under `standard_policy`.
    pub async fn with_vault() -> TestResult<Self> {
        let env = Self::new().await?;
        env.deposit(&env.owner, near(10)).await?.assert_success();
        env.set_agent(&env.owner, &env.agent, &env.standard_policy())
            .await?
            .assert_success();
        Ok(env)
    }

    pub const fn vault_id(&self) -> &AccountId {
        self.contract.account_id()
    }

    /// 1 NEAR per transaction, 3 NEAR and 5 spends per 24 hours, merchant only.
    pub fn standard_policy(&self) -> Policy {
        Policy {
            per_tx_cap: near(1),
            daily_cap: near(3),
            max_spends_per_24h: 5,
            allowlist: vec![self.merchant.clone()],
            ..Default::default()
        }
    }

    /// Calls `method` on any contract, signed by `signer_id`.
    pub async fn call_on(
        &self,
        contract_id: &AccountId,
        signer_id: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        Ok(near_api::Contract(contract_id.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(gas)
            .with_signer(signer_id.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?)
    }

    /// Calls `method` on the vault, signed by `signer_id`.
    pub async fn call(
        &self,
        signer_id: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<TransactionResult> {
        let gas = NearGas::from_tgas(100);
        self.call_on(self.vault_id(), signer_id, method, args, deposit, gas)
            .await
    }

    pub async fn view_on<T: DeserializeOwned + Send + Sync>(
        &self,
        contract_id: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(near_api::Contract(contract_id.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    pub async fn deposit(
        &self,
        who: &AccountId,
        amount: NearToken,
    ) -> TestResult<TransactionResult> {
        self.call(who, "deposit", json!({}), amount).await
    }

    pub async fn set_agent(
        &self,
        who: &AccountId,
        agent: &AccountId,
        policy: &Policy,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "agent_id": agent, "policy": policy });
        self.call(who, "set_agent", args, ONE_YOCTO).await
    }

    pub async fn agent_spend(
        &self,
        caller: &AccountId,
        receiver: &AccountId,
        amount: NearToken,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "owner_id": self.owner, "receiver_id": receiver, "amount": amount });
        self.call(caller, "agent_spend", args, NO_DEPOSIT).await
    }

    /// An `agent_spend` from the registered agent to the merchant that must go through.
    pub async fn spend_ok(&self, amount: NearToken) -> TestResult {
        let result = self
            .agent_spend(&self.agent, &self.merchant, amount)
            .await?;
        assert!(result.assert_success().json::<bool>()?);
        Ok(())
    }

    pub async fn vault(&self, owner: &AccountId) -> TestResult<Vault> {
        let vault: Option<Vault> = self
            .view_on(self.vault_id(), "get_vault", json!({ "owner_id": owner }))
            .await?;
        Ok(vault.expect("vault should exist"))
    }

    pub async fn policy(&self, owner: &AccountId) -> TestResult<Option<Policy>> {
        self.view_on(self.vault_id(), "get_policy", json!({ "owner_id": owner }))
            .await
    }

    pub async fn near_balance(&self, account: &AccountId) -> TestResult<NearToken> {
        Ok(near_api::Account(account.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.network)
            .await?
            .total)
    }

    pub async fn block_timestamp(&self) -> TestResult<u64> {
        Ok(near_api::Chain::block()
            .fetch_from(&self.network)
            .await?
            .header
            .timestamp)
    }

    /// Fast-forwards the sandbox until block time is past `timestamp_ns`. Each sandbox block adds
    /// ~0.3s of block time, so this is only practical for minutes, not hours.
    pub async fn advance_past(&self, timestamp_ns: u64) -> TestResult<()> {
        while self.block_timestamp().await? <= timestamp_ns {
            self.sandbox.fast_forward(200).await?;
        }
        Ok(())
    }

    /// Overwrites `owner`'s stored vault record, e.g. to age its spends. Mirrors the contract's
    /// storage layout: `LookupMap` prefix `b"v"` + Borsh owner id as key, Borsh vault as value.
    pub async fn patch_vault(&self, owner: &AccountId, vault: &Vault) -> TestResult<()> {
        let mut key = b"v".to_vec();
        key.extend(near_sdk::borsh::to_vec(owner)?);
        let value = near_sdk::borsh::to_vec(vault)?;
        self.sandbox
            .patch_state(self.vault_id().clone())
            .storage(BASE64.encode(key), BASE64.encode(value))
            .send()
            .await?;
        Ok(())
    }

    /// Creates an account funded from the sandbox genesis account.
    pub async fn create_account(&self, name: &str, balance: NearToken) -> TestResult<AccountId> {
        create_account(&self.sandbox, name, balance).await
    }

    /// Creates `name` and deploys `wasm` there with an init call.
    pub async fn deploy(
        &self,
        name: &str,
        wasm: Vec<u8>,
        init_method: &str,
        init_args: Value,
    ) -> TestResult<AccountId> {
        let account_id = self.create_account(name, near(50)).await?;
        near_api::Contract::deploy(account_id.clone())
            .use_code(wasm)
            .with_init_call(init_method, init_args)?
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await?
            .assert_success();
        Ok(account_id)
    }
}

pub async fn create_account(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
    balance: NearToken,
) -> TestResult<AccountId> {
    let account_id: AccountId = name.parse()?;
    sandbox
        .create_account(account_id.clone())
        .initial_balance(balance)
        .send()
        .await?;
    Ok(account_id)
}

/// The `data` of every `intatto` event called `name` in the transaction's logs, including logs
/// from receipts that failed.
pub fn events(result: &TransactionResult, name: &str) -> Vec<Value> {
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
pub fn assert_fails_with(result: TransactionResult, message: &str) {
    let failure = result.assert_failure().to_string();
    assert!(
        failure.contains(message),
        "expected failure containing {message:?}, got: {failure}"
    );
}

/// A rejected agent call fails with `message` and still leaves a rejection event in the logs.
#[track_caller]
pub fn assert_rejected(result: TransactionResult, event: &str, reason: &str, message: &str) {
    let rejections = events(&result, event);
    assert_eq!(rejections.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(rejections[0]["reason"], reason);
    assert_fails_with(result, message);
}

#[track_caller]
pub fn assert_spend_rejected(result: TransactionResult, reason: &str, message: &str) {
    assert_rejected(result, "spend_rejected", reason, message);
}
