use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const T0: u64 = 1_700_000_000_000_000_000;
const HOUR_NS: u64 = 60 * 60 * 1_000_000_000;
const POOL: u64 = 7;

fn owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.near".parse().unwrap()
}
fn merchant() -> AccountId {
    "merchant.near".parse().unwrap()
}
fn contract_id() -> AccountId {
    "vault.near".parse().unwrap()
}
fn exchange() -> AccountId {
    "exchange.near".parse().unwrap()
}
fn wnear() -> AccountId {
    "wnear.near".parse().unwrap()
}
fn usdt() -> AccountId {
    "usdt.near".parse().unwrap()
}

fn set_context(predecessor: AccountId, deposit: NearToken, timestamp: u64) {
    set_context_with_gas(predecessor, deposit, timestamp, Gas::from_tgas(300));
}

fn set_context_with_gas(predecessor: AccountId, deposit: NearToken, timestamp: u64, gas: Gas) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(contract_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .account_balance(NearToken::from_near(1_000))
        .attached_deposit(deposit)
        .block_timestamp(timestamp)
        .prepaid_gas(gas);
    testing_env!(builder.build());
}

/// 1 NEAR per spend and 3 NEAR per 24h; up to 100 wNEAR per swap and 250 per 24h; usdt
/// allowed as an output; pool 7 trades wNEAR/usdt with up to 1% slippage; 5 agent actions per 24h.
fn policy(allowlist: Vec<AccountId>) -> Policy {
    Policy {
        per_tx_cap: NearToken::from_near(1),
        daily_cap: NearToken::from_near(3),
        max_spends_per_24h: 5,
        allowlist,
        tokens: vec![
            TokenPolicy {
                token_id: wnear(),
                per_tx_cap: U128(100),
                daily_cap: U128(250),
            },
            TokenPolicy {
                token_id: usdt(),
                per_tx_cap: U128(1_000),
                daily_cap: U128(1_000),
            },
        ],
        pools: vec![PoolPolicy {
            pool_id: POOL,
            token_ids: [wnear(), usdt()],
            max_slippage_bps: 100,
        }],
    }
}

/// A vault holding ~10 NEAR and 1000 wNEAR, with `policy` for the agent.
fn setup() -> Contract {
    let mut contract = Contract::new(exchange());
    set_context(owner(), NearToken::from_near(10), T0);
    contract.deposit();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy(vec![merchant()]));
    set_context(wnear(), NearToken::from_yoctonear(0), T0);
    let _ = contract.ft_on_transfer(owner(), U128(1_000), String::new());
    contract
}

fn spend(contract: &mut Contract, timestamp: u64) {
    set_context(agent(), NearToken::from_yoctonear(0), timestamp);
    contract
        .agent_spend(owner(), merchant(), NearToken::from_near(1))
        .detach();
}

/// `agent_swap` asking for at least `min_amount_out`, without its quote callback.
fn request_swap(contract: &mut Contract, amount_in: u128, min_amount_out: u128, timestamp: u64) {
    set_context(agent(), NearToken::from_yoctonear(0), timestamp);
    contract
        .agent_swap(
            owner(),
            POOL,
            wnear(),
            usdt(),
            U128(amount_in),
            U128(min_amount_out),
        )
        .detach();
}

/// The exchange's quote reaching `on_swap_quoted` at `timestamp`.
fn quote_swap(
    contract: &mut Contract,
    amount_in: u128,
    min_amount_out: u128,
    quote: Result<U128, PromiseError>,
    timestamp: u64,
) {
    set_context(contract_id(), NearToken::from_yoctonear(0), timestamp);
    let request = SwapTicket {
        min_amount_out: U128(min_amount_out),
        ..ticket(0, amount_in)
    };
    contract.on_swap_quoted(agent(), request, quote).detach();
}

/// A swap the exchange quotes 1:1 and the agent asks for exactly the quote, through to the
/// deposit: `agent_swap` and its quote callback.
fn swap(contract: &mut Contract, amount_in: u128, timestamp: u64) {
    request_swap(contract, amount_in, amount_in, timestamp);
    quote_swap(
        contract,
        amount_in,
        amount_in,
        Ok(U128(amount_in)),
        timestamp,
    );
}

