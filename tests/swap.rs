//! Agent swaps against the real Rhea (Ref) V1 exchange: the ref-exchange 1.9.19 binary deployed at
//! `ref-finance-101.testnet`, with the `wrap.testnet` binary as both wNEAR and a stand-in USDT.
//! See tests/res/README.md for where the binaries come from.

// `SwapEnv` holds a sandbox slot (a semaphore permit) for the whole test on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use std::collections::HashMap;

use common::*;
use intatto::{
    AGENT_SWAP_TGAS, ExchangeLedger, FEE_BPS, Policy, PoolPolicy, RECLAIM_TGAS, TokenPolicy,
    split_fee,
};
use near_api::types::transaction::actions::{Action, FunctionCallAction, TransferAction};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use testresult::TestResult;

/// ref-exchange 1.9.19, the code of `ref-finance-101.testnet` (tests/res/README.md).
const EXCHANGE_1_9_19_SHA256: &str = "AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX";
/// ref-exchange 1.9.21, the code of `v2.ref-finance.near` on mainnet (tests/res/README.md).
const EXCHANGE_1_9_21_SHA256: &str = "GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi";
/// Selects the exchange binary: `1.9.19` (testnet, the default) or `1.9.21` (mainnet).
const EXCHANGE_VERSION_ENV: &str = "INTATTO_TEST_EXCHANGE";

/// The exchange version these tests run against.
fn exchange_version() -> String {
    std::env::var(EXCHANGE_VERSION_ENV).unwrap_or_else(|_| "1.9.19".to_string())
}

fn exchange_wasm() -> Vec<u8> {
    match exchange_version().as_str() {
        "1.9.19" => res_wasm("ref_exchange_v1.9.19.wasm", EXCHANGE_1_9_19_SHA256),
        "1.9.21" => res_wasm("ref_exchange_v1.9.21.wasm", EXCHANGE_1_9_21_SHA256),
        other => panic!("{EXCHANGE_VERSION_ENV}={other}: expected 1.9.19 or 1.9.21"),
    }
}
const POOL_ID: u64 = 0;
/// Slippage the policy allows on the pool: 0.5%.
const MAX_SLIPPAGE_BPS: u16 = 50;

const fn tgas(amount: u64) -> NearGas {
    NearGas::from_tgas(amount)
}

/// Both tokens have 24 decimals, so whole-NEAR amounts double as token amounts.
const fn units(amount: NearToken) -> u128 {
    amount.as_yoctonear()
}

/// Which storage registrations the vault gets before a test runs.
struct Registered {
    on_exchange: bool,
    on_usdt: bool,
}

const FULLY_REGISTERED: Registered = Registered {
    on_exchange: true,
    on_usdt: true,
};

struct SwapEnv {
    env: TestEnv,
    exchange: AccountId,
    wnear: AccountId,
    usdt: AccountId,
}

impl SwapEnv {
    /// The vault from `TestEnv::with_vault` next to the real exchange with one simple pool of
    /// 100 wNEAR / 125 USDT. The owner's vault holds 5 wNEAR and the agent has `swap_policy`.
    async fn new(registered: Registered) -> TestResult<Self> {
        Self::on_code(contract_wasm(), registered).await
    }

    /// `new()`, with `wasm` as the vault contract.
    async fn on_code(wasm: Vec<u8>, registered: Registered) -> TestResult<Self> {
        let env = TestEnv::with_vault_on(wasm).await?;
        let dex_owner = env.create_account("dex-owner.sandbox", near(50)).await?;
        let exchange_args = json!({
            "owner_id": dex_owner,
            "boost_farm_id": "boostfarm.sandbox",
            "burrowland_id": "burrow.sandbox",
            "exchange_fee": 2000,
            "referral_fee": 0,
        });
        let exchange = env
            .deploy(EXCHANGE, exchange_wasm(), "new", exchange_args)
            .await?;
        let w_near = res_wasm("w_near.wasm", W_NEAR_SHA256);
        let wnear = env
            .deploy("wnear.sandbox", w_near.clone(), "new", json!({}))
            .await?;
        let usdt = env.deploy("usdt.sandbox", w_near, "new", json!({})).await?;
        let lp = env.create_account("lp.sandbox", near(1_000)).await?;
        let s = Self {
            env,
            exchange,
            wnear,
            usdt,
        };

        for token in [&s.wnear, &s.usdt] {
            for account in [&s.exchange, &lp, &s.env.owner] {
                s.register(token, account).await?;
            }
        }
        let tokens = json!({ "tokens": [s.wnear, s.usdt] });
        s.env
            .call_on(
                &s.exchange,
                &dex_owner,
                "extend_whitelisted_tokens",
                tokens,
                ONE_YOCTO,
                tgas(30),
            )
            .await?
            .assert_success();
        let pool_args = json!({ "tokens": [s.wnear, s.usdt], "fee": 30 });
        let pool_id: u64 = s
            .env
            .call_on(
                &s.exchange,
                &dex_owner,
                "add_simple_pool",
                pool_args,
                millinear(100),
                tgas(30),
            )
            .await?
            .assert_success()
            .json()?;
        assert_eq!(pool_id, POOL_ID);

        s.mint(&s.wnear, &lp, near(100)).await?;
        s.mint(&s.usdt, &lp, near(125)).await?;
        s.register_on_exchange(&lp, &lp).await?;
        s.transfer_call(&s.wnear, &lp, &s.exchange, units(near(100)))
            .await?;
        s.transfer_call(&s.usdt, &lp, &s.exchange, units(near(125)))
            .await?;
        let liquidity = json!({
            "pool_id": POOL_ID,
            "amounts": [units(near(100)).to_string(), units(near(125)).to_string()],
        });
        s.env
            .call_on(
                &s.exchange,
                &lp,
                "add_liquidity",
                liquidity,
                millinear(10),
                tgas(100),
            )
            .await?
            .assert_success();

        let vault = s.env.vault_id().clone();
        s.register(&s.wnear, &vault).await?;
        if registered.on_usdt {
            s.register(&s.usdt, &vault).await?;
        }
        if registered.on_exchange {
            s.register_on_exchange(&s.env.owner, &vault).await?;
        }

        s.env
            .set_agent(&s.env.owner, &s.env.agent, &s.swap_policy())
            .await?
            .assert_success();
        s.mint(&s.wnear, &s.env.owner, near(10)).await?;
        let used = s
            .transfer_call(&s.wnear, &s.env.owner, &vault, units(near(5)))
            .await?;
        assert_eq!(used, units(near(5)));
        assert_eq!(s.token(&s.wnear).await?, (units(near(5)), 0));
        Ok(s)
    }

