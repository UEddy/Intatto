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
fn treasury() -> AccountId {
    "treasury.near".parse().unwrap()
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
    let mut contract = Contract::new(exchange(), treasury());
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
    ticket_for(owner(), spend_id, amount_in)
}

fn ticket_for(owner_id: AccountId, spend_id: u64, amount_in: u128) -> SwapTicket {
    SwapTicket {
        spend_id: U64(spend_id),
        owner_id,
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
    contract.get_vault(owner()).unwrap().vault
}

fn other() -> AccountId {
    "other.near".parse().unwrap()
}

/// A second vault, for `other`, with the same policy and 1000 wNEAR.
fn add_other_owner(contract: &mut Contract) {
    set_context(other(), NearToken::from_near(10), T0);
    contract.deposit();
    set_context(other(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), policy(vec![merchant()]));
    set_context(wnear(), NearToken::from_yoctonear(0), T0);
    let _ = contract.ft_on_transfer(other(), U128(1_000), String::new());
}

/// A whole swap of `amount_in` wNEAR for `amount_out` USDT by `owner_id`'s agent, accepted as
/// spend `spend_id`, whose output withdrawal is delivered or not.
fn swap_to_output(
    contract: &mut Contract,
    owner_id: AccountId,
    spend_id: u64,
    amount_in: u128,
    amount_out: u128,
    delivered: bool,
    timestamp: u64,
) {
    set_context(agent(), NearToken::from_yoctonear(0), timestamp);
    contract
        .agent_swap(
            owner_id.clone(),
            POOL,
            wnear(),
            usdt(),
            U128(amount_in),
            U128(amount_in),
        )
        .detach();
    let ticket = ticket_for(owner_id, spend_id, amount_in);
    set_context(contract_id(), NearToken::from_yoctonear(0), timestamp);
    contract
        .on_swap_quoted(agent(), ticket.clone(), Ok(U128(amount_in)))
        .detach();
    as_vault();
    expect_promise(contract.on_swap_deposited(ticket.clone(), Ok(U128(amount_in))));
    as_vault();
    expect_promise(contract.on_swap_executed(ticket.clone(), Ok(U128(amount_out))));
    as_vault();
    let withdrawn = if delivered { amount_out } else { 0 };
    assert!(contract.on_swap_output_withdrawn(ticket, U128(amount_out), Ok(U128(withdrawn))));
}

/// The ledger's (expected, in_flight) for `token_id`.
fn ledger_of(contract: &Contract, token_id: &AccountId) -> (u128, u32) {
    let entry = contract.get_exchange_ledger(token_id.clone());
    (entry.expected.0, entry.in_flight)
}

/// `reclaim_from_exchange` of USDT by `owner_id`, then its check callback with the exchange
/// reporting `actual` in the vault's account.
fn reclaim(contract: &mut Contract, owner_id: AccountId, actual: u128, timestamp: u64) {
    set_context(owner_id.clone(), NearToken::from_yoctonear(1), timestamp);
    contract.reclaim_from_exchange(usdt()).detach();
    let generation = contract.get_exchange_ledger(usdt()).generation;
    set_context(contract_id(), NearToken::from_yoctonear(0), timestamp);
    contract
        .on_reclaim_checked(owner_id, usdt(), generation, Ok(U128(actual)))
        .detach();
}

fn lock_until(contract: &mut Contract, until: u64, timestamp: u64) {
    set_context(owner(), NearToken::from_yoctonear(1), timestamp);
    contract.lock_withdrawals_until(U64(until));
}

fn locked_until(contract: &Contract) -> Option<u64> {
    contract
        .get_vault(owner())
        .unwrap()
        .withdrawals_locked_until
        .map(|until| until.0)
}

/// No pools, no tokens, nobody to pay, zero NEAR caps. `max_spends_per_24h` cannot be 0, but with
/// every cap at zero the count never matters.
fn zero_outflow_policy() -> Policy {
    Policy {
        per_tx_cap: NearToken::from_yoctonear(0),
        daily_cap: NearToken::from_yoctonear(0),
        max_spends_per_24h: 1,
        allowlist: vec![],
        tokens: vec![],
        pools: vec![],
    }
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

/// What a new exchange ledger entry costs: its own storage record (key, value and the runtime's
/// 40 bytes of overhead per record).
fn ledger_entry_cost(token_id: &AccountId) -> NearToken {
    let key = [b"x".to_vec(), near_sdk::borsh::to_vec(token_id).unwrap()].concat();
    let value = near_sdk::borsh::to_vec(&ExchangeLedger::default()).unwrap();
    storage_cost((key.len() + value.len() + 40) as u64)
}

/// What a new treasury fee entry costs: key `b"f"` + Borsh token id, a `U128` value, and the
/// runtime's 40 bytes of overhead per record.
fn fee_entry_cost(token_id: &AccountId) -> NearToken {
    let key = [b"f".to_vec(), near_sdk::borsh::to_vec(token_id).unwrap()].concat();
    storage_cost((key.len() + 16 + 40) as u64)
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
    let mut contract = Contract::new(exchange(), treasury());
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
    let mut contract = Contract::new(exchange(), treasury());
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
    let mut contract = Contract::new(exchange(), treasury());
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
    // The swap's record, its output's new balance entry, the first ledger entries of both tokens
    // and the treasury's fee entry for the output are all charged to the owner.
    let storage = borsh_cost(&record)
        .checked_add(borsh_cost(&token(&contract, &usdt())))
        .and_then(|cost| cost.checked_add(ledger_entry_cost(&wnear())))
        .and_then(|cost| cost.checked_add(ledger_entry_cost(&usdt())))
        .and_then(|cost| cost.checked_add(fee_entry_cost(&usdt())))
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
    // The exchange's transfer to the vault failed, so it kept the output in our deposit account.
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    let output = token(&contract, &usdt());
    assert_eq!((output.balance, output.on_exchange), (U128(0), U128(123)));
    assert_eq!(ledger_of(&contract, &usdt()), (123, 0));

    // A failed reclaim leaves it recorded; a successful one credits it.
    reclaim(&mut contract, owner(), 123, T0 + 20);
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(0));
    assert_eq!(ledger_of(&contract, &usdt()), (123, 1));
    as_vault();
    assert!(!contract.on_reclaim_complete(owner(), usdt(), U128(123), Err(PromiseError::Failed)));
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(123));
    assert_eq!(ledger_of(&contract, &usdt()), (123, 0));

    reclaim(&mut contract, owner(), 123, T0 + 30);
    as_vault();
    assert!(contract.on_reclaim_complete(owner(), usdt(), U128(123), Ok(U128(123))));
    let output = token(&contract, &usdt());
    assert_eq!((output.balance, output.on_exchange), (U128(123), U128(0)));
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));
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

