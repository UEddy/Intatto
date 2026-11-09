//! Agent swaps through the Rhea (Ref) V1 exchange: the policy and slippage checks, and the
//! promise chain that deposits, swaps and withdraws.
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, Promise, assert_one_yocto, env, ext_contract, near, require};

use crate::events::{Attempt, RejectReason, VaultEvent};
use crate::fees;
use crate::ledger::{self, ExchangeLedger};
use crate::spend::Spend;
use crate::tokens::{MAX_TOKEN_BALANCES, ext_ft};
use crate::{CALLBACK_GAS, Contract, ContractExt, ONE_YOCTO, add_amounts, sub_amounts};

/// Minimum gas an owner must attach to `reclaim_from_exchange`, in TGas: the call itself, the
/// exchange's balance query and the check that follows it.
pub const RECLAIM_TGAS: u64 = 20 + EXCHANGE_GET_DEPOSIT_TGAS + ON_RECLAIM_CHECKED_TGAS;
pub const EXCHANGE_GET_DEPOSIT_TGAS: u64 = 10;
/// The balance check, the withdrawal, and the callback that settles it.
pub const ON_RECLAIM_CHECKED_TGAS: u64 = 15 + EXCHANGE_WITHDRAW_TGAS + CALLBACK_GAS.as_tgas();

/// Basis points in a whole.
const BPS_DENOMINATOR: u128 = 10_000;

/// Minimum gas an agent must attach to `agent_swap`, in TGas: the call itself plus every step of
/// the swap's promise chain.
pub const AGENT_SWAP_TGAS: u64 = 20 + EXCHANGE_GET_RETURN_TGAS + ON_SWAP_QUOTED_TGAS;

// Gas for each step of a swap, in TGas. Each callback reserves what the rest of the chain needs.
pub const EXCHANGE_GET_RETURN_TGAS: u64 = 10;
pub const FT_TRANSFER_CALL_TGAS: u64 = 60;
pub const EXCHANGE_SWAP_TGAS: u64 = 40;
pub const EXCHANGE_WITHDRAW_TGAS: u64 = 60;
pub const SWAP_CALLBACK_TGAS: u64 = 15;
pub const ON_SWAP_WITHDRAWN_TGAS: u64 = SWAP_CALLBACK_TGAS;
pub const ON_SWAP_EXECUTED_TGAS: u64 =
    SWAP_CALLBACK_TGAS + EXCHANGE_WITHDRAW_TGAS + ON_SWAP_WITHDRAWN_TGAS;
pub const ON_SWAP_DEPOSITED_TGAS: u64 =
    SWAP_CALLBACK_TGAS + EXCHANGE_SWAP_TGAS + ON_SWAP_EXECUTED_TGAS;
/// The quote callback re-runs every policy check and writes the swap's record, so it keeps more
/// for itself than the other callbacks.
pub const ON_SWAP_QUOTED_TGAS: u64 = 20 + FT_TRANSFER_CALL_TGAS + ON_SWAP_DEPOSITED_TGAS;

/// One `agent_swap`, carried through every step of its promise chain.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SwapTicket {
    /// Assigned when the quote callback accepts the swap; until then it is only provisional.
    pub spend_id: U64,
    pub owner_id: AccountId,
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
}

/// Which step of a refunded swap failed.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapStep {
    /// Depositing token_in into the vault's exchange account.
    Deposit,
    /// The exchange's swap itself, e.g. output below `min_amount_out`.
    Swap,
}

/// A swap action as the exchange's `swap` method takes it (ref-exchange `SwapAction`).
#[near(serializers = [json])]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

/// Rhea (Ref) V1 exchange methods the vault calls, as defined in ref-exchange 1.9.19
/// (`ref-exchange/src/views.rs` and `lib.rs`). `swap` and `withdraw` act on the vault's own
/// deposit account on the exchange.
#[ext_contract(ext_exchange)]
pub trait Exchange {
    /// View: how much of `token_id` the exchange holds for `account_id` (0 if none).
    fn get_deposit(&self, account_id: AccountId, token_id: AccountId) -> U128;
    /// View: the amount of `token_out` that swapping `amount_in` of `token_in` through `pool_id`
    /// would return right now, after fees. Panics for an unknown pool or a pair it doesn't trade.
    fn get_return(
        &self,
        pool_id: u64,
        token_in: AccountId,
        amount_in: U128,
        token_out: AccountId,
    ) -> U128;
    /// Returns the amount out of the last action.
    fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<AccountId>) -> U128;
    /// Resolves to `amount` once the tokens reached the vault, or 0 if sending them failed and
    /// the exchange put them back in the vault's deposit account.
    fn withdraw(
        &mut self,
        token_id: AccountId,
        amount: U128,
        unregister: Option<bool>,
        skip_unwrap_near: Option<bool>,
    ) -> U128;
}