/// The ticket of a `swap` accepted as spend `spend_id`, as its later callbacks receive it.
fn ticket(spend_id: u64, amount_in: u128) -> SwapTicket {
    SwapTicket {
        spend_id: U64(spend_id),
        owner_id: owner(),
        pool_id: POOL,
        token_in: wnear(),
        token_out: usdt(),
        amount_in: U128(amount_in),
        min_amount_out: U128(amount_in),
    }
}

/// Runs a callback as the vault itself, the only caller `#[private]` allows.
fn as_vault() {
    set_context(contract_id(), NearToken::from_yoctonear(0), T0 + 10);
}

fn fail_transfer(contract: &mut Contract, spend_id: u64, timestamp: u64) {
    set_context(contract_id(), NearToken::from_yoctonear(0), timestamp);
    let ok = contract.on_spend_complete(
        U64(spend_id),
        owner(),
        merchant(),
        NearToken::from_near(1),
        Err(PromiseError::Failed),
    );
    assert!(!ok);
}

fn vault(contract: &Contract) -> Vault {
    contract.get_vault(owner()).unwrap()
}

fn token(contract: &Contract, token_id: &AccountId) -> TokenBalance {
    vault(contract)
        .tokens
        .into_iter()
        .find(|token| &token.token_id == token_id)
        .unwrap()
}

fn spend_ids(contract: &Contract) -> Vec<u64> {
    vault(contract)
        .recent_spends
        .iter()
        .map(|spend| spend.spend_id.0)
        .collect()
}

fn borsh_cost<T: near_sdk::borsh::BorshSerialize>(value: &T) -> NearToken {
    storage_cost(near_sdk::borsh::to_vec(value).unwrap().len() as u64)
}

/// What one NEAR spend's entry in `recent_spends` costs in storage.
fn spend_record_cost() -> NearToken {
    borsh_cost(&Spend {
        spend_id: U64(0),
        timestamp: U64(0),
        token_id: None,
        amount: U128(0),
    })
}

fn expect_promise(result: PromiseOrValue<bool>) {
    match result {
        PromiseOrValue::Promise(promise) => promise.detach(),
        PromiseOrValue::Value(value) => panic!("expected the chain to continue, got {value}"),
    }
}

#[test]
#[should_panic(expected = "would exceed the 24-hour cap")]
fn burst_23h_after_spending_the_cap_is_rejected() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + 1);
    spend(&mut contract, T0 + 2);
    spend(&mut contract, T0 + 23 * HOUR_NS);
}

#[test]
#[should_panic(expected = "would exceed the 24-hour cap")]
fn spend_still_counts_one_ns_before_24h() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + HOUR_NS);
    spend(&mut contract, T0 + 2 * HOUR_NS);
    spend(&mut contract, T0 + WINDOW_NS - 1);
}

#[test]
fn spend_ages_out_exactly_24h_later() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + HOUR_NS);
    spend(&mut contract, T0 + 2 * HOUR_NS);
    spend(&mut contract, T0 + WINDOW_NS);

    let timestamps: Vec<u64> = vault(&contract)
        .recent_spends
        .iter()
        .map(|spend| spend.timestamp.0)
        .collect();
    assert_eq!(timestamps, [T0 + HOUR_NS, T0 + 2 * HOUR_NS, T0 + WINDOW_NS]);
}

/// A fixed window opened at T0 would have reset at T0 + 24h and allowed 3 more NEAR.
#[test]
#[should_panic(expected = "would exceed the 24-hour cap")]
fn only_aged_out_spends_free_the_cap() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + 23 * HOUR_NS);
    spend(&mut contract, T0 + 23 * HOUR_NS + 1);
    spend(&mut contract, T0 + WINDOW_NS);
    assert_eq!(spend_ids(&contract), [1, 2, 3]); // only the T0 spend aged out
    spend(&mut contract, T0 + WINDOW_NS + 1);
}