#[test]
#[should_panic(expected = "Withdrawals are locked until 1700000000000000100 (block timestamp, ns)")]
fn locked_withdraw_is_rejected_one_ns_before_the_lock_ends() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 99);
    contract.withdraw(NearToken::from_near(1)).detach();
}

#[test]
#[should_panic(expected = "Withdrawals are locked until")]
fn locked_token_withdraw_is_rejected() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 50);
    contract.withdraw_token(wnear(), U128(1)).detach();
}

#[test]
fn withdrawals_work_again_exactly_when_the_lock_ends() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    let balance = vault(&contract).balance;
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 100);
    contract.withdraw(NearToken::from_near(1)).detach();
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 100);
    contract.withdraw_token(wnear(), U128(400)).detach();
    assert_eq!(
        vault(&contract).balance,
        balance.checked_sub(NearToken::from_near(1)).unwrap()
    );
    assert_eq!(token(&contract, &wnear()).balance, U128(600));
}

#[test]
fn lock_is_shown_extended_and_charged_for_once() {
    let mut contract = setup();
    assert_eq!(locked_until(&contract), None);
    let before = vault(&contract).balance;
    lock_until(&mut contract, T0 + 100, T0);
    assert_eq!(locked_until(&contract), Some(T0 + 100));
    let after_first = vault(&contract).balance;
    assert!(after_first < before); // the lock's storage

    lock_until(&mut contract, T0 + 100, T0 + 1); // the same value is allowed
    lock_until(&mut contract, T0 + 500, T0 + 2);
    assert_eq!(locked_until(&contract), Some(T0 + 500));
    assert_eq!(vault(&contract).balance, after_first); // same entry, no new storage
}

