//! Unit and scenario tests. Names follow the PLAN §9 adversarial table where a row still applies
//! (docs/audit-response.md maps rows to tests).

use near_sdk::serde_json::json;

use super::harness::*;
use crate::types::*;

const T: u128 = USDC;

fn propose_ok(w: &mut World, ob: u8, supplier: SupplierId, amount: u128) -> ProposeResult {
    let r = w.propose(ob, supplier, amount, 0).unwrap();
    assert!(r.accepted, "refused: {:?}", r.reason);
    r
}

/// An approved cross-chain intent with an unauthorized attempt on deposit `dep`.
fn crosschain_with_attempt(
    w: &mut World,
    tron: SupplierId,
    ob: u8,
    amount: u128,
    amount_in: u128,
    dep: u8,
) -> IntentId {
    let r = propose_ok(w, ob, tron, amount);
    if r.status == Status::Pending {
        w.decide(r.intent_id, "APPROVE").unwrap();
    }
    assert_eq!(w.intent(r.intent_id).status, Status::Approved);
    let deadline = w.now + HOUR;
    w.create_attempt(r.intent_id, dep, amount_in, deadline)
        .unwrap();
    r.intent_id
}

// ── Setup and access control ───────────────────────────────────────────────────────────────────

#[test]
fn init_sets_roles_and_policy() {
    let mut w = World::new(&test_policy());
    let s = w.state();
    assert_eq!(
        (s.owner_id, s.agent_id, s.executor_id, s.token_id),
        (owner(), agent(), executor(), usdc())
    );
    assert_eq!(s.policy, test_policy());
    assert_eq!(
        (
            s.next_supplier_id,
            s.next_intent_id,
            s.stored_intents,
            s.paying
        ),
        (1, 1, 0, 0)
    );
}

#[test]
fn every_role_is_enforced() {
    let (mut w, native, _) = standard_world(&test_policy());
    expect_err(
        w.call(&stranger(), zero(), Vec::new(), Vec::new(), |c| {
            c.propose([1; 32], native, T, 0)
        }),
        "ONLY_AGENT",
    );
    expect_err(
        w.call(&owner(), zero(), Vec::new(), Vec::new(), |c| {
            c.propose([1; 32], native, T, 0)
        }),
        "ONLY_AGENT",
    );
    expect_err(
        w.call(&agent(), zero(), Vec::new(), Vec::new(), |c| c.fund(1)),
        "ONLY_EXECUTOR",
    );
    expect_err(
        w.call(&agent(), zero(), Vec::new(), Vec::new(), |c| {
            c.create_attempt(1, deposit(1), T, 0)
        }),
        "ONLY_EXECUTOR",
    );
    expect_err(
        w.call(&agent(), zero(), Vec::new(), Vec::new(), |c| {
            c.forget(vec![1])
        }),
        "ONLY_EXECUTOR_OR_OWNER",
    );
    let args = json!({ "paused": true }).to_string().into_bytes();
    expect_err(
        w.call(&executor(), one_yocto(), args.clone(), Vec::new(), |c| {
            c.set_paused()
        }),
        "ONLY_OWNER",
    );
    // The owner without exactly 1 yocto (i.e. not a full-access key) is refused too.
    expect_err(
        w.call(&owner(), zero(), args, Vec::new(), |c| c.set_paused()),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
}

#[test]
fn unauthorized_callers_spam_proposals_panic_before_writing() {
    let (mut w, native, _) = standard_world(&test_policy());
    let before = w.state();
    for n in 0..20 {
        expect_err(
            w.call(&stranger(), zero(), Vec::new(), Vec::new(), |c| {
                c.propose([n; 32], native, T, 0)
            }),
            "ONLY_AGENT",
        );
    }
    assert_eq!(w.state(), before, "nothing was written");
    assert!(w.debits.is_empty());
}

#[test]
fn owner_arguments_are_parsed_strictly() {
    let (mut w, native, _) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, native, 40 * T).intent_id; // above threshold: pending
    let raw = |text: &str| text.as_bytes().to_vec();
    let decide = |w: &mut World, text: &str| {
        w.call(&owner(), one_yocto(), raw(text), Vec::new(), |c| c.decide())
    };
    // A wallet could show the first value while a lax parser read the second.
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"APPROVE","amount_out":"1","amount_out":"40000000","supplier_id":1}"#,
        ),
        "DUPLICATE_ARG",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"APPROVE","amount_out":"40000000","supplier_id":1,"x":1}"#,
        ),
        "UNKNOWN_ARG",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"APPROVE","amount_out":"40000000"}"#,
        ),
        "MISSING_ARG",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1.0,"action":"APPROVE","amount_out":"40000000","supplier_id":1}"#,
        ),
        "BAD_JSON",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":"1","action":"APP\u0052OVE","amount_out":"40000000","supplier_id":1}"#,
        ),
        "BAD_JSON",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"APPROVE","amount_out":"040000000","supplier_id":1}"#,
        ),
        "BAD_NUMBER",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"APPROVE","amount_out":"40000000","supplier_id":1} x"#,
        ),
        "BAD_JSON",
    );
    expect_err(
        decide(
            &mut w,
            r#"{"intent_id":1,"action":"approve","amount_out":"40000000","supplier_id":1}"#,
        ),
        "BAD_ACTION",
    );
    assert_eq!(w.intent(id).status, Status::Pending);
    // Whitespace and numbers-as-strings are fine.
    decide(&mut w, " {\n \"intent_id\" : \"1\", \"action\":\"APPROVE\", \"amount_out\":\"40000000\", \"supplier_id\":1 }\n").unwrap();
    assert_eq!(w.intent(id).status, Status::Paying);
}

