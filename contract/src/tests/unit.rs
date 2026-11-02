//! Scenario tests. Names follow the PLAN §9 adversarial table where a row applies.

use near_sdk::json_types::{U128, U64};
use near_sdk::NearToken;

use super::harness::*;
use crate::ledger::Period;
use crate::types::*;

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

fn accepted(r: Result<ProposeResult, String>) -> IntentId {
    let r = r.expect("propose call");
    assert!(r.accepted, "proposal rejected: {:?}", r.reason);
    r.intent_id.unwrap()
}

fn rejected(r: Result<ProposeResult, String>) -> RejectReason {
    let r = r.expect("propose call");
    assert!(!r.accepted, "expected a rejection, got intent {:?}", r.intent_id);
    r.reason.unwrap()
}

impl World {
    fn create_native(&mut self, intent_id: IntentId) -> Result<AttemptId, String> {
        self.executor(|c| c.create_attempt_native(intent_id))
    }

    fn create_cross(&mut self, intent_id: IntentId, deposit: &str, amount_in: u128, quote: &str) -> Result<AttemptId, String> {
        let deadline = self.now + 30 * MINUTE;
        let deposit = acc(deposit);
        let quote = quote.to_string();
        self.executor(|c| c.create_attempt_crosschain(intent_id, deposit, U128(amount_in), U64(deadline), quote))
    }

    fn fund_native(&mut self, attempt_id: AttemptId) -> Result<(), String> {
        self.executor(|c| {
            c.fund_native(attempt_id).detach();
        })
    }

    fn fund_cross(&mut self, attempt_id: AttemptId) -> Result<(), String> {
        self.executor(|c| {
            c.fund_crosschain(attempt_id).detach();
        })
    }

    fn ledger(&mut self) -> crate::ledger::Ledger {
        self.view(|c| c.get_ledger())
    }

    /// Native intent paid end to end; returns (intent, attempt).
    fn pay_native(&mut self, obligation: u8, supplier: SupplierId, amount: u128) -> (IntentId, AttemptId) {
        let intent = accepted(self.propose(obligation, supplier, amount, None));
        if self.intent(intent).status == IntentStatus::Pending {
            self.approve(intent).unwrap();
        }
        let attempt = self.create_native(intent).unwrap();
        self.fund_native(attempt).unwrap();
        self.transfer_callback(attempt, true).unwrap();
        (intent, attempt)
    }
}

fn trust_policy(trust: u128) -> Policy {
    let mut p = test_policy();
    p.executor_trust_daily_budget = trust;
    p
}

// ── Setup and access control ───────────────────────────────────────────────────────────────────

#[test]
fn init_sets_roles_and_registers_the_treasury_asset() {
    let mut w = World::new(None, true);
    let config = w.view(|c| c.get_config());
    assert_eq!(config.owner_id, owner());
    assert_eq!(config.treasury_asset_id, usdc_asset());
    assert!(config.hosted_mode);
    assert_eq!(config.policy.executor_trust_daily_budget, 0);
    let assets = w.view(|c| c.list_assets());
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].0, usdc_asset());
}

#[test]
#[should_panic(expected = "HOSTED_MODE_TRUST_BUDGET_MUST_BE_ZERO")]
fn init_refuses_a_trust_budget_in_hosted_mode() {
    World::new(Some(trust_policy(5 * USDC)), true);
}

#[test]
fn unauthorized_callers_spam_proposals_panic_before_writing() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let before = (w.ledger(), w.view(|c| c.get_budgets_today()), w.view(|c| c.get_recent_rejections()));
    let ob = obligation_hex(1);
    for caller in [stranger(), owner(), executor()] {
        let ob = ob.clone();
        expect_err(
            w.call(&caller, zero(), Vec::new(), |c| c.propose_payment(ob, native, U128(USDC), None)),
            "ONLY_AGENT",
        );
    }
    let after = (w.ledger(), w.view(|c| c.get_budgets_today()), w.view(|c| c.get_recent_rejections()));
    assert_eq!(before, after, "a rejected caller must not change state, not even quotas");
}

#[test]
fn every_role_is_enforced() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 5 * USDC, None));
    let attempt = w.create_native(intent).unwrap();
    // Executor methods.
    expect_err(w.call(&agent(), zero(), Vec::new(), |c| c.create_attempt_native(intent)), "ONLY_EXECUTOR");
    expect_err(w.call(&owner(), one_yocto(), Vec::new(), |c| { c.fund_native(attempt).detach(); }), "ONLY_EXECUTOR");
    expect_err(w.call(&stranger(), zero(), Vec::new(), |c| { c.register_recipient(attempt).detach(); }), "ONLY_EXECUTOR");
    // Owner methods.
    for caller in [agent(), executor(), stranger()] {
        expect_err(w.call(&caller, one_yocto(), Vec::new(), |c| c.pause()), "ONLY_OWNER");
        expect_err(w.call(&caller, one_yocto(), Vec::new(), |c| { c.withdraw(U128(USDC)).detach(); }), "ONLY_OWNER");
        expect_err(w.call(&caller, one_yocto(), Vec::new(), |c| { c.upgrade().detach(); }), "ONLY_OWNER");
    }
    // Operational methods: executor or owner only.
    expect_err(w.call(&agent(), zero(), Vec::new(), |c| c.sweep(10)), "ONLY_EXECUTOR_OR_OWNER");
    // Top-ups only from the treasury token.
    expect_err(
        w.call(&stranger(), zero(), Vec::new(), |c| c.ft_on_transfer(owner(), U128(USDC), String::new())),
        "UNSUPPORTED_TOKEN",
    );
}

#[test]
fn non_owner_calls_upgrade_or_withdraw_rejected_and_owner_needs_one_yocto() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    expect_err(w.call(&stranger(), one_yocto(), Vec::new(), |c| { c.upgrade().detach(); }), "ONLY_OWNER");
    expect_err(w.call(&stranger(), one_yocto(), Vec::new(), |c| { c.withdraw(U128(USDC)).detach(); }), "ONLY_OWNER");
    for deposit in [zero(), NearToken::from_yoctonear(2)] {
        expect_err(w.call(&owner(), deposit, Vec::new(), |c| { c.withdraw(U128(USDC)).detach(); }), "1 yoctoNEAR");
        expect_err(w.call(&owner(), deposit, Vec::new(), |c| c.pause()), "1 yoctoNEAR");
        expect_err(w.call(&owner(), deposit, Vec::new(), |c| { c.upgrade().detach(); }), "1 yoctoNEAR");
    }
}