#[test]
#[should_panic(expected = "has made 5 spends in the last 24 hours; the policy allows 5")]
fn spend_count_is_limited_per_24h() {
    let mut contract = setup();
    for i in 0..6 {
        set_context(agent(), NearToken::from_yoctonear(0), T0 + i);
        contract
            .agent_spend(owner(), merchant(), NearToken::from_millinear(100))
            .detach();
    }
}

#[test]
fn spend_records_are_charged_to_the_vault() {
    let mut contract = setup();
    let start = vault(&contract).balance;

    spend(&mut contract, T0);
    let after_first = vault(&contract).balance;
    assert_eq!(
        after_first,
        start
            .checked_sub(NearToken::from_near(1))
            .and_then(|b| b.checked_sub(spend_record_cost()))
            .unwrap()
    );

    // The T0 entry is pruned as the new one is added, so storage nets to zero.
    spend(&mut contract, T0 + WINDOW_NS);
    assert_eq!(
        vault(&contract).balance,
        after_first.checked_sub(NearToken::from_near(1)).unwrap()
    );
}

#[test]
fn failed_transfer_removes_only_its_own_entry() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + 1);
    spend(&mut contract, T0 + 2);
    assert_eq!(spend_ids(&contract), [0, 1, 2]);
    let before_refund = vault(&contract).balance;

    fail_transfer(&mut contract, 1, T0 + 3);

    assert_eq!(spend_ids(&contract), [0, 2]);
    assert_eq!(
        vault(&contract).balance,
        before_refund
            .checked_add(NearToken::from_near(1))
            .and_then(|b| b.checked_add(spend_record_cost()))
            .unwrap()
    );
    // The refunded 1 NEAR is spendable again within the same 24 hours.
    spend(&mut contract, T0 + 4);
    assert_eq!(spend_ids(&contract), [0, 2, 3]);
}

#[test]
fn refund_after_its_entry_aged_out_only_restores_the_balance() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + WINDOW_NS); // prunes spend 0
    let before_refund = vault(&contract).balance;

    fail_transfer(&mut contract, 0, T0 + WINDOW_NS);

    assert_eq!(spend_ids(&contract), [1]);
    assert_eq!(
        vault(&contract).balance,
        before_refund.checked_add(NearToken::from_near(1)).unwrap()
    );
}

#[test]
fn policy_storage_is_charged_and_refunded_to_the_vault() {
    let mut contract = Contract::new(exchange());
    set_context(owner(), NearToken::from_near(10), T0);
    contract.deposit();
    let after_deposit = vault(&contract).balance;
    assert!(after_deposit < NearToken::from_near(10));

    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(
        agent(),
        policy(vec![merchant(), "shop.near".parse().unwrap()]),
    );
    let after_big_policy = vault(&contract).balance;
    assert!(after_big_policy < after_deposit);

    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(
        agent(),
        Policy {
            tokens: vec![],
            pools: vec![],
            ..policy(vec![])
        },
    );
    let after_small_policy = vault(&contract).balance;
    assert!(after_small_policy > after_big_policy);
    assert!(after_small_policy < after_deposit); // still pays for the agent id

    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.remove_agent();
    assert_eq!(vault(&contract).balance, after_deposit);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn set_agent_requires_one_yocto() {
    let mut contract = Contract::new(exchange());
    set_context(owner(), NearToken::from_near(10), T0);
    contract.deposit();
    set_context(owner(), NearToken::from_yoctonear(0), T0);
    contract.set_agent(agent(), policy(vec![]));
}

#[test]
#[should_panic(expected = "max_spends_per_24h must be between 1 and 100")]
fn set_agent_rejects_zero_max_spends() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(
        agent(),
        Policy {
            max_spends_per_24h: 0,
            ..policy(vec![])
        },
    );
}

#[test]
#[should_panic(expected = "max_spends_per_24h must be between 1 and 100")]
fn set_agent_rejects_more_than_100_max_spends() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(
        agent(),
        Policy {
            max_spends_per_24h: 101,
            ..policy(vec![])
        },
    );
}