#[test]
fn policy_validation() {
    let (mut w, _, _) = standard_world(&test_policy());
    let bad = |f: fn(&mut Policy)| {
        let mut p = test_policy();
        f(&mut p);
        p
    };
    expect_err(
        w.set_policy(&bad(|p| p.autonomous_daily_budget = p.daily_cap + 1)),
        "POLICY_ABOVE_DAILY_CAP",
    );
    expect_err(
        w.set_policy(&bad(|p| p.executor_trust_daily_budget = p.daily_cap + 1)),
        "POLICY_ABOVE_DAILY_CAP",
    );
    expect_err(
        w.set_policy(&bad(|p| p.callback_grace_ns = HOUR - 1)),
        "POLICY_CALLBACK_GRACE",
    );
    expect_err(
        w.set_policy(&bad(|p| p.funding_margin_ns = p.quote_min_validity_ns + 1)),
        "POLICY_QUOTE_MARGINS",
    );
    expect_err(
        w.set_policy(&bad(|p| p.max_fee_bps = 5_001)),
        "POLICY_FEE_BPS",
    );
    expect_err(
        w.set_policy(&bad(|p| p.max_proposals_per_day = 0)),
        "POLICY_MAX_PROPOSALS",
    );
    expect_err(
        w.set_policy(&bad(|p| p.retention_ns = DAY - 1)),
        "POLICY_RETENTION",
    );
    let mut ok = test_policy();
    ok.executor_trust_daily_budget = 0;
    w.set_policy(&ok).unwrap();
    assert_eq!(w.state().policy, ok);
}

// ── Native payouts ─────────────────────────────────────────────────────────────────────────────

#[test]
fn native_funding_debit_equals_amount_out() {
    let (mut w, native, _) = standard_world(&test_policy());
    let r = propose_ok(&mut w, 1, native, 18 * T);
    assert_eq!((r.status, r.route), (Status::Paying, Route::Autonomous));
    assert_eq!(w.debits.len(), 1);
    let d = w.debits[0].clone();
    assert_eq!(
        (d.receiver.as_str(), d.amount, d.registered),
        ("acme.near", 18 * T, false)
    );
    assert_eq!(d.callback, Some((r.intent_id, w.now)));
    assert_eq!(w.state().paying, 1);
    w.settle(r.intent_id, true).unwrap();
    assert_eq!(w.intent(r.intent_id).status, Status::Paid);
    assert_eq!(w.state().paying, 0);
}

#[test]
fn a_native_payout_the_token_refuses_fails_cleanly_and_can_be_retried() {
    let (mut w, native, _) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    w.settle(id, false).unwrap(); // e.g. balance too low: the token refuses, nothing moves
    assert_eq!(w.intent(id).status, Status::Failed);
    let b = w.state().budgets;
    assert_eq!(
        (b.autonomous, b.outflow),
        (10 * T, 10 * T),
        "failed transfers never give budget back"
    );
    w.advance(MINUTE);
    w.decide(id, "RETRY").unwrap();
    assert_eq!(w.debits.len(), 2);
    assert_eq!(
        w.state().budgets.outflow,
        20 * T,
        "the retry is counted again"
    );
    w.settle(id, true).unwrap();
    assert_eq!(w.intent(id).status, Status::Paid);
    expect_err(w.decide(id, "RETRY"), "NOT_RETRYABLE");
}

