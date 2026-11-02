//! Property tests: the pure budget and routing rules, and random walks over the whole contract
//! that check the safety invariants after every step (docs/audit-response.md, "Random walks").
//!
//! Deeper runs: `PROPTEST_CASES=500 cargo test contract_invariants_hold`.

use std::collections::{BTreeSet, HashMap};

use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

use super::harness::*;
use crate::budget::{day_of, fits, max_in, min_in, to_treasury_units};
use crate::rules::route;
use crate::types::*;
use crate::validate::to_hex;

// ── Pure rules ─────────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Counters never go down within a day and start from zero on a later one.
    #[test]
    fn budgets_only_go_up_within_a_day(day in 0u32..100_000, later in 1u32..10, a in 0u128..1u128 << 100, b in 0u128..1u128 << 100) {
        let budgets = Budgets { day, autonomous: a, outflow: b, trust: a, proposals: 3 };
        prop_assert_eq!(budgets.at(day), budgets);
        prop_assert_eq!(budgets.at(day.saturating_sub(1)), budgets);
        prop_assert_eq!(budgets.at(day + later), Budgets { day: day + later, ..Budgets::default() });
    }

    /// `Autonomous` only when every limit leaves room.
    #[test]
    fn route_is_autonomous_only_within_every_limit(
        value in 0u128..100 * USDC, extra in 0u128..5 * USDC, used_a in 0u128..60 * USDC, used_o in 0u128..250 * USDC,
        flagged in any::<bool>(), cooldown in any::<bool>(),
    ) {
        let p = test_policy();
        let b = Budgets { day: 1, autonomous: used_a, outflow: used_o, trust: 0, proposals: 0 };
        let max = value + extra;
        if route(&p, &b, value, max, flagged, cooldown) == Route::Autonomous {
            prop_assert!(!flagged && !cooldown);
            prop_assert!(value <= p.approval_threshold);
            prop_assert!(fits(used_a, max, p.autonomous_daily_budget));
            prop_assert!(fits(used_o, max, p.daily_cap));
        }
    }

    /// The fee bounds bracket the value, and unit conversion never rounds a payment down.
    #[test]
    fn fee_bounds_bracket_the_value(value in 0u128..1_000_000_000_000_000, bps in 0u16..=5_000, fixed in 0u128..10 * USDC, d in 0u8..=24) {
        let hi = max_in(value, bps, fixed).unwrap();
        prop_assert!(min_in(value, bps) <= value && value <= hi);
        if let Some(units) = to_treasury_units(value, d, 6)
            && d >= 6 { prop_assert!(units * 10u128.pow(u32::from(d - 6)) >= value); }
    }
}

