//! NEP-297 events for the activity feed, and the logging of rejected agent calls.
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, NearToken, env, near};

use crate::policy::Policy;
use crate::swap::{SwapStep, SwapTicket};

/// Why an agent call was rejected, as reported in `spend_rejected` and `swap_rejected` events.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    NoVault,
    NotAgent,
    ZeroAmount,
    ZeroMinAmountOut,
    InsufficientGas,
    Frozen,
    ReceiverNotAllowlisted,
    PoolNotAllowlisted,
    PairMismatch,
    OverPerTxCap,
    TooManySpends,
    OverDailyCap,
    InsufficientBalance,
    TooManyTokens,
    /// The exchange's `get_return` failed, so there is no quote to check `min_amount_out` against.
    QuoteFailed,
    /// `min_amount_out` is further below the exchange's quote than the pool's `max_slippage_bps`.
    SlippageTooLoose,
}

/// NEP-297 events for the activity feed, logged as
/// `EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"<name>","data":{...}}`.
#[near(event_json(standard = "intatto"))]
pub enum VaultEvent {
    /// `amount` is what was credited; `storage_cost` is the part of the first deposit kept to
    /// pay for the vault record's storage.
    #[event_version("1.0.0")]
    Deposit {
        owner_id: AccountId,
        amount: NearToken,
        storage_cost: NearToken,
    },
    #[event_version("1.0.0")]
    AgentSet {
        owner_id: AccountId,
        agent_id: AccountId,
        policy: Policy,
    },
    #[event_version("1.0.0")]
    AgentRemoved {
        owner_id: AccountId,
        agent_id: AccountId,
    },
    #[event_version("1.0.0")]
    Frozen { owner_id: AccountId },
    #[event_version("1.0.0")]
    Unfrozen { owner_id: AccountId },
    /// `withdraw` and `withdraw_token` are blocked until `locked_until` (block timestamp, ns).
    #[event_version("1.0.0")]
    WithdrawalsLocked {
        owner_id: AccountId,
        locked_until: U64,
    },
    /// `set_agent` was refused because the owner's withdrawals are locked until `locked_until`.
    /// Logged right before the panic, so it survives in the failed receipt's outcome.
    #[event_version("1.0.0")]
    SetAgentRejected {
        owner_id: AccountId,
        agent_id: AccountId,
        locked_until: U64,
    },
    #[event_version("1.0.0")]
    Withdraw {
        owner_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    WithdrawRefunded {
        owner_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    TokenDeposit {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    TokenWithdraw {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    TokenWithdrawRefunded {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// Logged right before the panic, so it survives in the failed receipt's outcome.
    #[event_version("1.0.0")]
    SpendRejected {
        owner_id: AccountId,
        caller_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
        reason: RejectReason,
    },
    /// The spend passed every check; the balance is deducted, the spend is recorded and the
    /// transfer is in flight.
    #[event_version("1.0.0")]
    SpendInitiated {
        spend_id: U64,
        owner_id: AccountId,
        agent_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    SpendCompleted {
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
    /// The transfer failed; the amount went back to the vault and the spend's record was removed.
    #[event_version("1.0.0")]
    SpendRefunded {
        spend_id: U64,
        owner_id: AccountId,
        receiver_id: AccountId,
        amount: NearToken,
    },
    /// Logged right before the panic, so it survives in the failed receipt's outcome. Rejections
    /// that need the exchange's quote are logged by the `on_swap_quoted` receipt.
    #[event_version("1.0.0")]
    SwapRejected {
        owner_id: AccountId,
        caller_id: AccountId,
        pool_id: u64,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        min_amount_out: U128,
        reason: RejectReason,
    },
    /// The swap passed every check, including slippage against the exchange's quote; token_in is
    /// deducted, the swap is recorded and its deposit is in flight.
    #[event_version("1.0.0")]
    SwapInitiated {
        agent_id: AccountId,
        swap: SwapTicket,
    },
    /// The exchange swapped `amount_in` for exactly `amount_out` (gross). The owner was credited
    /// `net` and the treasury `fee`, and `net + fee == amount_out`. If withdrawing the output
    /// from the exchange failed (`held_on_exchange`), all of it is recorded as the owner's
    /// `on_exchange`, `fee` is 0 and `net` is `amount_out`. Version 1.0.0 had no `fee` or `net`.
    #[event_version("1.1.0")]
    SwapCompleted {
        swap: SwapTicket,
        amount_out: U128,
        fee: U128,
        net: U128,
        held_on_exchange: bool,
    },
    /// The swap did not happen; `amount_in` went back to the owner (or is recorded as
    /// `on_exchange`) and the swap's record was removed.
    #[event_version("1.0.0")]
    SwapRefunded {
        swap: SwapTicket,
        failed_step: SwapStep,
        held_on_exchange: bool,
    },
    /// A reclaim was refused because the vault's exchange account holds less of `token_id`
    /// (`actual`) than owners are owed there (`expected`). Logged right before the panic, so it
    /// survives in the failed receipt's outcome.
    #[event_version("1.0.0")]
    ExchangeShortfall {
        owner_id: AccountId,
        token_id: AccountId,
        expected: U128,
        actual: U128,
    },
    /// The exchange ledger was asked to remove more than it held, which means it was missing an
    /// earlier step (for example a swap started before the ledger existed). It was clamped at 0.
    #[event_version("1.0.0")]
    ExchangeLedgerUnderflow {
        token_id: AccountId,
        field: String,
        value: U128,
        decrease: U128,
    },
    #[event_version("1.0.0")]
    ExchangeReclaim {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
        succeeded: bool,
    },
    /// `amount` of accrued `token_id` fees was deducted from the treasury balance and its transfer
    /// to `treasury_id` is in flight.
    #[event_version("1.0.0")]
    FeesWithdrawn {
        treasury_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// The transfer of a fee withdrawal failed; `amount` went back to the treasury balance.
    #[event_version("1.0.0")]
    FeesWithdrawRefunded {
        treasury_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// The vault's intents account is bound to this Verifier and MPC signer, for good.
    #[event_version("1.0.0")]
    IntentsSetup {
        intents_id: AccountId,
        signer_id: AccountId,
    },
    /// `add_public_key(public_key)` on the Verifier finished, successfully or not.
    #[event_version("1.0.0")]
    IntentsKeyAdded { public_key: String, succeeded: bool },
    /// The Verifier listed `found` as the vault's keys; `verified` iff that is exactly
    /// `expected`, the MPC-derived key.
    #[event_version("1.0.0")]
    IntentsKeyChecked {
        expected: Option<String>,
        found: Vec<String>,
        verified: bool,
    },
    /// `amount` left the owner's vault balance for the vault's intents account; its transfer to
    /// the Verifier is in flight.
    #[event_version("1.0.0")]
    IntentsDeposit {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// The Verifier did not keep `amount` of a deposit; it went back to the owner's vault balance.
    #[event_version("1.0.0")]
    IntentsDepositRefunded {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// `amount` left the owner's intents balance; its withdrawal to the vault is in flight.
    #[event_version("1.0.0")]
    IntentsWithdraw {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    /// `amount` of a withdrawal stayed in the vault's intents account and went back to the
    /// owner's intents balance.
    #[event_version("1.0.0")]
    IntentsWithdrawRefunded {
        owner_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
}

/// What an agent asked for, kept so every rejection can be logged.
pub enum Attempt<'a> {
    Spend {
        owner_id: &'a AccountId,
        caller_id: &'a AccountId,
        receiver_id: &'a AccountId,
        amount: NearToken,
    },
    Swap {
        caller_id: &'a AccountId,
        ticket: &'a SwapTicket,
    },
}

impl Attempt<'_> {
    /// `require!` for agent calls: logs a rejection event before panicking.
    pub fn require(&self, condition: bool, reason: RejectReason, message: impl FnOnce() -> String) {
        if !condition {
            self.reject(reason, &message());
        }
    }

    /// Logs survive a panic in the failed receipt's outcome (state changes do not), so indexers
    /// still see the rejected attempt.
    pub fn reject(&self, reason: RejectReason, message: &str) -> ! {
        match self {
            Self::Spend {
                owner_id,
                caller_id,
                receiver_id,
                amount,
            } => VaultEvent::SpendRejected {
                owner_id: (*owner_id).clone(),
                caller_id: (*caller_id).clone(),
                receiver_id: (*receiver_id).clone(),
                amount: *amount,
                reason,
            }
            .emit(),
            Self::Swap { caller_id, ticket } => VaultEvent::SwapRejected {
                owner_id: ticket.owner_id.clone(),
                caller_id: (*caller_id).clone(),
                pool_id: ticket.pool_id,
                token_in: ticket.token_in.clone(),
                token_out: ticket.token_out.clone(),
                amount_in: ticket.amount_in,
                min_amount_out: ticket.min_amount_out,
                reason,
            }
            .emit(),
        }
        env::panic_str(message)
    }
}