#[test]
fn above_threshold_waits_for_the_owner_and_approval_names_the_terms() {
    let (mut w, native, _) = standard_world(&test_policy());
    let r = propose_ok(&mut w, 1, native, 40 * T);
    assert_eq!(
        (r.status, r.route),
        (Status::Pending, Route::AboveThreshold)
    );
    assert!(w.debits.is_empty());
    expect_err(
        w.decide_terms(r.intent_id, "APPROVE", 4 * T, native),
        "TERMS_MISMATCH",
    );
    expect_err(
        w.decide_terms(r.intent_id, "APPROVE", 40 * T, native + 1),
        "TERMS_MISMATCH",
    );
    w.decide(r.intent_id, "APPROVE").unwrap();
    assert_eq!(w.intent(r.intent_id).status, Status::Paying);
    assert_eq!(
        (w.debits[0].receiver.as_str(), w.debits[0].amount),
        ("acme.near", 40 * T)
    );
    assert_eq!(
        w.state().budgets.autonomous,
        0,
        "owner approvals do not use the agent's budget"
    );
}

#[test]
fn autonomous_budget_caps_a_fabricated_small_invoice_stream() {
    let (mut w, native, _) = standard_world(&test_policy());
    for n in 0..5 {
        let r = propose_ok(&mut w, n, native, 10 * T);
        assert_eq!(r.route, Route::Autonomous, "invoice {n}");
    }
    let r = propose_ok(&mut w, 5, native, 10 * T);
    assert_eq!(
        (r.status, r.route),
        (Status::Pending, Route::AutonomousBudgetUsed)
    );
    assert_eq!(
        w.debits.iter().map(|d| d.amount).sum::<u128>(),
        50 * T,
        "at most the autonomous budget per day"
    );
    w.advance(DAY);
    assert_eq!(
        propose_ok(&mut w, 6, native, 10 * T).route,
        Route::Autonomous,
        "a new day, a new budget"
    );
}

#[test]
fn the_daily_cap_binds_the_owner_too() {
    let mut p = test_policy();
    p.daily_cap = 60 * T;
    p.autonomous_daily_budget = 20 * T;
    let (mut w, native, _) = standard_world(&p);
    let a = propose_ok(&mut w, 1, native, 50 * T).intent_id;
    let b = propose_ok(&mut w, 2, native, 30 * T).intent_id; // both above the 25 threshold
    w.decide(a, "APPROVE").unwrap();
    expect_err(w.decide(b, "APPROVE"), "OVER_DAILY_CAP");
    assert_eq!(w.intent(b).status, Status::Pending);
    w.advance(DAY);
    w.decide(b, "APPROVE").unwrap();
    assert_eq!(w.debits.len(), 2);
}

#[test]
fn a_review_flag_can_only_force_review() {
    let (mut w, native, _) = standard_world(&test_policy());
    let r = w.propose(1, native, T, 1).unwrap();
    assert_eq!((r.status, r.route), (Status::Pending, Route::ReviewFlag));
    expect_err(w.propose(2, native, T, 5), "BAD_FLAG");
    assert!(w.debits.is_empty());
}

#[test]
fn prompt_injection_to_an_unknown_supplier_is_refused_and_logged() {
    let (mut w, _, _) = standard_world(&test_policy());
    let r = w.propose(1, 0, 3 * T, 0).unwrap();
    assert_eq!(
        (r.accepted, r.reason, r.intent_id),
        (false, Reason::UnknownSupplier, 0)
    );
    assert_eq!(w.state().stored_intents, 0, "refusals store nothing");
    assert!(
        w.logs
            .iter()
            .any(|l| l.contains("proposal_refused") && l.contains("UNKNOWN_SUPPLIER"))
    );
    // Its invoice is not blocked: a refusal is not an obligation.
    assert_eq!(
        w.propose(1, 0, 3 * T, 0).unwrap().reason,
        Reason::UnknownSupplier
    );
}

// ── Invoices (obligations) ─────────────────────────────────────────────────────────────────────

#[test]
fn same_invoice_with_edited_fields_keeps_its_obligation_id() {
    let (mut w, native, _) = standard_world(&test_policy());
    let paid = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    w.settle(paid, true).unwrap();
    assert_eq!(
        w.propose(1, native, 12 * T, 0).unwrap().reason,
        Reason::ObligationOpenOrPaid
    );
    let rejected = propose_ok(&mut w, 2, native, 40 * T).intent_id;
    w.decide(rejected, "REJECT").unwrap();
    assert_eq!(
        w.propose(2, native, 40 * T, 0).unwrap().reason,
        Reason::ObligationRejected
    );
    // After retention both are forgotten, and both invoices stay blocked.
    w.advance(8 * DAY);
    assert_eq!(w.forget(vec![paid, rejected]).unwrap(), 2);
    assert_eq!(
        w.propose(1, native, 10 * T, 0).unwrap().reason,
        Reason::ObligationOpenOrPaid
    );
    assert_eq!(
        w.propose(2, native, 40 * T, 0).unwrap().reason,
        Reason::ObligationRejected
    );
}