    /// `standard_policy` plus: sell up to 2 wNEAR per swap and 3 per 24 hours, receive USDT, and
    /// trade through the wNEAR/USDT pool with up to 0.5% slippage.
    fn swap_policy(&self) -> Policy {
        Policy {
            tokens: vec![
                TokenPolicy {
                    token_id: self.wnear.clone(),
                    per_tx_cap: U128(units(near(2))),
                    daily_cap: U128(units(near(3))),
                },
                TokenPolicy {
                    token_id: self.usdt.clone(),
                    per_tx_cap: U128(units(near(10))),
                    daily_cap: U128(units(near(10))),
                },
            ],
            pools: vec![PoolPolicy {
                pool_id: POOL_ID,
                token_ids: [self.wnear.clone(), self.usdt.clone()],
                max_slippage_bps: MAX_SLIPPAGE_BPS,
            }],
            ..self.env.standard_policy()
        }
    }

    async fn register(&self, token: &AccountId, account: &AccountId) -> TestResult {
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

    /// Pays `account`'s exchange storage: the account itself plus room for several tokens.
    async fn register_on_exchange(&self, payer: &AccountId, account: &AccountId) -> TestResult {
        let args = json!({ "account_id": account, "registration_only": false });
        self.env
            .call_on(
                &self.exchange,
                payer,
                "storage_deposit",
                args,
                millinear(10),
                tgas(30),
            )
            .await?
            .assert_success();
        Ok(())
    }

    /// Mints `amount` of a w_near token to `account` by wrapping NEAR.
    async fn mint(&self, token: &AccountId, account: &AccountId, amount: NearToken) -> TestResult {
        self.env
            .call_on(token, account, "near_deposit", json!({}), amount, tgas(30))
            .await?
            .assert_success();
        Ok(())
    }

    /// `ft_transfer_call` with an empty msg; returns the amount the receiver kept.
    async fn transfer_call(
        &self,
        token: &AccountId,
        from: &AccountId,
        to: &AccountId,
        amount: u128,
    ) -> TestResult<u128> {
        let args = json!({ "receiver_id": to, "amount": amount.to_string(), "msg": "" });
        let used: U128 = self
            .env
            .call_on(token, from, "ft_transfer_call", args, ONE_YOCTO, tgas(100))
            .await?
            .assert_success()
            .json()?;
        Ok(used.0)
    }

    async fn ft_balance(&self, token: &AccountId, account: &AccountId) -> TestResult<u128> {
        let balance: U128 = self
            .env
            .view_on(token, "ft_balance_of", json!({ "account_id": account }))
            .await?;
        Ok(balance.0)
    }

    /// The exchange's own quote for a swap through the pool.
    async fn quote(&self, amount_in: u128) -> TestResult<u128> {
        let args = json!({
            "pool_id": POOL_ID,
            "token_in": self.wnear,
            "amount_in": amount_in.to_string(),
            "token_out": self.usdt,
        });
        let amount_out: U128 = self.env.view_on(&self.exchange, "get_return", args).await?;
        Ok(amount_out.0)
    }

    /// What the vault has deposited in its own exchange account, per token.
    async fn exchange_deposits(&self) -> TestResult<HashMap<String, U128>> {
        let args = json!({ "account_id": self.env.vault_id() });
        self.env.view_on(&self.exchange, "get_deposits", args).await
    }

    /// The owner's (balance, on_exchange) of a token in the vault.
    async fn token(&self, token_id: &AccountId) -> TestResult<(u128, u128)> {
        let vault = self.env.vault(&self.env.owner).await?;
        Ok(vault
            .tokens
            .iter()
            .find(|token| &token.token_id == token_id)
            .map_or((0, 0), |token| (token.balance.0, token.on_exchange.0)))
    }

    async fn agent_swap_as(
        &self,
        caller: &AccountId,
        pool_id: u64,
        token_out: &AccountId,
        amount_in: u128,
        min_amount_out: u128,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        let args = json!({
            "owner_id": self.env.owner,
            "pool_id": pool_id,
            "token_in": self.wnear,
            "token_out": token_out,
            "amount_in": amount_in.to_string(),
            "min_amount_out": min_amount_out.to_string(),
        });
        let vault = self.env.vault_id();
        self.env
            .call_on(vault, caller, "agent_swap", args, NO_DEPOSIT, gas)
            .await
    }

    /// The agent sells `amount_in` wNEAR for USDT through the pool, with full gas.
    async fn agent_swap(
        &self,
        amount_in: u128,
        min_amount_out: u128,
    ) -> TestResult<TransactionResult> {
        self.agent_swap_as(
            &self.env.agent,
            POOL_ID,
            &self.usdt,
            amount_in,
            min_amount_out,
            tgas(300),
        )
        .await
    }

    /// Nothing moved: the owner still has the 5 wNEAR from setup and no recorded swap, the vault
    /// still holds them, and its exchange account is empty.
    async fn assert_untouched(&self) -> TestResult {
        assert_eq!(self.token(&self.wnear).await?, (units(near(5)), 0));
        assert!(
            self.env
                .vault(&self.env.owner)
                .await?
                .recent_spends
                .is_empty()
        );
        assert_eq!(
            self.ft_balance(&self.wnear, self.env.vault_id()).await?,
            units(near(5))
        );
        self.assert_nothing_left_on_exchange().await
    }

    /// `owner`'s (balance, on_exchange) of a token in the vault.
    async fn token_of(&self, owner: &AccountId, token_id: &AccountId) -> TestResult<(u128, u128)> {
        let vault = self.env.vault(owner).await?;
        Ok(vault
            .tokens
            .iter()
            .find(|token| &token.token_id == token_id)
            .map_or((0, 0), |token| (token.balance.0, token.on_exchange.0)))
    }

    /// A second vault, for `owner`: 10 NEAR, `swap_policy` for the same agent, and 5 wNEAR.
    async fn add_owner(&self, owner: &AccountId) -> TestResult {
        self.env.deposit(owner, near(10)).await?.assert_success();
        self.env
            .set_agent(owner, &self.env.agent, &self.swap_policy())
            .await?
            .assert_success();
        self.register(&self.wnear, owner).await?;
        self.mint(&self.wnear, owner, near(5)).await?;
        let vault = self.env.vault_id().clone();
        let used = self
            .transfer_call(&self.wnear, owner, &vault, units(near(5)))
            .await?;
        assert_eq!(used, units(near(5)));
        Ok(())
    }

    /// The agent sells `amount_in` wNEAR of `owner`'s for USDT at exactly the quote.
    async fn swap_at_quote(&self, owner: &AccountId, amount_in: u128) -> TestResult<u128> {
        let quote = self.quote(amount_in).await?;
        let args = json!({
            "owner_id": owner,
            "pool_id": POOL_ID,
            "token_in": self.wnear,
            "token_out": self.usdt,
            "amount_in": amount_in.to_string(),
            "min_amount_out": quote.to_string(),
        });
        let vault = self.env.vault_id();
        let result = self
            .env
            .call_on(
                vault,
                &self.env.agent,
                "agent_swap",
                args,
                NO_DEPOSIT,
                tgas(300),
            )
            .await?;
        assert_eq!(
            events(&result, "swap_completed").len(),
            1,
            "logs: {:?}",
            result.logs()
        );
        assert!(result.assert_success().json::<bool>()?);
        Ok(quote)
    }

    async fn reclaim(&self, owner: &AccountId) -> TestResult<TransactionResult> {
        let args = json!({ "token_id": self.usdt });
        let vault = self.env.vault_id();
        self.env
            .call_on(
                vault,
                owner,
                "reclaim_from_exchange",
                args,
                ONE_YOCTO,
                tgas(RECLAIM_TGAS),
            )
            .await
    }

    async fn exchange_view(&self, method: &str, token: &AccountId) -> TestResult<u128> {
        let args = json!({ "account_id": self.env.vault_id(), "token_id": token });
        let amount: U128 = self.env.view_on(&self.exchange, method, args).await?;
        Ok(amount.0)
    }

    async fn usdt_ledger(&self) -> TestResult<ExchangeLedger> {
        let args = json!({ "token_id": self.usdt });
        self.env
            .view_on(self.env.vault_id(), "get_exchange_ledger", args)
            .await
    }

    /// Moves the vault's `amount` USDT on the exchange into the exchange's lostfound, signed with
    /// the vault account's own key (in the sandbox, every account has the genesis key).
    ///
    /// One transaction, two actions on the exchange, run in one receipt: `withdraw` with
    /// `unregister: true` takes the USDT and removes its slot from the vault's exchange account,
    /// then `storage_withdraw` takes back the storage that slot used. The vault is not registered
    /// with USDT, so the transfer fails, and the exchange's callback cannot put the tokens back:
    /// a new slot no longer fits the account's storage. ref-exchange 1.9.19 then credits them to
    /// the vault's lostfound (`exchange_callback_post_withdraw` ->
    /// `internal_handle_fail_in_withdraw_callback`).
    async fn force_into_lostfound(&self, amount: u128) -> TestResult {
        let call = |method: &str, args: near_sdk::serde_json::Value, gas: u64| {
            Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: method.to_string(),
                args: args.to_string().into_bytes(),
                gas: tgas(gas),
                deposit: ONE_YOCTO,
            }))
        };
        // The exchange puts tokens in the user's own lostfound only while it has more than
        // 100 NEAR (MIN_CONTRACT_FREE_BALANCE) free; otherwise they go to its owner's. Give it the
        // free balance it has on testnet (~219 NEAR at the time of writing).
        let whale = self.env.create_account("whale.sandbox", near(300)).await?;
        near_api::Transaction::construct(whale, self.exchange.clone())
            .add_action(Action::Transfer(TransferAction { deposit: near(200) }))
            .with_signer(self.env.signer.clone())
            .send_to(&self.env.network)
            .await?
            .assert_success();
        let withdraw = json!({
            "token_id": self.usdt,
            "amount": amount.to_string(),
            "unregister": true,
            "skip_unwrap_near": true,
        });
        let result =
            near_api::Transaction::construct(self.env.vault_id().clone(), self.exchange.clone())
                .add_action(call("withdraw", withdraw, 150))
                .add_action(call("storage_withdraw", json!({}), 30))
                .with_signer(self.env.signer.clone())
                .send_to(&self.env.network)
                .await?;
        assert!(
            result
                .logs()
                .iter()
                .any(|log| log.contains("Depositing to user lostfound account")),
            "logs: {:?}",
            result.logs()
        );
        result.assert_success();
        assert_eq!(self.exchange_view("get_deposit", &self.usdt).await?, 0);
        assert_eq!(
            self.exchange_view("get_lostfound_token", &self.usdt)
                .await?,
            amount
        );
        Ok(())
    }

    /// Two owners with USDT held on the exchange, the first owner's moved into lostfound: the
    /// vault account there holds only the second owner's. Returns both amounts.
    async fn one_owner_in_lostfound(&self, other: &AccountId) -> TestResult<(u128, u128)> {
        let owner = self.env.owner.clone();
        self.add_owner(other).await?;
        let lost = self.swap_at_quote(&owner, units(near(1))).await?;
        assert_eq!(self.token_of(&owner, &self.usdt).await?, (0, lost));
        self.force_into_lostfound(lost).await?;
        // Give the vault's exchange account room for the USDT slot again.
        self.register_on_exchange(&owner, self.env.vault_id())
            .await?;
        let kept = self.swap_at_quote(other, units(near(2))).await?;
        assert!(kept > lost);
        assert_eq!(self.token_of(other, &self.usdt).await?, (0, kept));
        assert_eq!(self.exchange_view("get_deposit", &self.usdt).await?, kept);
        // From here on, the vault can receive USDT, so a refusal is not a failed delivery.
        self.register(&self.usdt, self.env.vault_id()).await?;
        Ok((lost, kept))
    }

    /// The treasury's accrued fees in `token`.
    async fn fees(&self, token: &AccountId) -> TestResult<u128> {
        let fees: U128 = self
            .env
            .view_on(
                self.env.vault_id(),
                "get_fees",
                json!({ "token_id": token }),
            )
            .await?;
        Ok(fees.0)
    }

    /// `withdraw_fees` of `amount` USDT, signed by `caller` with `deposit` attached.
    async fn withdraw_fees(
        &self,
        caller: &AccountId,
        amount: u128,
        deposit: NearToken,
    ) -> TestResult<TransactionResult> {
        let args = json!({ "token_id": self.usdt, "amount": amount.to_string() });
        self.env
            .call_on(
                self.env.vault_id(),
                caller,
                "withdraw_fees",
                args,
                deposit,
                tgas(100),
            )
            .await
    }

    /// The vault's own USDT holding is exactly the owners' balances plus the treasury's fees.
    async fn assert_usdt_backed(&self, owners: &[&AccountId]) -> TestResult {
        let mut owed = self.fees(&self.usdt).await?;
        for owner in owners {
            owed += self.token_of(owner, &self.usdt).await?.0;
        }
        assert_eq!(
            self.ft_balance(&self.usdt, self.env.vault_id()).await?,
            owed
        );
        Ok(())
    }

    async fn assert_nothing_left_on_exchange(&self) -> TestResult {
        let deposits = self.exchange_deposits().await?;
        assert!(
            deposits.values().all(|amount| amount.0 == 0),
            "vault deposits on the exchange: {deposits:?}"
        );
        Ok(())
    }
}

