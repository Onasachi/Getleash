//! Domain types: assets, suppliers, intents, attempts, policy, and the JSON shapes of results.
//!
//! JSON conventions (docs/decisions.md D-17): ids are numbers, amounts and nanosecond timestamps are
//! decimal strings, hashes are 64-char hex. Enum codes are SCREAMING_SNAKE_CASE.

use near_sdk::serde_with::hex::Hex;
use near_sdk::serde_with::DisplayFromStr;
use near_sdk::{near, AccountId};

use crate::ledger::{Period, PeriodCounter};

pub type SupplierId = u32;
pub type IntentId = u64;
pub type AttemptId = u64;
pub type Hash32 = [u8; 32];

/// Upper bound on any single amount: 1e15 base units (1e9 USDC). Keeps fee maths far from overflow.
pub const MAX_AMOUNT: u128 = 1_000_000_000_000_000;
pub const MAX_ASSET_ID_LEN: usize = 128;
pub const MAX_QUOTE_REF_LEN: usize = 128;
pub const MAX_TX_REF_LEN: usize = 128;
pub const MAX_SUPPLIERS: u32 = 256;
pub const MAX_ASSETS: u32 = 32;
pub const MAX_ATTEMPTS_PER_INTENT: usize = 10;
pub const REJECTION_RING: u32 = 100;
pub const MAX_RECONCILE_ENTRIES: usize = 20;
pub const HARD_MAX_OPEN_INTENTS: u32 = 100;
pub const HARD_MAX_PROPOSALS_PER_DAY: u32 = 1_000;
pub const HARD_MAX_ATTEMPTS_PER_DAY: u32 = 1_000;
pub const HARD_MAX_REGISTRATIONS_PER_DAY: u32 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Chain {
    Near,
    Tron,
}

/// How an intent is paid: a direct treasury-token transfer, or a 1Click swap.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PayoutKind {
    Native,
    CrossChain,
}

/// A destination asset the owner allows. Keyed by its 1Click `assetId`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetInfo {
    pub chain: Chain,
    pub decimals: u8,
    /// Upper bound on fixed route fees (e.g. the Tron withdrawal fee), in treasury base units (D-02).
    #[serde_as(as = "DisplayFromStr")]
    pub max_fixed_fee: u128,
    pub enabled: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Supplier {
    pub id: SupplierId,
    /// Bumped on every destination change; intents snapshot it.
    pub revision: u32,
    pub chain: Chain,
    pub asset_id: String,
    pub recipient: String,
    /// In the supplier's asset base units (D-03).
    #[serde_as(as = "DisplayFromStr")]
    pub per_payment_cap: u128,
    /// In the supplier's asset base units, per UTC month.
    #[serde_as(as = "DisplayFromStr")]
    pub monthly_cap: u128,
    /// When the destination last changed; the cooldown runs from here.
    #[serde_as(as = "DisplayFromStr")]
    pub changed_at: u64,
    pub verified: bool,
    pub active: bool,
    /// Σ amount_out of this supplier's approved, unfunded intents.
    #[serde_as(as = "DisplayFromStr")]
    pub reserved_out: u128,
    /// Σ amount_out funded this UTC month.
    pub month_out: PeriodCounter,
    /// Σ max_in approved while unverified, since the last destination change (D-04).
    #[serde_as(as = "DisplayFromStr")]
    pub unverified_committed: u128,
}

