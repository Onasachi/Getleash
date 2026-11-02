//! Property tests (PLAN §9 "Property tests").
//!
//! 1. `ledger_invariants_hold`: random operation sequences on the pure ledger, checked against a
//!    simple model after every step.
//! 2. `contract_invariants_hold`: a model-based random walk over the whole contract. Every role
//!    acts (agent, executor, owner, the token contract, strangers), callbacks arrive in any order,
//!    get lost or replayed, time jumps across days and months, suppliers change, the contract
//!    pauses. After every step all PLAN §4.1.3 invariants are checked, plus token conservation:
//!    what the token contract holds always equals what the ledger thinks it holds plus money whose
//!    transfer outcome the contract has not learned yet.

use std::collections::{HashMap, HashSet};

use near_sdk::json_types::{U128, U64};
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, TestCaseError, TestRunner};

use super::harness::*;
use crate::ledger::*;
use crate::types::*;

// ── 1. Pure ledger ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum LedgerOp {
    Credit(u32),
    Reserve(u32),
    Release(u8),
    Fund(u8, u8),
    Confirm(u8),
    Land(u8),
    Fail(u8),
    Withdraw(u32),
    FailWithdraw(u8),
    Advance(u32),
}

#[derive(Clone, Copy, Debug)]
enum Item {
    Reserved { max_in: u128 },
    Pending { max_in: u128, amount_in: u128, charged: Period },
    Sent { amount_in: u128 },
    Closed,
}

fn ledger_op() -> impl Strategy<Value = LedgerOp> {
    prop_oneof![
        3 => (1u32..500).prop_map(LedgerOp::Credit),
        4 => (1u32..300).prop_map(LedgerOp::Reserve),
        1 => any::<u8>().prop_map(LedgerOp::Release),
        3 => (any::<u8>(), 1u8..=100).prop_map(|(i, p)| LedgerOp::Fund(i, p)),
        2 => any::<u8>().prop_map(LedgerOp::Confirm),
        2 => any::<u8>().prop_map(LedgerOp::Land),
        2 => any::<u8>().prop_map(LedgerOp::Fail),
        1 => (1u32..200).prop_map(LedgerOp::Withdraw),
        1 => any::<u8>().prop_map(LedgerOp::FailWithdraw),
        2 => (0u32..200_000).prop_map(LedgerOp::Advance),
    ]
}

fn pick(items: &[Item], i: u8, want: fn(&Item) -> bool) -> Option<usize> {
    let candidates: Vec<usize> = (0..items.len()).filter(|&k| want(&items[k])).collect();
    (!candidates.is_empty()).then(|| candidates[i as usize % candidates.len()])
}