#[tokio::test]
async fn swap_through_the_real_exchange_credits_the_exact_output() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let vault = s.env.vault_id().clone();
    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;

    let result = s.agent_swap(amount_in, quote).await?;
    assert_eq!(events(&result, "swap_initiated").len(), 1);
    let completed = events(&result, "swap_completed");
    assert_eq!(completed.len(), 1, "logs: {:?}", result.logs());
    // The output, split into the owner's net and the 0.10% fee, which add up to it exactly.
    let (net, fee) = split_fee(quote);
    assert_eq!(fee, quote * u128::from(FEE_BPS) / 10_000);
    assert!(fee > 0);
    assert_eq!(net + fee, quote);
    assert_eq!(completed[0]["amount_out"], json!(quote.to_string()));
    assert_eq!(completed[0]["fee"], json!(fee.to_string()));
    assert_eq!(completed[0]["net"], json!(net.to_string()));
    assert_eq!(completed[0]["held_on_exchange"], false);
    assert!(
        result
            .logs()
            .iter()
            .any(|log| log.contains(r#""version":"1.1.0","event":"swap_completed""#)),
        "logs: {:?}",
        result.logs()
    );
    assert!(result.assert_success().json::<bool>()?);

    // The owner is credited the output less the fee, the treasury the fee, and the swap counts as
    // a spend.
    assert_eq!(s.token(&s.wnear).await?, (units(near(4)), 0));
    assert_eq!(s.token(&s.usdt).await?, (net, 0));
    assert_eq!(s.fees(&s.usdt).await?, fee);
    assert_eq!(s.fees(&s.wnear).await?, 0);
    let spends = s.env.vault(&s.env.owner).await?.recent_spends;
    assert_eq!(spends.len(), 1);
    assert_eq!(spends[0].token_id.as_ref(), Some(&s.wnear));
    assert_eq!(spends[0].amount, U128(amount_in));
    // Nothing is left behind on the exchange, and the vault really holds what it credited.
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, quote);
    s.assert_usdt_backed(&[&s.env.owner]).await?;
    assert_eq!(s.ft_balance(&s.wnear, &vault).await?, units(near(4)));

    // The owner can take the output out, even while frozen.
    s.env
        .call(&s.env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    // The owner cannot withdraw the fee's share.
    let args = json!({ "token_id": s.usdt, "amount": quote.to_string() });
    assert_fails_with(
        s.env
            .call(&s.env.owner, "withdraw_token", args, ONE_YOCTO)
            .await?,
        "exceeds the vault's",
    );
    let args = json!({ "token_id": s.usdt, "amount": net.to_string() });
    let result = s
        .env
        .call(&s.env.owner, "withdraw_token", args, ONE_YOCTO)
        .await?;
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.ft_balance(&s.usdt, &s.env.owner).await?, net);
    assert_eq!(s.token(&s.usdt).await?, (0, 0));
    // What is left in the vault is exactly the fee.
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, fee);
    s.assert_usdt_backed(&[&s.env.owner]).await?;
    Ok(())
}