/// Flags the agent may raise. A flag can only force review, never skip it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewFlag {
    AddressMismatch,
    UncertainMatch,
    AmbiguousExtraction,
    UnusualAmount,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalReason {
    AboveThreshold,
    AutonomousBudgetUsed,
    UnverifiedSupplier,
    ReviewFlag,
    TestPayment,
    OwnerAmended,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Route {
    Autonomous,
    NeedsApproval(ApprovalReason),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IntentStatus {
    /// Waiting for the owner's approval.
    Pending,
    /// Approved and reserved; no funded attempt yet.
    Approved,
    /// An attempt has been funded; settlement is in progress.
    Funding,
    Done,
    /// Refused by the owner while pending.
    Rejected,
    /// Cancelled by the owner.
    Cancelled,
    /// The supplier's destination changed before funding.
    Invalidated,
    /// Not funded before `expires_at`.
    Expired,
}

impl IntentStatus {
    pub fn is_open(self) -> bool {
        matches!(self, IntentStatus::Pending | IntentStatus::Approved | IntentStatus::Funding)
    }
}

/// The immutable terms of an intent. `intent_hash` covers exactly these fields (D-18).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentTerms {
    pub id: IntentId,
    #[serde_as(as = "Hex")]
    pub obligation_id: Hash32,
    pub supplier_id: SupplierId,
    pub supplier_revision: u32,
    pub chain: Chain,
    pub asset_id: String,
    pub recipient: String,
    pub kind: PayoutKind,
    /// What the supplier must receive, in the destination asset's base units.
    #[serde_as(as = "DisplayFromStr")]
    pub amount_out: u128,
    /// `amount_out` in treasury base units (rounded up).
    #[serde_as(as = "DisplayFromStr")]
    pub value: u128,
    /// Most the treasury may spend on this intent, fees included (D-02). Reserved in full.
    #[serde_as(as = "DisplayFromStr")]
    pub max_in: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub created_at: u64,
    #[serde_as(as = "DisplayFromStr")]
    pub expires_at: u64,
    pub route: Route,
    pub review_flag: Option<ReviewFlag>,
    /// Accepted during the supplier's cooldown as a test payment (D-15).
    pub test_payment: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub terms: IntentTerms,
    #[serde_as(as = "Hex")]
    pub intent_hash: Hash32,
    pub status: IntentStatus,
    /// Treasury units currently reserved for this intent: `max_in` while approved, the fee slack
    /// while a transfer is unconfirmed, otherwise 0.
    #[serde_as(as = "DisplayFromStr")]
    pub reserved: u128,
    pub live_attempt: Option<AttemptId>,
    pub attempt_ids: Vec<AttemptId>,
    #[serde_as(as = "Option<DisplayFromStr>")]
    pub approved_at: Option<u64>,
    #[serde_as(as = "DisplayFromStr")]
    pub updated_at: u64,
}

/// 1Click deposit type, committed in every cross-chain attempt.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DepositType {
    OriginChain,
}

/// 1Click recipient type, committed in every cross-chain attempt.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecipientType {
    DestinationChain,
}

/// 1Click refund type, committed in every cross-chain attempt (refunds come back to this contract).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RefundType {
    OriginChain,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttemptAuth {
    /// Native payout to the intent's fixed destination.
    NativeAuto,
    /// Cross-chain, inside today's executor-trust budget.
    TrustBudget,
    /// Needs the owner's signature on the attempt hash.
    OwnerRequired,
    /// The owner signed the attempt hash.
    OwnerSigned,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttemptStatus {
    AwaitingOwner,
    Authorized,
    /// The transfer promise is out; its callback has not run yet.
    FundingPending,
    /// Cross-chain: the deposit reached 1Click; delivery not yet reported.
    Funded,
    Delivered,
    /// The transfer provably failed; the ledger was restored.
    Failed,
    /// Cancelled or expired before funding.
    Void,
    /// Outcome unknown; only the owner can resolve it.
    NeedsReconciliation,
    /// Owner-resolved: the deposit left but the swap failed (funds return via reconciliation).
    SwapFailed,
}

impl AttemptStatus {
    /// Unfunded attempts can still be cancelled or voided.
    pub fn is_unfunded(self) -> bool {
        matches!(self, AttemptStatus::AwaitingOwner | AttemptStatus::Authorized)
    }

    /// A live attempt blocks a new one for the same intent.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            AttemptStatus::AwaitingOwner
                | AttemptStatus::Authorized
                | AttemptStatus::FundingPending
                | AttemptStatus::Funded
                | AttemptStatus::NeedsReconciliation
        )
    }
}