proptest! {
    #![proptest_config(Config { cases: 512, ..Config::default() })]

    #[test]
    fn ledger_invariants_hold(ops in prop::collection::vec(ledger_op(), 1..150)) {
        let caps = Caps { daily: 1_000, monthly: 3_000 };
        let mut now = NOV_1_2026;
        let mut l = Ledger::default();
        let mut items: Vec<Item> = Vec::new();
        let mut withdrawals: Vec<u128> = Vec::new();
        let mut cash: u128 = 0;
        for op in ops {
            let at = Period::at(now);
            match op {
                LedgerOp::Credit(a) => {
                    l.credit(u128::from(a), CreditKind::TopUp).unwrap();
                    cash += u128::from(a);
                }
                LedgerOp::Reserve(a) => {
                    let a = u128::from(a);
                    let feasible = l.check_reserve(a, at, caps).is_ok();
                    prop_assert_eq!(l.reserve(a, at, caps).is_ok(), feasible);
                    if feasible {
                        items.push(Item::Reserved { max_in: a });
                    }
                }
                LedgerOp::Release(i) => {
                    if let Some(k) = pick(&items, i, |it| matches!(it, Item::Reserved { .. })) {
                        let Item::Reserved { max_in } = items[k] else { unreachable!() };
                        l.release(max_in).unwrap();
                        items[k] = Item::Closed;
                    }
                }
                LedgerOp::Fund(i, pct) => {
                    if let Some(k) = pick(&items, i, |it| matches!(it, Item::Reserved { .. })) {
                        let Item::Reserved { max_in } = items[k] else { unreachable!() };
                        let amount_in = (max_in * u128::from(pct) / 100).max(1);
                        l.fund(amount_in, at).unwrap();
                        cash -= amount_in;
                        items[k] = Item::Pending { max_in, amount_in, charged: at };
                    }
                }
                LedgerOp::Confirm(i) => {
                    if let Some(k) = pick(&items, i, |it| matches!(it, Item::Pending { .. })) {
                        let Item::Pending { max_in, amount_in, .. } = items[k] else { unreachable!() };
                        l.confirm_sent(max_in - amount_in).unwrap();
                        items[k] = Item::Sent { amount_in };
                    }
                }
                LedgerOp::Land(i) => {
                    if let Some(k) = pick(&items, i, |it| matches!(it, Item::Sent { .. })) {
                        let Item::Sent { amount_in } = items[k] else { unreachable!() };
                        l.land(amount_in).unwrap();
                        items[k] = Item::Closed;
                    }
                }
                LedgerOp::Fail(i) => {
                    if let Some(k) = pick(&items, i, |it| matches!(it, Item::Pending { .. })) {
                        let Item::Pending { max_in, amount_in, charged } = items[k] else { unreachable!() };
                        let restored = l.fail_transfer(amount_in, charged, at, caps, true).unwrap();
                        cash += amount_in;
                        if charged == at {
                            prop_assert!(restored, "same-period failures always restore");
                        }
                        if restored {
                            items[k] = Item::Reserved { max_in };
                        } else {
                            l.release(max_in - amount_in).unwrap();
                            items[k] = Item::Closed;
                        }
                    }
                }
                LedgerOp::Withdraw(a) => {
                    let a = u128::from(a);
                    let available = l.available();
                    match l.begin_withdraw(a) {
                        Ok(()) => {
                            withdrawals.push(a);
                            cash -= a;
                        }
                        Err(_) => prop_assert!(a > available),
                    }
                }
                LedgerOp::FailWithdraw(i) => {
                    if !withdrawals.is_empty() {
                        let a = withdrawals.remove(i as usize % withdrawals.len());
                        l.fail_withdraw(a).unwrap();
                        cash += a;
                    }
                }
                LedgerOp::Advance(s) => now += u64::from(s) * SECOND,
            }

            let at = Period::at(now);
            prop_assert!(l.check_invariants().is_ok());
            prop_assert_eq!(l.cash, cash);
            let reserved: u128 = items.iter().map(|it| match *it {
                Item::Reserved { max_in } => max_in,
                Item::Pending { max_in, amount_in, .. } => max_in - amount_in,
                _ => 0,
            }).sum();
            prop_assert_eq!(l.reserved, reserved);
            let flight: u128 = items.iter().map(|it| match *it {
                Item::Pending { amount_in, .. } | Item::Sent { amount_in } => amount_in,
                _ => 0,
            }).sum();
            prop_assert_eq!(l.in_flight, flight);
            prop_assert!(l.committed_day(at.day).unwrap() <= caps.daily);
            prop_assert!(l.committed_month(at.month).unwrap() <= caps.monthly);
            prop_assert_eq!(l.available(), l.cash - l.reserved);
        }
    }
}

// ── 2. Whole contract ──────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Act {
    TopUp(u8),
    Propose { s: u8, ob: u8, amt: u8, flag: bool },
    Approve(u8),
    BadApprove(u8),
    Reject(u8),
    Cancel(u8),
    Amend(u8, u8),
    CreateNative(u8),
    CreateCross { i: u8, pct: u8, q: u16 },
    Authorize(u8),
    CancelAttempt(u8),
    Register(u8),
    Fund(u8),
    FundWrongMethod(u8),
    Callback { a: u8, ok: bool },
    DropCallback { a: u8, sent: bool },
    Replay(u8),
    Deliver(u8),
    Flag(u8),
    Resolve(u8, u8),
    Return { a: u8, pct: u8 },
    Withdraw(u8),
    WithdrawCallback(bool),
    UpdateSupplier(u8),
    Verify(u8),
    SetActive(u8, bool),
    Pause,
    Unpause,
    Advance(u32),
    Sweep,
    Prune,
    Intruder(u8),
}