#[test]
#[should_panic(
    expected = "Withdrawals are already locked until 1700000000000000500; a lock can only be extended"
)]
fn lock_cannot_be_shortened() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 500, T0);
    lock_until(&mut contract, T0 + 499, T0 + 1);
}

#[test]
#[should_panic(expected = "a lock can only be extended")]
fn expired_lock_still_cannot_be_moved_earlier() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 500, T0);
    lock_until(&mut contract, T0 + 10, T0 + 1_000);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn lock_requires_one_yocto() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(0), T0);
    contract.lock_withdrawals_until(U64(T0 + 100));
}

#[test]
#[should_panic(expected = "No vault found for stranger.near; call deposit first")]
fn lock_requires_a_vault() {
    let mut contract = setup();
    set_context(
        "stranger.near".parse().unwrap(),
        NearToken::from_yoctonear(1),
        T0,
    );
    contract.lock_withdrawals_until(U64(T0 + 100));
}

#[test]
fn lock_leaves_the_agent_and_freeze_as_they_were() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + WINDOW_NS, T0);
    // The agent still spends and swaps within its policy...
    spend(&mut contract, T0 + 1);
    swap(&mut contract, 100, T0 + 2);
    assert_eq!(spend_ids(&contract), [0, 1]);
    // ...and freeze and unfreeze work as before.
    set_context(owner(), NearToken::from_yoctonear(0), T0 + 3);
    contract.freeze();
    assert!(vault(&contract).frozen);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 4);
    contract.unfreeze();
    assert!(!vault(&contract).frozen);
}

#[test]
fn set_agent_accepts_a_zero_outflow_policy() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), zero_outflow_policy());
    assert_eq!(vault(&contract).policy, zero_outflow_policy());
}

#[test]
#[should_panic(expected = "Receiver merchant.near is not on the vault's allowlist")]
fn zero_outflow_policy_rejects_spends() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), zero_outflow_policy());
    set_context(agent(), NearToken::from_yoctonear(0), T0);
    contract
        .agent_spend(owner(), merchant(), NearToken::from_yoctonear(1))
        .detach();
}

#[test]
#[should_panic(expected = "Pool 7 is not on the vault's pool allowlist")]
fn zero_outflow_policy_rejects_swaps() {
    let mut contract = setup();
    set_context(owner(), NearToken::from_yoctonear(1), T0);
    contract.set_agent(agent(), zero_outflow_policy());
    request_swap(&mut contract, 1, 1, T0);
}

#[test]
#[should_panic(expected = "Pool 7 is not on the vault's pool allowlist")]
fn zero_outflow_policy_rejects_a_quote_already_in_flight() {
    let mut contract = setup();
    // Requested under the old policy, quoted after the owner switched to zero outflow.
    request_swap(&mut contract, 100, 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 1);
    contract.set_agent(agent(), zero_outflow_policy());
    quote_swap(&mut contract, 100, 100, Ok(U128(100)), T0 + 2);
}

#[test]
#[should_panic(
    expected = "Withdrawals are locked until 1700000000000000100 (block timestamp, ns); set_agent is disabled until then"
)]
fn set_agent_is_rejected_while_locked() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 99);
    contract.set_agent(agent(), zero_outflow_policy());
}