#[tokio::test]
async fn swap_below_min_amount_out_is_refunded() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;

    let result = s.agent_swap(amount_in, quote + 1).await?;
    let refunded = events(&result, "swap_refunded");
    assert_eq!(refunded.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(refunded[0]["failed_step"], "swap");
    assert_eq!(refunded[0]["held_on_exchange"], false);
    assert!(events(&result, "swap_completed").is_empty());
    assert!(!result.assert_success().json::<bool>()?);

    // No output, no fee.
    assert_eq!(s.fees(&s.usdt).await?, 0);
    assert_eq!(s.fees(&s.wnear).await?, 0);
    assert_eq!(s.token(&s.wnear).await?, (units(near(5)), 0));
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(
        s.ft_balance(&s.wnear, s.env.vault_id()).await?,
        units(near(5))
    );
    Ok(())
}

#[tokio::test]
async fn swap_whose_deposit_fails_is_refunded() -> TestResult {
    // Without exchange storage, the exchange rejects the deposit and wNEAR bounces back.
    let s = SwapEnv::new(Registered {
        on_exchange: false,
        on_usdt: true,
    })
    .await?;

    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;

    let result = s.agent_swap(amount_in, quote).await?;
    let refunded = events(&result, "swap_refunded");
    assert_eq!(refunded.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(refunded[0]["failed_step"], "deposit");
    assert_eq!(refunded[0]["held_on_exchange"], false);
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(s.fees(&s.usdt).await?, 0);
    assert_eq!(s.fees(&s.wnear).await?, 0);

    assert_eq!(s.token(&s.wnear).await?, (units(near(5)), 0));
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());
    assert_eq!(
        s.ft_balance(&s.wnear, s.env.vault_id()).await?,
        units(near(5))
    );
    Ok(())
}

#[tokio::test]
async fn undelivered_output_is_held_then_reclaimed() -> TestResult {
    // The vault isn't registered with USDT, so the exchange cannot send it the output and keeps it
    // in the vault's exchange account instead.
    let s = SwapEnv::new(Registered {
        on_exchange: true,
        on_usdt: false,
    })
    .await?;
    let vault = s.env.vault_id().clone();
    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;

    let result = s.agent_swap(amount_in, quote).await?;
    let completed = events(&result, "swap_completed");
    assert_eq!(completed.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(completed[0]["held_on_exchange"], true);
    // Output the vault does not hold carries no fee: all of it is the owner's.
    assert_eq!(completed[0]["fee"], "0");
    assert_eq!(completed[0]["net"], json!(quote.to_string()));
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.usdt).await?, (0, quote));
    assert_eq!(s.fees(&s.usdt).await?, 0);
    let deposits = s.exchange_deposits().await?;
    assert_eq!(deposits.get(s.usdt.as_str()), Some(&U128(quote)));

    s.register(&s.usdt, &vault).await?;
    let result = s.reclaim(&s.env.owner).await?;
    let reclaimed = events(&result, "exchange_reclaim");
    assert_eq!(reclaimed[0]["succeeded"], true);
    assert!(result.assert_success().json::<bool>()?);

    // Reclaimed in full: still no fee.
    assert_eq!(s.token(&s.usdt).await?, (quote, 0));
    assert_eq!(s.fees(&s.usdt).await?, 0);
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, quote);
    s.assert_usdt_backed(&[&s.env.owner]).await?;
    Ok(())
}

#[tokio::test]
async fn tiny_swap_output_carries_no_fee() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let amount_in = 500;
    let quote = s.quote(amount_in).await?;
    // An output under 1000 units: 10 bps of it rounds down to 0.
    assert!(quote > 0 && quote < 1_000, "quote {quote}");
    let result = s.agent_swap(amount_in, quote).await?;
    let completed = events(&result, "swap_completed");
    assert_eq!(completed.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(completed[0]["fee"], "0");
    assert_eq!(completed[0]["net"], json!(quote.to_string()));
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.usdt).await?, (quote, 0));
    assert_eq!(s.fees(&s.usdt).await?, 0);
    s.assert_usdt_backed(&[&s.env.owner]).await
}