#[test]
#[should_panic(expected = "Pool 7 uses usdt.near, which has no caps in the policy")]
fn set_agent_rejects_pool_token_without_caps() {
    let mut contract = setup();
    let mut policy = policy(vec![]);
    policy.tokens.retain(|token| token.token_id != usdt());
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy);
}

#[test]
#[should_panic(expected = "Token wnear.near is listed more than once")]
fn set_agent_rejects_duplicate_tokens() {
    let mut contract = setup();
    let mut policy = policy(vec![]);
    policy.tokens.push(policy.tokens[0].clone());
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy);
}

#[test]
fn token_deposit_credits_the_sender_and_pays_its_storage() {
    let mut contract = Contract::new(exchange());
    set_context(owner(), NearToken::from_near(10), T0);
    contract.deposit();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy(vec![]));
    let before = vault(&contract).balance;

    set_context(usdt(), NearToken::from_yoctonear(0), T0);
    let unused = contract.ft_on_transfer(owner(), U128(500), String::new());
    assert!(matches!(unused, PromiseOrValue::Value(U128(0))));
    set_context(usdt(), NearToken::from_yoctonear(0), T0);
    let _ = contract.ft_on_transfer(owner(), U128(25), String::new());

    let entry = token(&contract, &usdt());
    assert_eq!(entry.balance, U128(525));
    assert_eq!(
        vault(&contract).balance,
        before.checked_sub(borsh_cost(&entry)).unwrap()
    );
}

#[test]
#[should_panic(expected = "Token dai.near is not allowlisted in this vault's policy")]
fn token_deposit_rejects_unlisted_tokens() {
    let mut contract = setup();
    set_context(
        "dai.near".parse().unwrap(),
        NearToken::from_yoctonear(0),
        T0,
    );
    let _ = contract.ft_on_transfer(owner(), U128(1), String::new());
}

#[test]
#[should_panic(expected = "Token deposits take an empty msg")]
fn token_deposit_rejects_a_msg() {
    let mut contract = setup();
    set_context(wnear(), NearToken::from_yoctonear(0), T0);
    let _ = contract.ft_on_transfer(owner(), U128(1), "{}".to_string());
}

#[test]
fn failed_token_withdrawal_is_credited_back() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.withdraw_token(wnear(), U128(400)).detach();
    assert_eq!(token(&contract, &wnear()).balance, U128(600));

    as_vault();
    let ok =
        contract.on_token_withdraw_complete(owner(), wnear(), U128(400), Err(PromiseError::Failed));
    assert!(!ok);
    assert_eq!(token(&contract, &wnear()).balance, U128(1_000));
}

#[test]
fn swap_deducts_records_and_pays_storage_once_quoted() {
    let mut contract = setup();
    let near_before = vault(&contract).balance;

    // agent_swap itself only asks for the quote.
    request_swap(&mut contract, 100, 100, T0);
    assert_eq!(token(&contract, &wnear()).balance, U128(1_000));
    assert!(vault(&contract).tokens.iter().all(|t| t.token_id != usdt()));
    assert!(spend_ids(&contract).is_empty());
    assert_eq!(vault(&contract).balance, near_before);

    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0);

    let vault = vault(&contract);
    assert_eq!(token(&contract, &wnear()).balance, U128(900));
    assert_eq!(token(&contract, &usdt()).balance, U128(0));
    let record = Spend {
        spend_id: U64(0),
        timestamp: U64(T0),
        token_id: Some(wnear()),
        amount: U128(100),
    };
    assert_eq!(vault.recent_spends, std::slice::from_ref(&record));
    // The swap's record and its output's new balance entry are both charged to the owner.
    let storage = borsh_cost(&record)
        .checked_add(borsh_cost(&token(&contract, &usdt())))
        .unwrap();
    assert_eq!(vault.balance, near_before.checked_sub(storage).unwrap());
}