fn act() -> impl Strategy<Value = Act> {
    prop_oneof![
        3 => any::<u8>().prop_map(Act::TopUp),
        14 => (any::<u8>(), any::<u8>(), any::<u8>(), prop::bool::weighted(0.15))
            .prop_map(|(s, ob, amt, flag)| Act::Propose { s, ob, amt, flag }),
        6 => any::<u8>().prop_map(Act::Approve),
        1 => any::<u8>().prop_map(Act::BadApprove),
        1 => any::<u8>().prop_map(Act::Reject),
        1 => any::<u8>().prop_map(Act::Cancel),
        1 => (any::<u8>(), any::<u8>()).prop_map(|(i, a)| Act::Amend(i, a)),
        7 => any::<u8>().prop_map(Act::CreateNative),
        7 => (any::<u8>(), any::<u8>(), any::<u16>()).prop_map(|(i, pct, q)| Act::CreateCross { i, pct, q }),
        6 => any::<u8>().prop_map(Act::Authorize),
        1 => any::<u8>().prop_map(Act::CancelAttempt),
        1 => any::<u8>().prop_map(Act::Register),
        11 => any::<u8>().prop_map(Act::Fund),
        1 => any::<u8>().prop_map(Act::FundWrongMethod),
        8 => (any::<u8>(), prop::bool::weighted(0.65)).prop_map(|(a, ok)| Act::Callback { a, ok }),
        3 => (any::<u8>(), any::<bool>()).prop_map(|(a, sent)| Act::DropCallback { a, sent }),
        1 => any::<u8>().prop_map(Act::Replay),
        3 => any::<u8>().prop_map(Act::Deliver),
        5 => any::<u8>().prop_map(Act::Flag),
        5 => (any::<u8>(), any::<u8>()).prop_map(|(a, c)| Act::Resolve(a, c)),
        2 => (any::<u8>(), 1u8..=100).prop_map(|(a, pct)| Act::Return { a, pct }),
        1 => any::<u8>().prop_map(Act::Withdraw),
        1 => any::<bool>().prop_map(Act::WithdrawCallback),
        1 => any::<u8>().prop_map(Act::UpdateSupplier),
        1 => any::<u8>().prop_map(Act::Verify),
        1 => (any::<u8>(), prop::bool::weighted(0.7)).prop_map(|(s, b)| Act::SetActive(s, b)),
        1 => Just(Act::Pause),
        2 => Just(Act::Unpause),
        6 => prop_oneof![0u32..30, 0u32..4_320].prop_map(Act::Advance),
        2 => Just(Act::Sweep),
        1 => Just(Act::Prune),
        2 => any::<u8>().prop_map(Act::Intruder),
    ]
}

struct Sim {
    w: World,
    /// What the token contract says the policy contract holds.
    balance: u128,
    /// Attempts whose amount left `cash` but whose tokens have not (yet) left `balance`.
    unsettled: HashMap<AttemptId, u128>,
    /// Whether each funded attempt's transfer really happened, once decided.
    truth: HashMap<AttemptId, bool>,
    pending_callbacks: Vec<AttemptId>,
    delivered_callbacks: Vec<AttemptId>,
    pending_withdrawals: Vec<u128>,
    suppliers: Vec<SupplierId>,
    renames: u32,
    debits_checked: usize,
    funded: HashSet<AttemptId>,
    stats: HashMap<&'static str, usize>,
}

impl Sim {
    fn new() -> Self {
        let mut p = Policy::defaults(6);
        p.autonomous_daily_budget = 30 * USDC;
        p.approval_threshold = 15 * USDC;
        p.daily_cap = 120 * USDC;
        p.monthly_cap = 400 * USDC;
        p.executor_trust_daily_budget = 8 * USDC;
        p.unverified_cumulative_budget = 10 * USDC;
        p.test_payment_max = USDC / 2;
        p.max_open_intents = 20;
        p.max_proposals_per_day = 200;
        p.max_attempts_per_day = 200;
        p.max_registrations_per_day = 50;
        let mut w = World::new(Some(p), false);
        w.add_tron_asset(3 * USDC / 2);
        let s1 = w.add_supplier(Chain::Near, &usdc_asset(), "acme.near", 50 * USDC, 300 * USDC);
        let s2 = w.add_supplier(Chain::Tron, TRON_USDT, TRON_RECIPIENT, 50 * USDC, 300 * USDC);
        w.top_up(300 * USDC).unwrap();
        w.advance(3 * DAY);
        w.verify(s1);
        w.verify(s2);
        let s3 = w.add_supplier(Chain::Near, &usdc_asset(), "newco.near", 50 * USDC, 300 * USDC);
        Sim {
            w,
            balance: 300 * USDC,
            unsettled: HashMap::new(),
            truth: HashMap::new(),
            pending_callbacks: Vec::new(),
            delivered_callbacks: Vec::new(),
            pending_withdrawals: Vec::new(),
            suppliers: vec![s1, s2, s3],
            renames: 0,
            debits_checked: 0,
            funded: HashSet::new(),
            stats: HashMap::new(),
        }
    }

    fn hit(&mut self, what: &'static str) {
        *self.stats.entry(what).or_default() += 1;
    }

    fn intent_id(&mut self, i: u8) -> Option<IntentId> {
        let next = self.w.view(|c| c.next_intent_id);
        (next > 1).then(|| 1 + u64::from(i) % (next - 1))
    }