#[test]
fn set_agent_rejection_is_logged() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 99);
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.set_agent(agent(), zero_outflow_policy());
    }));
    assert!(rejected.is_err());
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter()
            .any(|log| log.contains(r#""event":"set_agent_rejected""#)
                && log.contains(r#""locked_until":"1700000000000000100""#)),
        "{logs:?}"
    );
}

#[test]
fn set_agent_works_again_once_the_lock_ends() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + 100, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 100);
    contract.set_agent(agent(), zero_outflow_policy());
    assert_eq!(vault(&contract).policy, zero_outflow_policy());
}

#[test]
fn remove_agent_freeze_and_unfreeze_work_while_locked() {
    let mut contract = setup();
    lock_until(&mut contract, T0 + WINDOW_NS, T0);
    set_context(owner(), NearToken::from_yoctonear(0), T0 + 1);
    contract.freeze();
    assert!(vault(&contract).frozen);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 2);
    contract.unfreeze();
    assert!(!vault(&contract).frozen);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 3);
    contract.remove_agent();
    assert_eq!(vault(&contract).agent_id, None);
    assert_eq!(vault(&contract).policy, Policy::default());
}

#[test]
fn ledger_tracks_a_swap_in_flight_and_clears_when_it_settles() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    // wNEAR is on its way to the exchange; USDT will arrive there.
    assert_eq!(ledger_of(&contract, &wnear()), (100, 1));
    assert_eq!(ledger_of(&contract, &usdt()), (0, 1));
    as_vault();
    expect_promise(contract.on_swap_deposited(ticket(0, 100), Ok(U128(100))));
    as_vault();
    expect_promise(contract.on_swap_executed(ticket(0, 100), Ok(U128(123))));
    assert_eq!(ledger_of(&contract, &wnear()), (0, 1));
    assert_eq!(ledger_of(&contract, &usdt()), (123, 1));
    as_vault();
    assert!(contract.on_swap_output_withdrawn(ticket(0, 100), U128(123), Ok(U128(123))));
    assert_eq!(ledger_of(&contract, &wnear()), (0, 0));
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));
}

#[test]
fn ledger_clears_on_every_refund_path() {
    let mut contract = setup();
    // The token refunded the deposit.
    swap(&mut contract, 100, T0);
    as_vault();
    let _ = contract.on_swap_deposited(ticket(0, 100), Ok(U128(0)));
    assert_eq!(ledger_of(&contract, &wnear()), (0, 0));
    // The swap failed and its refund came back.
    swap(&mut contract, 100, T0 + 1);
    as_vault();
    expect_promise(contract.on_swap_executed(ticket(1, 100), Err(PromiseError::Failed)));
    as_vault();
    contract.on_swap_refund_withdrawn(ticket(1, 100), U128(100), SwapStep::Swap, Ok(U128(100)));
    assert_eq!(ledger_of(&contract, &wnear()), (0, 0));
    // The exchange kept 60 of 100: 40 come back now, then 60 are withdrawn.
    swap(&mut contract, 100, T0 + 2);
    as_vault();
    expect_promise(contract.on_swap_deposited(ticket(2, 100), Ok(U128(60))));
    assert_eq!(ledger_of(&contract, &wnear()), (60, 1));
    as_vault();
    contract.on_swap_refund_withdrawn(ticket(2, 100), U128(60), SwapStep::Deposit, Ok(U128(60)));
    assert_eq!(ledger_of(&contract, &wnear()), (0, 0));
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));
    assert_eq!(token(&contract, &wnear()).balance, U128(1_000));
}

#[test]
fn undelivered_refund_stays_expected_on_the_exchange() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    as_vault();
    contract.on_swap_refund_withdrawn(ticket(0, 100), U128(100), SwapStep::Swap, Ok(U128(0)));
    assert_eq!(token(&contract, &wnear()).on_exchange, U128(100));
    assert_eq!(ledger_of(&contract, &wnear()), (100, 0));
}