#[tokio::test]
async fn treasury_withdraws_only_accrued_fees_and_nobody_else_can() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let other = s.env.stranger.clone();
    s.add_owner(&other).await?;
    let first = s.swap_at_quote(&s.env.owner, units(near(1))).await?;
    let second = s.swap_at_quote(&other, units(near(2))).await?;
    let fee = split_fee(first).1 + split_fee(second).1;
    assert_eq!(s.fees(&s.usdt).await?, fee);
    let owners = [&s.env.owner, &other];
    s.assert_usdt_backed(&owners).await?;
    let before = (
        s.token_of(&s.env.owner, &s.usdt).await?,
        s.token_of(&other, &s.usdt).await?,
    );

    // Nobody but the treasury, and only with exactly 1 yoctoNEAR.
    for caller in [&s.env.owner, &other, &s.env.agent, &s.env.merchant] {
        assert_fails_with(
            s.withdraw_fees(caller, 1, ONE_YOCTO).await?,
            "Only the treasury account can withdraw fees",
        );
    }
    let treasury = s.env.treasury.clone();
    assert_fails_with(
        s.withdraw_fees(&treasury, 1, NO_DEPOSIT).await?,
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    // Never more than accrued, though the vault holds both owners' USDT too.
    assert!(s.ft_balance(&s.usdt, s.env.vault_id()).await? > fee + 1);
    assert_fails_with(
        s.withdraw_fees(&treasury, fee + 1, ONE_YOCTO).await?,
        &format!("exceeds the accrued {} fees of {fee}", s.usdt),
    );

    // The treasury is not registered with USDT yet: the transfer fails and is credited back.
    let result = s.withdraw_fees(&treasury, fee, ONE_YOCTO).await?;
    assert_eq!(events(&result, "fees_withdrawn").len(), 1);
    assert_eq!(
        events(&result, "fees_withdraw_refunded").len(),
        1,
        "logs: {:?}",
        result.logs()
    );
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(s.fees(&s.usdt).await?, fee);
    s.assert_usdt_backed(&owners).await?;

    // Registered, it receives exactly the fees, and no owner's balance moves.
    s.register(&s.usdt, &treasury).await?;
    let result = s.withdraw_fees(&treasury, fee, ONE_YOCTO).await?;
    let withdrawn = events(&result, "fees_withdrawn");
    assert_eq!(withdrawn.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(withdrawn[0]["treasury_id"], json!(treasury));
    assert_eq!(withdrawn[0]["amount"], json!(fee.to_string()));
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.ft_balance(&s.usdt, &treasury).await?, fee);
    assert_eq!(s.fees(&s.usdt).await?, 0);
    let after = (
        s.token_of(&s.env.owner, &s.usdt).await?,
        s.token_of(&other, &s.usdt).await?,
    );
    assert_eq!(after, before);
    s.assert_usdt_backed(&owners).await?;
    // Nothing left to take.
    assert_fails_with(
        s.withdraw_fees(&treasury, 1, ONE_YOCTO).await?,
        &format!("exceeds the accrued {} fees of 0", s.usdt),
    );
    Ok(())
}

#[tokio::test]
async fn fee_views_report_the_constant_and_the_treasury() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let vault = s.env.vault_id();
    let bps: u16 = s.env.view_on(vault, "get_fee_bps", json!({})).await?;
    assert_eq!(bps, 10);
    let treasury: Option<AccountId> = s.env.view_on(vault, "get_treasury_id", json!({})).await?;
    assert_eq!(treasury.as_ref(), Some(&s.env.treasury));
    Ok(())
}

/// The code vault-v1 runs (J5Mo…, the reproducible build of b85cece), with a vault, a policy, a
/// token balance, a completed swap and a withdrawal lock written by it, then replaced by this
/// build. Everything reads back unchanged. The upgraded vault has no treasury (J5Mo's `new` had
/// none, and nothing can set one), so fees from later swaps accrue but cannot be withdrawn.
#[tokio::test]
async fn j5mo_state_survives_a_code_upgrade_and_later_swaps_pay_the_fee() -> TestResult {
    let j5mo = res_wasm("intatto_j5mo.wasm", J5MO_SHA256);
    let s = SwapEnv::on_code(j5mo, FULLY_REGISTERED).await?;
    let vault = s.env.vault_id().clone();
    let owner = s.env.owner.clone();
    let first = s.swap_at_quote(&owner, units(near(1))).await?;
    assert_eq!(s.token(&s.usdt).await?, (first, 0)); // J5Mo charges no fee
    let until = s.env.block_timestamp().await? + 30 * 24 * HOUR_NS;
    s.env
        .call(
            &owner,
            "lock_withdrawals_until",
            json!({ "timestamp_ns": until.to_string() }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    let before = s.env.vault_json(&owner).await?;
    let ledger_before = s.usdt_ledger().await?;

    near_api::Contract::deploy(vault.clone())
        .use_code(contract_wasm())
        .without_init_call()
        .with_signer(s.env.signer.clone())
        .send_to(&s.env.network)
        .await?
        .assert_success();

    assert_eq!(s.env.vault_json(&owner).await?, before);
    assert_eq!(s.usdt_ledger().await?, ledger_before);
    let exchange: AccountId = s.env.view_on(&vault, "get_exchange_id", json!({})).await?;
    assert_eq!(exchange.as_str(), EXCHANGE);
    let treasury: Option<AccountId> = s.env.view_on(&vault, "get_treasury_id", json!({})).await?;
    assert_eq!(treasury, None);
    assert_eq!(s.fees(&s.usdt).await?, 0);

    // The agent keeps its policy, and the next swap pays the fee.
    let second = s.swap_at_quote(&owner, units(near(1))).await?;
    let (net, fee) = split_fee(second);
    assert_eq!(s.token(&s.usdt).await?, (first + net, 0));
    assert_eq!(s.fees(&s.usdt).await?, fee);
    s.assert_usdt_backed(&[&owner]).await?;
    // The lock still binds the owner, and nobody can withdraw the fees.
    assert_fails_with(
        s.env
            .call(
                &owner,
                "withdraw_token",
                json!({ "token_id": s.usdt, "amount": "1" }),
                ONE_YOCTO,
            )
            .await?,
        &format!("Withdrawals are locked until {until}"),
    );
    let treasury = s.env.treasury.clone();
    assert_fails_with(
        s.withdraw_fees(&treasury, 1, ONE_YOCTO).await?,
        "This vault has no treasury account",
    );
    Ok(())
}

#[tokio::test]
async fn swap_rejections_are_logged_and_change_nothing() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let agent = s.env.agent.clone();
    let one = units(near(1));
    let full = tgas(300);

    let result = s
        .agent_swap_as(&s.env.stranger, POOL_ID, &s.usdt, one, 1, full)
        .await?;
    assert_rejected(
        result,
        "swap_rejected",
        "not_agent",
        "is not the registered agent",
    );
    let result = s.agent_swap_as(&agent, 1, &s.usdt, one, 1, full).await?;
    assert_rejected(
        result,
        "swap_rejected",
        "pool_not_allowlisted",
        "Pool 1 is not on the vault's pool allowlist",
    );
    let result = s
        .agent_swap_as(&agent, POOL_ID, &s.wnear, one, 1, full)
        .await?;
    assert_rejected(
        result,
        "swap_rejected",
        "pair_mismatch",
        "Pool 0 trades wnear.sandbox and usdt.sandbox, not wnear.sandbox for wnear.sandbox",
    );
    let over_cap = units(near(2)) + 1;
    let result = s
        .agent_swap_as(&agent, POOL_ID, &s.usdt, over_cap, 1, full)
        .await?;
    assert_rejected(
        result,
        "swap_rejected",
        "over_per_tx_cap",
        "exceeds its per-transaction cap",
    );
    let result = s
        .agent_swap_as(&agent, POOL_ID, &s.usdt, one, 1, tgas(AGENT_SWAP_TGAS - 1))
        .await?;
    assert_rejected(
        result,
        "swap_rejected",
        "insufficient_gas",
        "agent_swap needs at least",
    );
    s.env
        .call(&s.env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    let result = s.agent_swap(one, 1).await?;
    assert_rejected(
        result,
        "swap_rejected",
        "frozen",
        "Vault is frozen; agent swapping is disabled",
    );

    assert_eq!(s.token(&s.wnear).await?, (units(near(5)), 0));
    assert!(s.env.vault(&s.env.owner).await?.recent_spends.is_empty());

    // Tokens from an account without a vault bounce back to the sender.
    s.register(&s.wnear, &s.env.stranger).await?;
    s.mint(&s.wnear, &s.env.stranger, near(1)).await?;
    let used = s
        .transfer_call(&s.wnear, &s.env.stranger, s.env.vault_id(), one)
        .await?;
    assert_eq!(used, 0);
    assert_eq!(s.ft_balance(&s.wnear, &s.env.stranger).await?, one);
    Ok(())
}

#[tokio::test]
async fn min_amount_out_of_1_is_rejected_as_slippage_too_loose() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;
    let floor = quote * (10_000 - u128::from(MAX_SLIPPAGE_BPS)) / 10_000;

    let result = s.agent_swap(amount_in, 1).await?;
    assert!(events(&result, "swap_initiated").is_empty());
    assert_rejected(
        result,
        "swap_rejected",
        "slippage_too_loose",
        &format!(
            "Minimum amount out 1 is below {floor}: the exchange quotes {quote} and pool 0 allows 50 bps of slippage"
        ),
    );
    s.assert_untouched().await
}

#[tokio::test]
async fn min_amount_out_at_the_slippage_floor_is_accepted() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let amount_in = units(near(1));
    let quote = s.quote(amount_in).await?;
    let floor = quote * (10_000 - u128::from(MAX_SLIPPAGE_BPS)) / 10_000;

    // One unit looser than the policy allows is rejected...
    let result = s.agent_swap(amount_in, floor - 1).await?;
    assert_rejected(result, "swap_rejected", "slippage_too_loose", "is below");
    s.assert_untouched().await?;

    // ...and exactly the floor goes through. Nothing traded in between, so the pool pays the quote.
    let result = s.agent_swap(amount_in, floor).await?;
    let completed = events(&result, "swap_completed");
    assert_eq!(completed.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(completed[0]["amount_out"], json!(quote.to_string()));
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.wnear).await?, (units(near(4)), 0));
    // The floor bounds the gross output; the owner gets it less the 0.10% fee. At worst (output
    // exactly at the floor) that is the floor less 10 bps: max_slippage_bps + 10 bps in all.
    let (net, fee) = split_fee(quote);
    assert_eq!(s.token(&s.usdt).await?, (net, 0));
    assert_eq!(s.fees(&s.usdt).await?, fee);
    let (worst_net, _) = split_fee(floor);
    assert!(
        worst_net >= quote * (10_000 - u128::from(MAX_SLIPPAGE_BPS) - u128::from(FEE_BPS)) / 10_000
    );
    assert_eq!(s.env.vault(&s.env.owner).await?.recent_spends.len(), 1);
    s.assert_nothing_left_on_exchange().await
}