#[near]
impl Contract {
    /// Swaps `amount_in` of `token_in` from `owner_id`'s vault for `token_out` through exchange
    /// pool `pool_id`. Only the vault's registered agent may call this, and only within the
    /// vault's policy; it needs at least `AGENT_SWAP_TGAS` of gas.
    ///
    /// This call checks the policy and asks the exchange for a quote (`get_return`); it changes no
    /// state. `on_swap_quoted` checks the policy again against the state at that point, rejects a
    /// `min_amount_out` further below the quote than the pool's `max_slippage_bps`, and only then
    /// deducts token_in and records the swap. The chain then deposits token_in into the vault's
    /// exchange account, swaps it there (learning the exact output from the exchange's return
    /// value), and withdraws the output to the vault, crediting the owner exactly that amount. If
    /// the deposit or swap fails, token_in is refunded and the record removed.
    pub fn agent_swap(
        &mut self,
        owner_id: AccountId,
        pool_id: u64,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        min_amount_out: U128,
    ) -> Promise {
        let caller_id = env::predecessor_account_id();
        let ticket = SwapTicket {
            spend_id: U64(self.next_spend_id),
            owner_id,
            pool_id,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
        };
        let attempt = Attempt::Swap {
            caller_id: &caller_id,
            ticket: &ticket,
        };
        // Fail fast, before paying for a quote. The callback repeats these checks.
        self.check_swap(&attempt, env::block_timestamp(), true);

        ext_exchange::ext(self.exchange_id.clone())
            .with_static_gas(Gas::from_tgas(EXCHANGE_GET_RETURN_TGAS))
            .get_return(
                pool_id,
                ticket.token_in.clone(),
                amount_in,
                ticket.token_out.clone(),
            )
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_SWAP_QUOTED_TGAS))
                    .on_swap_quoted(caller_id, ticket),
            )
    }

    /// Retries withdrawing the caller's `token_id` left in the vault's exchange account after an
    /// earlier withdrawal from the exchange failed. Works while frozen and while withdrawals are
    /// locked (the tokens stay in the vault). Requires exactly 1 yoctoNEAR (full-access key only)
    /// and at least `RECLAIM_TGAS` of gas.
    ///
    /// Every owner's tokens on the exchange share the vault's one account there, so this first
    /// asks the exchange how much of `token_id` that account holds (`get_deposit`).
    /// `on_reclaim_checked` withdraws the caller's own `on_exchange` amount only if the account
    /// holds at least what the ledger says all owners are owed, and only if no swap or reclaim of
    /// `token_id` started in the meantime. Otherwise it refuses and changes nothing.
    #[payable]
    pub fn reclaim_from_exchange(&mut self, token_id: AccountId) -> Promise {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let held = self
            .vaults
            .get(&owner_id)
            .unwrap_or_else(|| {
                env::panic_str(&format!(
                    "No vault found for {owner_id}; call deposit first"
                ))
            })
            .tokens
            .iter()
            .find(|entry| entry.token_id == token_id)
            .map_or(0, |entry| entry.on_exchange.0);
        require!(
            held > 0,
            format!("Vault has no {token_id} left on the exchange")
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(RECLAIM_TGAS),
            format!("reclaim_from_exchange needs at least {RECLAIM_TGAS} TGas")
        );
        let entry = ledger::ledger(&token_id);
        require!(entry.in_flight == 0, busy_message(&token_id));

        ext_exchange::ext(self.exchange_id.clone())
            .with_static_gas(Gas::from_tgas(EXCHANGE_GET_DEPOSIT_TGAS))
            .get_deposit(env::current_account_id(), token_id.clone())
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_RECLAIM_CHECKED_TGAS))
                    .on_reclaim_checked(owner_id, token_id, entry.generation),
            )
    }

    /// The vault-wide ledger entry of `token_id`: what the vault's exchange account should hold
    /// of it, and how many swaps and reclaims of it are in flight.
    pub fn get_exchange_ledger(&self, token_id: AccountId) -> ExchangeLedger {
        ledger::ledger(&token_id)
    }
}

/// Why a reclaim of `token_id` cannot go ahead right now.
pub fn busy_message(token_id: &AccountId) -> String {
    format!(
        "Swaps or reclaims of {token_id} are in flight on the exchange; retry once they have settled"
    )
}

impl Contract {
    /// Marks a swap's two tokens as no longer in flight. Every swap ends here exactly once.
    pub fn end_swap(ticket: &SwapTicket) {
        ledger::finish(&ticket.token_in);
        ledger::finish(&ticket.token_out);
    }