#[test]
fn set_policy_with_trust_budget_while_hosted_rejected() {
    let (mut w, _, _) = standard_world(test_policy(), true);
    expect_err(w.owner(|c| c.set_policy(trust_policy(5 * USDC))), "HOSTED_MODE_TRUST_BUDGET_MUST_BE_ZERO");
    w.owner(|c| c.set_hosted_mode(false)).unwrap();
    w.owner(|c| c.set_policy(trust_policy(5 * USDC))).unwrap();
    w.owner(|c| c.set_hosted_mode(true)).unwrap();
    assert_eq!(w.view(|c| c.get_policy().executor_trust_daily_budget), 0, "hosted mode forces 0");
}

#[test]
fn rotation_moves_authority_to_the_new_account() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let new_agent = acc("agent-2.biz.near");
    let a2 = new_agent.clone();
    w.owner(|c| c.rotate_agent(a2)).unwrap();
    expect_err(w.propose(1, native, USDC, None), "ONLY_AGENT");
    let ob = obligation_hex(1);
    let r = w.call(&new_agent, zero(), Vec::new(), |c| c.propose_payment(ob, native, U128(USDC), None));
    assert!(r.unwrap().accepted);
    expect_err(w.owner(|c| c.rotate_executor(owner())), "BAD_ROLE_ACCOUNT");
}

// ── Native payouts ─────────────────────────────────────────────────────────────────────────────

#[test]
fn native_funding_debit_equals_amount_out() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let cash_before = w.ledger().cash;
    let r = w.propose(1, native, 10 * USDC, None).unwrap();
    assert_eq!(r.route, Some(Route::Autonomous));
    assert_eq!(r.status, Some(IntentStatus::Approved));
    let intent = r.intent_id.unwrap();
    let attempt = w.create_native(intent).unwrap();
    assert_eq!(w.attempt(attempt).authorization, AttemptAuth::NativeAuto);
    w.fund_native(attempt).unwrap();

    let debit = w.debits.last().unwrap().clone();
    assert_eq!(debit.receiver, acc("acme.near"));
    assert_eq!(debit.amount, 10 * USDC);
    assert_eq!(debit.callback_attempt, Some(attempt));
    let l = w.ledger();
    assert_eq!(l.cash, cash_before - 10 * USDC);
    assert_eq!(l.in_flight, 10 * USDC);
    assert_eq!(w.attempt(attempt).status, AttemptStatus::FundingPending);

    w.transfer_callback(attempt, true).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Delivered);
    assert_eq!(w.intent(intent).status, IntentStatus::Done);
    let l = w.ledger();
    assert_eq!((l.in_flight, l.reserved), (0, 0));
    assert_eq!(l.spent_day.current(Period::at(w.now).day), 10 * USDC);
    assert!(w.view(|c| c.get_open_work()).is_empty());
}

#[test]
fn transfer_failure_restores_the_ledger_once_and_allows_a_retry() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let before = w.ledger();
    let intent = accepted(w.propose(1, native, 10 * USDC, None));
    let reserved_after_approval = w.ledger().reserved;
    let attempt = w.create_native(intent).unwrap();
    w.fund_native(attempt).unwrap();
    w.transfer_callback(attempt, false).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Failed);
    let i = w.intent(intent);
    assert_eq!(i.status, IntentStatus::Approved);
    assert_eq!(i.live_attempt, None);
    let l = w.ledger();
    assert_eq!(l.cash, before.cash);
    assert_eq!(l.in_flight, 0);
    assert_eq!(l.reserved, reserved_after_approval);
    assert_eq!(l.spent_day.current(Period::at(w.now).day), 0);
    // A duplicate callback changes nothing.
    w.transfer_callback(attempt, false).unwrap();
    assert_eq!(w.ledger(), l);
    // Retry with a new attempt.
    let retry = w.create_native(intent).unwrap();
    assert_ne!(retry, attempt);
    w.fund_native(retry).unwrap();
    w.transfer_callback(retry, true).unwrap();
    assert_eq!(w.intent(intent).status, IntentStatus::Done);
}

#[test]
fn transfer_succeeds_callback_fails_needs_reconciliation_and_no_refund() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 10 * USDC, None));
    let attempt = w.create_native(intent).unwrap();
    w.fund_native(attempt).unwrap();
    // The callback never runs (out of gas, say). The executor must not re-fund.
    expect_err(w.fund_native(attempt), "ATTEMPT_NOT_AUTHORIZED");
    expect_err(w.create_native(intent), "INTENT_NOT_APPROVED");
    expect_err(w.executor(|c| c.flag_reconciliation(attempt)), "CANNOT_FLAG");
    w.advance(11 * MINUTE);
    w.executor(|c| c.flag_reconciliation(attempt)).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::NeedsReconciliation);
    // A late callback is now stale and changes nothing.
    let l = w.ledger();
    w.transfer_callback(attempt, true).unwrap();
    assert_eq!(w.ledger(), l);
    // Only the owner resolves it.
    expect_err(
        w.call(&executor(), zero(), Vec::new(), |c| c.resolve_reconciliation(attempt, ReconcileOutcome::Sent)),
        "ONLY_OWNER",
    );
    w.owner(|c| c.resolve_reconciliation(attempt, ReconcileOutcome::Sent)).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Delivered);
    assert_eq!(w.intent(intent).status, IntentStatus::Done);
    assert_eq!(w.ledger().in_flight, 0);
    assert_eq!(w.debits.len(), 1, "exactly one transfer was ever requested");
}

#[test]
fn stale_callback_after_a_new_attempt_has_no_effect() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 10 * USDC, None));
    let first = w.create_native(intent).unwrap();
    w.fund_native(first).unwrap();
    w.transfer_callback(first, false).unwrap();
    let second = w.create_native(intent).unwrap();
    w.fund_native(second).unwrap();
    let l = w.ledger();
    let a2 = w.attempt(second);
    // A replayed success callback for the first attempt must not touch the second.
    w.transfer_callback(first, true).unwrap();
    assert_eq!(w.ledger(), l);
    assert_eq!(w.attempt(second), a2);
    assert_eq!(w.attempt(first).status, AttemptStatus::Failed);
}

