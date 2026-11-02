//! Stored records, call results and views of the v2 contract (docs/decisions.md D-28).
//!
//! Encoding: owner methods and `new` take flat JSON (readable in the owner's wallet, parsed by
//! `json.rs`); the agent, executor and callback take Borsh; results and views are Borsh. In JSON,
//! u128 and u64 values may be decimal strings (D-17). Every enum is stored as its one-byte Borsh
//! index, so variants may only ever be appended.

use near_sdk::{AccountId, env, near};

use crate::json::Args;

pub type SupplierId = u32;
pub type IntentId = u64;
pub type Hash32 = [u8; 32];

/// Largest amount accepted anywhere, in base units (10^9 USDC).
pub const MAX_AMOUNT: u128 = 1_000_000_000_000_000;
pub const MAX_ASSET_ID_LEN: usize = 128;
/// Hard cap on intents held in storage (each ≈ 0.003 NEAR with its obligation entry).
pub const MAX_STORED_INTENTS: u32 = 50;
/// Most ids one `forget` call or one list view handles.
pub const MAX_BATCH: u32 = 50;
pub const HARD_MAX_PROPOSALS_PER_DAY: u32 = 200;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chain {
    Near,
    Tron,
}

impl Chain {
    pub fn parse(text: &str) -> Chain {
        match text {
            "NEAR" => Chain::Near,
            "TRON" => Chain::Tron,
            _ => env::panic_str("BAD_CHAIN"),
        }
    }
}

/// The owner's rules. Amounts are in treasury base units (USDC, 6 decimals).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// What the agent may approve on its own per UTC day, counted as `max_in`.
    pub autonomous_daily_budget: u128,
    /// Payments worth more than this always wait for the owner.
    pub approval_threshold: u128,
    /// Absolute ceiling on what leaves the treasury per UTC day, counted when it is sent.
    pub daily_cap: u128,
    /// What the executor may send to deposit addresses it chose without the owner's signature.
    /// 0 means every cross-chain payment needs the owner ("hosted mode").
    pub executor_trust_daily_budget: u128,
    /// Most the owner may approve for a supplier whose address changed less than
    /// `cooldown_ns` ago (a test payment to the new address).
    pub cooldown_max: u128,
    /// Fixed part of the cross-chain fee bound (D-02).
    pub max_fixed_fee: u128,
    /// Percentage part of the cross-chain fee bound, in basis points.
    pub max_fee_bps: u16,
    pub cooldown_ns: u64,
    /// Pending or approved intents expire this long after their status last changed.
    pub intent_ttl_ns: u64,
    /// A quote must be valid at least this long when an attempt is created.
    pub quote_min_validity_ns: u64,
    /// Funding stops this long before a quote's deadline.
    pub funding_margin_ns: u64,
    /// After this long without a transfer callback the owner may settle the payment by hand.
    pub callback_grace_ns: u64,
    /// Paid and rejected intents can be forgotten this long after they closed.
    pub retention_ns: u64,
    pub max_proposals_per_day: u32,
}