#[tokio::test]
async fn failed_quote_is_rejected_and_deducts_nothing() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    // The owner allowlists pool 1, which doesn't exist on the exchange, so get_return panics.
    let mut policy = s.swap_policy();
    policy.pools.push(PoolPolicy {
        pool_id: 1,
        ..policy.pools[0].clone()
    });
    s.env
        .set_agent(&s.env.owner, &s.env.agent, &policy)
        .await?
        .assert_success();

    let args = json!({
        "pool_id": 1,
        "token_in": s.wnear,
        "amount_in": units(near(1)).to_string(),
        "token_out": s.usdt,
    });
    let direct = near_api::Contract(s.exchange.clone())
        .call_function("get_return", args)
        .read_only::<U128>()
        .fetch_from(&s.env.network)
        .await;
    let error = format!("{:?}", direct.expect_err("the exchange has no pool 1"));
    assert!(error.contains("E85: invalid pool id"), "{error}");

    let result = s
        .agent_swap_as(&s.env.agent, 1, &s.usdt, units(near(1)), 1, tgas(300))
        .await?;
    assert!(events(&result, "swap_initiated").is_empty());
    assert_rejected(
        result,
        "swap_rejected",
        "quote_failed",
        "The exchange could not quote pool 1 for wnear.sandbox to usdt.sandbox",
    );
    s.assert_untouched().await
}

/// Everything that holds the owner's funds, read straight from the chain.
#[derive(Debug, PartialEq)]
struct Holdings {
    vault: near_sdk::serde_json::Value,
    wnear_held: u128,
    usdt_held: u128,
    exchange_deposits: HashMap<String, U128>,
}

impl SwapEnv {
    async fn holdings(&self) -> TestResult<Holdings> {
        let vault = self.env.vault_id();
        Ok(Holdings {
            vault: self.env.vault_json(&self.env.owner).await?,
            wnear_held: self.ft_balance(&self.wnear, vault).await?,
            usdt_held: self.ft_balance(&self.usdt, vault).await?,
            exchange_deposits: self.exchange_deposits().await?,
        })
    }

    /// A call from the agent's account that must fail.
    async fn agent_attempt(
        &self,
        method: &str,
        args: near_sdk::serde_json::Value,
        deposit: NearToken,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        let vault = self.env.vault_id();
        let result = self
            .env
            .call_on(vault, &self.env.agent, method, args.clone(), deposit, gas)
            .await?;
        assert!(
            result.is_failure(),
            "{method}({args}) should fail, logs: {:?}",
            result.logs()
        );
        for started in ["spend_initiated", "swap_initiated"] {
            assert!(events(&result, started).is_empty(), "{method}({args})");
        }
        Ok(result)
    }
}