#[test]
fn worker_restart_after_broadcast_recovers_from_open_work() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 10 * USDC, None));
    let attempt = w.create_native(intent).unwrap();
    w.fund_native(attempt).unwrap();
    // A restarted worker rebuilds its queue from the contract.
    let work = w.view(|c| c.get_open_work());
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].intent.terms.id, intent);
    assert_eq!(work[0].attempt.as_ref().unwrap().status, AttemptStatus::FundingPending);
    // Whatever it retries, no second transfer is possible.
    expect_err(w.fund_native(attempt), "ATTEMPT_NOT_AUTHORIZED");
    expect_err(w.create_native(intent), "INTENT_NOT_APPROVED");
    assert_eq!(w.debits.len(), 1);
}

// ── Proposals, reason codes and routing ────────────────────────────────────────────────────────

#[test]
fn prompt_injection_to_an_unknown_supplier_is_rejected_and_recorded() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    assert_eq!(rejected(w.propose(1, 999, 10 * USDC, None)), RejectReason::UnknownSupplier);
    let rejections = w.view(|c| c.get_recent_rejections());
    assert_eq!(rejections.len(), 1);
    assert_eq!(rejections[0].reason, RejectReason::UnknownSupplier);
    assert_eq!(w.view(|c| c.get_config().next_intent_id), 1, "no intent was created");
}

#[test]
fn every_rejection_reason_code() {
    let mut p = test_policy();
    p.daily_cap = 120 * USDC;
    p.monthly_cap = 150 * USDC;
    let (mut w, native, _) = standard_world(p, false);

    // OVER_PER_PAYMENT_CAP (supplier cap 100)
    assert_eq!(rejected(w.propose(1, native, 101 * USDC, None)), RejectReason::OverPerPaymentCap);
    // OVER_DAILY_CAP: approve 100, then 30 more exceeds 120
    let big = accepted(w.propose(2, native, 100 * USDC, None));
    w.approve(big).unwrap();
    assert_eq!(rejected(w.propose(3, native, 30 * USDC, None)), RejectReason::OverDailyCap);
    // OVER_MONTHLY_CAP: pay the 100, then next day 100 charged this month + 60 > 150 (daily is fine)
    let a = w.create_native(big).unwrap();
    w.fund_native(a).unwrap();
    w.transfer_callback(a, true).unwrap();
    w.advance(DAY);
    assert_eq!(rejected(w.propose(3, native, 60 * USDC, None)), RejectReason::OverMonthlyCap);
    // OBLIGATION_OPEN_OR_PAID
    assert_eq!(rejected(w.propose(2, native, 10 * USDC, None)), RejectReason::ObligationOpenOrPaid);
    // INSUFFICIENT_FUNDS: cash 400, nothing reserved → withdraw 395 leaves 5 available
    w.owner(|c| { c.withdraw(U128(395 * USDC)).detach(); }).unwrap();
    assert_eq!(rejected(w.propose(4, native, 6 * USDC, None)), RejectReason::InsufficientFunds);
    w.top_up(400 * USDC).unwrap();
    // OVER_MONTHLY_SUPPLIER_CAP
    w.owner(|c| c.set_supplier_caps(native, U128(100 * USDC), U128(110 * USDC))).unwrap();
    assert_eq!(rejected(w.propose(5, native, 20 * USDC, None)), RejectReason::OverMonthlySupplierCap);
    w.owner(|c| c.set_supplier_caps(native, U128(100 * USDC), U128(1_000 * USDC))).unwrap();
    // INACTIVE_SUPPLIER
    w.owner(|c| c.set_supplier_active(native, false)).unwrap();
    assert_eq!(rejected(w.propose(6, native, USDC, None)), RejectReason::InactiveSupplier);
    w.owner(|c| c.set_supplier_active(native, true)).unwrap();
    // ASSET_DISABLED
    let asset = usdc_asset();
    w.owner(|c| c.set_asset(asset, U128(0), false)).unwrap();
    assert_eq!(rejected(w.propose(7, native, USDC, None)), RejectReason::AssetDisabled);
    let asset = usdc_asset();
    w.owner(|c| c.set_asset(asset, U128(0), true)).unwrap();
    // PAUSED
    w.owner(|c| c.pause()).unwrap();
    assert_eq!(rejected(w.propose(8, native, USDC, None)), RejectReason::Paused);
    w.owner(|c| c.unpause()).unwrap();
    // UNKNOWN_SUPPLIER
    assert_eq!(rejected(w.propose(9, 77, USDC, None)), RejectReason::UnknownSupplier);
    // OBLIGATION_REJECTED
    let flagged = accepted(w.propose(10, native, USDC, Some(ReviewFlag::UnusualAmount)));
    w.owner(|c| c.reject(flagged)).unwrap();
    assert_eq!(rejected(w.propose(10, native, USDC, None)), RejectReason::ObligationRejected);
    // SUPPLIER_COOLDOWN and OVER_UNVERIFIED_BUDGET: a brand-new supplier
    let fresh = w.add_supplier(Chain::Near, &usdc_asset(), "newco.near", 100 * USDC, 1_000 * USDC);
    assert_eq!(rejected(w.propose(11, fresh, 5 * USDC, None)), RejectReason::SupplierCooldown);
    w.advance(3 * DAY);
    assert_eq!(rejected(w.propose(11, fresh, 11 * USDC, None)), RejectReason::OverUnverifiedBudget);
    let unverified = accepted(w.propose(11, fresh, 6 * USDC, None));
    w.approve(unverified).unwrap();
    assert_eq!(rejected(w.propose(12, fresh, 5 * USDC, None)), RejectReason::OverUnverifiedBudget);
}

#[test]
fn routing_reasons() {
    let mut p = test_policy();
    p.autonomous_daily_budget = 30 * USDC;
    let (mut w, native, _) = standard_world(p, false);
    let route = |r: Result<ProposeResult, String>| r.unwrap().route.unwrap();
    assert_eq!(route(w.propose(1, native, 20 * USDC, None)), Route::Autonomous);
    assert_eq!(
        route(w.propose(2, native, 26 * USDC, None)),
        Route::NeedsApproval(ApprovalReason::AboveThreshold)
    );
    assert_eq!(
        route(w.propose(3, native, 11 * USDC, None)),
        Route::NeedsApproval(ApprovalReason::AutonomousBudgetUsed)
    );
    assert_eq!(
        route(w.propose(4, native, USDC, Some(ReviewFlag::AddressMismatch))),
        Route::NeedsApproval(ApprovalReason::ReviewFlag)
    );
    let unverified = w.add_supplier(Chain::Near, &usdc_asset(), "newco.near", 100 * USDC, 1_000 * USDC);
    assert_eq!(
        route(w.propose(5, unverified, USDC / 2, None)),
        Route::NeedsApproval(ApprovalReason::TestPayment)
    );
    w.advance(3 * DAY);
    assert_eq!(
        route(w.propose(6, unverified, USDC, None)),
        Route::NeedsApproval(ApprovalReason::UnverifiedSupplier)
    );
}