#[test]
#[should_panic(
    expected = "The vault's exchange account holds 50 of usdt.near but owners are owed 173; reclaims of usdt.near are refused until the shortfall is resolved"
)]
fn reclaim_is_refused_when_the_exchange_holds_less_than_owners_are_owed() {
    let mut contract = setup();
    add_other_owner(&mut contract);
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    swap_to_output(&mut contract, other(), 1, 40, 50, false, T0 + 1);
    assert_eq!(ledger_of(&contract, &usdt()), (173, 0));
    // owner's 123 went to lostfound: the account only holds other's 50. other's reclaim is
    // refused too, so owner's loss is never moved onto other.
    reclaim(&mut contract, other(), 50, T0 + 2);
}

#[test]
fn shortfall_is_logged_and_changes_nothing() {
    let mut contract = setup();
    add_other_owner(&mut contract);
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    swap_to_output(&mut contract, other(), 1, 40, 50, false, T0 + 1);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reclaim(&mut contract, owner(), 50, T0 + 2);
    }));
    assert!(refused.is_err());
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter()
            .any(|log| log.contains(r#""event":"exchange_shortfall""#)
                && log.contains(r#""expected":"173""#)
                && log.contains(r#""actual":"50""#)),
        "{logs:?}"
    );
}

#[test]
#[should_panic(
    expected = "Swaps or reclaims of usdt.near are in flight on the exchange; retry once they have settled"
)]
fn reclaim_is_refused_while_a_swap_of_the_token_is_in_flight() {
    let mut contract = setup();
    add_other_owner(&mut contract);
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    // other's swap paying out USDT has started.
    set_context(agent(), NearToken::from_yoctonear(0), T0 + 1);
    contract
        .agent_swap(other(), POOL, wnear(), usdt(), U128(40), U128(40))
        .detach();
    set_context(contract_id(), NearToken::from_yoctonear(0), T0 + 1);
    contract
        .on_swap_quoted(agent(), ticket_for(other(), 1, 40), Ok(U128(40)))
        .detach();
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 2);
    contract.reclaim_from_exchange(usdt()).detach();
}

#[test]
#[should_panic(expected = "Swaps or reclaims of usdt.near are in flight on the exchange")]
fn reclaim_is_refused_if_a_swap_started_while_checking() {
    let mut contract = setup();
    add_other_owner(&mut contract);
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    set_context(owner(), NearToken::from_yoctonear(1), T0 + 1);
    contract.reclaim_from_exchange(usdt()).detach();
    let generation = contract.get_exchange_ledger(usdt()).generation;
    // other's whole swap runs between the exchange's balance query and the check: the balance
    // the query saw may include its output, which has left again by now.
    swap_to_output(&mut contract, other(), 1, 40, 50, true, T0 + 2);
    assert_eq!(ledger_of(&contract, &usdt()), (123, 0));
    set_context(contract_id(), NearToken::from_yoctonear(0), T0 + 3);
    contract
        .on_reclaim_checked(owner(), usdt(), generation, Ok(U128(173)))
        .detach();
}

#[test]
#[should_panic(expected = "reclaim_from_exchange needs at least 115 TGas")]
fn reclaim_needs_enough_gas() {
    let mut contract = setup();
    swap_to_output(&mut contract, owner(), 0, 100, 123, false, T0);
    set_context_with_gas(
        owner(),
        NearToken::from_yoctonear(1),
        T0 + 1,
        Gas::from_tgas(100),
    );
    contract.reclaim_from_exchange(usdt()).detach();
}

