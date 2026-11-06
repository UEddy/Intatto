//! `#[private]` callbacks that settle every transfer, withdrawal and swap step.
use near_sdk::json_types::{U64, U128};
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, near, require,
};

use crate::events::{Attempt, RejectReason, VaultEvent};
use crate::ledger;
use crate::swap::{
    EXCHANGE_SWAP_TGAS, EXCHANGE_WITHDRAW_TGAS, ON_SWAP_EXECUTED_TGAS, ON_SWAP_WITHDRAWN_TGAS,
    SwapAction, SwapStep, SwapTicket, busy_message, ext_exchange, slippage_floor,
};
use crate::{CALLBACK_GAS, Contract, ContractExt, ONE_YOCTO, add_amounts, add_tokens, sub_amounts};

#[near]
impl Contract {
    /// Settles an `agent_spend` transfer. Returns whether the transfer succeeded, which also
    /// becomes the result of the agent's transaction.
    #[private]
    pub fn on_spend_complete(
        &mut self,
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            VaultEvent::SpendCompleted {
                spend_id,
                owner_id,
                receiver_id,
                amount,
            }
            .emit();
            return true;
        }

        // The failed transfer's NEAR is refunded to this contract: return it to the vault and
        // delete exactly this spend's entry so it stops counting toward the 24-hour limits.
        let usage_before = env::storage_usage();
        let vault = self.vault_mut(&owner_id);
        vault.balance = add_tokens(vault.balance, amount);
        vault
            .recent_spends
            .retain(|spend| spend.spend_id != spend_id);
        // Removing an entry only frees storage, so settling can only credit the vault.
        let _ = self.settle_storage(&owner_id, usage_before);