/// The immutable terms of an attempt. `attempt_hash` covers exactly these fields (D-18).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptTerms {
    pub id: AttemptId,
    pub intent_id: IntentId,
    #[serde_as(as = "Hex")]
    pub intent_hash: Hash32,
    pub kind: PayoutKind,
    /// Who receives the treasury token: the supplier (native) or the 1Click deposit account.
    pub pay_to: AccountId,
    /// Exactly what leaves the treasury. Native: equals the intent's `amount_out`.
    #[serde_as(as = "DisplayFromStr")]
    pub amount_in: u128,
    /// Cross-chain: the quote's deposit deadline.
    #[serde_as(as = "Option<DisplayFromStr>")]
    pub quote_deadline: Option<u64>,
    pub deposit_type: Option<DepositType>,
    pub recipient_type: Option<RecipientType>,
    pub refund_type: Option<RefundType>,
    pub refund_to: Option<AccountId>,
    /// Snapshot of the intent's destination, for side-by-side checks against the quote.
    pub destination_asset: String,
    pub final_recipient: String,
    #[serde_as(as = "DisplayFromStr")]
    pub expected_out: u128,
    /// 1Click quote reference (correlation id), unique across attempts.
    pub quote_ref: Option<String>,
    #[serde_as(as = "DisplayFromStr")]
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub terms: AttemptTerms,
    #[serde_as(as = "Hex")]
    pub attempt_hash: Hash32,
    pub authorization: AttemptAuth,
    pub status: AttemptStatus,
    /// Day the executor-trust budget was taken, if it was.
    pub trust_day: Option<u32>,
    #[serde_as(as = "Option<DisplayFromStr>")]
    pub funded_at: Option<u64>,
    /// The period the charge was recorded in (one attempt, one period).
    pub charged: Option<Period>,
    /// The transfer callback (or the owner) confirmed the funds left.
    pub transfer_confirmed: bool,
    #[serde_as(as = "Option<DisplayFromStr>")]
    pub delivered_amount: Option<u128>,
    pub dest_tx: Option<String>,
    /// Refunds and change the owner reconciled to this attempt (never more than `amount_in`).
    #[serde_as(as = "DisplayFromStr")]
    pub returned_amount: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub updated_at: u64,
}

/// Why a proposal was refused. Only enum codes are stored, never model text.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RejectReason {
    Paused,
    UnknownSupplier,
    InactiveSupplier,
    AssetDisabled,
    ObligationOpenOrPaid,
    ObligationRejected,
    SupplierCooldown,
    OverUnverifiedBudget,
    OverPerPaymentCap,
    OverMonthlySupplierCap,
    OverDailyCap,
    OverMonthlyCap,
    InsufficientFunds,
}

impl RejectReason {
    pub fn code(self) -> &'static str {
        match self {
            RejectReason::Paused => "PAUSED",
            RejectReason::UnknownSupplier => "UNKNOWN_SUPPLIER",
            RejectReason::InactiveSupplier => "INACTIVE_SUPPLIER",
            RejectReason::AssetDisabled => "ASSET_DISABLED",
            RejectReason::ObligationOpenOrPaid => "OBLIGATION_OPEN_OR_PAID",
            RejectReason::ObligationRejected => "OBLIGATION_REJECTED",
            RejectReason::SupplierCooldown => "SUPPLIER_COOLDOWN",
            RejectReason::OverUnverifiedBudget => "OVER_UNVERIFIED_BUDGET",
            RejectReason::OverPerPaymentCap => "OVER_PER_PAYMENT_CAP",
            RejectReason::OverMonthlySupplierCap => "OVER_MONTHLY_SUPPLIER_CAP",
            RejectReason::OverDailyCap => "OVER_DAILY_CAP",
            RejectReason::OverMonthlyCap => "OVER_MONTHLY_CAP",
            RejectReason::InsufficientFunds => "INSUFFICIENT_FUNDS",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    #[serde_as(as = "DisplayFromStr")]
    pub at: u64,
    #[serde_as(as = "Hex")]
    pub obligation_id: Hash32,
    pub supplier_id: SupplierId,
    #[serde_as(as = "DisplayFromStr")]
    pub amount_out: u128,
    pub reason: RejectReason,
}

/// Owner-set rules. Treasury amounts are in treasury base units (D-03).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Total `max_in` the contract may auto-approve per UTC day.
    #[serde_as(as = "DisplayFromStr")]
    pub autonomous_daily_budget: u128,
    /// Invoice value above which a payment always needs approval.
    #[serde_as(as = "DisplayFromStr")]
    pub approval_threshold: u128,
    /// Ceiling on committed outflow per UTC day, owner-approved payments included.
    #[serde_as(as = "DisplayFromStr")]
    pub daily_cap: u128,
    /// Ceiling on committed outflow per UTC month.
    #[serde_as(as = "DisplayFromStr")]
    pub monthly_cap: u128,
    /// Cross-chain funding allowed per day without an owner-signed attempt. Forced to 0 while hosted.
    #[serde_as(as = "DisplayFromStr")]
    pub executor_trust_daily_budget: u128,
    /// Total `max_in` ever approved to one supplier while it is unverified.
    #[serde_as(as = "DisplayFromStr")]
    pub unverified_cumulative_budget: u128,
    /// Largest invoice value accepted as a test payment during a cooldown.
    #[serde_as(as = "DisplayFromStr")]
    pub test_payment_max: u128,
    /// Percentage fee headroom for cross-chain intents, in basis points.
    pub max_fee_bps: u16,
    #[serde_as(as = "DisplayFromStr")]
    pub new_supplier_cooldown_ns: u64,
    /// Unfunded intents expire this long after creation.
    #[serde_as(as = "DisplayFromStr")]
    pub intent_ttl_ns: u64,
    /// A cross-chain attempt's quote must stay valid at least this long after creation.
    #[serde_as(as = "DisplayFromStr")]
    pub quote_min_validity_ns: u64,
    /// Funding must happen at least this long before the quote deadline.
    #[serde_as(as = "DisplayFromStr")]
    pub funding_margin_ns: u64,
    /// A stuck `FundingPending` attempt may be flagged after this long.
    #[serde_as(as = "DisplayFromStr")]
    pub reconcile_grace_ns: u64,
    /// Closed intents older than this may be pruned.
    #[serde_as(as = "DisplayFromStr")]
    pub retention_ns: u64,
    pub max_open_intents: u32,
    pub max_proposals_per_day: u32,
    pub max_attempts_per_day: u32,
    pub max_registrations_per_day: u32,
}