#[test]
fn unexecutable_approved_intent_expires_and_frees_its_invoice_when_forgotten() {
    let (mut w, native, tron) = standard_world(&test_policy());
    let pending = propose_ok(&mut w, 1, native, 40 * T).intent_id;
    let approved = propose_ok(&mut w, 2, tron, 2 * T).intent_id;
    assert_eq!(w.intent(approved).status, Status::Approved);
    w.advance(3 * DAY + 1);
    expect_err(w.decide(pending, "APPROVE"), "INTENT_EXPIRED");
    let deadline = w.now + HOUR;
    expect_err(
        w.create_attempt(approved, 9, 2_100_000, deadline),
        "INTENT_EXPIRED",
    );
    assert_eq!(w.forget(vec![pending, approved]).unwrap(), 2);
    assert_eq!(w.state().stored_intents, 0);
    assert!(
        propose_ok(&mut w, 1, native, 40 * T).accepted,
        "an expired, never-paid invoice can be proposed again"
    );
}

#[test]
fn forget_never_touches_live_or_recent_intents() {
    let (mut w, native, _) = standard_world(&test_policy());
    let paying = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    let pending = propose_ok(&mut w, 2, native, 40 * T).intent_id;
    let paid = propose_ok(&mut w, 3, native, 10 * T).intent_id;
    w.settle(paid, true).unwrap();
    assert_eq!(w.forget(vec![paying, pending, paid, 99]).unwrap(), 0);
    w.advance(30 * DAY);
    assert_eq!(
        w.forget(vec![paying]).unwrap(),
        0,
        "a payout in flight is never forgotten"
    );
    expect_err(w.forget((0..51).collect()), "TOO_MANY");
}

// ── Suppliers and the cooldown ─────────────────────────────────────────────────────────────────

#[test]
fn cooldown_holds_every_payment_and_caps_even_the_owner() {
    let (mut w, native, _) = standard_world(&test_policy());
    w.update_supplier(native, "NEAR", &usdc_asset(), "acme-new.near", 6)
        .unwrap();
    let normal = w.propose(1, native, 3 * T, 0).unwrap();
    assert_eq!(
        (normal.status, normal.route),
        (Status::Pending, Route::SupplierCooldown)
    );
    expect_err(w.decide(normal.intent_id, "APPROVE"), "OVER_COOLDOWN_MAX");
    let test = propose_ok(&mut w, 2, native, T / 2);
    assert_eq!(test.route, Route::SupplierCooldown);
    w.decide(test.intent_id, "APPROVE").unwrap();
    assert_eq!(
        (w.debits[0].receiver.as_str(), w.debits[0].amount),
        ("acme-new.near", T / 2)
    );
    w.advance(2 * DAY);
    w.decide(normal.intent_id, "APPROVE").unwrap();
    assert_eq!(w.debits.len(), 2);
}

#[test]
fn supplier_changed_after_approval_invalidates_open_intents() {
    let (mut w, native, tron) = standard_world(&test_policy());
    let pending = propose_ok(&mut w, 1, native, 40 * T).intent_id;
    let cross = crosschain_with_attempt(&mut w, tron, 2, 2 * T, 2_100_000, 7);
    w.update_supplier(native, "NEAR", &usdc_asset(), "acme-new.near", 6)
        .unwrap();
    w.update_supplier(tron, "TRON", TRON_USDT, TRON_RECIPIENT_2, 6)
        .unwrap();
    expect_err(w.decide(pending, "APPROVE"), "SUPPLIER_CHANGED");
    w.authorize(cross).unwrap();
    expect_err(w.fund(cross), "SUPPLIER_CHANGED");
    assert!(w.debits.is_empty());
    // Stale intents can be forgotten at once, freeing the invoices for the new address.
    assert_eq!(w.forget(vec![pending, cross]).unwrap(), 2);
    assert!(w.propose(1, native, 40 * T, 0).unwrap().accepted);
}