    /// Every policy check of an agent swap, in order; rejects the attempt on the first that fails.
    /// Changes no state. `at_entry` adds the gas check, which only `agent_swap` itself can make.
    /// Returns the pool's `max_slippage_bps`.
    pub fn check_swap(&self, attempt: &Attempt, now: u64, at_entry: bool) -> u16 {
        let Attempt::Swap { caller_id, ticket } = attempt else {
            env::panic_str("check_swap takes a swap attempt");
        };
        let SwapTicket {
            owner_id,
            pool_id,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
            ..
        } = ticket;
        let caller_id = *caller_id;

        let Some(vault) = self.vaults.get(owner_id) else {
            attempt.reject(
                RejectReason::NoVault,
                &format!("No vault exists for {owner_id}"),
            );
        };
        attempt.require(
            vault.agent_id.as_ref() == Some(caller_id),
            RejectReason::NotAgent,
            || format!("{caller_id} is not the registered agent for {owner_id}'s vault"),
        );
        attempt.require(amount_in.0 > 0, RejectReason::ZeroAmount, || {
            "Swap amount must be greater than zero".to_string()
        });
        attempt.require(min_amount_out.0 > 0, RejectReason::ZeroMinAmountOut, || {
            "Minimum amount out must be greater than zero".to_string()
        });
        attempt.require(
            !at_entry || env::prepaid_gas() >= Gas::from_tgas(AGENT_SWAP_TGAS),
            RejectReason::InsufficientGas,
            || format!("agent_swap needs at least {AGENT_SWAP_TGAS} TGas"),
        );
        attempt.require(!vault.frozen, RejectReason::Frozen, || {
            "Vault is frozen; agent swapping is disabled".to_string()
        });
        let Some(pool) = vault
            .policy
            .pools
            .iter()
            .find(|pool| pool.pool_id == *pool_id)
        else {
            attempt.reject(
                RejectReason::PoolNotAllowlisted,
                &format!("Pool {pool_id} is not on the vault's pool allowlist"),
            );
        };
        attempt.require(
            token_in != token_out
                && pool.token_ids.contains(token_in)
                && pool.token_ids.contains(token_out),
            RejectReason::PairMismatch,
            || {
                format!(
                    "Pool {pool_id} trades {} and {}, not {token_in} for {token_out}",
                    pool.token_ids[0], pool.token_ids[1]
                )
            },
        );
        // The policy guarantees caps for every token of an allowlisted pool.
        let Some(caps) = vault
            .policy
            .tokens
            .iter()
            .find(|token| &token.token_id == token_in)
        else {
            attempt.reject(
                RejectReason::PairMismatch,
                &format!("Token {token_in} has no caps in the policy"),
            );
        };
        attempt.require(
            amount_in.0 <= caps.per_tx_cap.0,
            RejectReason::OverPerTxCap,
            || {
                format!(
                    "Amount {} of {token_in} exceeds its per-transaction cap of {}",
                    amount_in.0, caps.per_tx_cap.0
                )
            },
        );

        // Swaps share the sliding window and spend count with NEAR spends; caps are per token.
        let (spend_count, sold) = vault.window_usage(now, Some(token_in));
        let max_spends = vault.policy.max_spends_per_24h;
        attempt.require(
            spend_count < max_spends as usize,
            RejectReason::TooManySpends,
            || {
                format!(
                    "The agent has made {spend_count} spends in the last 24 hours; the policy allows {max_spends}"
                )
            },
        );
        attempt.require(
            add_amounts(sold, amount_in.0) <= caps.daily_cap.0,
            RejectReason::OverDailyCap,
            || {
                format!(
                    "Amount {} of {token_in} would exceed its 24-hour cap of {} ({sold} already sold in the last 24 hours)",
                    amount_in.0, caps.daily_cap.0
                )
            },
        );
        let balance_in = vault.token_balance(token_in);
        attempt.require(
            amount_in.0 <= balance_in,
            RejectReason::InsufficientBalance,
            || {
                format!(
                    "Amount {} exceeds the vault's {token_in} balance of {balance_in}",
                    amount_in.0
                )
            },
        );
        pool.max_slippage_bps
    }

