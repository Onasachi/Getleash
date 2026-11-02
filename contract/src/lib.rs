//! GetLeash policy contract.
//!
//! One business's treasury. An AI agent proposes payments, a deterministic executor funds terms
//! already committed here, and the owner's wallet holds every power that matters. The contract
//! account itself has no access keys; code changes only through the owner-signed `upgrade`.
//!
//! Specification: `docs/PLAN.md` §4.1. Deliberate deviations: `docs/decisions.md`.
//!
//! Module map:
//! - `ledger`   pure accounting core (no `env`), property-tested
//! - `agent`    `propose_payment`
//! - `executor` attempts, funding, callbacks, delivery reports, `ft_on_transfer`, sweeps
//! - `owner`    approvals, suppliers, policy, reconciliation, withdrawals, rotation, upgrade
//! - `views`    read-only methods

pub mod events;
pub mod hash;
pub mod ledger;
pub mod types;
pub mod validate;

mod agent;
mod executor;
mod owner;
mod views;

#[cfg(test)]
mod tests;

use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise,
};

use crate::ledger::{Caps, Ledger, LedgerError, Period};
use crate::types::*;

pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_TRANSFER_CALLBACK: Gas = Gas::from_tgas(20);
pub(crate) const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub(crate) const GAS_MIGRATE: Gas = Gas::from_tgas(50);
/// Funding must leave room for the method itself, `ft_transfer` and the callback.
pub(crate) const MIN_GAS_FOR_FUNDING: Gas = Gas::from_tgas(60);
pub(crate) const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// USDC on NEAR: `storage_balance_bounds` min = max = 0.00125 NEAR (docs/verified-facts.md).
pub(crate) const FT_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEAR kept back from `withdraw_near` beyond storage staking, for gas and future storage.
pub(crate) const NEAR_RESERVE: NearToken = NearToken::from_millinear(500);

/// Storage prefixes. Never reorder or delete variants: that would corrupt on-chain data.
#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
pub(crate) enum StorageKey {
    Assets,
    Suppliers,
    Intents,
    Attempts,
    Obligations,
    OpenIntents,
    UsedRefs,
    Rejections,
    ClosedQueue,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    agent_id: AccountId,
    executor_id: AccountId,
    /// NEP-141 contract of the treasury asset (USDC).
    treasury_token: AccountId,
    /// `nep141:<treasury_token>`, the 1Click asset id of the treasury asset.
    treasury_asset_id: String,
    treasury_decimals: u8,
    paused: bool,
    hosted_mode: bool,
    policy: Policy,
    ledger: Ledger,
    quotas: Quotas,
    assets: IterableMap<String, AssetInfo>,
    suppliers: IterableMap<SupplierId, Supplier>,
    next_supplier_id: SupplierId,
    intents: LookupMap<IntentId, Intent>,
    next_intent_id: IntentId,
    attempts: LookupMap<AttemptId, Attempt>,
    next_attempt_id: AttemptId,
    /// Latest intent per obligation id.
    obligations: LookupMap<Hash32, IntentId>,
    /// Non-terminal intents (bounded by `max_open_intents`); the executor's work set.
    open_intents: IterableSet<IntentId>,
    /// Quote refs and deposit accounts already used by an attempt.
    used_refs: LookupSet<Hash32>,
    /// Ring buffer of the last `REJECTION_RING` rejected proposals.
    rejections: Vector<Rejection>,
    rejection_cursor: u32,
    /// FIFO of closed intents awaiting pruning: `closed_queue[head..tail]`.
    closed_queue: LookupMap<u64, IntentId>,
    closed_head: u64,
    closed_tail: u64,
}

#[near]
impl Contract {
    /// Initialise the treasury. Called in the owner's setup batch (CreateAccount, Transfer,
    /// DeployContract, `new`), so the account never has an access key (docs/decisions.md D-11).
    #[init]
    pub fn new(
        owner_id: AccountId,
        agent_id: AccountId,
        executor_id: AccountId,
        treasury_token: AccountId,
        treasury_decimals: u8,
        hosted_mode: bool,
        policy: Option<Policy>,
    ) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(caller == owner_id || caller == me, "INIT_ONLY_BY_OWNER");
        require!(
            owner_id != agent_id && owner_id != executor_id && agent_id != executor_id,
            "ROLES_MUST_DIFFER"
        );
        require!(
            owner_id != me && agent_id != me && executor_id != me && treasury_token != me,
            "ROLE_IS_CONTRACT"
        );
        require!(treasury_decimals <= 24, "BAD_DECIMALS");
        let policy = policy.unwrap_or_else(|| Policy::defaults(treasury_decimals));
        validate_policy(&policy, hosted_mode);