    fn attempt_id(&mut self, i: u8) -> Option<AttemptId> {
        let next = self.w.view(|c| c.next_attempt_id);
        (next > 1).then(|| 1 + u64::from(i) % (next - 1))
    }

    /// Three times in four, an intent in the wanted state; otherwise any intent (so invalid
    /// transitions keep being tried too).
    fn pick_intent(&mut self, i: u8, want: fn(&Intent) -> bool) -> Option<IntentId> {
        if i % 4 == 0 {
            return self.intent_id(i / 4);
        }
        let ids: Vec<IntentId> = self.w.view(|c| {
            (1..c.next_intent_id).filter(|id| c.get_intent(*id).is_some_and(|x| want(&x))).collect()
        });
        (!ids.is_empty()).then(|| ids[i as usize % ids.len()])
    }

    fn pick_attempt(&mut self, i: u8, want: fn(&Attempt) -> bool) -> Option<AttemptId> {
        if i % 4 == 0 {
            return self.attempt_id(i / 4);
        }
        let ids: Vec<AttemptId> = self.w.view(|c| {
            (1..c.next_attempt_id).filter(|id| c.get_attempt(*id).is_some_and(|x| want(&x))).collect()
        });
        (!ids.is_empty()).then(|| ids[i as usize % ids.len()])
    }