// ── Random walks over the contract ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Op {
    Propose {
        ob: u8,
        supplier: u8,
        centi: u32,
        flag: bool,
    },
    Approve(u8),
    Reject(u8),
    Retry(u8),
    Mark(u8, bool),
    Attempt {
        id: u8,
        dep: u8,
        frac: u8,
    },
    Authorize(u8),
    Fund(u8),
    /// The owner signs and the executor funds straight after, as in practice.
    AuthorizeFund(u8),
    Settle(u8, bool),
    Stale(u8, bool),
    Advance(u16),
    Update(bool),
    Active(bool, bool),
    Pause(bool),
    Forget(Vec<u8>),
    Rotate,
    Withdraw(u32),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (0u8..16, 0u8..3, prop_oneof![3 => 50u32..450, 1 => 450u32..6_000], prop::bool::weighted(0.1))
            .prop_map(|(ob, supplier, centi, flag)| Op::Propose { ob, supplier, centi, flag }),
        3 => any::<u8>().prop_map(Op::Approve),
        1 => any::<u8>().prop_map(Op::Reject),
        4 => any::<u8>().prop_map(Op::Retry),
        1 => (any::<u8>(), any::<bool>()).prop_map(|(i, p)| Op::Mark(i, p)),
        4 => (any::<u8>(), 1u8..6, any::<u8>()).prop_map(|(id, dep, frac)| Op::Attempt { id, dep, frac }),
        5 => any::<u8>().prop_map(Op::Authorize),
        4 => any::<u8>().prop_map(Op::Fund),
        2 => any::<u8>().prop_map(Op::AuthorizeFund),
        5 => (any::<u8>(), prop::bool::weighted(0.7)).prop_map(|(i, ok)| Op::Settle(i, ok)),
        1 => (any::<u8>(), any::<bool>()).prop_map(|(i, ok)| Op::Stale(i, ok)),
        3 => prop_oneof![4 => 0u16..90, 1 => 90u16..2_000].prop_map(Op::Advance),
        1 => any::<bool>().prop_map(Op::Update),
        1 => (any::<bool>(), prop::bool::weighted(0.7)).prop_map(|(w, on)| Op::Active(w, on)),
        1 => prop::bool::weighted(0.3).prop_map(Op::Pause),
        1 => prop::collection::vec(any::<u8>(), 1..6).prop_map(Op::Forget),
        2 => Just(Op::Rotate),
        1 => (1u32..1_000).prop_map(Op::Withdraw),
    ]
}

/// What the walk has seen, to check the invariants against.
struct Model {
    policy: Policy,
    autonomous_by_day: HashMap<u32, u128>,
    trust_by_day: HashMap<u32, u128>,
    /// Payout debits (not withdrawals) per intent, and owner retries per intent.
    payouts: HashMap<IntentId, u32>,
    retries: HashMap<IntentId, u32>,
    /// Callbacks not yet delivered: (intent, since).
    callbacks: Vec<(IntentId, u64)>,
    /// Who each supplier pays at each revision.
    recipients: HashMap<(SupplierId, u32), String>,
    executor: near_sdk::AccountId,
    /// `next_intent_id` after the last step.
    next_id: IntentId,
    reached: BTreeSet<&'static str>,
}

/// Mostly one of the four newest intents (multi-step flows need the same id twice), otherwise
/// any id ever used, or one past the end.
fn pick_id(m: &Model, n: u8) -> IntentId {
    let newest = m.next_id.saturating_sub(1).max(1);
    if n < 192 {
        newest.saturating_sub(u64::from(n % 4)).max(1)
    } else {
        1 + u64::from(n) % m.next_id.max(1)
    }
}

fn exec_call<R>(
    w: &mut World,
    m: &Model,
    f: impl FnOnce(&mut crate::Contract) -> R,
) -> Result<R, String> {
    let executor = m.executor.clone();
    w.call(&executor, zero(), Vec::new(), Vec::new(), f)
}