        VaultEvent::SpendRefunded {
            spend_id,
            owner_id,
            receiver_id,
            amount,
        }
        .emit();
        false
    }

    /// Settles a `withdraw` transfer, crediting the vault back if it failed.
    #[private]
    pub fn on_withdraw_complete(
        &mut self,
        owner_id: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            let vault = self.vault_mut(&owner_id);
            vault.balance = add_tokens(vault.balance, amount);
            VaultEvent::WithdrawRefunded { owner_id, amount }.emit();
        }
        result.is_ok()
    }

    /// Settles a `withdraw_token` transfer, crediting the vault back if it failed.
    #[private]
    pub fn on_token_withdraw_complete(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            let entry = self.vault_mut(&owner_id).swap_token(&token_id);
            entry.balance = U128(add_amounts(entry.balance.0, amount.0));
            VaultEvent::TokenWithdrawRefunded {
                owner_id,
                token_id,
                amount,
            }
            .emit();
        }
        result.is_ok()
    }

    /// Swap step 1: the exchange quoted the swap, or failed to. Nothing has been deducted yet, so
    /// every rejection here simply panics and leaves the vault as it was. The policy is checked
    /// again because the owner or another agent call may have changed the vault since
    /// `agent_swap`.
    #[private]
    pub fn on_swap_quoted(
        &mut self,
        caller_id: AccountId,
        ticket: SwapTicket,
        #[callback_result] quote: Result<U128, PromiseError>,
    ) -> Promise {
        let now = env::block_timestamp();
        let ticket = SwapTicket {
            spend_id: U64(self.next_spend_id),
            ..ticket
        };
        let attempt = Attempt::Swap {
            caller_id: &caller_id,
            ticket: &ticket,
        };
        let max_slippage_bps = self.check_swap(&attempt, now, false);
        let Ok(quote) = quote else {
            attempt.reject(
                RejectReason::QuoteFailed,
                &format!(
                    "The exchange could not quote pool {} for {} to {}",
                    ticket.pool_id, ticket.token_in, ticket.token_out
                ),
            );
        };
        let floor = slippage_floor(quote.0, max_slippage_bps);
        attempt.require(
            ticket.min_amount_out.0 >= floor,
            RejectReason::SlippageTooLoose,
            || {
                format!(
                    "Minimum amount out {} is below {floor}: the exchange quotes {} and pool {} allows {max_slippage_bps} bps of slippage",
                    ticket.min_amount_out.0, quote.0, ticket.pool_id
                )
            },
        );
        self.begin_swap(&attempt, now)
    }

    /// Swap step 2: token_in's `ft_transfer_call` into the vault's exchange account resolved to
    /// the amount the exchange kept. All of it: swap it. None: the token refunded it, so refund
    /// the owner.
    #[private]
    pub fn on_swap_deposited(
        &mut self,
        ticket: SwapTicket,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let used = used.map_or(0, |used| used.0);
        let amount_in = ticket.amount_in.0;
        // NEP-141 never reports more than was sent; treating it as "all" keeps the callback
        // panic-free even for a token that does.
        if used >= amount_in {
            let action = SwapAction {
                pool_id: ticket.pool_id,
                token_in: ticket.token_in.clone(),
                amount_in: Some(ticket.amount_in),
                token_out: ticket.token_out.clone(),
                min_amount_out: ticket.min_amount_out,
            };
            return ext_exchange::ext(self.exchange_id.clone())
                .with_static_gas(Gas::from_tgas(EXCHANGE_SWAP_TGAS))
                .swap(vec![action], None)
                .then(
                    Self::ext_self()
                        .with_static_gas(Gas::from_tgas(ON_SWAP_EXECUTED_TGAS))
                        .on_swap_executed(ticket),
                )
                .into();
        }
        if used == 0 {
            self.refund_swap(&ticket, amount_in, true, SwapStep::Deposit);
            return PromiseOrValue::Value(false);
        }
        // A plain deposit is all or nothing, but if the exchange ever kept only part, return the
        // rest now and withdraw what it kept before refunding.
        let returned = sub_amounts(amount_in, used);
        let entry = self
            .vault_mut(&ticket.owner_id)
            .swap_token(&ticket.token_in);
        entry.balance = U128(add_amounts(entry.balance.0, returned));
        ledger::release(&ticket.token_in, returned);
        self.withdraw_refund(ticket, used, SwapStep::Deposit).into()
    }

    /// Swap step 3: the exchange's `swap` returned the exact amount out, or failed (for example
    /// below `min_amount_out`) and left token_in in the vault's exchange account.
    #[private]
    pub fn on_swap_executed(
        &mut self,
        ticket: SwapTicket,
        #[callback_result] amount_out: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        match amount_out {
            Ok(amount_out) if amount_out.0 > 0 => {
                // The exchange swapped token_in for token_out inside the vault's account.
                ledger::release(&ticket.token_in, ticket.amount_in.0);
                ledger::expect(&ticket.token_out, amount_out.0);
                ext_exchange::ext(self.exchange_id.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
                    .withdraw(
                        ticket.token_out.clone(),
                        amount_out,
                        Some(false),
                        Some(true),
                    )
                    .then(
                        Self::ext_self()
                            .with_static_gas(Gas::from_tgas(ON_SWAP_WITHDRAWN_TGAS))
                            .on_swap_output_withdrawn(ticket, amount_out),
                    )
                    .into()
            }
            // Zero output needs a zero `min_amount_out`, which agent_swap rejects. Never withdraw
            // it: the exchange reads an amount of 0 as "everything".
            Ok(amount_out) => {
                ledger::release(&ticket.token_in, ticket.amount_in.0);
                Self::end_swap(&ticket);
                VaultEvent::SwapCompleted {
                    swap: ticket,
                    amount_out,
                    held_on_exchange: false,
                }
                .emit();
                PromiseOrValue::Value(true)
            }
            Err(_) => {
                let amount_in = ticket.amount_in.0;
                self.withdraw_refund(ticket, amount_in, SwapStep::Swap)
                    .into()
            }
        }
    }

    /// Swap step 4: the output's withdrawal from the exchange resolved to `amount_out` if it
    /// reached the vault. Credits the owner exactly that, or records it as left on the exchange.
    #[private]
    pub fn on_swap_output_withdrawn(
        &mut self,
        ticket: SwapTicket,
        amount_out: U128,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount_out);
        let entry = self
            .vault_mut(&ticket.owner_id)
            .swap_token(&ticket.token_out);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount_out.0));
            ledger::release(&ticket.token_out, amount_out.0);
        } else {
            // Still owed to this owner on the exchange, so still expected there.
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount_out.0));
        }
        Self::end_swap(&ticket);

        VaultEvent::SwapCompleted {
            swap: ticket,
            amount_out,
            held_on_exchange: !delivered,
        }
        .emit();
        true
    }

    /// Refund step: token_in's withdrawal from the exchange resolved to `amount` if it reached
    /// the vault.
    #[private]
    pub fn on_swap_refund_withdrawn(
        &mut self,
        ticket: SwapTicket,
        amount: U128,
        failed_step: SwapStep,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount);
        self.refund_swap(&ticket, amount.0, delivered, failed_step);
        false
    }

    /// Reclaim step 2: the exchange reported how much of `token_id` the vault's account holds.
    /// Withdraws the owner's own `on_exchange` amount only if that covers everything the ledger
    /// says owners are owed and nothing moved since `reclaim_from_exchange` read `generation`.
    /// Every refusal panics before changing anything; a shortfall also logs `exchange_shortfall`.
    #[private]
    pub fn on_reclaim_checked(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        generation: U64,
        #[callback_result] deposit: Result<U128, PromiseError>,
    ) -> Promise {
        let entry = ledger::ledger(&token_id);
        // Anything that started since the query may have changed the account in between, which
        // would make the balance below stale.
        require!(
            entry.generation == generation && entry.in_flight == 0,
            busy_message(&token_id)
        );
        let Ok(actual) = deposit else {
            env::panic_str(&format!(
                "The exchange did not report the vault's {token_id} balance; retry"
            ));
        };
        if actual.0 < entry.expected.0 {
            VaultEvent::ExchangeShortfall {
                owner_id,
                token_id: token_id.clone(),
                expected: entry.expected,
                actual,
            }
            .emit();
            env::panic_str(&format!(
                "The vault's exchange account holds {} of {token_id} but owners are owed {}; reclaims of {token_id} are refused until the shortfall is resolved",
                actual.0, entry.expected.0
            ));
        }
        let held = self.vault_mut(&owner_id).swap_token(&token_id);
        let amount = held.on_exchange;
        require!(
            amount.0 > 0,
            format!("Vault has no {token_id} left on the exchange")
        );
        held.on_exchange = U128(0);
        // Still expected on the exchange until the withdrawal is confirmed.
        ledger::start(&token_id, 0);

        ext_exchange::ext(self.exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(EXCHANGE_WITHDRAW_TGAS))
            .withdraw(token_id.clone(), amount, Some(false), Some(true))
            .then(
                Self::ext_self()
                    .with_static_gas(CALLBACK_GAS)
                    .on_reclaim_complete(owner_id, token_id, amount),
            )
    }

    /// Reclaim step 3: settles the withdrawal `on_reclaim_checked` made.
    #[private]
    pub fn on_reclaim_complete(
        &mut self,
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] withdrawn: Result<U128, PromiseError>,
    ) -> bool {
        let delivered = withdrawn.is_ok_and(|withdrawn| withdrawn == amount);
        let entry = self.vault_mut(&owner_id).swap_token(&token_id);
        if delivered {
            entry.balance = U128(add_amounts(entry.balance.0, amount.0));
            ledger::release(&token_id, amount.0);
        } else {
            entry.on_exchange = U128(add_amounts(entry.on_exchange.0, amount.0));
        }
        ledger::finish(&token_id);

        VaultEvent::ExchangeReclaim {
            owner_id,
            token_id,
            amount,
            succeeded: delivered,
        }
        .emit();
        delivered
    }
}