#[test]
fn ledger_underflow_is_logged_and_clamped_without_panicking() {
    let mut contract = setup();
    swap(&mut contract, 100, T0);
    // A delivered output the ledger never saw arrive, as for a swap started before the ledger.
    as_vault();
    assert!(contract.on_swap_output_withdrawn(ticket(0, 100), U128(123), Ok(U128(123))));
    assert_eq!(token(&contract, &usdt()).balance, U128(123));
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter()
            .any(|log| log.contains(r#""event":"exchange_ledger_underflow""#)),
        "{logs:?}"
    );
}

/* ---------- protocol fee ---------- */

/// The treasury's accrued USDT fees.
fn fees(contract: &Contract) -> u128 {
    contract.get_fees(usdt()).0
}

/// A delivered swap of 100 wNEAR whose output is `amount_out` USDT, so the treasury accrues
/// `split_fee(amount_out).1`.
fn accrue_fees(contract: &mut Contract, amount_out: u128) {
    swap_to_output(contract, owner(), 0, 100, amount_out, true, T0);
}

fn withdraw_fees_as(contract: &mut Contract, caller: AccountId, deposit: u128, amount: u128) {
    set_context(caller, NearToken::from_yoctonear(deposit), T0 + 20);
    contract.withdraw_fees(usdt(), U128(amount)).detach();
}

#[test]
fn fee_is_ten_bps_and_within_the_hard_cap() {
    assert_eq!(FEE_BPS, 10);
    assert_eq!(MAX_FEE_BPS, 10);
    let contract = setup();
    assert_eq!(contract.get_fee_bps(), FEE_BPS);
    assert_eq!(contract.get_treasury_id(), Some(treasury()));
}

#[test]
fn fee_split_rounds_down_and_always_adds_up() {
    // (amount_out, net, fee)
    let cases = [
        (0, 0, 0),
        (1, 1, 0),
        (999, 999, 0), // 999 * 10 < 10000: no fee
        (1_000, 999, 1),
        (1_999, 1_998, 1),
        (9_999, 9_990, 9),
        (10_000, 9_990, 10),
        (
            10_000_000_000_000_000_000_000_000,
            9_990_000_000_000_000_000_000_000,
            10_000_000_000_000_000_000_000,
        ),
    ];
    for (amount_out, net, fee) in cases {
        assert_eq!(split_fee(amount_out), (net, fee), "amount_out {amount_out}");
    }
    // Exactly floor(amount_out * 10 / 10000), and net + fee == amount_out, wherever the product fits.
    for amount_out in (0..50_000u128).chain([u128::MAX / 10 - 1, u128::MAX / 10]) {
        let (net, fee) = split_fee(amount_out);
        assert_eq!(
            fee,
            amount_out * u128::from(FEE_BPS) / 10_000,
            "amount_out {amount_out}"
        );
        assert_eq!(net + fee, amount_out);
    }
    // No overflow at the top of the range either.
    let (net, fee) = split_fee(u128::MAX);
    assert_eq!(net.checked_add(fee), Some(u128::MAX));
    assert_eq!(
        fee,
        u128::MAX / 10_000 * 10 + (u128::MAX % 10_000) * 10 / 10_000
    );
}

#[test]
fn delivered_output_credits_net_to_the_owner_and_the_fee_to_the_treasury() {
    let mut contract = setup();
    accrue_fees(&mut contract, 10_000);
    assert_eq!(token(&contract, &usdt()).balance, U128(9_990));
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(0));
    assert_eq!(fees(&contract), 10);
    // The whole output was withdrawn to the vault: nothing is expected on the exchange.
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));
}

#[test]
fn output_held_on_the_exchange_carries_no_fee() {
    let mut contract = setup();
    swap_to_output(&mut contract, owner(), 0, 100, 10_000, false, T0);
    assert_eq!(token(&contract, &usdt()).balance, U128(0));
    assert_eq!(token(&contract, &usdt()).on_exchange, U128(10_000));
    assert_eq!(fees(&contract), 0);
    assert_eq!(ledger_of(&contract, &usdt()), (10_000, 0));
}

#[test]
fn tiny_output_carries_no_fee() {
    let mut contract = setup();
    accrue_fees(&mut contract, 999);
    assert_eq!(token(&contract, &usdt()).balance, U128(999));
    assert_eq!(fees(&contract), 0);
}