fn step(w: &mut World, m: &mut Model, op: &Op) {
    let debits_before = w.debits.len();
    // The payee each payout path must use, computed before the call.
    let mut expect_receiver: Option<(IntentId, String)> = None;
    let mut trust_funding: Option<u128> = None;
    let ok = match op.clone() {
        Op::Propose {
            ob,
            supplier,
            centi,
            flag,
        } => {
            let amount = u128::from(centi) * 10_000;
            match w.propose(ob, u32::from(supplier), amount, u8::from(flag)) {
                Ok(r) if r.accepted => {
                    let i = w.intent(r.intent_id);
                    if r.route == Route::Autonomous {
                        *m.autonomous_by_day.entry(day_of(w.now)).or_default() += i.max_in;
                    }
                    if r.status == Status::Paying {
                        expect_receiver = Some((
                            r.intent_id,
                            m.recipients[&(i.supplier_id, i.revision)].clone(),
                        ));
                        m.reached.insert("native_autonomous_payout");
                    }
                    if r.route == Route::SupplierCooldown {
                        m.reached.insert("cooldown_hold");
                    }
                    true
                }
                Ok(_) => true,
                Err(_) => false,
            }
        }
        Op::Approve(n) => {
            let id = pick_id(m, n);
            let receiver = w
                .try_intent(id)
                .map(|i| m.recipients[&(i.supplier_id, i.revision)].clone());
            let r = receiver.is_some() && w.decide(id, "APPROVE").is_ok();
            if r && w.intent(id).status == Status::Paying {
                expect_receiver = receiver.map(|rcv| (id, rcv));
            }
            r
        }
        Op::Reject(n) => {
            let id = pick_id(m, n);
            w.try_intent(id).is_some() && w.decide(id, "REJECT").is_ok()
        }
        Op::Retry(n) => {
            let id = pick_id(m, n);
            let receiver = w
                .try_intent(id)
                .map(|i| m.recipients[&(i.supplier_id, i.revision)].clone());
            let r = w.try_intent(id).is_some() && w.decide(id, "RETRY").is_ok();
            if r {
                *m.retries.entry(id).or_default() += 1;
                m.reached.insert("retry");
                if w.intent(id).status == Status::Paying {
                    expect_receiver = receiver.map(|rcv| (id, rcv));
                }
            }
            r
        }
        Op::Mark(n, paid) => {
            let id = pick_id(m, n);
            let r = w.try_intent(id).is_some()
                && w.decide(id, if paid { "MARK_PAID" } else { "MARK_FAILED" })
                    .is_ok();
            if r {
                m.reached.insert("mark_after_grace");
            }
            r
        }
        Op::Attempt { id, dep, frac } => {
            let id = pick_id(m, id);
            match w.try_intent(id) {
                Some(i) => {
                    let lo = min_in(i.value, m.policy.max_fee_bps);
                    let amount_in = lo + (i.max_in - lo) * u128::from(frac) / 255;
                    let deadline = w.now + HOUR;
                    let replaced = i.attempt.is_some();
                    let r = exec_call(w, m, |c| {
                        c.create_attempt(id, deposit(dep), amount_in, deadline)
                    })
                    .is_ok();
                    if r && replaced {
                        m.reached.insert("requote");
                    }
                    r
                }
                None => false,
            }
        }
        Op::Authorize(n) => {
            let id = pick_id(m, n);
            w.try_intent(id).and_then(|i| i.attempt).is_some() && w.authorize(id).is_ok()
        }
        Op::AuthorizeFund(n) => {
            let id = pick_id(m, n);
            w.try_intent(id).and_then(|i| i.attempt).is_some()
                && w.authorize(id).is_ok()
                && fund_step(w, m, id, &mut expect_receiver, &mut trust_funding)
        }
        Op::Fund(n) => {
            let id = pick_id(m, n);
            fund_step(w, m, id, &mut expect_receiver, &mut trust_funding)
        }
        Op::Settle(n, success) => {
            let id = pick_id(m, n);
            if let Some(pos) = m.callbacks.iter().rposition(|(i, _)| *i == id) {
                let (_, since) = m.callbacks.remove(pos);
                w.callback(id, since, success)
                    .expect("callbacks never panic");
                if w.try_intent(id).is_some_and(|i| i.status == Status::Failed) {
                    m.reached.insert("payout_failed");
                }
                true
            } else {
                false
            }
        }
        Op::Stale(n, success) => {
            let id = pick_id(m, n);
            let before = w.try_intent(id);
            let since = before.as_ref().map_or(0, |i| i.since.wrapping_sub(1));
            w.callback(id, since, success)
                .expect("callbacks never panic");
            assert_eq!(w.try_intent(id), before, "a stale callback changes nothing");
            m.reached.insert("stale_callback_ignored");
            true
        }
        Op::Advance(minutes) => {
            w.advance(u64::from(minutes) * MINUTE);
            true
        }
        Op::Update(native) => {
            let (id, chain, asset, a, b) = if native {
                (1, "NEAR", usdc_asset(), "acme.near", "acme-new.near")
            } else {
                (
                    2,
                    "TRON",
                    TRON_USDT.to_string(),
                    TRON_RECIPIENT,
                    TRON_RECIPIENT_2,
                )
            };
            let s = w.supplier(id);
            let next = if s.recipient == a { b } else { a };
            let r = w.update_supplier(id, chain, &asset, next, 6).is_ok();
            if r {
                m.recipients.insert((id, s.revision + 1), next.to_string());
            }
            r
        }
        Op::Active(native, on) => {
            let id = if native { 1 } else { 2 };
            w.owner_json(
                near_sdk::serde_json::json!({ "supplier_id": id, "active": on }),
                |c| c.set_supplier_active(),
            )
            .is_ok()
        }
        Op::Pause(p) => w.set_paused(p).is_ok(),
        Op::Forget(ns) => {
            let ids: Vec<IntentId> = ns.iter().map(|n| pick_id(m, *n)).collect();
            let r = exec_call(w, m, |c| c.forget(ids));
            if matches!(r, Ok(n) if n > 0) {
                m.reached.insert("forgotten");
            }
            r.is_ok()
        }
        Op::Rotate => {
            let next = if m.executor == executor() {
                acc("executor-2.biz.near")
            } else {
                executor()
            };
            let r = w.set_roles(&agent(), &next).is_ok();
            if r {
                m.executor = next;
            }
            r
        }
        Op::Withdraw(units) => w
            .owner_json(
                near_sdk::serde_json::json!({ "amount": (u128::from(units) * 1_000).to_string() }),
                |c| c.withdraw(),
            )
            .is_ok(),
    };

    // New debits: at most one payout per step, to exactly the expected payee.
    let new: Vec<Debit> = w.debits[debits_before..].to_vec();
    let payouts: Vec<&Debit> = new.iter().filter(|d| d.callback.is_some()).collect();
    assert!(
        payouts.len() <= 1,
        "{op:?} produced {} payouts",
        payouts.len()
    );
    if let Some(d) = payouts.first() {
        let (id, since) = d.callback.unwrap();
        let (expected_id, receiver) = expect_receiver
            .clone()
            .unwrap_or_else(|| panic!("{op:?} paid unexpectedly: {d:?}"));
        assert_eq!(id, expected_id, "{op:?}");
        assert_eq!(d.receiver, receiver, "{op:?} paid the wrong account");
        *m.payouts.entry(id).or_default() += 1;
        m.callbacks.push((id, since));
        if let Some(amount) = trust_funding {
            assert_eq!(d.amount, amount);
            *m.trust_by_day.entry(day_of(d.at)).or_default() += amount;
        }
    } else {
        assert!(expect_receiver.is_none() || !ok, "{op:?} should have paid");
    }
    for d in new.iter().filter(|d| d.callback.is_none()) {
        assert_eq!(
            d.receiver,
            owner().to_string(),
            "only withdrawals go out without a callback"
        );
    }
    check_invariants(w, m);
}