#[test]
fn a_review_flag_can_only_force_review() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    for flag in [
        ReviewFlag::AddressMismatch,
        ReviewFlag::UncertainMatch,
        ReviewFlag::AmbiguousExtraction,
        ReviewFlag::UnusualAmount,
    ] {
        let r = w.propose(flag as u8 + 1, native, USDC, Some(flag)).unwrap();
        assert_eq!(r.status, Some(IntentStatus::Pending));
        let intent = r.intent_id.unwrap();
        expect_err(w.create_native(intent), "INTENT_NOT_APPROVED");
    }
}

#[test]
fn same_invoice_with_edited_fields_keeps_its_obligation_id() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let (intent, _) = w.pay_native(1, native, 10 * USDC);
    assert_eq!(w.intent(intent).status, IntentStatus::Done);
    // Same obligation id (same supplier + invoice number) with a different amount: refused.
    assert_eq!(rejected(w.propose(1, native, 12 * USDC, None)), RejectReason::ObligationOpenOrPaid);
    // While one is open, a duplicate is refused too.
    let open = accepted(w.propose(2, native, 30 * USDC, None));
    assert_eq!(w.intent(open).status, IntentStatus::Pending);
    assert_eq!(rejected(w.propose(2, native, 5 * USDC, None)), RejectReason::ObligationOpenOrPaid);
}

#[test]
fn authorized_agent_spam_hits_quotas_and_the_ring_stays_bounded() {
    let mut p = test_policy();
    p.max_proposals_per_day = 150;
    let (mut w, _, _) = standard_world(p, false);
    for i in 0..150u32 {
        let r = w.propose((i % 250) as u8, 999, USDC, None).unwrap();
        assert!(!r.accepted);
    }
    assert_eq!(w.view(|c| c.get_recent_rejections()).len(), REJECTION_RING as usize);
    expect_err(w.propose(1, 999, USDC, None), "QUOTA_PROPOSALS");
    w.advance(DAY);
    assert!(w.propose(1, 999, USDC, None).is_ok(), "quota resets the next day");
}

#[test]
fn open_intents_are_capped() {
    let mut p = test_policy();
    p.max_open_intents = 3;
    let (mut w, native, _) = standard_world(p, false);
    for ob in 1..=3 {
        accepted(w.propose(ob, native, 30 * USDC, None)); // above threshold → pending
    }
    expect_err(w.propose(4, native, 30 * USDC, None), "QUOTA_OPEN_INTENTS");
}

// ── Approvals and supplier changes ─────────────────────────────────────────────────────────────

#[test]
fn approval_is_bound_to_the_intent_hash() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 30 * USDC, None));
    expect_err(w.owner(|c| c.approve(intent, "00".repeat(32))), "INTENT_HASH_MISMATCH");
    expect_err(w.owner(|c| c.approve(intent, "zz".to_string())), "BAD_HASH");
    w.approve(intent).unwrap();
    expect_err(w.approve(intent), "INTENT_NOT_PENDING");
}

#[test]
fn intent_hash_binds_the_contract_and_terms() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let id = accepted(w_propose(&mut w, 1, native));
    let intent = w.intent(id);
    let recomputed = w.view(|_| crate::hash::intent_hash(&contract_id(), &intent.terms));
    assert_eq!(recomputed, intent.intent_hash);
    let other = w.view(|_| crate::hash::intent_hash(&acc("demo-getleash.biz.near"), &intent.terms));
    assert_ne!(other, intent.intent_hash, "the same terms hash differently on another contract");
    let mut edited = intent.terms.clone();
    edited.amount_out += 1;
    assert_ne!(w.view(|_| crate::hash::intent_hash(&contract_id(), &edited)), intent.intent_hash);
}

fn w_propose(w: &mut World, ob: u8, supplier: SupplierId) -> Result<ProposeResult, String> {
    w.propose(ob, supplier, 30 * USDC, None)
}

#[test]
fn supplier_changed_after_approval_invalidates_open_intents() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 30 * USDC, None));
    w.approve(intent).unwrap();
    let attempt = w.create_native(intent).unwrap();
    let reserved = w.ledger().reserved;
    assert_eq!(reserved, 30 * USDC);

    let asset = usdc_asset();
    w.owner(|c| c.update_supplier(native, Chain::Near, asset, "attacker.near".to_string())).unwrap();

    assert_eq!(w.intent(intent).status, IntentStatus::Invalidated);
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Void);
    assert_eq!(w.ledger().reserved, 0);
    expect_err(w.fund_native(attempt), "ATTEMPT_NOT_AUTHORIZED");
    expect_err(w.create_native(intent), "INTENT_NOT_APPROVED");
    let s = w.view(|c| c.get_supplier(native)).unwrap();
    assert_eq!((s.revision, s.verified, s.reserved_out), (2, false, 0));
    assert!(w.debits.is_empty(), "the old approval never paid anyone");
    // The obligation can be proposed again; the new destination starts its cooldown.
    assert_eq!(rejected(w.propose(1, native, 30 * USDC, None)), RejectReason::SupplierCooldown);
}

#[test]
fn approve_then_pause_or_deactivate_supplier_blocks_funding() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 10 * USDC, None));
    let attempt = w.create_native(intent).unwrap();
    w.owner(|c| c.pause()).unwrap();
    expect_err(w.fund_native(attempt), "PAUSED");
    expect_err(w.create_native(intent), "PAUSED");
    w.owner(|c| c.unpause()).unwrap();
    w.owner(|c| c.set_supplier_active(native, false)).unwrap();
    expect_err(w.fund_native(attempt), "INACTIVE_SUPPLIER");
    w.owner(|c| c.set_supplier_active(native, true)).unwrap();
    w.fund_native(attempt).unwrap();
}