#[tokio::test]
async fn zero_outflow_policy_rejects_everything_the_agent_can_try() -> TestResult {
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let owner = s.env.owner.clone();
    let vault = s.env.vault_id().clone();
    let zero_outflow = Policy {
        per_tx_cap: NO_DEPOSIT,
        daily_cap: NO_DEPOSIT,
        // The smallest count set_agent accepts; with every cap at zero it never matters.
        max_spends_per_24h: 1,
        allowlist: vec![],
        tokens: vec![],
        pools: vec![],
    };
    s.env
        .set_agent(&owner, &s.env.agent, &zero_outflow)
        .await?
        .assert_success();
    assert_eq!(s.env.policy(&owner).await?, Some(zero_outflow));
    let before = s.holdings().await?;
    let near_held = s.env.near_balance(&vault).await?;
    let balance = s.env.vault(&owner).await?.balance.as_yoctonear();
    let full = tgas(300);

    // agent_spend: every receiver the agent might pick, every interesting amount.
    let receivers = [
        &s.env.merchant,
        &owner,
        &s.env.agent,
        &s.env.stranger,
        &vault,
        &s.exchange,
        &s.wnear,
    ];
    let amounts = [1, units(near(1)), balance, balance + 1, u128::MAX];
    for receiver in receivers {
        for amount in amounts {
            let args =
                json!({ "owner_id": owner, "receiver_id": receiver, "amount": amount.to_string() });
            let result = s
                .agent_attempt("agent_spend", args, NO_DEPOSIT, full)
                .await?;
            let rejected = events(&result, "spend_rejected");
            assert_eq!(rejected[0]["reason"], "receiver_not_allowlisted");
        }
    }
    let args = json!({ "owner_id": owner, "receiver_id": s.env.merchant, "amount": "0" });
    let result = s
        .agent_attempt("agent_spend", args, NO_DEPOSIT, full)
        .await?;
    assert_eq!(
        events(&result, "spend_rejected")[0]["reason"],
        "zero_amount"
    );

    // agent_swap: the real pool and pools that don't exist, every pair, amounts up to more than
    // the vault holds, the loosest and tightest minimums.
    let stranger = s.env.stranger.clone();
    let pairs = [
        (&s.wnear, &s.usdt),
        (&s.usdt, &s.wnear),
        (&s.wnear, &s.wnear),
        (&s.wnear, &stranger),
    ];
    for pool_id in [POOL_ID, 1, u64::MAX] {
        for (token_in, token_out) in pairs {
            for amount_in in [1, units(near(5)), u128::MAX] {
                for min_amount_out in [1, u128::MAX] {
                    let args = json!({
                        "owner_id": owner,
                        "pool_id": pool_id,
                        "token_in": token_in,
                        "token_out": token_out,
                        "amount_in": amount_in.to_string(),
                        "min_amount_out": min_amount_out.to_string(),
                    });
                    let result = s
                        .agent_attempt("agent_swap", args, NO_DEPOSIT, full)
                        .await?;
                    let rejected = events(&result, "swap_rejected");
                    assert_eq!(rejected[0]["reason"], "pool_not_allowlisted");
                }
            }
        }
    }
    for (amount_in, min_amount_out, gas, reason) in [
        (0, 1, full, "zero_amount"),
        (1, 0, full, "zero_min_amount_out"),
        (1, 1, tgas(AGENT_SWAP_TGAS - 1), "insufficient_gas"),
    ] {
        let args = json!({
            "owner_id": owner,
            "pool_id": POOL_ID,
            "token_in": s.wnear,
            "token_out": s.usdt,
            "amount_in": amount_in.to_string(),
            "min_amount_out": min_amount_out.to_string(),
        });
        let result = s.agent_attempt("agent_swap", args, NO_DEPOSIT, gas).await?;
        assert_eq!(events(&result, "swap_rejected")[0]["reason"], reason);
    }

    // The callbacks that credit balances, called directly with made-up results.
    let ticket = json!({
        "spend_id": "0",
        "owner_id": owner,
        "pool_id": POOL_ID,
        "token_in": s.wnear,
        "token_out": s.usdt,
        "amount_in": units(near(1)).to_string(),
        "min_amount_out": "1",
    });
    let big = units(near(1_000)).to_string();
    let callbacks = [
        (
            "on_spend_complete",
            json!({ "spend_id": "0", "owner_id": owner, "receiver_id": s.env.agent, "amount": big }),
        ),
        (
            "on_withdraw_complete",
            json!({ "owner_id": owner, "amount": big }),
        ),
        (
            "on_token_withdraw_complete",
            json!({ "owner_id": owner, "token_id": s.wnear, "amount": big }),
        ),
        (
            "on_swap_quoted",
            json!({ "caller_id": s.env.agent, "ticket": ticket }),
        ),
        ("on_swap_deposited", json!({ "ticket": ticket })),
        ("on_swap_executed", json!({ "ticket": ticket })),
        (
            "on_swap_output_withdrawn",
            json!({ "ticket": ticket, "amount_out": big }),
        ),
        (
            "on_swap_refund_withdrawn",
            json!({ "ticket": ticket, "amount": big, "failed_step": "swap" }),
        ),
        (
            "on_reclaim_complete",
            json!({ "owner_id": owner, "token_id": s.usdt, "amount": big }),
        ),
        (
            "on_fees_withdraw_complete",
            json!({ "treasury_id": s.env.agent, "token_id": s.usdt, "amount": big }),
        ),
    ];
    for (method, args) in callbacks {
        let result = s.agent_attempt(method, args, NO_DEPOSIT, full).await?;
        assert_fails_with(result, &format!("Method {method} is private"));
    }

    // Posing as a token that credits the owner.
    let args = json!({ "sender_id": owner, "amount": big, "msg": "" });
    let result = s
        .agent_attempt("ft_on_transfer", args, NO_DEPOSIT, full)
        .await?;
    assert_fails_with(result, "is not allowlisted in this vault's policy");

    // The owner's methods act on the caller's own vault, and the agent has none.
    for (method, args) in [
        ("withdraw", json!({ "amount": big })),
        (
            "withdraw_token",
            json!({ "token_id": s.wnear, "amount": big }),
        ),
        ("reclaim_from_exchange", json!({ "token_id": s.wnear })),
        (
            "set_agent",
            json!({ "agent_id": s.env.agent, "policy": s.swap_policy() }),
        ),
        ("remove_agent", json!({})),
        ("unfreeze", json!({})),
        ("lock_withdrawals_until", json!({ "timestamp_ns": "0" })),
    ] {
        let result = s.agent_attempt(method, args, ONE_YOCTO, full).await?;
        assert_fails_with(result, "No vault found for agent.sandbox");
    }

    assert_eq!(s.holdings().await?, before);
    // The contract account only gains (its share of the gas burnt); no NEAR left it.
    assert!(s.env.near_balance(&vault).await? >= near_held);
    Ok(())
}

#[tokio::test]
async fn lostfound_shortfall_refuses_reclaims_and_leaves_the_other_owner_untouched() -> TestResult {
    let s = SwapEnv::new(Registered {
        on_exchange: true,
        on_usdt: false,
    })
    .await?;
    let owner = s.env.owner.clone();
    let other = s.env.stranger.clone();
    let (lost, kept) = s.one_owner_in_lostfound(&other).await?;
    let ledger = s.usdt_ledger().await?;
    assert_eq!((ledger.expected.0, ledger.in_flight), (lost + kept, 0));
    let other_before = s.env.vault(&other).await?;

    // Both reclaims are refused, with the shortfall on record, and nothing moves.
    for who in [&owner, &other] {
        let result = s.reclaim(who).await?;
        let shortfall = events(&result, "exchange_shortfall");
        assert_eq!(shortfall.len(), 1, "logs: {:?}", result.logs());
        assert_eq!(shortfall[0]["owner_id"], json!(who));
        assert_eq!(shortfall[0]["expected"], json!((lost + kept).to_string()));
        assert_eq!(shortfall[0]["actual"], json!(kept.to_string()));
        assert!(events(&result, "exchange_reclaim").is_empty());
        assert_fails_with(
            result,
            &format!(
                "The vault's exchange account holds {kept} of usdt.sandbox but owners are owed {}",
                lost + kept
            ),
        );
    }
    assert_eq!(s.token_of(&owner, &s.usdt).await?, (0, lost));
    assert_eq!(s.env.vault(&other).await?.tokens, other_before.tokens);
    assert_eq!(s.exchange_view("get_deposit", &s.usdt).await?, kept);
    assert_eq!(s.ft_balance(&s.usdt, s.env.vault_id()).await?, 0);
    assert_eq!(s.usdt_ledger().await?, ledger);
    Ok(())
}