/// The executor funds `id`; records the payee and any trust-budget use for the checks.
fn fund_step(
    w: &mut World,
    m: &mut Model,
    id: IntentId,
    expect_receiver: &mut Option<(IntentId, String)>,
    trust_funding: &mut Option<u128>,
) -> bool {
    let before = w.try_intent(id);
    let r = exec_call(w, m, |c| c.fund(id));
    match (&r, before.and_then(|i| i.attempt)) {
        (Ok(()), Some(a)) => {
            *expect_receiver = Some((id, to_hex(&a.deposit)));
            if !a.authorized {
                *trust_funding = Some(a.amount_in);
                m.reached.insert("trust_funded");
            } else {
                m.reached.insert("owner_funded");
            }
        }
        (Err(e), _) if e.contains("STALE_EXECUTOR_EPOCH") => {
            m.reached.insert("rotation_voided_trust");
        }
        _ => {}
    }
    r.is_ok()
}

fn check_invariants(w: &mut World, m: &mut Model) {
    let p = &m.policy;
    let mut outflow_by_day: HashMap<u32, u128> = HashMap::new();
    for d in w.debits.iter().filter(|d| d.callback.is_some()) {
        *outflow_by_day.entry(day_of(d.at)).or_default() += d.amount;
    }
    for (day, total) in &outflow_by_day {
        assert!(
            *total <= p.daily_cap,
            "day {day}: {total} sent, cap {}",
            p.daily_cap
        );
    }
    for (day, total) in &m.autonomous_by_day {
        assert!(
            *total <= p.autonomous_daily_budget,
            "day {day}: agent approved {total} alone"
        );
    }
    for (day, total) in &m.trust_by_day {
        assert!(
            *total <= p.executor_trust_daily_budget,
            "day {day}: executor funded {total} untrusted"
        );
    }
    for (id, n) in &m.payouts {
        let retries = m.retries.get(id).copied().unwrap_or(0);
        assert!(
            *n <= 1 + retries,
            "intent {id} paid {n} times with {retries} owner retries"
        );
    }
    let state = w.state();
    m.next_id = state.next_intent_id;
    let today = day_of(w.now);
    assert_eq!(
        state.budgets.outflow,
        outflow_by_day.get(&today).copied().unwrap_or(0),
        "outflow counter"
    );
    let mut stored = 0;
    let mut paying = 0;
    let mut from = 1;
    while from < state.next_intent_id {
        for (_, i) in w.view(|c| c.get_intents(from, MAX_BATCH)) {
            stored += 1;
            paying += u32::from(i.status == Status::Paying);
        }
        from += u64::from(MAX_BATCH);
    }
    assert_eq!(state.stored_intents, stored);
    assert_eq!(state.paying, paying);
    assert!(state.stored_intents <= MAX_STORED_INTENTS);
}