#[test]
fn cooldown_allows_only_an_owner_signed_test_payment_and_verification_does_not_end_it() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    let fresh = w.add_supplier(Chain::Near, &usdc_asset(), "newco.near", 100 * USDC, 1_000 * USDC);
    assert_eq!(rejected(w.propose(1, fresh, USDC, None)), RejectReason::SupplierCooldown);
    let r = w.propose(2, fresh, USDC / 2, None).unwrap();
    assert_eq!(r.route, Some(Route::NeedsApproval(ApprovalReason::TestPayment)));
    let intent = r.intent_id.unwrap();
    assert!(w.intent(intent).terms.test_payment);
    w.approve(intent).unwrap();
    let attempt = w.create_native(intent).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::AwaitingOwner);
    expect_err(w.fund_native(attempt), "ATTEMPT_NOT_AUTHORIZED");
    w.authorize(attempt).unwrap();
    assert_eq!(w.attempt(attempt).authorization, AttemptAuth::OwnerSigned);
    w.fund_native(attempt).unwrap();
    w.transfer_callback(attempt, true).unwrap();
    // The supplier confirms out of band; the owner verifies. The cooldown still applies.
    w.verify(fresh);
    assert_eq!(rejected(w.propose(3, fresh, USDC, None)), RejectReason::SupplierCooldown);
    w.advance(2 * DAY);
    assert_eq!(w.propose(3, fresh, USDC, None).unwrap().route, Some(Route::Autonomous));
}

#[test]
fn verify_supplier_is_bound_to_the_revision() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let asset = usdc_asset();
    w.owner(|c| c.update_supplier(native, Chain::Near, asset, "acme2.near".to_string())).unwrap();
    expect_err(w.owner(|c| c.verify_supplier(native, 1)), "REVISION_MISMATCH");
    w.owner(|c| c.verify_supplier(native, 2)).unwrap();
}

#[test]
fn supplier_destinations_are_validated() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    let add = |w: &mut World, chain: Chain, asset: String, recipient: &str| {
        let recipient = recipient.to_string();
        w.owner(|c| c.add_supplier(chain, asset, recipient, U128(USDC), U128(USDC)))
    };
    expect_err(add(&mut w, Chain::Tron, TRON_USDT.into(), "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"), "BAD_TRON_RECIPIENT");
    expect_err(add(&mut w, Chain::Near, TRON_USDT.into(), "acme.near"), "ASSET_CHAIN_MISMATCH");
    expect_err(add(&mut w, Chain::Near, usdc_asset(), "getleash.biz.near"), "BAD_RECIPIENT");
    expect_err(add(&mut w, Chain::Near, usdc_asset(), "executor-1.biz.near"), "BAD_RECIPIENT");
    expect_err(add(&mut w, Chain::Near, "nep141:unknown.near".into(), "acme.near"), "UNKNOWN_ASSET");
    assert!(add(&mut w, Chain::Tron, TRON_USDT.into(), TRON_RECIPIENT_2).is_ok());
}

#[test]
fn rejected_and_amended_obligations() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 30 * USDC, None));
    w.owner(|c| c.reject(intent)).unwrap();
    assert_eq!(rejected(w.propose(1, native, 30 * USDC, None)), RejectReason::ObligationRejected);
    // The owner can revive it with a corrected amount; it still needs approval.
    let amended = w.owner(|c| c.amend_intent(intent, U128(28 * USDC))).unwrap();
    let a = w.intent(amended);
    assert_eq!(a.status, IntentStatus::Pending);
    assert_eq!(a.terms.route, Route::NeedsApproval(ApprovalReason::OwnerAmended));
    assert_eq!(a.terms.obligation_id, w.intent(intent).terms.obligation_id);
    expect_err(w.owner(|c| c.amend_intent(intent, U128(USDC))), "NOT_LATEST_FOR_OBLIGATION");
    w.approve(amended).unwrap();
    // Cancelling an approved intent releases the reservation and blocks the obligation.
    w.owner(|c| c.cancel(amended)).unwrap();
    assert_eq!(w.ledger().reserved, 0);
    assert_eq!(rejected(w.propose(1, native, 30 * USDC, None)), RejectReason::ObligationRejected);
}

// ── Budgets and accounting ─────────────────────────────────────────────────────────────────────

#[test]
fn sixty_of_hundred_in_flight_no_double_subtraction() {
    let mut w = World::new(Some(test_policy()), false);
    let s = w.add_supplier(Chain::Near, &usdc_asset(), "acme.near", 100 * USDC, 1_000 * USDC);
    w.top_up(100 * USDC).unwrap();
    w.advance(3 * DAY);
    w.verify(s);
    let intent = accepted(w.propose(1, s, 60 * USDC, None));
    w.approve(intent).unwrap();
    let attempt = w.create_native(intent).unwrap();
    w.fund_native(attempt).unwrap();
    let l = w.ledger();
    assert_eq!((l.cash, l.in_flight, l.reserved, l.available()), (40 * USDC, 60 * USDC, 0, 40 * USDC));
    // 40 is really available: a 40 payment fits, 41 does not.
    let mut p = test_policy();
    p.approval_threshold = 100 * USDC;
    p.autonomous_daily_budget = 100 * USDC;
    w.owner(|c| c.set_policy(p)).unwrap();
    assert_eq!(rejected(w.propose(2, s, 41 * USDC, None)), RejectReason::InsufficientFunds);
    accepted(w.propose(2, s, 40 * USDC, None));
    assert_eq!(w.ledger().available(), 0);
}

#[test]
fn concurrent_approvals_with_fee_headroom_never_exceed_cash() {
    let mut w = World::new(Some(test_policy()), false);
    w.add_tron_asset(3 * USDC / 2);
    let tron = w.add_supplier(Chain::Tron, TRON_USDT, TRON_RECIPIENT, 100 * USDC, 1_000 * USDC);
    w.top_up(20 * USDC).unwrap();
    w.advance(3 * DAY);
    w.verify(tron);
    // Each 2 USDT intent reserves 3.52 USDC (2.02 + 1.5 fixed fee bound).
    let mut approved = Vec::new();
    for ob in 1..=10u8 {
        let r = w.propose(ob, tron, 2 * USDC, None).unwrap();
        if !r.accepted {
            assert_eq!(r.reason, Some(RejectReason::InsufficientFunds));
            break;
        }
        approved.push(r.intent_id.unwrap());
        let l = w.ledger();
        assert!(l.reserved <= l.cash);
    }
    assert_eq!(approved.len(), 5, "5 × 3.52 = 17.6 ≤ 20 < 6 × 3.52");
    assert_eq!(w.intent(approved[0]).terms.max_in, 3_520_000);
}