#[test]
fn approve_then_pause_or_deactivate_supplier_blocks_funding() {
    let (mut w, native, tron) = standard_world(&test_policy());
    let id = crosschain_with_attempt(&mut w, tron, 1, 2 * T, 2_100_000, 7);
    w.set_paused(true).unwrap();
    expect_err(w.fund(id), "PAUSED");
    w.set_paused(false).unwrap();
    w.owner_json(json!({ "supplier_id": tron, "active": false }), |c| {
        c.set_supplier_active()
    })
    .unwrap();
    expect_err(w.fund(id), "INACTIVE_SUPPLIER");
    let pending = propose_ok(&mut w, 2, native, 40 * T).intent_id;
    w.owner_json(json!({ "supplier_id": native, "active": false }), |c| {
        c.set_supplier_active()
    })
    .unwrap();
    expect_err(w.decide(pending, "APPROVE"), "INACTIVE_SUPPLIER");
    assert_eq!(
        w.propose(3, native, T, 0).unwrap().reason,
        Reason::InactiveSupplier
    );
    assert!(w.debits.is_empty());
}

#[test]
fn supplier_destinations_are_validated() {
    let mut w = World::new(&test_policy());
    for bad in [
        "getleash.biz.near",
        "biz.near",
        "agent-1.biz.near",
        "executor-1.biz.near",
        "Not An Account",
    ] {
        expect_err(
            w.add_supplier("NEAR", &usdc_asset(), bad, 6),
            "BAD_NEAR_RECIPIENT",
        );
    }
    expect_err(
        w.add_supplier("NEAR", &usdc_asset(), usdc().as_str(), 6),
        "BAD_NEAR_RECIPIENT",
    );
    expect_err(
        w.add_supplier("TRON", TRON_USDT, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60", 6),
        "BAD_TRON_RECIPIENT",
    );
    expect_err(
        w.add_supplier("TRON", TRON_USDT, "acme.near", 6),
        "BAD_TRON_RECIPIENT",
    );
    expect_err(
        w.add_supplier("SOLANA", TRON_USDT, TRON_RECIPIENT, 6),
        "BAD_CHAIN",
    );
    expect_err(
        w.add_supplier("TRON", "nep141:has space", TRON_RECIPIENT, 6),
        "BAD_ASSET_ID",
    );
    // A native supplier must use the token's decimals: otherwise 1,000 USDC could count as 1.
    expect_err(
        w.add_supplier("NEAR", &usdc_asset(), "acme.near", 18),
        "NATIVE_DECIMALS",
    );
    // USDT on NEAR is not native (paid via 1Click), so other decimals are fine there.
    assert_eq!(
        w.add_supplier("NEAR", "nep141:usdt.tether-token.near", "acme.near", 6)
            .unwrap(),
        1
    );
}

// ── Cross-chain payouts ────────────────────────────────────────────────────────────────────────

#[test]
fn executor_supplies_its_own_deposit_address_above_the_trust_budget() {
    let (mut w, _, tron) = standard_world(&test_policy());
    // 20 USDT, approved by the owner; the attempt needs 20.3, above the 5 USDC trust budget.
    let id = crosschain_with_attempt(&mut w, tron, 1, 20 * T, 20_300_000, 66);
    expect_err(w.fund(id), "OVER_TRUST_BUDGET");
    assert!(
        w.debits.is_empty(),
        "funding is impossible without the owner's signature"
    );
    w.authorize(id).unwrap();
    w.fund(id).unwrap();
    let d = w.debits[0].clone();
    assert_eq!(
        (d.receiver, d.amount, d.registered),
        (deposit_hex(66), 20_300_000, true)
    );
    assert_eq!(
        w.state().budgets.trust,
        0,
        "owner-signed funding does not use the trust budget"
    );
    w.settle(id, true).unwrap();
    assert_eq!(w.intent(id).status, Status::Paid);
}

#[test]
fn executor_funds_its_own_address_within_the_trust_budget_is_bounded() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let a = crosschain_with_attempt(&mut w, tron, 1, 2 * T, 2_300_000, 7);
    let b = crosschain_with_attempt(&mut w, tron, 2, 2 * T, 2_300_000, 8);
    let c = crosschain_with_attempt(&mut w, tron, 3, T, 1_100_000, 9);
    w.fund(a).unwrap();
    w.fund(b).unwrap();
    expect_err(w.fund(c), "OVER_TRUST_BUDGET");
    assert_eq!(w.state().budgets.trust, 4_600_000);
    assert!(
        w.debits.iter().map(|d| d.amount).sum::<u128>() <= 5 * T,
        "at most the trust budget per day without the owner"
    );
    w.advance(DAY);
    // Next day there is room again; the old quote has expired, so the executor re-quotes.
    expect_err(w.fund(c), "QUOTE_TOO_CLOSE_TO_DEADLINE");
    let deadline = w.now + HOUR;
    w.create_attempt(c, 10, 1_100_000, deadline).unwrap();
    w.fund(c).unwrap();
}