#[test]
fn successful_swap_credits_the_exact_output() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);

    as_vault();
    expect_promise(contract.on_swap_deposited(ticket(0, 100), Ok(U128(100))));
    as_vault();
    expect_promise(contract.on_swap_executed(ticket(0, 100), Ok(U128(123))));
    as_vault();
    assert!(contract.on_swap_output_withdrawn(ticket(0, 100), U128(123), Ok(U128(123))));

    assert_eq!(token(&contract, &wnear()).balance, U128(900));
    let output = token(&contract, &usdt());
    assert_eq!((output.balance, output.on_exchange), (U128(123), U128(0)));
    assert_eq!(spend_ids(&contract), [0]); // the swap happened, so it keeps counting
}

#[test]
fn failed_swap_refunds_and_removes_only_its_own_entry() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    swap(&mut contract, 50, T0 + 1);
    let near_before = vault(&contract).balance;

    // Swap 0's exchange call failed (e.g. under min_amount_out): withdraw token_in, then refund.
    as_vault();
    expect_promise(contract.on_swap_executed(ticket(0, 100), Err(PromiseError::Failed)));
    as_vault();
    let swapped =
        contract.on_swap_refund_withdrawn(ticket(0, 100), U128(100), SwapStep::Swap, Ok(U128(100)));

    assert!(!swapped);
    assert_eq!(token(&contract, &wnear()).balance, U128(950));
    assert_eq!(spend_ids(&contract), [1]);
    let freed = borsh_cost(&Spend {
        spend_id: U64(0),
        timestamp: U64(T0),
        token_id: Some(wnear()),
        amount: U128(100),
    });
    assert_eq!(
        vault(&contract).balance,
        near_before.checked_add(freed).unwrap()
    );
}

#[test]
fn failed_deposit_refunds_without_touching_the_exchange() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    swap(&mut contract, 50, T0 + 1);

    as_vault();
    let result = contract.on_swap_deposited(ticket(0, 100), Ok(U128(0)));
    assert!(matches!(result, PromiseOrValue::Value(false)));
    as_vault();
    let result = contract.on_swap_deposited(ticket(1, 50), Err(PromiseError::Failed));
    assert!(matches!(result, PromiseOrValue::Value(false)));

    assert_eq!(token(&contract, &wnear()).balance, U128(1_000));
    assert!(spend_ids(&contract).is_empty());
}

#[test]
fn undelivered_output_is_held_and_reclaimable() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    as_vault();
    // The exchange's transfer to the vault failed, so it kept the output in our deposit account.
    assert!(contract.on_swap_output_withdrawn(ticket(0, 100), U128(123), Ok(U128(0))));
    let output = token(&contract, &usdt());
    assert_eq!((output.balance, output.on_exchange), (U128(0), U128(123)));

    // A failed reclaim leaves it recorded; a successful one credits it.
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 20);
    contract.reclaim_from_exchange(usdt()).detach();
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(0));
    as_vault();
    assert!(!contract.on_reclaim_complete(owner(), usdt(), U128(123), Err(PromiseError::Failed)));
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(123));

    set_context(owner(), NearToken::from_yoctonear(1), T0 + 30);
    contract.reclaim_from_exchange(usdt()).detach();
    as_vault();
    assert!(contract.on_reclaim_complete(owner(), usdt(), U128(123), Ok(U128(123))));
    let output = token(&contract, &usdt());
    assert_eq!((output.balance, output.on_exchange), (U128(123), U128(0)));
}

#[test]
fn undelivered_refund_is_held_and_the_entry_removed() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    as_vault();
    contract.on_swap_refund_withdrawn(ticket(0, 100), U128(100), SwapStep::Swap, Ok(U128(0)));

    let input = token(&contract, &wnear());
    assert_eq!((input.balance, input.on_exchange), (U128(900), U128(100)));
    assert!(spend_ids(&contract).is_empty());
}

#[test]
#[should_panic(expected = "Vault has no usdt.near left on the exchange")]
fn reclaim_needs_something_held() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.reclaim_from_exchange(usdt()).detach();
}

#[test]
#[should_panic(
    expected = "would exceed its 24-hour cap of 250 (200 already sold in the last 24 hours)"
)]
fn swap_daily_cap_is_per_token_and_ignores_near_spends() {
    let mut contract = setup();
    spend(&mut contract, T0);
    swap(&mut contract, 100, T0 + 1);
    swap(&mut contract, 100, T0 + 2);
    swap(&mut contract, 100, T0 + 3);
}