impl Policy {
    /// Conservative defaults for a treasury token with `decimals` decimals.
    pub fn defaults(decimals: u8) -> Self {
        let unit = 10u128.pow(u32::from(decimals));
        const MINUTE: u64 = 60 * 1_000_000_000;
        const HOUR: u64 = 60 * MINUTE;
        const DAY: u64 = 24 * HOUR;
        Self {
            autonomous_daily_budget: 50 * unit,
            approval_threshold: 25 * unit,
            daily_cap: 200 * unit,
            monthly_cap: 2_000 * unit,
            executor_trust_daily_budget: 0,
            unverified_cumulative_budget: 10 * unit,
            test_payment_max: unit / 2,
            max_fee_bps: 100,
            new_supplier_cooldown_ns: 2 * DAY,
            intent_ttl_ns: 3 * DAY,
            quote_min_validity_ns: 5 * MINUTE,
            funding_margin_ns: 3 * MINUTE,
            reconcile_grace_ns: 10 * MINUTE,
            retention_ns: 30 * DAY,
            max_open_intents: 50,
            max_proposals_per_day: 100,
            max_attempts_per_day: 100,
            max_registrations_per_day: 20,
        }
    }
}

/// Per-day call quotas (counts).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Quotas {
    pub proposals: PeriodCounter,
    pub attempts: PeriodCounter,
    pub registrations: PeriodCounter,
}

/// Result of `propose_payment`. Rejections are a normal result, not a panic, so they can be recorded.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposeResult {
    pub accepted: bool,
    pub intent_id: Option<IntentId>,
    pub status: Option<IntentStatus>,
    pub route: Option<Route>,
    pub intent_hash: Option<String>,
    pub reason: Option<RejectReason>,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InflowAttribution {
    TopUp,
    AttemptReturn { attempt_id: AttemptId },
    Unattributed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InflowEntry {
    #[serde_as(as = "DisplayFromStr")]
    pub amount: u128,
    pub attribution: InflowAttribution,
}

/// The owner's ruling on an attempt in `NeedsReconciliation` (D-09).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReconcileOutcome {
    /// The treasury transfer never happened.
    NotSent,
    /// The treasury transfer happened (native: the supplier was paid).
    Sent,
    /// Cross-chain delivery confirmed by the owner.
    Delivered {
        #[serde_as(as = "DisplayFromStr")]
        delivered_amount: u128,
        dest_tx: String,
    },
    /// Cross-chain: the deposit left, the swap failed; funds come back via `reconcile_inflows`.
    SwapFailed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub executor_id: AccountId,
    pub treasury_token: AccountId,
    pub treasury_asset_id: String,
    pub treasury_decimals: u8,
    pub paused: bool,
    pub hosted_mode: bool,
    pub policy: Policy,
    pub open_intents: u32,
    pub supplier_count: u32,
    pub next_intent_id: IntentId,
    pub next_attempt_id: AttemptId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetLine {
    #[serde_as(as = "DisplayFromStr")]
    pub limit: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub used: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub remaining: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetsView {
    pub period: Period,
    /// Charged today + reserved, against `daily_cap`.
    pub daily: BudgetLine,
    /// Charged this month + reserved, against `monthly_cap`.
    pub monthly: BudgetLine,
    pub autonomous: BudgetLine,
    pub executor_trust: BudgetLine,
    #[serde_as(as = "DisplayFromStr")]
    pub available: u128,
    pub proposals_today: u32,
    pub attempts_today: u32,
    pub registrations_today: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenWorkItem {
    pub intent: Intent,
    pub attempt: Option<Attempt>,
}