#[test]
fn requoted_attempt_cannot_use_an_earlier_authorization() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let id = crosschain_with_attempt(&mut w, tron, 1, 20 * T, 20_300_000, 66);
    let reviewed = deposit_hex(66);
    // The executor swaps in another deposit before the owner's signature lands.
    let deadline = w.now + HOUR;
    w.create_attempt(id, 67, 20_300_000, deadline).unwrap();
    expect_err(
        w.authorize_terms(id, &reviewed, 20_300_000),
        "TERMS_MISMATCH",
    );
    expect_err(w.fund(id), "OVER_TRUST_BUDGET");
    // And an authorization never survives a re-quote.
    w.authorize(id).unwrap();
    let deadline = w.now + HOUR;
    w.create_attempt(id, 68, 20_300_000, deadline).unwrap();
    assert!(!w.intent(id).attempt.unwrap().authorized);
    expect_err(
        w.create_attempt(id, 68, 20_300_000, deadline),
        "SAME_DEPOSIT",
    );
}

#[test]
fn rotating_the_executor_voids_trust_funding_of_its_attempts() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let id = crosschain_with_attempt(&mut w, tron, 1, 2 * T, 2_300_000, 7);
    // The executor key is stolen; the owner rotates it. The new executor must not fund the old
    // key's deposits from the trust budget.
    let new_executor = acc("executor-2.biz.near");
    w.set_roles(&agent(), &new_executor).unwrap();
    assert_eq!(w.state().executor_epoch, 1);
    let fund = w.call(&new_executor, zero(), Vec::new(), Vec::new(), |c| {
        c.fund(id)
    });
    expect_err(fund, "STALE_EXECUTOR_EPOCH");
    expect_err(w.fund(id), "ONLY_EXECUTOR");
    // An owner-signed attempt is still fine.
    w.authorize(id).unwrap();
    w.call(&new_executor, zero(), Vec::new(), Vec::new(), |c| {
        c.fund(id)
    })
    .unwrap();
    assert_eq!(w.debits.len(), 1);
}

#[test]
fn attempts_are_refused_on_native_intents() {
    let (mut w, native, _) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, native, 40 * T).intent_id;
    let deadline = w.now + HOUR;
    expect_err(
        w.create_attempt(id, 7, 40 * T, deadline),
        "INTENT_NOT_APPROVED",
    );
    expect_err(w.fund(id), "INTENT_NOT_APPROVED");
    // Native intents never rest in APPROVED: approving pays at once.
    w.decide(id, "APPROVE").unwrap();
    assert_eq!(w.intent(id).status, Status::Paying);
    expect_err(w.fund(id), "INTENT_NOT_APPROVED");
}

#[test]
fn crosschain_attempt_terms_are_checked() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, tron, 2 * T).intent_id; // value 2, max_in 2*1.01+1.5 = 3.52
    assert_eq!(w.intent(id).max_in, 3_520_000);
    let now = w.now;
    expect_err(
        w.create_attempt(id, 7, 2_100_000, now + MINUTE),
        "BAD_DEADLINE",
    );
    expect_err(
        w.create_attempt(id, 7, 2_100_000, now + DAY + 1),
        "BAD_DEADLINE",
    );
    expect_err(w.create_attempt(id, 7, 3_520_001, now + HOUR), "FEE_BOUND");
    expect_err(w.create_attempt(id, 7, 1_979_999, now + HOUR), "FEE_BOUND");
    // Circle's USDC id is itself 64-hex: it must never be accepted as a deposit account.
    let usdc_bytes = crate::validate::parse_hex32(usdc().as_str()).unwrap();
    let bad = w.call(&executor(), zero(), Vec::new(), Vec::new(), |c| {
        c.create_attempt(id, usdc_bytes, 2_100_000, now + HOUR)
    });
    expect_err(bad, "BAD_DEPOSIT");
    w.create_attempt(id, 7, 1_980_000, now + HOUR).unwrap();
    w.create_attempt(id, 8, 3_520_000, now + HOUR).unwrap();
}

#[test]
fn cooldown_crosschain_attempts_need_the_owner() {
    let (mut w, _, tron) = standard_world(&test_policy());
    w.update_supplier(tron, "TRON", TRON_USDT, TRON_RECIPIENT_2, 6)
        .unwrap();
    let r = propose_ok(&mut w, 1, tron, T / 2);
    assert_eq!(r.route, Route::SupplierCooldown);
    w.decide(r.intent_id, "APPROVE").unwrap();
    let deadline = w.now + HOUR;
    w.create_attempt(r.intent_id, 7, 600_000, deadline).unwrap();
    expect_err(w.fund(r.intent_id), "COOLDOWN_NEEDS_OWNER");
    w.authorize(r.intent_id).unwrap();
    w.fund(r.intent_id).unwrap();
}