#[test]
fn swap_cap_frees_up_exactly_24h_later() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    swap(&mut contract, 100, T0 + HOUR_NS);
    swap(&mut contract, 50, T0 + WINDOW_NS); // the T0 swap aged out: 100 + 50 sold
    assert_eq!(spend_ids(&contract), [1, 2]);
}

#[test]
#[should_panic(expected = "has made 5 spends in the last 24 hours; the policy allows 5")]
fn swaps_and_spends_share_the_spend_count() {
    let mut contract = setup();
    spend(&mut contract, T0);
    spend(&mut contract, T0 + 1);
    swap(&mut contract, 10, T0 + 2);
    swap(&mut contract, 10, T0 + 3);
    spend(&mut contract, T0 + 4);
    swap(&mut contract, 10, T0 + 5);
}

#[test]
#[should_panic(expected = "Pool 8 is not on the vault's pool allowlist")]
fn swap_rejects_a_pool_not_allowlisted() {
    let mut contract = setup();
    set_context(agent(), NearToken::from_yoctonear(0), T0);
    contract
        .agent_swap(owner(), 8, wnear(), usdt(), U128(10), U128(1))
        .detach();
}

#[test]
#[should_panic(expected = "Pool 7 trades wnear.near and usdt.near, not wnear.near for dai.near")]
fn swap_rejects_a_pair_the_pool_does_not_trade() {
    let mut contract = setup();
    set_context(agent(), NearToken::from_yoctonear(0), T0);
    contract
        .agent_swap(
            owner(),
            POOL,
            wnear(),
            "dai.near".parse().unwrap(),
            U128(10),
            U128(1),
        )
        .detach();
}

#[test]
#[should_panic(expected = "Amount 101 of wnear.near exceeds its per-transaction cap of 100")]
fn swap_rejects_over_the_per_tx_cap() {
    let mut contract = setup();
    swap(&mut contract, 101, T0);
}

#[test]
#[should_panic(expected = "agent_swap needs at least 255 TGas")]
fn swap_rejects_too_little_gas() {
    let mut contract = setup();
    set_context_with_gas(
        agent(),
        NearToken::from_yoctonear(0),
        T0,
        Gas::from_tgas(100),
    );
    contract
        .agent_swap(owner(), POOL, wnear(), usdt(), U128(10), U128(1))
        .detach();
}

#[test]
#[should_panic(expected = "Vault is frozen; agent swapping is disabled")]
fn swap_rejects_when_frozen() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(0), T0);
    contract.freeze();
    swap(&mut contract, 10, T0);
}

#[test]
#[should_panic(expected = "stranger.near is not the registered agent for owner.near's vault")]
fn swap_rejects_anyone_but_the_agent() {
    let mut contract = setup();
    set_context(
        "stranger.near".parse().unwrap(),
        NearToken::from_yoctonear(0),
        T0,
    );
    contract
        .agent_swap(owner(), POOL, wnear(), usdt(), U128(10), U128(1))
        .detach();
}

#[test]
fn slippage_floor_matches_the_direct_formula_and_never_overflows() {
    for quote in [0, 1, 9_999, 10_000, 10_001, 123_456_789, 10u128.pow(30) + 7] {
        for bps in [1, 37, 100, 999, MAX_SLIPPAGE_BPS] {
            let direct = quote * (10_000 - u128::from(bps)) / 10_000;
            assert_eq!(
                slippage_floor(quote, bps),
                direct,
                "quote {quote}, bps {bps}"
            );
        }
    }
    // The direct formula would overflow here.
    let expected = u128::MAX / 10_000 * 9_000 + (u128::MAX % 10_000) * 9_000 / 10_000;
    assert_eq!(slippage_floor(u128::MAX, MAX_SLIPPAGE_BPS), expected);
    assert!(slippage_floor(u128::MAX, 1) < u128::MAX);
}