#[test]
fn unexecutable_approved_intent_expires_releasing_only_the_unfunded_reservation() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let stuck = accepted(w.propose(1, native, 10 * USDC, None));
    let paid = accepted(w.propose(2, native, 5 * USDC, None));
    let a = w.create_native(paid).unwrap();
    w.fund_native(a).unwrap(); // in flight, callback pending
    assert_eq!(w.ledger().reserved, 10 * USDC);
    w.advance(3 * DAY + MINUTE);
    let swept = w.executor(|c| c.sweep(10)).unwrap();
    assert_eq!(swept.expired, 1);
    assert_eq!(w.intent(stuck).status, IntentStatus::Expired);
    assert_eq!(w.intent(paid).status, IntentStatus::Funding, "funded intents never expire");
    let l = w.ledger();
    assert_eq!((l.reserved, l.in_flight), (0, 5 * USDC));
    // An expired obligation may be proposed again.
    accepted(w.propose(1, native, 10 * USDC, None));
}

#[test]
fn autonomous_budget_caps_a_fabricated_small_invoice_stream() {
    // PLAN §8 "the honest one": small fake invoices to a real supplier are paid within the rules,
    // but the autonomous budget bounds the damage per day.
    let mut p = test_policy();
    p.autonomous_daily_budget = 20 * USDC;
    let (mut w, native, _) = standard_world(p, false);
    let mut auto_total = 0;
    for ob in 1..=10u8 {
        let r = w.propose(ob, native, 4 * USDC, None).unwrap();
        if r.route == Some(Route::Autonomous) {
            auto_total += 4 * USDC;
        } else {
            assert_eq!(r.route, Some(Route::NeedsApproval(ApprovalReason::AutonomousBudgetUsed)));
        }
    }
    assert_eq!(auto_total, 20 * USDC);
    let budgets = w.view(|c| c.get_budgets_today());
    assert_eq!(budgets.autonomous.used, 20 * USDC);
    assert_eq!(budgets.autonomous.remaining, 0);
}

#[test]
fn caps_hold_across_midnight_after_a_failed_transfer() {
    let mut p = test_policy();
    p.daily_cap = 50 * USDC;
    p.approval_threshold = 50 * USDC;
    p.autonomous_daily_budget = 200 * USDC;
    let mut w = World::new(Some(p), false);
    let s = w.add_supplier(Chain::Near, &usdc_asset(), "acme.near", 100 * USDC, 1_000 * USDC);
    w.top_up(500 * USDC).unwrap();
    // Start just before a midnight.
    w.advance(3 * DAY - 2 * MINUTE);
    w.verify(s);
    let a = accepted(w.propose(1, s, 40 * USDC, None));
    let at = w.create_native(a).unwrap();
    w.fund_native(at).unwrap();
    w.advance(5 * MINUTE); // new day
    let b = accepted(w.propose(2, s, 45 * USDC, None)); // fits the fresh day
    assert_eq!(w.intent(b).status, IntentStatus::Approved);
    // The first transfer turns out to have failed: restoring 40 would break today's cap.
    w.transfer_callback(at, false).unwrap();
    assert_eq!(w.intent(a).status, IntentStatus::Pending, "needs approval again (D-08)");
    let budgets = w.view(|c| c.get_budgets_today());
    assert!(budgets.daily.used <= 50 * USDC);
    assert_eq!(w.ledger().reserved, 45 * USDC);
}

// ── Cross-chain ────────────────────────────────────────────────────────────────────────────────

const DEPOSIT: &str = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
const DEPOSIT_2: &str = "aa2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";

#[test]
fn executor_supplies_its_own_deposit_address_above_the_trust_budget() {
    let (mut w, _, tron) = standard_world(test_policy(), false); // trust budget 0
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, "executor-loot.near", 2_865_850, "quote-1").unwrap();
    let a = w.attempt(attempt);
    assert_eq!(a.status, AttemptStatus::AwaitingOwner);
    assert_eq!(a.terms.final_recipient, TRON_RECIPIENT);
    assert_eq!(a.terms.refund_to, Some(contract_id()));
    assert_eq!(a.terms.deposit_type, Some(DepositType::OriginChain));
    expect_err(w.fund_cross(attempt), "ATTEMPT_NOT_AUTHORIZED");
    // The owner checks the quote on the attempt page, sees a mismatch, and cancels instead.
    w.owner(|c| c.cancel_attempt(attempt)).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Void);
    assert!(w.debits.is_empty());
}

#[test]
fn executor_funds_its_own_address_within_the_trust_budget_is_bounded() {
    let (mut w, _, tron) = standard_world(trust_policy(5 * USDC), false);
    let i1 = accepted(w.propose(1, tron, 2 * USDC, None));
    let i2 = accepted(w.propose(2, tron, 2 * USDC, None));
    let a1 = w.create_cross(i1, DEPOSIT, 3 * USDC, "q1").unwrap();
    assert_eq!(w.attempt(a1).authorization, AttemptAuth::TrustBudget);
    // The accepted risk: a stolen executor key can redirect this one (3 ≤ 5)…
    w.fund_cross(a1).unwrap();
    // …but not the next: 3 + 3 > 5 needs the owner.
    let a2 = w.create_cross(i2, DEPOSIT_2, 3 * USDC, "q2").unwrap();
    assert_eq!(w.attempt(a2).status, AttemptStatus::AwaitingOwner);
    expect_err(w.fund_cross(a2), "ATTEMPT_NOT_AUTHORIZED");
    assert_eq!(w.view(|c| c.get_budgets_today()).executor_trust.used, 3 * USDC);
}

#[test]
fn hosted_mode_cross_chain_always_needs_the_owner() {
    let (mut w, _, tron) = standard_world(test_policy(), true);
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, DEPOSIT, 3 * USDC, "q1").unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::AwaitingOwner);
}

#[test]
fn quote_reused_for_another_intent_or_attempt_rejected() {
    let (mut w, _, tron) = standard_world(trust_policy(10 * USDC), false);
    let i1 = accepted(w.propose(1, tron, 2 * USDC, None));
    let i2 = accepted(w.propose(2, tron, 2 * USDC, None));
    let a1 = w.create_cross(i1, DEPOSIT, 3 * USDC, "q1").unwrap();
    expect_err(w.create_cross(i1, DEPOSIT_2, 3 * USDC, "q2"), "LIVE_ATTEMPT_EXISTS");
    expect_err(w.create_cross(i2, DEPOSIT_2, 3 * USDC, "q1"), "QUOTE_REUSED");
    expect_err(w.create_cross(i2, DEPOSIT, 3 * USDC, "q3"), "DEPOSIT_ADDRESS_REUSED");
    // Even after the first attempt is cancelled, its quote and deposit account stay burnt.
    w.executor(|c| c.cancel_attempt(a1)).unwrap();
    expect_err(w.create_cross(i1, DEPOSIT, 3 * USDC, "q4"), "DEPOSIT_ADDRESS_REUSED");
    expect_err(w.create_cross(i1, DEPOSIT_2, 3 * USDC, "q1"), "QUOTE_REUSED");
    assert!(w.create_cross(i1, DEPOSIT_2, 3 * USDC, "q5").is_ok());
}