#[test]
fn quote_deadline_margin_blocks_funding_and_authorization() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let id = crosschain_with_attempt(&mut w, tron, 1, 2 * T, 2_300_000, 7);
    w.advance(HOUR - 2 * MINUTE); // inside the 3-minute margin
    expect_err(w.fund(id), "QUOTE_TOO_CLOSE_TO_DEADLINE");
    expect_err(w.authorize(id), "QUOTE_TOO_CLOSE_TO_DEADLINE");
}

#[test]
fn executor_claims_a_refund_no_budget_restoration() {
    let (mut w, _, tron) = standard_world(&test_policy());
    let id = crosschain_with_attempt(&mut w, tron, 1, 2 * T, 2_300_000, 7);
    w.fund(id).unwrap();
    w.settle(id, true).unwrap();
    let before = w.state().budgets;
    // The swap is refunded: USDC comes back to the contract by plain transfer. Nothing on-chain
    // gives budget back; only the owner can send the intent round again, and that is counted.
    expect_err(
        w.call(&executor(), zero(), Vec::new(), Vec::new(), |c| c.decide()),
        "ONLY_OWNER",
    );
    w.decide(id, "RETRY").unwrap();
    let i = w.intent(id);
    assert_eq!((i.status, i.attempt), (Status::Approved, None));
    assert_eq!(w.state().budgets, before);
    let deadline = w.now + HOUR;
    w.create_attempt(id, 8, 2_300_000, deadline).unwrap();
    w.fund(id).unwrap();
    assert_eq!(w.state().budgets.outflow, before.outflow + 2_300_000);
}

// ── Callbacks ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn stale_callback_after_a_retry_has_no_effect() {
    let (mut w, native, _) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    let (_, first) = w.debits[0].callback.unwrap();
    // The callback is late; after the grace time the owner marks it failed and retries.
    expect_err(w.decide(id, "MARK_FAILED"), "NOT_STUCK");
    w.advance(HOUR);
    w.decide(id, "MARK_FAILED").unwrap();
    w.decide(id, "RETRY").unwrap();
    let (_, second) = w.debits[1].callback.unwrap();
    assert_ne!(first, second);
    // The late callback of the first transfer must not settle the second.
    w.callback(id, first, true).unwrap();
    assert_eq!(w.intent(id).status, Status::Paying);
    assert!(w.logs.iter().any(|l| l == "CALLBACK_STALE"));
    w.callback(id, second, true).unwrap();
    assert_eq!(w.intent(id).status, Status::Paid);
    assert_eq!(w.state().paying, 0);
}

#[test]
fn a_lost_callback_can_only_be_settled_after_the_grace_time() {
    let (mut w, native, _) = standard_world(&test_policy());
    let id = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    expect_err(w.decide(id, "MARK_PAID"), "NOT_STUCK");
    expect_err(w.decide(id, "RETRY"), "NOT_RETRYABLE");
    expect_err(
        w.call(&owner(), one_yocto(), Vec::new(), Vec::new(), |c| {
            c.upgrade()
        }),
        "PAYOUTS_IN_FLIGHT",
    );
    w.advance(HOUR);
    w.decide(id, "MARK_PAID").unwrap();
    assert_eq!((w.intent(id).status, w.state().paying), (Status::Paid, 0));
}

#[test]
fn callbacks_never_panic() {
    let (mut w, native, _) = standard_world(&test_policy());
    w.callback(42, 0, true).unwrap();
    let id = propose_ok(&mut w, 1, native, 10 * T).intent_id;
    w.settle(id, true).unwrap();
    w.settle(id, false).unwrap(); // a duplicate after settlement
    assert_eq!(w.intent(id).status, Status::Paid);
    let wrong = w.call(&contract_id(), zero(), Vec::new(), Vec::new(), |c| {
        c.on_paid(id, 0)
    });
    assert!(wrong.is_ok());
}

// ── Quotas, storage and pause ──────────────────────────────────────────────────────────────────

#[test]
fn authorized_agent_spam_hits_the_daily_quota_and_the_storage_cap() {
    let mut p = test_policy();
    p.max_proposals_per_day = 60;
    let (mut w, native, _) = standard_world(&p);
    for n in 0..MAX_STORED_INTENTS as u8 {
        assert!(w.propose(n, native, 40 * T, 0).unwrap().accepted);
    }
    assert_eq!(
        w.propose(200, native, 40 * T, 0).unwrap().reason,
        Reason::StorageFull
    );
    for n in 0..9u8 {
        w.propose(201 + n, native, 40 * T, 0).unwrap();
    }
    expect_err(w.propose(250, native, 40 * T, 0), "QUOTA_PROPOSALS");
    assert_eq!(w.state().stored_intents, MAX_STORED_INTENTS);
    w.advance(DAY);
    assert_eq!(
        w.propose(251, native, 40 * T, 0).unwrap().reason,
        Reason::StorageFull,
        "the cap holds across days"
    );
}