        let treasury_asset_id = format!("nep141:{treasury_token}");
        let mut this = Self {
            owner_id: owner_id.clone(),
            agent_id: agent_id.clone(),
            executor_id: executor_id.clone(),
            treasury_token: treasury_token.clone(),
            treasury_asset_id: treasury_asset_id.clone(),
            treasury_decimals,
            paused: false,
            hosted_mode,
            policy,
            ledger: Ledger::default(),
            quotas: Quotas::default(),
            assets: IterableMap::new(StorageKey::Assets),
            suppliers: IterableMap::new(StorageKey::Suppliers),
            next_supplier_id: 1,
            intents: LookupMap::new(StorageKey::Intents),
            next_intent_id: 1,
            attempts: LookupMap::new(StorageKey::Attempts),
            next_attempt_id: 1,
            obligations: LookupMap::new(StorageKey::Obligations),
            open_intents: IterableSet::new(StorageKey::OpenIntents),
            used_refs: LookupSet::new(StorageKey::UsedRefs),
            rejections: Vector::new(StorageKey::Rejections),
            rejection_cursor: 0,
            closed_queue: LookupMap::new(StorageKey::ClosedQueue),
            closed_head: 0,
            closed_tail: 0,
        };
        this.assets.insert(
            treasury_asset_id.clone(),
            AssetInfo { chain: Chain::Near, decimals: treasury_decimals, max_fixed_fee: 0, enabled: true },
        );
        events::emit(
            "initialized",
            json!({
                "owner_id": owner_id,
                "agent_id": agent_id,
                "executor_id": executor_id,
                "treasury_token": treasury_token,
                "hosted_mode": hosted_mode,
            }),
        );
        this
    }

    /// Owner-only code upgrade. The transaction's raw input is the new wasm. The deploy and the
    /// `migrate` call share one receipt, so a failed migration also reverts the deploy.
    #[payable]
    pub fn upgrade(&mut self) -> Promise {
        self.assert_owner_call();
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "NO_CODE");
        events::emit("upgrade", json!({ "code_sha256": hash::to_hex(&env::sha256_array(&code)) }));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate", Vec::new(), NearToken::from_near(0), GAS_MIGRATE)
    }

    /// Runs after `upgrade` deploys new code. The state layout is unchanged in v1.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let state: Contract = env::state_read().unwrap_or_else(|| env::panic_str("NO_STATE"));
        events::emit("migrated", json!({ "version": env!("CARGO_PKG_VERSION") }));
        state
    }
}

/// Validates a policy; panics with a code on the first problem.
pub(crate) fn validate_policy(p: &Policy, hosted_mode: bool) {
    const HOUR: u64 = 3_600_000_000_000;
    const DAY: u64 = 24 * HOUR;
    let amounts = [
        p.autonomous_daily_budget,
        p.approval_threshold,
        p.daily_cap,
        p.monthly_cap,
        p.executor_trust_daily_budget,
        p.unverified_cumulative_budget,
        p.test_payment_max,
    ];
    require!(amounts.iter().all(|a| *a <= MAX_AMOUNT), "POLICY_AMOUNT_TOO_LARGE");
    require!(p.max_fee_bps <= 5_000, "POLICY_FEE_BPS");
    require!(p.new_supplier_cooldown_ns <= 90 * DAY, "POLICY_COOLDOWN");
    require!(p.intent_ttl_ns >= HOUR && p.intent_ttl_ns <= 30 * DAY, "POLICY_INTENT_TTL");
    require!(p.funding_margin_ns <= p.quote_min_validity_ns, "POLICY_QUOTE_MARGINS");
    require!(p.quote_min_validity_ns <= DAY, "POLICY_QUOTE_VALIDITY");
    require!(p.reconcile_grace_ns <= DAY, "POLICY_RECONCILE_GRACE");
    require!(p.retention_ns >= DAY, "POLICY_RETENTION");
    require!(
        p.max_open_intents >= 1 && p.max_open_intents <= HARD_MAX_OPEN_INTENTS,
        "POLICY_MAX_OPEN_INTENTS"
    );
    require!(
        p.max_proposals_per_day >= 1 && p.max_proposals_per_day <= HARD_MAX_PROPOSALS_PER_DAY,
        "POLICY_MAX_PROPOSALS"
    );
    require!(p.max_attempts_per_day <= HARD_MAX_ATTEMPTS_PER_DAY, "POLICY_MAX_ATTEMPTS");
    require!(
        p.max_registrations_per_day <= HARD_MAX_REGISTRATIONS_PER_DAY,
        "POLICY_MAX_REGISTRATIONS"
    );
    if hosted_mode {
        require!(p.executor_trust_daily_budget == 0, "HOSTED_MODE_TRUST_BUDGET_MUST_BE_ZERO");
    }
}