#[test]
fn refunded_swaps_carry_no_fee() {
    let mut contract = setup();
    // The exchange's swap fails (e.g. below min_amount_out), and the refund arrives.
    swap(&mut contract, 100, T0);
    as_vault();
    expect_promise(contract.on_swap_deposited(ticket(0, 100), Ok(U128(100))));
    as_vault();
    expect_promise(contract.on_swap_executed(ticket(0, 100), Err(PromiseError::Failed)));
    as_vault();
    assert!(!contract.on_swap_refund_withdrawn(
        ticket(0, 100),
        U128(100),
        SwapStep::Swap,
        Ok(U128(100))
    ));
    // The deposit fails outright.
    swap(&mut contract, 100, T0 + 1);
    as_vault();
    let refunded = contract.on_swap_deposited(ticket(1, 100), Ok(U128(0)));
    assert!(matches!(refunded, PromiseOrValue::Value(false)));
    assert_eq!(token(&contract, &wnear()).balance, U128(1_000));
    assert_eq!(fees(&contract), 0);
}

#[test]
fn treasury_withdraws_accrued_fees_without_touching_owner_balances() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    assert_eq!(fees(&contract), 100);
    let owner_before = vault(&contract);

    withdraw_fees_as(&mut contract, treasury(), 1, 60);
    assert_eq!(fees(&contract), 40);
    assert_eq!(vault(&contract).tokens, owner_before.tokens);
    assert_eq!(vault(&contract).balance, owner_before.balance);
    assert_eq!(ledger_of(&contract, &usdt()), (0, 0));

    // A successful transfer changes nothing more.
    as_vault();
    assert!(contract.on_fees_withdraw_complete(treasury(), usdt(), U128(60), Ok(())));
    assert_eq!(fees(&contract), 40);
}

#[test]
fn failed_fee_transfer_is_credited_back_once() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, treasury(), 1, 100);
    assert_eq!(fees(&contract), 0);
    as_vault();
    assert!(!contract.on_fees_withdraw_complete(
        treasury(),
        usdt(),
        U128(100),
        Err(PromiseError::Failed)
    ));
    assert_eq!(fees(&contract), 100);
    assert_eq!(token(&contract, &usdt()).balance, U128(99_900));
}

#[test]
#[should_panic(expected = "exceeds the accrued usdt.near fees of 100")]
fn treasury_cannot_withdraw_more_than_accrued() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    // The vault holds 99,900 USDT of the owner's, but the treasury is owed only 100.
    withdraw_fees_as(&mut contract, treasury(), 1, 101);
}

#[test]
#[should_panic(expected = "exceeds the accrued wnear.near fees of 0")]
fn treasury_cannot_withdraw_a_token_with_no_fees() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    // The vault holds the owner's wNEAR, none of it fees.
    set_context(treasury(), NearToken::from_yoctonear(1), T0 + 20);
    contract.withdraw_fees(wnear(), U128(1)).detach();
}

#[test]
#[should_panic(expected = "Only the treasury account can withdraw fees")]
fn owner_cannot_withdraw_fees() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, owner(), 1, 1);
}

#[test]
#[should_panic(expected = "Only the treasury account can withdraw fees")]
fn agent_cannot_withdraw_fees() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, agent(), 1, 1);
}

#[test]
#[should_panic(expected = "Only the treasury account can withdraw fees")]
fn the_contract_itself_cannot_withdraw_fees() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, contract_id(), 1, 1);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn fee_withdrawal_needs_exactly_one_yocto() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, treasury(), 0, 1);
}

#[test]
#[should_panic(expected = "Withdrawal amount must be greater than zero")]
fn zero_fee_withdrawal_is_rejected() {
    let mut contract = setup();
    accrue_fees(&mut contract, 100_000);
    withdraw_fees_as(&mut contract, treasury(), 1, 0);
}

#[test]
#[should_panic(expected = "The treasury cannot be the vault contract itself")]
fn treasury_cannot_be_the_contract() {
    set_context(owner(), NearToken::from_yoctonear(0), T0);
    let _ = Contract::new(exchange(), contract_id());
}