#[test]
fn crosschain_attempt_terms_are_checked() {
    let (mut w, native, tron) = standard_world(trust_policy(10 * USDC), false);
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    expect_err(w.create_cross(intent, DEPOSIT, 3_520_001, "q1"), "AMOUNT_IN_ABOVE_MAX");
    expect_err(w.create_cross(intent, "getleash.biz.near", 3 * USDC, "q1"), "BAD_DEPOSIT_ADDRESS");
    let soon = w.now + MINUTE;
    expect_err(
        w.executor(|c| c.create_attempt_crosschain(intent, acc(DEPOSIT), U128(3 * USDC), U64(soon), "q1".into())),
        "QUOTE_DEADLINE_TOO_SOON",
    );
    expect_err(w.create_cross(intent, DEPOSIT, 3 * USDC, "has space"), "BAD_QUOTE_REF");
    let native_intent = accepted(w.propose(2, native, USDC, None));
    expect_err(w.create_cross(native_intent, DEPOSIT, USDC, "q1"), "NOT_CROSSCHAIN");
    expect_err(w.create_native(intent), "NOT_NATIVE");
    // The right funding method only.
    let attempt = w.create_cross(intent, DEPOSIT, 3 * USDC, "q1").unwrap();
    expect_err(w.fund_native(attempt), "WRONG_FUNDING_METHOD");
    // Too close to the quote deadline: funding refused, sweep voids it, a fresh quote is needed.
    w.advance(28 * MINUTE);
    expect_err(w.fund_cross(attempt), "QUOTE_TOO_CLOSE_TO_DEADLINE");
    let swept = w.executor(|c| c.sweep(10)).unwrap();
    assert_eq!(swept.voided_attempts, 1);
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Void);
    assert_eq!(w.view(|c| c.get_budgets_today()).executor_trust.used, 0, "trust budget returned");
    assert!(w.create_cross(intent, DEPOSIT_2, 3 * USDC, "q2").is_ok());
}

#[test]
fn register_recipient_registers_only_the_committed_payee() {
    let (mut w, _, tron) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, DEPOSIT, 3 * USDC, "q1").unwrap();
    w.executor(|c| { c.register_recipient(attempt).detach(); }).unwrap();
    assert_eq!(w.registrations, vec![acc(DEPOSIT)]);
}

#[test]
fn executor_claims_a_refund_no_credit_no_budget_restoration() {
    let (mut w, _, tron) = standard_world(trust_policy(10 * USDC), false);
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, DEPOSIT, 2_865_850, "q1").unwrap();
    w.fund_cross(attempt).unwrap();
    w.transfer_callback(attempt, true).unwrap();
    let before = (w.ledger(), w.view(|c| c.get_budgets_today()));
    let entry = vec![InflowEntry { amount: 2_865_850, attribution: InflowAttribution::AttemptReturn { attempt_id: attempt } }];
    let e2 = entry.clone();
    expect_err(w.call(&executor(), zero(), Vec::new(), |c| c.reconcile_inflows(e2)), "ONLY_OWNER");
    expect_err(w.call(&executor(), one_yocto(), Vec::new(), |c| c.reconcile_inflows(entry)), "ONLY_OWNER");
    // Reporting delivery credits nothing either.
    w.executor(|c| c.report_delivery(attempt, U128(2 * USDC), "tron-tx-1".into())).unwrap();
    let after = (w.ledger(), w.view(|c| c.get_budgets_today()));
    assert_eq!(before.0.cash, after.0.cash);
    assert_eq!(before.1.daily, after.1.daily);
    assert_eq!(before.1.executor_trust, after.1.executor_trust);
}

#[test]
fn exact_output_swap_returns_change_recorded_separately() {
    let (mut w, _, tron) = standard_world(trust_policy(10 * USDC), false);
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, DEPOSIT, 2_865_850, "q1").unwrap();
    w.fund_cross(attempt).unwrap();
    w.transfer_callback(attempt, true).unwrap();
    assert_eq!(w.attempt(attempt).status, AttemptStatus::Funded);
    assert_eq!(w.ledger().reserved, 0, "fee slack released once the deposit is confirmed");
    w.executor(|c| c.report_delivery(attempt, U128(2 * USDC), "tron-tx-1".into())).unwrap();
    let spent = w.view(|c| c.get_budgets_today()).daily.used;
    // 1Click returns 14 330 units of unused input; the owner attributes it.
    let entry = vec![InflowEntry { amount: 14_330, attribution: InflowAttribution::AttemptReturn { attempt_id: attempt } }];
    let cash = w.ledger().cash;
    w.owner(|c| c.reconcile_inflows(entry)).unwrap();
    let a = w.attempt(attempt);
    assert_eq!(a.delivered_amount, Some(2 * USDC));
    assert_eq!(a.returned_amount, 14_330);
    assert_eq!(a.status, AttemptStatus::Delivered);
    assert_eq!(w.ledger().cash, cash + 14_330);
    assert_eq!(w.view(|c| c.get_budgets_today()).daily.used, spent, "returns never restore budget");
    // Never more than what left.
    let too_much = vec![InflowEntry { amount: 2_865_850, attribution: InflowAttribution::AttemptReturn { attempt_id: attempt } }];
    expect_err(w.owner(|c| c.reconcile_inflows(too_much)), "RETURN_EXCEEDS_AMOUNT_IN");
}