/// The same situation on the v1 code now deployed on vault-v1.intatto-dev.testnet: the owner whose
/// USDT went to lostfound reclaims it out of the other owner's, and the other owner is left with
/// an `on_exchange` amount nothing backs. This is the bug the ledger fixes.
#[tokio::test]
async fn v1_lets_one_owner_reclaim_another_owners_tokens() -> TestResult {
    let v1 = res_wasm("intatto_v1.wasm", V1_SHA256);
    let s = SwapEnv::on_code(
        v1,
        Registered {
            on_exchange: true,
            on_usdt: false,
        },
    )
    .await?;
    let owner = s.env.owner.clone();
    let other = s.env.stranger.clone();
    let (lost, kept) = s.one_owner_in_lostfound(&other).await?;

    let result = s.reclaim(&owner).await?;
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.token_of(&owner, &s.usdt).await?, (lost, 0));
    assert_eq!(s.ft_balance(&s.usdt, s.env.vault_id()).await?, lost);
    // The exchange account now holds less than the other owner's claim, so its reclaim fails.
    assert_eq!(s.exchange_view("get_deposit", &s.usdt).await?, kept - lost);
    let result = s.reclaim(&other).await?;
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(s.token_of(&other, &s.usdt).await?, (0, kept));
    Ok(())
}

/// The exchange owner appoints `dex-owner.sandbox` a blacklist manager, which then sets whether the
/// vault's account is blacklisted. ref-exchange 1.9.21 only.
async fn set_vault_blacklisted(s: &SwapEnv, blacklisted: bool) -> TestResult {
    let dex_owner: AccountId = "dex-owner.sandbox".parse()?;
    let managers: Vec<AccountId> = s
        .env
        .view_on(&s.exchange, "get_blacklist_managers", json!({}))
        .await?;
    if !managers.contains(&dex_owner) {
        // Only blacklist managers may blacklist, not the exchange owner itself.
        let args = json!({ "users": [s.env.vault_id()] });
        assert_fails_with(
            s.env
                .call_on(
                    &s.exchange,
                    &dex_owner,
                    "extend_blacklisted_users",
                    args,
                    ONE_YOCTO,
                    tgas(30),
                )
                .await?,
            "E100: no permission to invoke this",
        );
        s.env
            .call_on(
                &s.exchange,
                &dex_owner,
                "extend_blacklist_managers",
                json!({ "managers": [dex_owner] }),
                ONE_YOCTO,
                tgas(30),
            )
            .await?
            .assert_success();
    }
    let method = if blacklisted {
        "extend_blacklisted_users"
    } else {
        "remove_blacklisted_users"
    };
    let args = json!({ "users": [s.env.vault_id()] });
    s.env
        .call_on(&s.exchange, &dex_owner, method, args, ONE_YOCTO, tgas(30))
        .await?
        .assert_success();
    let listed: bool = s
        .env
        .view_on(
            &s.exchange,
            "is_blacklisted_user",
            json!({ "account_id": s.env.vault_id() }),
        )
        .await?;
    assert_eq!(listed, blacklisted);
    Ok(())
}

/// ref-exchange 1.9.21 (mainnet) adds a user blacklist that its blacklist managers control. On
/// mainnet, `blockdexuser.near` is one, and 174 accounts were blacklisted on 2026-11-09. If the
/// vault's account is blacklisted, the exchange refuses its deposits: every swap is refunded at
/// the deposit step and nothing is lost.
#[tokio::test]
async fn blacklisted_vault_on_1_9_21_refunds_swaps_and_loses_nothing() -> TestResult {
    if exchange_version() != "1.9.21" {
        eprintln!("skipped: needs {EXCHANGE_VERSION_ENV}=1.9.21");
        return Ok(());
    }
    let s = SwapEnv::new(FULLY_REGISTERED).await?;
    let vault = s.env.vault_id().clone();
    let amount_in = units(near(1));
    let first = s.swap_at_quote(&s.env.owner, amount_in).await?;
    let usdt = split_fee(first).0;
    set_vault_blacklisted(&s, true).await?;

    let quote = s.quote(amount_in).await?;
    let result = s.agent_swap(amount_in, quote).await?;
    let refunded = events(&result, "swap_refunded");
    assert_eq!(refunded.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(refunded[0]["failed_step"], "deposit");
    assert_eq!(refunded[0]["held_on_exchange"], false);
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.wnear).await?, (units(near(4)), 0));
    assert_eq!(s.token(&s.usdt).await?, (usdt, 0));
    assert_eq!(s.ft_balance(&s.wnear, &vault).await?, units(near(4)));
    assert_eq!(s.usdt_ledger().await?.expected, U128(0));
    s.assert_nothing_left_on_exchange().await?;

    // Off the blacklist, swaps work again.
    set_vault_blacklisted(&s, false).await?;
    s.swap_at_quote(&s.env.owner, amount_in).await?;
    Ok(())
}

/// Output already held in the vault's exchange account when the vault is blacklisted cannot be
/// reclaimed until the vault is off the blacklist; nothing is lost meanwhile.
#[tokio::test]
async fn blacklisted_vault_on_1_9_21_keeps_held_output_until_reclaimable() -> TestResult {
    if exchange_version() != "1.9.21" {
        eprintln!("skipped: needs {EXCHANGE_VERSION_ENV}=1.9.21");
        return Ok(());
    }
    let s = SwapEnv::new(Registered {
        on_exchange: true,
        on_usdt: false,
    })
    .await?;
    let vault = s.env.vault_id().clone();
    let held = s.swap_at_quote(&s.env.owner, units(near(1))).await?;
    assert_eq!(s.token(&s.usdt).await?, (0, held));
    s.register(&s.usdt, &vault).await?;
    set_vault_blacklisted(&s, true).await?;

    // The exchange refuses a blacklisted account's withdrawal: the reclaim fails, and the owner's
    // claim stays recorded on the exchange, where the tokens still are.
    let result = s.reclaim(&s.env.owner).await?;
    let reclaimed = events(&result, "exchange_reclaim");
    assert_eq!(reclaimed.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(reclaimed[0]["succeeded"], false);
    assert!(!result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.usdt).await?, (0, held));
    assert_eq!(s.exchange_view("get_deposit", &s.usdt).await?, held);
    assert_eq!(s.usdt_ledger().await?.expected, U128(held));

    // Off the blacklist, the same reclaim delivers it.
    set_vault_blacklisted(&s, false).await?;
    let result = s.reclaim(&s.env.owner).await?;
    assert_eq!(events(&result, "exchange_reclaim")[0]["succeeded"], true);
    assert_eq!(s.token(&s.usdt).await?, (held, 0));
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, held);
    Ok(())
}