    fn step(&mut self, act: Act) -> Result<(), TestCaseError> {
        match act {
            Act::TopUp(a) => {
                let amount = u128::from(a % 50 + 1) * USDC;
                if self.w.top_up(amount).is_ok() {
                    self.balance += amount;
                }
            }
            Act::Propose { s, ob, amt, flag } => {
                let supplier = if s % 7 == 6 { 999 } else { self.suppliers[s as usize % 3] };
                let amount = u128::from(amt % 60 + 1) * USDC / 2;
                let flag = flag.then_some(ReviewFlag::UnusualAmount);
                if let Ok(r) = self.w.propose(ob % 24, supplier, amount, flag) {
                    self.hit(if r.accepted { "propose_accepted" } else { "propose_rejected" });
                }
            }
            Act::Approve(i) => {
                if let Some(id) = self.pick_intent(i, |x| x.status == IntentStatus::Pending) {
                    if self.w.approve(id).is_ok() {
                        self.hit("approve");
                    }
                }
            }
            Act::BadApprove(i) => {
                if let Some(id) = self.intent_id(i) {
                    let r = self.w.owner(|c| c.approve(id, "11".repeat(32)));
                    prop_assert!(r.is_err(), "approval with a wrong hash must fail");
                }
            }
            Act::Reject(i) => {
                if let Some(id) = self.pick_intent(i, |x| x.status == IntentStatus::Pending) {
                    if self.w.owner(|c| c.reject(id)).is_ok() {
                        self.hit("reject");
                    }
                }
            }
            Act::Cancel(i) => {
                if let Some(id) = self.pick_intent(i, |x| matches!(x.status, IntentStatus::Pending | IntentStatus::Approved)) {
                    if self.w.owner(|c| c.cancel(id)).is_ok() {
                        self.hit("cancel");
                    }
                }
            }
            Act::Amend(i, a) => {
                if let Some(id) = self.intent_id(i) {
                    let amount = u128::from(a % 40 + 1) * USDC / 2;
                    if self.w.owner(|c| c.amend_intent(id, U128(amount))).is_ok() {
                        self.hit("amend");
                    }
                }
            }
            Act::CreateNative(i) => {
                if let Some(id) = self.pick_intent(i, |x| x.status == IntentStatus::Approved && x.terms.kind == PayoutKind::Native && x.live_attempt.is_none()) {
                    if self.w.executor(|c| c.create_attempt_native(id)).is_ok() {
                        self.hit("create_native");
                    }
                }
            }
            Act::CreateCross { i, pct, q } => {
                if let Some(id) = self.pick_intent(i, |x| x.status == IntentStatus::Approved && x.terms.kind == PayoutKind::CrossChain && x.live_attempt.is_none()) {
                    let max_in = self.w.intent(id).terms.max_in;
                    let amount_in = if pct > 230 { max_in + 1 } else { (max_in * u128::from(pct % 101) / 100).max(1) };
                    let deposit = acc(&crate::hash::to_hex(&[(q % 251) as u8; 32]));
                    let quote = format!("q{}", q % 251);
                    let deadline = self.w.now + 30 * MINUTE;
                    let r = self.w.executor(|c| {
                        c.create_attempt_crosschain(id, deposit, U128(amount_in), U64(deadline), quote)
                    });
                    if amount_in > max_in {
                        prop_assert!(r.is_err(), "amount_in above max_in must be refused");
                    }
                    if r.is_ok() {
                        self.hit("create_cross");
                    }
                }
            }
            Act::Authorize(a) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status == AttemptStatus::AwaitingOwner) {
                    if self.w.authorize(id).is_ok() {
                        self.hit("authorize");
                    }
                }
            }
            Act::CancelAttempt(a) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status.is_unfunded()) {
                    if self.w.executor(|c| c.cancel_attempt(id)).is_ok() {
                        self.hit("cancel_attempt");
                    }
                }
            }
            Act::Register(a) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status.is_unfunded()) {
                    if self.w.executor(|c| c.register_recipient(id).detach()).is_ok() {
                        self.hit("register");
                    }
                }
            }
            Act::Fund(a) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status == AttemptStatus::Authorized) {
                    let attempt = self.w.attempt(id);
                    let r = match attempt.terms.kind {
                        PayoutKind::Native => self.w.executor(|c| c.fund_native(id).detach()),
                        PayoutKind::CrossChain => self.w.executor(|c| c.fund_crosschain(id).detach()),
                    };
                    if r.is_ok() {
                        prop_assert!(self.funded.insert(id), "attempt {} funded twice", id);
                        self.unsettled.insert(id, attempt.terms.amount_in);
                        self.pending_callbacks.push(id);
                        self.hit("fund");
                    }
                }
            }
            Act::FundWrongMethod(a) => {
                if let Some(id) = self.attempt_id(a) {
                    let r = match self.w.attempt(id).terms.kind {
                        PayoutKind::Native => self.w.executor(|c| c.fund_crosschain(id).detach()),
                        PayoutKind::CrossChain => self.w.executor(|c| c.fund_native(id).detach()),
                    };
                    prop_assert!(r.is_err(), "the wrong funding method must fail");
                }
            }
            Act::Callback { a, ok } => {
                if !self.pending_callbacks.is_empty() {
                    let id = self.pending_callbacks.remove(a as usize % self.pending_callbacks.len());
                    let amount_in = self.w.attempt(id).terms.amount_in;
                    self.truth.insert(id, ok);
                    let r = self.w.transfer_callback(id, ok);
                    prop_assert!(r.is_ok(), "callbacks never panic: {:?}", r);
                    if ok {
                        self.balance -= amount_in;
                        self.unsettled.remove(&id);
                    } else if self.w.attempt(id).status == AttemptStatus::Failed {
                        self.unsettled.remove(&id); // the contract restored cash
                    }
                    self.delivered_callbacks.push(id);
                    self.hit(if ok { "callback_ok" } else { "callback_failed" });
                }
            }
            Act::DropCallback { a, sent } => {
                if !self.pending_callbacks.is_empty() {
                    let id = self.pending_callbacks.remove(a as usize % self.pending_callbacks.len());
                    self.truth.insert(id, sent);
                    if sent {
                        self.balance -= self.w.attempt(id).terms.amount_in;
                        self.unsettled.remove(&id);
                    }
                    self.hit("callback_lost");
                }
            }
            Act::Replay(a) => {
                if !self.delivered_callbacks.is_empty() {
                    let id = self.delivered_callbacks[a as usize % self.delivered_callbacks.len()];
                    let before = (self.w.view(|c| c.get_ledger()), self.w.attempt(id));
                    if before.1.status != AttemptStatus::FundingPending {
                        let ok = self.truth[&id];
                        prop_assert!(self.w.transfer_callback(id, ok).is_ok());
                        let after = (self.w.view(|c| c.get_ledger()), self.w.attempt(id));
                        prop_assert_eq!(before, after, "a replayed callback changed state");
                        self.hit("replay");
                    }
                }
            }
            Act::Deliver(a) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status == AttemptStatus::Funded) {
                    if self.w.executor(|c| c.report_delivery(id, U128(USDC), "dest-tx".into())).is_ok() {
                        self.hit("deliver");
                    }
                }
            }
            Act::Flag(a) => {
                if let Some(id) = self.pick_attempt(a, |x| matches!(x.status, AttemptStatus::FundingPending | AttemptStatus::Funded)) {
                    if self.w.executor(|c| c.flag_reconciliation(id)).is_ok() {
                        self.hit("flag");
                    }
                }
            }
            Act::Resolve(a, choice) => {
                if let Some(id) = self.pick_attempt(a, |x| x.status == AttemptStatus::NeedsReconciliation) {
                    let attempt = self.w.attempt(id);
                    if attempt.status == AttemptStatus::NeedsReconciliation {
                        let sent = if attempt.transfer_confirmed {
                            true
                        } else if let Some(t) = self.truth.get(&id) {
                            *t
                        } else {
                            // The callback is still in the air: the owner looks at the chain.
                            let t = choice & 1 == 1;
                            self.pending_callbacks.retain(|x| *x != id);
                            self.truth.insert(id, t);
                            if t {
                                self.balance -= attempt.terms.amount_in;
                                self.unsettled.remove(&id);
                            }
                            t
                        };
                        let cross = attempt.terms.kind == PayoutKind::CrossChain;
                        let outcome = if !sent {
                            ReconcileOutcome::NotSent
                        } else {
                            match (choice >> 1) % 3 {
                                0 => ReconcileOutcome::Sent,
                                1 => ReconcileOutcome::Delivered { delivered_amount: USDC, dest_tx: "owner-tx".into() },
                                _ if cross => ReconcileOutcome::SwapFailed,
                                _ => ReconcileOutcome::Sent,
                            }
                        };
                        let name = match &outcome {
                            ReconcileOutcome::NotSent => "resolve_not_sent",
                            ReconcileOutcome::Sent => "resolve_sent",
                            ReconcileOutcome::Delivered { .. } => "resolve_delivered",
                            ReconcileOutcome::SwapFailed => "resolve_swap_failed",
                        };
                        let r = self.w.owner(|c| c.resolve_reconciliation(id, outcome.clone()));
                        prop_assert!(r.is_ok(), "an honest resolution must succeed: {:?} {:?}", outcome, r);
                        if !sent {
                            self.unsettled.remove(&id);
                        }
                        self.hit(name);
                    }
                }
            }
            Act::Return { a, pct } => {
                if let Some(id) = self.pick_attempt(a, |x| x.terms.kind == PayoutKind::CrossChain && x.transfer_confirmed) {
                    let attempt = self.w.attempt(id);
                    let amount = (attempt.terms.amount_in * u128::from(pct) / 100).max(1);
                    let entries = vec![InflowEntry {
                        amount,
                        attribution: InflowAttribution::AttemptReturn { attempt_id: id },
                    }];
                    if self.w.owner(|c| c.reconcile_inflows(entries)).is_ok() {
                        self.balance += amount; // 1Click sent it back; the owner attributed it
                        self.hit("return");
                    }
                }
            }
            Act::Withdraw(a) => {
                let amount = u128::from(a % 40 + 1) * USDC;
                if self.w.owner(|c| c.withdraw(U128(amount)).detach()).is_ok() {
                    self.pending_withdrawals.push(amount);
                    self.hit("withdraw");
                }
            }
            Act::WithdrawCallback(ok) => {
                if !self.pending_withdrawals.is_empty() {
                    let amount = self.pending_withdrawals.remove(0);
                    prop_assert!(self.w.withdraw_callback(amount, ok).is_ok());
                    if ok {
                        self.balance -= amount;
                    }
                }
            }
            Act::UpdateSupplier(s) => {
                let id = self.suppliers[s as usize % 3];
                let supplier = self.w.view(|c| c.get_supplier(id)).unwrap();
                self.renames += 1;
                let recipient = match supplier.chain {
                    Chain::Near => format!("acme-{}.near", self.renames),
                    Chain::Tron if supplier.recipient == TRON_RECIPIENT => TRON_RECIPIENT_2.to_string(),
                    Chain::Tron => TRON_RECIPIENT.to_string(),
                };
                let (chain, asset) = (supplier.chain, supplier.asset_id.clone());
                if self.w.owner(|c| c.update_supplier(id, chain, asset, recipient)).is_ok() {
                    self.hit("update_supplier");
                }
            }
            Act::Verify(s) => {
                let id = self.suppliers[s as usize % 3];
                self.w.verify(id);
            }
            Act::SetActive(s, active) => {
                let id = self.suppliers[s as usize % 3];
                self.w.owner(|c| c.set_supplier_active(id, active)).unwrap();
            }
            Act::Pause => self.w.owner(|c| c.pause()).unwrap(),
            Act::Unpause => self.w.owner(|c| c.unpause()).unwrap(),
            Act::Advance(minutes) => self.w.advance(u64::from(minutes) * MINUTE),
            Act::Sweep => {
                let r = self.w.executor(|c| c.sweep(20)).unwrap();
                if r.expired + r.invalidated + r.voided_attempts > 0 {
                    self.hit("sweep_changed");
                }
            }
            Act::Prune => {
                if self.w.executor(|c| c.prune(20)).unwrap() > 0 {
                    self.hit("prune");
                }
            }
            Act::Intruder(k) => {
                let id = self.intent_id(k).unwrap_or(1);
                let r = match k % 6 {
                    0 => self.w.call(&stranger(), zero(), Vec::new(), |c| {
                        c.propose_payment(obligation_hex(1), 1, U128(USDC), None);
                    }),
                    1 => self.w.call(&stranger(), one_yocto(), Vec::new(), |c| c.approve(id, "00".repeat(32))),
                    2 => self.w.call(&agent(), zero(), Vec::new(), |c| {
                        c.create_attempt_native(id);
                    }),
                    3 => self.w.call(&executor(), one_yocto(), Vec::new(), |c| c.withdraw(U128(USDC)).detach()),
                    4 => self.w.call(&agent(), one_yocto(), Vec::new(), |c| {
                        c.reconcile_inflows(vec![InflowEntry { amount: USDC, attribution: InflowAttribution::TopUp }])
                    }),
                    _ => self.w.call(&executor(), one_yocto(), Vec::new(), |c| c.set_hosted_mode(false)),
                };
                prop_assert!(r.is_err(), "an unauthorized call succeeded (case {})", k % 6);
            }
        }
        self.check()
    }

    /// All invariants, checked after every step.
    fn check(&mut self) -> Result<(), TestCaseError> {
        let (ledger, policy, intents, attempts, suppliers, open, now) = self.w.view(|c| {
            let intents: Vec<Intent> = (1..c.next_intent_id).filter_map(|id| c.get_intent(id)).collect();
            let attempts: Vec<Attempt> = (1..c.next_attempt_id).filter_map(|id| c.get_attempt(id)).collect();
            let suppliers = c.list_suppliers(None, None);
            let open: HashSet<IntentId> = c.open_intents.iter().copied().collect();
            (c.get_ledger(), c.get_policy(), intents, attempts, suppliers, open, near_sdk::env::block_timestamp())
        });
        let attempts_by_id: HashMap<AttemptId, &Attempt> = attempts.iter().map(|a| (a.terms.id, a)).collect();
        let at = Period::at(now);

        // reserved ≤ cash, and the totals match the parts.
        prop_assert!(ledger.reserved <= ledger.cash, "reserved > cash");
        let reserved: u128 = intents.iter().map(|i| i.reserved).sum();
        prop_assert_eq!(ledger.reserved, reserved, "ledger.reserved != Σ intent.reserved");
        let in_flight: u128 = attempts
            .iter()
            .filter(|a| matches!(
                a.status,
                AttemptStatus::FundingPending | AttemptStatus::Funded | AttemptStatus::NeedsReconciliation
            ))
            .map(|a| a.terms.amount_in)
            .sum();
        prop_assert_eq!(ledger.in_flight, in_flight, "ledger.in_flight != Σ in-flight attempts");

        // Token conservation: nothing appears or disappears.
        let unsettled: u128 = self.unsettled.values().sum();
        let withdrawing: u128 = self.pending_withdrawals.iter().sum();
        prop_assert_eq!(
            self.balance,
            ledger.cash + unsettled + withdrawing,
            "token balance != cash + unsettled transfers + pending withdrawals"
        );

        // Caps and budgets (fixed in this test, so they must always hold).
        prop_assert!(ledger.committed_day(at.day).unwrap() <= policy.daily_cap, "daily cap broken");
        prop_assert!(ledger.committed_month(at.month).unwrap() <= policy.monthly_cap, "monthly cap broken");
        prop_assert!(ledger.autonomous_day.current(at.day) <= policy.autonomous_daily_budget);
        prop_assert!(ledger.trust_day.current(at.day) <= policy.executor_trust_daily_budget);

        // Per-intent shape.
        let mut live_per_intent: HashMap<IntentId, usize> = HashMap::new();
        for a in &attempts {
            prop_assert!(a.returned_amount <= a.terms.amount_in);
            if a.status.is_live() {
                *live_per_intent.entry(a.terms.intent_id).or_default() += 1;
            }
        }
        let mut open_obligations: HashMap<Hash32, usize> = HashMap::new();
        for i in &intents {
            let id = i.terms.id;
            prop_assert_eq!(open.contains(&id), i.status.is_open(), "open set out of sync for {}", id);
            prop_assert!(live_per_intent.get(&id).copied().unwrap_or(0) <= 1, "two live attempts for {}", id);
            if matches!(i.status, IntentStatus::Pending | IntentStatus::Approved | IntentStatus::Funding | IntentStatus::Done) {
                *open_obligations.entry(i.terms.obligation_id).or_default() += 1;
            }
            let live = i.live_attempt.and_then(|a| attempts_by_id.get(&a).copied());
            match i.status {
                IntentStatus::Approved => prop_assert_eq!(i.reserved, i.terms.max_in, "approved {} not fully reserved", id),
                IntentStatus::Funding => {
                    let a = live.expect("a funding intent has its attempt");
                    let expected = if a.transfer_confirmed { 0 } else { i.terms.max_in - a.terms.amount_in };
                    prop_assert_eq!(i.reserved, expected, "funding {} reservation", id);
                }
                _ => prop_assert_eq!(i.reserved, 0, "intent {} in {:?} still reserves", id, i.status),
            }
            if let Some(a) = live {
                prop_assert_eq!(a.terms.intent_id, id);
                prop_assert!(a.status.is_live() || a.status == AttemptStatus::Delivered);
            }
            for attempt_id in &i.attempt_ids {
                if let Some(a) = attempts_by_id.get(attempt_id) {
                    prop_assert!(a.terms.amount_in <= i.terms.max_in);
                    if a.terms.kind == PayoutKind::Native {
                        prop_assert_eq!(a.terms.amount_in, i.terms.amount_out);
                    }
                    if a.status.is_live() {
                        prop_assert_eq!(i.live_attempt, Some(*attempt_id), "live attempt not linked");
                    }
                }
            }
        }
        for (ob, n) in open_obligations {
            prop_assert!(n <= 1, "obligation {:?} has {} open-or-paid intents", &ob[..4], n);
        }
        for s in &suppliers {
            let reserved_out: u128 = intents
                .iter()
                .filter(|i| i.terms.supplier_id == s.id && i.status == IntentStatus::Approved)
                .map(|i| i.terms.amount_out)
                .sum();
            prop_assert_eq!(s.reserved_out, reserved_out, "supplier {} reserved_out", s.id);
        }

        // Every debit is an attempt's committed transfer (once) or an owner withdrawal.
        for d in &self.w.debits[self.debits_checked..] {
            match (d.callback_attempt, d.callback_withdraw) {
                (Some(attempt_id), None) => {
                    let a = attempts_by_id.get(&attempt_id).expect("debited attempt exists");
                    prop_assert_eq!(&d.receiver, &a.terms.pay_to, "debit to an uncommitted receiver");
                    prop_assert_eq!(d.amount, a.terms.amount_in, "debit amount != committed amount_in");
                }
                (None, Some(amount)) => {
                    prop_assert_eq!(&d.receiver, &owner(), "withdrawals go to the owner only");
                    prop_assert_eq!(d.amount, amount);
                }
                other => prop_assert!(false, "unattributed debit {:?}", other),
            }
        }
        let attempt_debits: Vec<AttemptId> = self.w.debits.iter().filter_map(|d| d.callback_attempt).collect();
        let unique: HashSet<&AttemptId> = attempt_debits.iter().collect();
        prop_assert_eq!(unique.len(), attempt_debits.len(), "an attempt was debited twice");
        self.debits_checked = self.w.debits.len();
        Ok(())
    }
}