/// Unwraps a ledger result in a method that may panic (the whole receipt reverts).
pub(crate) fn ledger_ok<T>(result: Result<T, LedgerError>) -> T {
    result.unwrap_or_else(|e| env::panic_str(e.code()))
}

/// Internal helpers shared by the method modules.
impl Contract {
    pub(crate) fn assert_owner_call(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        assert_one_yocto();
    }

    pub(crate) fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent_id, "ONLY_AGENT");
    }

    pub(crate) fn assert_executor(&self) {
        require!(env::predecessor_account_id() == self.executor_id, "ONLY_EXECUTOR");
    }

    /// Operational methods the executor (function-call key, no deposit) or the owner (1 yocto) may call.
    pub(crate) fn assert_executor_or_owner(&self) {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            assert_one_yocto();
        } else {
            require!(caller == self.executor_id, "ONLY_EXECUTOR_OR_OWNER");
        }
    }

    pub(crate) fn assert_not_paused(&self) {
        require!(!self.paused, "PAUSED");
    }

    pub(crate) fn caps(&self) -> Caps {
        Caps { daily: self.policy.daily_cap, monthly: self.policy.monthly_cap }
    }

    pub(crate) fn load_intent(&self, id: IntentId) -> Intent {
        self.intents.get(&id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_INTENT"))
    }

    pub(crate) fn load_attempt(&self, id: AttemptId) -> Attempt {
        self.attempts.get(&id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_ATTEMPT"))
    }

    pub(crate) fn load_supplier(&self, id: SupplierId) -> Supplier {
        self.suppliers.get(&id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_SUPPLIER"))
    }

    pub(crate) fn in_cooldown(&self, supplier: &Supplier, now: u64) -> bool {
        // Saturating: if this ever overflowed, the cooldown would simply never end.
        now < supplier.changed_at.saturating_add(self.policy.new_supplier_cooldown_ns)
    }

    /// The rule checks that apply both when a proposal arrives and when an intent is approved.
    /// Paused, unknown-supplier and obligation checks happen before this.
    pub(crate) fn check_payment_rules(
        &self,
        supplier: &Supplier,
        amount_out: u128,
        value: u128,
        max_in: u128,
        test_payment: bool,
        now: u64,
    ) -> Result<(), RejectReason> {
        if !supplier.active {
            return Err(RejectReason::InactiveSupplier);
        }
        match self.assets.get(&supplier.asset_id) {
            Some(asset) if asset.enabled => {}
            _ => return Err(RejectReason::AssetDisabled),
        }
        if self.in_cooldown(supplier, now) && !test_payment {
            return Err(RejectReason::SupplierCooldown);
        }
        if test_payment && value > self.policy.test_payment_max {
            return Err(RejectReason::SupplierCooldown);
        }
        if !supplier.verified {
            let after = supplier.unverified_committed.checked_add(max_in);
            if after.is_none_or(|total| total > self.policy.unverified_cumulative_budget) {
                return Err(RejectReason::OverUnverifiedBudget);
            }
        }
        if amount_out > supplier.per_payment_cap {
            return Err(RejectReason::OverPerPaymentCap);
        }
        let month = Period::at(now).month;
        let supplier_month = supplier
            .month_out
            .current(month)
            .checked_add(supplier.reserved_out)
            .and_then(|t| t.checked_add(amount_out));
        if supplier_month.is_none_or(|total| total > supplier.monthly_cap) {
            return Err(RejectReason::OverMonthlySupplierCap);
        }
        self.ledger
            .check_reserve(max_in, Period::at(now), self.caps())
            .map_err(|e| match e {
                LedgerError::OverDailyCap => RejectReason::OverDailyCap,
                LedgerError::OverMonthlyCap => RejectReason::OverMonthlyCap,
                _ => RejectReason::InsufficientFunds,
            })
    }

    /// Re-checks the rules and reserves for the intent: `Pending → Approved`.
    pub(crate) fn commit_approval(
        &mut self,
        intent: &mut Intent,
        supplier: &mut Supplier,
        now: u64,
    ) -> Result<(), RejectReason> {
        let t = &intent.terms;
        self.check_payment_rules(supplier, t.amount_out, t.value, t.max_in, t.test_payment, now)?;
        ledger_ok(self.ledger.reserve(t.max_in, Period::at(now), self.caps()));
        supplier.reserved_out = checked(supplier.reserved_out.checked_add(t.amount_out));
        if !supplier.verified {
            supplier.unverified_committed =
                checked(supplier.unverified_committed.checked_add(t.max_in));
        }
        intent.reserved = t.max_in;
        intent.status = IntentStatus::Approved;
        intent.approved_at = Some(now);
        intent.updated_at = now;
        Ok(())
    }

    /// Releases an unfunded intent's reservation and voids its unfunded live attempt, if any.
    /// Used by cancel, expiry and invalidation.
    pub(crate) fn release_unfunded(&mut self, intent: &mut Intent, supplier: Option<&mut Supplier>, now: u64) {
        if intent.status == IntentStatus::Approved {
            ledger_ok(self.ledger.release(intent.reserved));
            if let Some(s) = supplier {
                s.reserved_out = checked(s.reserved_out.checked_sub(intent.terms.amount_out));
            }
            intent.reserved = 0;
        }
        if let Some(attempt_id) = intent.live_attempt {
            let mut attempt = self.load_attempt(attempt_id);
            require!(attempt.status.is_unfunded(), "ATTEMPT_ALREADY_FUNDED");
            self.void_attempt(&mut attempt, now);
            self.attempts.insert(attempt_id, attempt);
            intent.live_attempt = None;
        }
    }

    /// `AwaitingOwner | Authorized → Void`, returning any executor-trust budget it took.
    pub(crate) fn void_attempt(&mut self, attempt: &mut Attempt, now: u64) {
        if let Some(day) = attempt.trust_day {
            ledger_ok(self.ledger.release_trust(attempt.terms.amount_in, day));
        }
        attempt.status = AttemptStatus::Void;
        attempt.updated_at = now;
        events::emit("attempt_void", json!({ "attempt_id": attempt.terms.id }));
    }

    /// Moves an intent to a terminal status and queues it for pruning.
    pub(crate) fn close_intent(&mut self, intent: &mut Intent, status: IntentStatus, now: u64) {
        debug_assert!(!status.is_open());
        intent.status = status;
        intent.updated_at = now;
        self.open_intents.remove(&intent.terms.id);
        self.closed_queue.insert(self.closed_tail, intent.terms.id);
        self.closed_tail += 1;
        events::emit(
            "intent_closed",
            json!({ "intent_id": intent.terms.id, "status": status }),
        );
    }

    /// Bumps a per-day call quota, panicking (before any other write) when it is exhausted.
    pub(crate) fn take_quota(counter: &mut ledger::PeriodCounter, day: u32, max: u32, code: &str) {
        require!(counter.current(day) < u128::from(max), code);
        ledger_ok(counter.add(day, 1));
    }
}

/// Unwraps checked arithmetic in a method that may panic.
pub(crate) fn checked<T>(value: Option<T>) -> T {
    value.unwrap_or_else(|| env::panic_str("ARITHMETIC"))
}