fn new_walk() -> (World, Model) {
    let policy = test_policy();
    let (w, _, _) = standard_world(&policy);
    let mut recipients = HashMap::new();
    recipients.insert((1, 1), "acme.near".to_string());
    recipients.insert((2, 1), TRON_RECIPIENT.to_string());
    let model = Model {
        policy,
        autonomous_by_day: HashMap::new(),
        trust_by_day: HashMap::new(),
        payouts: HashMap::new(),
        retries: HashMap::new(),
        callbacks: Vec::new(),
        recipients,
        executor: executor(),
        next_id: 1,
        reached: BTreeSet::new(),
    };
    (w, model)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 16, ..ProptestConfig::default() })]

    #[test]
    fn contract_invariants_hold(ops in prop::collection::vec(op(), 1..120)) {
        let (mut w, mut m) = new_walk();
        for op in &ops {
            step(&mut w, &mut m, op);
        }
    }
}

/// The walks must actually reach the interesting states, or the invariants above prove little.
#[test]
fn random_walks_reach_deep_states() {
    let mut reached = BTreeSet::new();
    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::deterministic_rng(RngAlgorithm::ChaCha),
    );
    let strategy = prop::collection::vec(op(), 150);
    for _ in 0..12 {
        let ops = strategy.new_tree(&mut runner).unwrap().current();
        let (mut w, mut m) = new_walk();
        for op in &ops {
            step(&mut w, &mut m, op);
        }
        reached.extend(m.reached);
    }
    for label in [
        "native_autonomous_payout",
        "cooldown_hold",
        "retry",
        "mark_after_grace",
        "requote",
        "trust_funded",
        "owner_funded",
        // "rotation_voided_trust" is rare in random walks; the unit test
        // rotating_the_executor_voids_trust_funding_of_its_attempts covers it deterministically.
        "payout_failed",
        "stale_callback_ignored",
        "forgotten",
    ] {
        assert!(
            reached.contains(label),
            "walks never reached {label}; reached {reached:?}"
        );
    }
}