#[test]
fn pause_blocks_payments_but_not_exits() {
    let (mut w, native, tron) = standard_world(&test_policy());
    let pending = propose_ok(&mut w, 1, native, 40 * T).intent_id;
    let cross = crosschain_with_attempt(&mut w, tron, 2, 2 * T, 2_300_000, 7);
    let paying = propose_ok(&mut w, 3, native, 10 * T).intent_id;
    w.set_paused(true).unwrap();
    assert_eq!(w.propose(4, native, T, 0).unwrap().reason, Reason::Paused);
    expect_err(w.decide(pending, "APPROVE"), "PAUSED");
    expect_err(w.authorize(cross), "PAUSED");
    expect_err(w.fund(cross), "PAUSED");
    let deadline = w.now + HOUR;
    expect_err(w.create_attempt(cross, 8, 2_300_000, deadline), "PAUSED");
    // Still allowed: callbacks, rejections, withdrawals, admin.
    w.settle(paying, true).unwrap();
    w.decide(pending, "REJECT").unwrap();
    w.owner_json(json!({ "amount": "1000000" }), |c| c.withdraw())
        .unwrap();
    assert_eq!(w.debits.last().unwrap().receiver, owner().to_string());
    w.set_policy(&test_policy()).unwrap();
}

// ── Owner powers ───────────────────────────────────────────────────────────────────────────────

#[test]
fn non_owner_calls_upgrade_or_withdraw_rejected_and_owner_needs_one_yocto() {
    let (mut w, _, _) = standard_world(&test_policy());
    let amount = json!({ "amount": "1" }).to_string().into_bytes();
    expect_err(
        w.call(
            &stranger(),
            one_yocto(),
            b"\0asm".to_vec(),
            Vec::new(),
            |c| c.upgrade(),
        ),
        "ONLY_OWNER",
    );
    expect_err(
        w.call(&agent(), one_yocto(), amount.clone(), Vec::new(), |c| {
            c.withdraw()
        }),
        "ONLY_OWNER",
    );
    expect_err(
        w.call(&executor(), one_yocto(), amount.clone(), Vec::new(), |c| {
            c.withdraw_near()
        }),
        "ONLY_OWNER",
    );
    expect_err(
        w.call(&owner(), zero(), amount, Vec::new(), |c| c.withdraw()),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    expect_err(
        w.call(&owner(), one_yocto(), Vec::new(), Vec::new(), |c| {
            c.upgrade()
        }),
        "NO_CODE",
    );
    w.call(
        &owner(),
        one_yocto(),
        b"\0asm-new-code".to_vec(),
        Vec::new(),
        |c| c.upgrade(),
    )
    .unwrap();
    assert_eq!(w.deploys, 1);
}

#[test]
fn withdraw_near_keeps_storage_and_a_reserve() {
    let (mut w, _, _) = standard_world(&test_policy());
    // The mocked account holds 2 NEAR and a few hundred bytes of storage.
    expect_err(
        w.owner_json(json!({ "amount": "1960000000000000000000000" }), |c| {
            c.withdraw_near()
        }),
        "NOT_ENOUGH_NEAR",
    );
    w.owner_json(json!({ "amount": "1000000000000000000000000" }), |c| {
        c.withdraw_near()
    })
    .unwrap();
    assert_eq!(
        w.near_transfers,
        vec![(owner().to_string(), 1_000_000_000_000_000_000_000_000)]
    );
}

#[test]
fn set_roles_keeps_roles_distinct() {
    let (mut w, _, _) = standard_world(&test_policy());
    expect_err(w.set_roles(&agent(), &agent()), "ROLES_MUST_DIFFER");
    expect_err(w.set_roles(&owner(), &executor()), "ROLES_MUST_DIFFER");
    expect_err(w.set_roles(&usdc(), &executor()), "BAD_ROLE");
    expect_err(w.set_roles(&agent(), &contract_id()), "BAD_ROLE");
    w.set_roles(&acc("agent-2.biz.near"), &executor()).unwrap();
    assert_eq!(
        w.state().executor_epoch,
        0,
        "a new agent alone does not bump the executor epoch"
    );
}