    /// Accepts a swap that passed `check_swap` and the slippage check: deducts token_in, records
    /// the swap, pays for the record's storage, then deposits token_in into the vault's exchange
    /// account.
    pub fn begin_swap(&mut self, attempt: &Attempt, now: u64) -> Promise {
        let Attempt::Swap { caller_id, ticket } = attempt else {
            env::panic_str("begin_swap takes a swap attempt");
        };
        let SwapTicket {
            owner_id,
            token_in,
            token_out,
            amount_in,
            ..
        } = ticket;
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(owner_id);
        vault.prune_spends(now, None);
        let entry_in = vault.swap_token(token_in);
        entry_in.balance = U128(sub_amounts(entry_in.balance.0, amount_in.0));
        // Create the output's entry now, so no later callback ever changes the record's size.
        if vault.token_entry(token_out).is_none() {
            attempt.reject(
                RejectReason::TooManyTokens,
                &format!("Vault already holds the maximum of {MAX_TOKEN_BALANCES} tokens"),
            );
        }
        vault.recent_spends.push(Spend {
            spend_id: ticket.spend_id,
            timestamp: U64(now),
            token_id: Some(token_in.clone()),
            amount: *amount_in,
        });
        self.advance_spend_id();
        // token_in is about to go to the exchange, and token_out will arrive there. The first
        // swap of a token creates its ledger entry, which this owner pays for below.
        ledger::start(token_in, amount_in.0);
        ledger::start(token_out, 0);
        // The treasury's entry for the output too, so the callback that credits the fee never
        // adds storage. The first swap into a token pays for it, like its ledger entry.
        fees::ensure_entry(token_out);
        if let Err(cost) = self.settle_storage(owner_id, usage_before) {
            attempt.reject(
                RejectReason::InsufficientBalance,
                &format!(
                    "Vault NEAR balance cannot cover {} of storage for this swap's record",
                    cost.exact_amount_display()
                ),
            );
        }

        VaultEvent::SwapInitiated {
            agent_id: (*caller_id).clone(),
            swap: (*ticket).clone(),
        }
        .emit();

        ext_ft::ext(token_in.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(FT_TRANSFER_CALL_TGAS))
            .ft_transfer_call(self.exchange_id.clone(), *amount_in, None, String::new())
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_SWAP_DEPOSITED_TGAS))
                    .on_swap_deposited((*ticket).clone()),
            )
    }

    /// Withdraws `amount` of a swap's token_in from the vault's exchange account so it can be
    /// refunded.
    pub fn withdraw_refund(
        &self,
        ticket: SwapTicket,
        amount: u128,
        failed_step: SwapStep,
    ) -> Promise {
        ext_exchange::ext(self.exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
            .withdraw(
                ticket.token_in.clone(),
                U128(amount),
                Some(false),
                Some(true),
            )
            .then(
                Self::ext_self()
                    .with_static_gas(Gas::from_tgas(ON_SWAP_WITHDRAWN_TGAS))
                    .on_swap_refund_withdrawn(ticket, U128(amount), failed_step),
            )
    }

    /// Ends a swap that did not happen: returns `amount` of token_in to the owner's balance (or
    /// records it as left on the exchange if it could not be withdrawn) and deletes exactly this
    /// swap's spend entry.
    pub fn refund_swap(
        &mut self,
        ticket: &SwapTicket,
        amount: u128,
        delivered: bool,
        failed_step: SwapStep,
    ) {
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&ticket.owner_id);
        let entry = vault.swap_token(&ticket.token_in);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount));
        } else {
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount));
        }
        vault
            .recent_spends
            .retain(|spend| spend.spend_id != ticket.spend_id);
        // Removing an entry only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&ticket.owner_id, usage_before);
        if delivered {
            ledger::release(&ticket.token_in, amount);
        }
        Self::end_swap(ticket);

        VaultEvent::SwapRefunded {
            swap: ticket.clone(),
            failed_step,
            held_on_exchange: !delivered,
        }
        .emit();
    }
}

/// The least `min_amount_out` a swap quoted at `quote` may ask for when `max_slippage_bps` of
/// slippage is allowed: `quote * (10000 - max_slippage_bps) / 10000`, rounded down.
///
/// Splitting `quote` into whole multiples of 10000 and a remainder gives exactly that value without
/// ever forming `quote * (10000 - max_slippage_bps)`, which overflows u128 for quotes above
/// ~3.4e34. Every step is still checked.
pub fn slippage_floor(quote: u128, max_slippage_bps: u16) -> u128 {
    let overflow = || env::panic_str("Slippage floor overflow");
    let keep = BPS_DENOMINATOR
        .checked_sub(u128::from(max_slippage_bps))
        .unwrap_or_else(overflow);
    let whole = (quote / BPS_DENOMINATOR)
        .checked_mul(keep)
        .unwrap_or_else(overflow);
    let part = (quote % BPS_DENOMINATOR)
        .checked_mul(keep)
        .unwrap_or_else(overflow)
        / BPS_DENOMINATOR;
    whole.checked_add(part).unwrap_or_else(overflow)
}
