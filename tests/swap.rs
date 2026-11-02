//! Agent swaps against the real Rhea (Ref) V1 exchange: the ref-exchange 1.9.19 binary deployed at
//! `ref-finance-101.testnet`, with the `wrap.testnet` binary as both wNEAR and a stand-in USDT.
//! See tests/res/README.md for where the binaries come from.

// `SwapEnv` holds a sandbox slot (a semaphore permit) for the whole test on purpose.
#![allow(clippy::significant_drop_tightening)]

mod common;

use std::collections::HashMap;

use common::*;
use intatto::{AGENT_SWAP_TGAS, Policy, PoolPolicy, TokenPolicy};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use testresult::TestResult;

const EXCHANGE_SHA256: &str = "AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX";
const W_NEAR_SHA256: &str = "DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa";
const POOL_ID: u64 = 0;
/// `storage_balance_bounds().min` of the w_near contract.
const TOKEN_STORAGE: NearToken = NearToken::from_micronear(1_250);

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
        let env = TestEnv::with_vault().await?;
        let dex_owner = env.create_account("dex-owner.sandbox", near(50)).await?;
        let exchange_args = json!({
            "owner_id": dex_owner,
            "boost_farm_id": "boostfarm.sandbox",
            "burrowland_id": "burrow.sandbox",
            "exchange_fee": 2000,
            "referral_fee": 0,
        });
        let exchange = env
            .deploy(
                EXCHANGE,
                res_wasm("ref_exchange_v1.9.19.wasm", EXCHANGE_SHA256),
                "new",
                exchange_args,
            )
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
    /// trade through the wNEAR/USDT pool.
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
    assert_eq!(completed[0]["amount_out"], json!(quote.to_string()));
    assert_eq!(completed[0]["held_on_exchange"], false);
    assert!(result.assert_success().json::<bool>()?);

    // The owner is credited exactly what the exchange swapped, and the swap counts as a spend.
    assert_eq!(s.token(&s.wnear).await?, (units(near(4)), 0));
    assert_eq!(s.token(&s.usdt).await?, (quote, 0));
    let spends = s.env.vault(&s.env.owner).await?.recent_spends;
    assert_eq!(spends.len(), 1);
    assert_eq!(spends[0].token_id.as_ref(), Some(&s.wnear));
    assert_eq!(spends[0].amount, U128(amount_in));
    // Nothing is left behind on the exchange, and the vault really holds what it credited.
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, quote);
    assert_eq!(s.ft_balance(&s.wnear, &vault).await?, units(near(4)));

    // The owner can take the output out, even while frozen.
    s.env
        .call(&s.env.owner, "freeze", json!({}), NO_DEPOSIT)
        .await?
        .assert_success();
    let args = json!({ "token_id": s.usdt, "amount": quote.to_string() });
    let result = s
        .env
        .call(&s.env.owner, "withdraw_token", args, ONE_YOCTO)
        .await?;
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.ft_balance(&s.usdt, &s.env.owner).await?, quote);
    assert_eq!(s.token(&s.usdt).await?, (0, 0));
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

    let result = s.agent_swap(units(near(1)), 1).await?;
    let refunded = events(&result, "swap_refunded");
    assert_eq!(refunded.len(), 1, "logs: {:?}", result.logs());
    assert_eq!(refunded[0]["failed_step"], "deposit");
    assert_eq!(refunded[0]["held_on_exchange"], false);
    assert!(!result.assert_success().json::<bool>()?);

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
    assert!(result.assert_success().json::<bool>()?);
    assert_eq!(s.token(&s.usdt).await?, (0, quote));
    let deposits = s.exchange_deposits().await?;
    assert_eq!(deposits.get(s.usdt.as_str()), Some(&U128(quote)));

    s.register(&s.usdt, &vault).await?;
    let args = json!({ "token_id": s.usdt });
    let result = s
        .env
        .call(&s.env.owner, "reclaim_from_exchange", args, ONE_YOCTO)
        .await?;
    let reclaimed = events(&result, "exchange_reclaim");
    assert_eq!(reclaimed[0]["succeeded"], true);
    assert!(result.assert_success().json::<bool>()?);

    assert_eq!(s.token(&s.usdt).await?, (quote, 0));
    s.assert_nothing_left_on_exchange().await?;
    assert_eq!(s.ft_balance(&s.usdt, &vault).await?, quote);
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