impl Policy {
    /// Reads the policy's fields from flat JSON arguments (`new`, `set_policy`).
    pub fn from_args(a: &mut Args) -> Policy {
        Policy {
            autonomous_daily_budget: a.u128("autonomous_daily_budget"),
            approval_threshold: a.u128("approval_threshold"),
            daily_cap: a.u128("daily_cap"),
            executor_trust_daily_budget: a.u128("executor_trust_daily_budget"),
            cooldown_max: a.u128("cooldown_max"),
            max_fixed_fee: a.u128("max_fixed_fee"),
            max_fee_bps: a.u16("max_fee_bps"),
            cooldown_ns: a.u64("cooldown_ns"),
            intent_ttl_ns: a.u64("intent_ttl_ns"),
            quote_min_validity_ns: a.u64("quote_min_validity_ns"),
            funding_margin_ns: a.u64("funding_margin_ns"),
            callback_grace_ns: a.u64("callback_grace_ns"),
            retention_ns: a.u64("retention_ns"),
            max_proposals_per_day: a.u32("max_proposals_per_day"),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Supplier {
    pub chain: Chain,
    /// 1Click asset id paid out (`nep141:<treasury token>` for native NEAR suppliers).
    pub asset_id: String,
    pub recipient: String,
    pub decimals: u8,
    pub active: bool,
    /// Bumped by every `update_supplier`; intents remember the revision they were made for.
    pub revision: u32,
    /// Start of the current cooldown.
    pub changed_at: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Waiting for the owner.
    Pending,
    /// Cross-chain only: waiting for the executor to quote and fund.
    Approved,
    /// Transfer sent, callback not yet seen.
    Paying,
    /// The treasury token accepted the transfer (for cross-chain: the deposit was funded).
    Paid,
    /// The transfer was refused; nothing left the treasury.
    Failed,
    Rejected,
}

/// Why an intent waits for the owner, or `Autonomous`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Autonomous,
    AboveThreshold,
    AutonomousBudgetUsed,
    DailyCap,
    ReviewFlag,
    SupplierCooldown,
}

/// Why a proposal was refused (nothing stored).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    None,
    Paused,
    UnknownSupplier,
    InactiveSupplier,
    ObligationOpenOrPaid,
    ObligationRejected,
    StorageFull,
    BadAmount,
}

/// A 1Click deposit the executor proposes for a cross-chain intent.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    /// NEAR implicit account (hex of these 32 bytes) that 1Click watches.
    pub deposit: Hash32,
    pub amount_in: u128,
    /// Quote deadline (ns).
    pub deadline: u64,
    /// Set by the owner's `authorize` for exactly this deposit and amount.
    pub authorized: bool,
    /// Executor epoch when the attempt was created; trust funding needs the current one.
    pub epoch: u32,
}

/// Immutable payment terms plus their status. Fixed width except `attempt`, which only changes in
/// executor and owner calls, never in the transfer callback.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub supplier_id: SupplierId,
    pub revision: u32,
    pub obligation: Hash32,
    /// In the supplier's asset units.
    pub amount_out: u128,
    /// `amount_out` in treasury units.
    pub value: u128,
    /// Most the treasury may spend on it (D-02); equals `value` for native suppliers.
    pub max_in: u128,
    pub status: Status,
    pub route: Route,
    pub flag: u8,
    /// When the status last changed (TTL and callback matching).
    pub since: u64,
    pub created_at: u64,
    pub attempt: Option<Attempt>,
}

/// Per-UTC-day counters. They only ever go up within a day.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Budgets {
    pub day: u32,
    pub autonomous: u128,
    pub outflow: u128,
    pub trust: u128,
    pub proposals: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposeResult {
    pub accepted: bool,
    pub intent_id: IntentId,
    pub status: Status,
    pub route: Route,
    pub reason: Reason,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub executor_id: AccountId,
    pub token_id: AccountId,
    pub token_decimals: u8,
    pub paused: bool,
    pub executor_epoch: u32,
    pub policy: Policy,
    /// Today's counters (zero if nothing happened today yet).
    pub budgets: Budgets,
    pub next_supplier_id: SupplierId,
    pub next_intent_id: IntentId,
    pub stored_intents: u32,
    pub paying: u32,
}

/// Owner decisions on an intent (`decide`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Approve,
    Reject,
    Retry,
    MarkPaid,
    MarkFailed,
}

impl Action {
    pub fn parse(text: &str) -> Action {
        match text {
            "APPROVE" => Action::Approve,
            "REJECT" => Action::Reject,
            "RETRY" => Action::Retry,
            "MARK_PAID" => Action::MarkPaid,
            "MARK_FAILED" => Action::MarkFailed,
            _ => env::panic_str("BAD_ACTION"),
        }
    }
}