#[test]
fn refund_for_an_october_attempt_arriving_in_november_leaves_november_charges() {
    let mut w = World::new(Some(trust_policy(10 * USDC)), false);
    // Set up on Oct 27 so that Oct 31 23:00 is past the supplier's cooldown.
    w.now = NOV_1_2026 - 5 * DAY;
    w.add_tron_asset(3 * USDC / 2);
    let tron = w.add_supplier(Chain::Tron, TRON_USDT, TRON_RECIPIENT, 100 * USDC, 1_000 * USDC);
    w.top_up(100 * USDC).unwrap();
    w.advance(3 * DAY);
    w.verify(tron);
    w.now = NOV_1_2026 - HOUR; // Oct 31, 23:00
    let intent = accepted(w.propose(1, tron, 2 * USDC, None));
    let attempt = w.create_cross(intent, DEPOSIT, 2_865_850, "q1").unwrap();
    w.fund_cross(attempt).unwrap();
    w.transfer_callback(attempt, true).unwrap();
    let october = Period::at(w.now).month;
    w.executor(|c| c.flag_reconciliation(attempt)).unwrap();
    w.advance(2 * HOUR); // Nov 1, 01:00
    let november = Period::at(w.now).month;
    assert_ne!(october, november);
    w.owner(|c| c.resolve_reconciliation(attempt, ReconcileOutcome::SwapFailed)).unwrap();
    let refund = vec![InflowEntry { amount: 2_865_850, attribution: InflowAttribution::AttemptReturn { attempt_id: attempt } }];
    w.owner(|c| c.reconcile_inflows(refund)).unwrap();
    let l = w.ledger();
    assert_eq!(l.spent_month.current(november), 0, "November charges unchanged by the refund");
    assert_eq!(l.total_returned, 2_865_850);
    assert_eq!(w.attempt(attempt).status, AttemptStatus::SwapFailed);
    // The invoice is still owed: the intent is re-reserved for a retry with a fresh quote.
    let i = w.intent(intent);
    assert_eq!(i.status, IntentStatus::Approved);
    assert_eq!(i.reserved, i.terms.max_in);
}

#[test]
fn unrelated_top_up_during_refund_processing_stays_unreconciled_until_attributed() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    let cash = w.ledger().cash;
    // A plain ft_transfer arrives (no ft_on_transfer): the contract does not see it at all.
    // The dashboard shows it as live balance − cash. Only the owner can recognise it.
    assert_eq!(w.ledger().cash, cash);
    let entry = vec![InflowEntry { amount: 7 * USDC, attribution: InflowAttribution::Unattributed }];
    w.owner(|c| c.reconcile_inflows(entry)).unwrap();
    let l = w.ledger();
    assert_eq!(l.cash, cash + 7 * USDC);
    assert_eq!(l.total_unattributed, 7 * USDC);
}

// ── Withdrawals and upgrades ───────────────────────────────────────────────────────────────────

#[test]
fn withdraw_only_unreserved_cash_and_restore_on_failure() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let intent = accepted(w.propose(1, native, 30 * USDC, None));
    w.approve(intent).unwrap();
    expect_err(w.owner(|c| { c.withdraw(U128(471 * USDC)).detach(); }), "INSUFFICIENT_FUNDS");
    w.owner(|c| { c.withdraw(U128(470 * USDC)).detach(); }).unwrap();
    let debit = w.debits.last().unwrap().clone();
    assert_eq!((debit.receiver, debit.amount), (owner(), 470 * USDC));
    assert_eq!(debit.callback_withdraw, Some(470 * USDC));
    assert_eq!(w.ledger().cash, 30 * USDC);
    w.withdraw_callback(470 * USDC, false).unwrap();
    assert_eq!(w.ledger().cash, 500 * USDC);
    // Pause does not block the owner's exit.
    w.owner(|c| c.pause()).unwrap();
    w.owner(|c| { c.withdraw(U128(USDC)).detach(); }).unwrap();
}

#[test]
fn upgrade_deploys_and_migrates_in_one_batch() {
    let (mut w, _, _) = standard_world(test_policy(), false);
    // The raw input is the code; in unit tests env::input() is empty, so the call refuses.
    expect_err(w.owner(|c| { c.upgrade().detach(); }), "NO_CODE");
}

#[test]
fn prune_removes_old_closed_intents_but_keeps_obligations_blocked() {
    let (mut w, native, _) = standard_world(test_policy(), false);
    let (paid, attempt) = w.pay_native(1, native, 5 * USDC);
    let expiring = accepted(w.propose(2, native, 30 * USDC, None));
    w.advance(4 * DAY);
    w.executor(|c| c.sweep(10)).unwrap();
    assert_eq!(w.intent(expiring).status, IntentStatus::Expired);
    assert_eq!(w.executor(|c| c.prune(10)).unwrap(), 0, "retention not reached");
    w.advance(31 * DAY);
    assert_eq!(w.executor(|c| c.prune(10)).unwrap(), 2);
    assert!(w.view(|c| c.get_intent(paid)).is_none());
    assert!(w.view(|c| c.get_attempt(attempt)).is_none());
    assert_eq!(rejected(w.propose(1, native, 5 * USDC, None)), RejectReason::ObligationOpenOrPaid);
    accepted(w.propose(2, native, 5 * USDC, None)); // expired obligations stay re-proposable
}

#[test]
fn rotating_the_executor_or_going_hosted_voids_its_trust_budget_attempts() {
    // A compromised executor creates an attempt to its own deposit account inside the trust
    // budget. The owner rotates the executor: the new, honest executor must not fund it (D-19).
    let (mut w, _, tron) = standard_world(trust_policy(10 * USDC), false);
    let i1 = accepted(w.propose(1, tron, 2 * USDC, None));
    let stolen = w.create_cross(i1, DEPOSIT, 3 * USDC, "q1").unwrap();
    assert_eq!(w.attempt(stolen).authorization, AttemptAuth::TrustBudget);
    let new_executor = acc("executor-2.biz.near");
    let ne = new_executor.clone();
    w.owner(|c| c.rotate_executor(ne)).unwrap();
    assert_eq!(w.attempt(stolen).status, AttemptStatus::Void);
    assert_eq!(w.intent(i1).live_attempt, None);
    assert_eq!(w.view(|c| c.get_budgets_today()).executor_trust.used, 0);
    expect_err(
        w.call(&new_executor, zero(), Vec::new(), |c| c.fund_crosschain(stolen).detach()),
        "ATTEMPT_NOT_AUTHORIZED",
    );
    // The new executor re-quotes into a fresh attempt for the same intent.
    let deadline = w.now + 30 * MINUTE;
    let fresh = w
        .call(&new_executor, zero(), Vec::new(), |c| {
            c.create_attempt_crosschain(i1, acc(DEPOSIT_2), U128(3 * USDC), U64(deadline), "q2".into())
        })
        .unwrap();

    // Going hosted voids trust-budget attempts too, and blocks funding them.
    w.owner(|c| c.set_hosted_mode(true)).unwrap();
    assert_eq!(w.attempt(fresh).status, AttemptStatus::Void);
    assert!(w.debits.is_empty(), "nothing the untrusted executor chose was ever paid");
}