#[test]
#[should_panic(expected = "max_slippage_bps of pool 7 must be between 1 and 1000")]
fn set_agent_rejects_zero_slippage() {
    let mut contract = setup();
    let mut policy = policy(vec![]);
    policy.pools[0].max_slippage_bps = 0;
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy);
}

#[test]
#[should_panic(expected = "max_slippage_bps of pool 7 must be between 1 and 1000")]
fn set_agent_rejects_more_than_1000_bps_slippage() {
    let mut contract = setup();
    let mut policy = policy(vec![]);
    policy.pools[0].max_slippage_bps = 1_001;
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy);
}

#[test]
fn set_agent_accepts_the_slippage_bounds() {
    let mut contract = setup();
    for bps in [1, MAX_SLIPPAGE_BPS] {
        let mut policy = policy(vec![]);
        policy.pools[0].max_slippage_bps = bps;
        set_context(owner(), NearToken::from_yoctonear(1), T0);
        contract.set_agent(agent(), policy);
        assert_eq!(vault(&contract).policy.pools[0].max_slippage_bps, bps);
    }
}

#[test]
fn min_amount_out_exactly_at_the_slippage_floor_is_accepted() {
    let mut contract = setup();
    // Quote 10_000 with 1% allowed: the floor is 9_900.
    request_swap(&mut contract, 100, 9_900, T0);
    quote_swap(&mut contract, 100, 9_900, Ok(U128(10_000)), T0);
    assert_eq!(token(&contract, &wnear()).balance, U128(900));
    assert_eq!(spend_ids(&contract), [0]);
}

#[test]
#[should_panic(
    expected = "Minimum amount out 9899 is below 9900: the exchange quotes 10000 and pool 7 allows 100 bps of slippage"
)]
fn min_amount_out_below_the_slippage_floor_is_rejected() {
    let mut contract = setup();
    request_swap(&mut contract, 100, 9_899, T0);
    quote_swap(&mut contract, 100, 9_899, Ok(U128(10_000)), T0);
}

#[test]
#[should_panic(expected = "The exchange could not quote pool 7 for wnear.near to usdt.near")]
fn failed_quote_is_rejected() {
    let mut contract = setup();
    request_swap(&mut contract, 100, 100, T0);
    quote_swap(&mut contract, 100, 100, Err(PromiseError::Failed), T0);
}

#[test]
#[should_panic(expected = "Vault is frozen; agent swapping is disabled")]
fn freeze_while_the_quote_is_in_flight_rejects_the_swap() {
    let mut contract = setup();
    request_swap(&mut contract, 100, 100, T0);
    set_context(owner(), NearToken::from_yoctonear(0), T0 + 1);
    contract.freeze();
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 2);
}

#[test]
#[should_panic(expected = "agent.near is not the registered agent for owner.near's vault")]
fn agent_removed_while_the_quote_is_in_flight_rejects_the_swap() {
    let mut contract = setup();
    request_swap(&mut contract, 100, 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 1);
    contract.remove_agent();
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 2);
}

#[test]
#[should_panic(
    expected = "would exceed its 24-hour cap of 250 (200 already sold in the last 24 hours)"
)]
fn caps_are_checked_again_when_two_quotes_race() {
    let mut contract = setup();
    // Both pass agent_swap's own checks while nothing is deducted yet...
    request_swap(&mut contract, 100, 100, T0);
    request_swap(&mut contract, 100, 100, T0 + 1);
    request_swap(&mut contract, 100, 100, T0 + 2);
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 3);
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 4);
    // ...but the third quote callback sees the first two.
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 5);
}

#[test]
fn quote_callback_assigns_spend_ids_in_acceptance_order() {
    let mut contract = setup();
    request_swap(&mut contract, 10, 10, T0);
    spend(&mut contract, T0 + 1); // takes spend id 0 while the swap's quote is in flight
    quote_swap(&mut contract, 10, 10, Ok(U128(10)), T0 + 2);
    assert_eq!(spend_ids(&contract), [0, 1]);
    assert_eq!(vault(&contract).recent_spends[1].token_id, Some(wnear()));
}