fn run_walk(acts: Vec<Act>) -> Result<HashMap<&'static str, usize>, TestCaseError> {
    let mut sim = Sim::new();
    sim.check()?;
    for act in acts {
        sim.step(act)?;
    }
    Ok(sim.stats)
}

/// Contract walks run in debug mode (see AGENTS.md) at ~2 s each, so the default is modest.
/// Deep runs: `PROPTEST_CASES=1000 cargo test contract_invariants_hold`.
fn walk_config() -> Config {
    let cases = std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(24);
    Config { cases, ..Config::default() }
}

proptest! {
    #![proptest_config(walk_config())]

    #[test]
    fn contract_invariants_hold(acts in prop::collection::vec(act(), 1..160)) {
        run_walk(acts)?;
    }
}

/// The random walk is only convincing if it reaches deep states. Run a fixed number of walks and
/// require that every interesting transition happened at least once.
#[test]
fn random_walks_reach_deep_states() {
    let mut runner = TestRunner::deterministic();
    let strategy = prop::collection::vec(act(), 160..240);
    let mut totals: HashMap<&'static str, usize> = HashMap::new();
    for _ in 0..20 {
        let acts = strategy.new_tree(&mut runner).unwrap().current();
        for (k, v) in run_walk(acts).expect("invariants") {
            *totals.entry(k).or_default() += v;
        }
    }
    for required in [
        "propose_accepted", "propose_rejected", "approve", "create_native", "create_cross",
        "authorize", "fund", "callback_ok", "callback_failed", "callback_lost", "replay",
        "deliver", "flag", "resolve_not_sent", "resolve_sent", "resolve_swap_failed", "return",
        "withdraw", "update_supplier", "sweep_changed", "cancel_attempt", "reject", "amend",
    ] {
        assert!(totals.get(required).copied().unwrap_or(0) > 0, "never reached: {required} (totals: {totals:?})");
    }
}

