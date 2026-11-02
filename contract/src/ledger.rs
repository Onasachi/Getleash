//! Pure accounting core (PLAN §4.1.3; docs/decisions.md D-01, D-04, D-08).
//!
//! Nothing in this module calls `env` or touches storage. Every operation takes the period and the
//! limits it needs as arguments, uses checked arithmetic, works on a copy, verifies the ledger
//! invariant, and only then commits. A failed operation therefore leaves the ledger unchanged,
//! which matters in callbacks, where panicking is not an option.
//!
//! Quantities (all in treasury base units, i.e. USDC with 6 decimals):
//! - `cash`: USDC the contract has recognised and still holds.
//! - `reserved`: what approved intents hold back for their payments (see D-01 for the fee slack).
//! - `in_flight`: what has left `cash` and is not yet delivered, failed or returned.
//! - period counters: gross outflow charged per UTC day and month, plus the autonomous and
//!   executor-trust budgets consumed today.
//!
//! Invariant: `reserved ≤ cash`. Available to spend is `cash − reserved`; `in_flight` is already out
//! of `cash`, so nothing is subtracted twice.

use near_sdk::near;
use near_sdk::serde_with::DisplayFromStr;

pub const NS_PER_DAY: u64 = 86_400_000_000_000;

/// UTC day number (days since 1970-01-01) of a nanosecond timestamp.
pub fn day_of(ts_ns: u64) -> u32 {
    // u64::MAX ns is ~213 503 days, so this always fits.
    (ts_ns / NS_PER_DAY) as u32
}

/// UTC month number, `year * 12 + (month - 1)`, of a nanosecond timestamp.
pub fn month_of(ts_ns: u64) -> u32 {
    let (year, month, _) = civil_from_days(day_of(ts_ns));
    year * 12 + (month - 1)
}

/// Civil date `(year, month 1..=12, day 1..=31)` of a day number counted from 1970-01-01.
/// Howard Hinnant's `civil_from_days`, restricted to non-negative day numbers.
pub fn civil_from_days(days: u32) -> (u32, u32, u32) {
    let z = u64::from(days) + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097; // day of era, [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // year of era, [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year from March 1, [0, 365]
    let mp = (5 * doy + 2) / 153; // March-based month, [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year as u32, month as u32, day as u32)
}

/// The UTC day and month a timestamp falls in.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Period {
    pub day: u32,
    pub month: u32,
}

impl Period {
    pub fn at(ts_ns: u64) -> Self {
        Self { day: day_of(ts_ns), month: month_of(ts_ns) }
    }
}

/// The two absolute ceilings on committed outflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub daily: u128,
    pub monthly: u128,
}

/// A running total that resets when a later period starts.
///
/// Block timestamps on NEAR never go backwards. If an earlier period is ever passed anyway, the
/// amount is counted in the later period, which errs towards stricter limits.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeriodCounter {
    pub period: u32,
    #[serde_as(as = "DisplayFromStr")]
    pub total: u128,
}

impl PeriodCounter {
    /// The total for `period`: zero once a later period has started.
    pub fn current(&self, period: u32) -> u128 {
        if period > self.period { 0 } else { self.total }
    }

    pub fn add(&mut self, period: u32, amount: u128) -> Result<(), LedgerError> {
        let mut next = *self;
        if period > next.period {
            next.period = period;
            next.total = 0;
        }
        next.total = add(next.total, amount)?;
        *self = next;
        Ok(())
    }

    /// Removes `amount` only if the counter is still in `period`; a past period no longer matters.
    pub fn sub_if_same(&mut self, period: u32, amount: u128) -> Result<(), LedgerError> {
        if period == self.period {
            self.total = sub(self.total, amount)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError {
    Overflow,
    Underflow,
    InsufficientFunds,
    OverDailyCap,
    OverMonthlyCap,
    ReservedExceedsCash,
}

impl LedgerError {
    /// Stable code used in panics and logs.
    pub fn code(&self) -> &'static str {
        match self {
            LedgerError::Overflow => "LEDGER_OVERFLOW",
            LedgerError::Underflow => "LEDGER_UNDERFLOW",
            LedgerError::InsufficientFunds => "INSUFFICIENT_FUNDS",
            LedgerError::OverDailyCap => "OVER_DAILY_CAP",
            LedgerError::OverMonthlyCap => "OVER_MONTHLY_CAP",
            LedgerError::ReservedExceedsCash => "LEDGER_RESERVED_EXCEEDS_CASH",
        }
    }
}

/// Where recognised inflow came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreditKind {
    /// `ft_transfer_call` top-up, or a plain transfer the owner attributes to a top-up.
    TopUp,
    /// Refund or returned change for a specific attempt (owner-reconciled).
    Return,
    /// Owner-recognised inflow with no attribution.
    Unattributed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    #[serde_as(as = "DisplayFromStr")]
    pub cash: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub reserved: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub in_flight: u128,
    /// Gross outflow charged in the current UTC day / month (removed only on proven failure).
    pub spent_day: PeriodCounter,
    pub spent_month: PeriodCounter,
    /// `max_in` auto-approved today (never returned the same day; D-04).
    pub autonomous_day: PeriodCounter,
    /// `amount_in` authorised under the executor-trust budget today.
    pub trust_day: PeriodCounter,
    #[serde_as(as = "DisplayFromStr")]
    pub total_topped_up: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub total_returned: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub total_unattributed: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub total_charged: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub total_withdrawn: u128,
}

impl Ledger {
    /// What can still be reserved or withdrawn: `cash − reserved`.
    pub fn available(&self) -> u128 {
        // The invariant guarantees reserved ≤ cash; if it were ever broken, report nothing available.
        self.cash.checked_sub(self.reserved).unwrap_or(0)
    }

    pub fn check_invariants(&self) -> Result<(), LedgerError> {
        if self.reserved > self.cash {
            return Err(LedgerError::ReservedExceedsCash);
        }
        Ok(())
    }

    /// Outflow committed against the day: charged so far today plus everything reserved.
    pub fn committed_day(&self, day: u32) -> Result<u128, LedgerError> {
        add(self.spent_day.current(day), self.reserved)
    }

    /// Outflow committed against the month: charged so far this month plus everything reserved.
    pub fn committed_month(&self, month: u32) -> Result<u128, LedgerError> {
        add(self.spent_month.current(month), self.reserved)
    }

    /// Would reserving `amount` now fit the funds and both caps?
    pub fn check_reserve(&self, amount: u128, at: Period, caps: Caps) -> Result<(), LedgerError> {
        if amount > self.available() {
            return Err(LedgerError::InsufficientFunds);
        }
        if add(self.committed_day(at.day)?, amount)? > caps.daily {
            return Err(LedgerError::OverDailyCap);
        }
        if add(self.committed_month(at.month)?, amount)? > caps.monthly {
            return Err(LedgerError::OverMonthlyCap);
        }
        Ok(())
    }

    pub fn reserve(&mut self, amount: u128, at: Period, caps: Caps) -> Result<(), LedgerError> {
        self.check_reserve(amount, at, caps)?;
        let mut next = self.clone();
        next.reserved = add(next.reserved, amount)?;
        self.commit(next)
    }

    pub fn release(&mut self, amount: u128) -> Result<(), LedgerError> {
        let mut next = self.clone();
        next.reserved = sub(next.reserved, amount)?;
        self.commit(next)
    }

    /// Funding: `amount_in` of an existing reservation leaves the treasury and is charged to `at`.
    /// The rest of that reservation (the fee slack) stays reserved until `confirm_sent` (D-01).
    pub fn fund(&mut self, amount_in: u128, at: Period) -> Result<(), LedgerError> {
        let mut next = self.clone();
        next.reserved = sub(next.reserved, amount_in)?;
        next.cash = sub(next.cash, amount_in)?;
        next.in_flight = add(next.in_flight, amount_in)?;
        next.spent_day.add(at.day, amount_in)?;
        next.spent_month.add(at.month, amount_in)?;
        next.total_charged = add(next.total_charged, amount_in)?;
        self.commit(next)
    }

    /// The transfer is known to have happened: release the fee slack still held for it.
    pub fn confirm_sent(&mut self, slack: u128) -> Result<(), LedgerError> {
        self.release(slack)
    }

    /// Money in flight has arrived, or has definitively left the flight (a failed swap whose funds
    /// will come back through owner reconciliation).
    pub fn land(&mut self, amount_in: u128) -> Result<(), LedgerError> {
        let mut next = self.clone();
        next.in_flight = sub(next.in_flight, amount_in)?;
        self.commit(next)
    }

    /// Proven transfer failure: the money never left. Undo the charge and try to restore the
    /// reservation for a retry. Returns whether it was restored. In the period it was charged it
    /// always fits (unless the owner lowered the caps); across a period boundary it is re-checked
    /// (D-08). `allow_restore = false` lets the caller veto the restore for its own reasons (for
    /// example a supplier cap). When `false` is returned, the caller must release the intent's
    /// remaining slack and send the intent back for approval.
    pub fn fail_transfer(
        &mut self,
        amount_in: u128,
        charged: Period,
        now: Period,
        caps: Caps,
        allow_restore: bool,
    ) -> Result<bool, LedgerError> {
        let mut next = self.clone();
        next.in_flight = sub(next.in_flight, amount_in)?;
        next.cash = add(next.cash, amount_in)?;
        next.spent_day.sub_if_same(charged.day, amount_in)?;
        next.spent_month.sub_if_same(charged.month, amount_in)?;
        next.total_charged = sub(next.total_charged, amount_in)?;
        let restored = allow_restore && next.check_reserve(amount_in, now, caps).is_ok();
        if restored {
            next.reserved = add(next.reserved, amount_in)?;
        }
        self.commit(next)?;
        Ok(restored)
    }

    /// Recognise inflow. Never touches charges or budgets (F-02).
    pub fn credit(&mut self, amount: u128, kind: CreditKind) -> Result<(), LedgerError> {
        let mut next = self.clone();
        next.cash = add(next.cash, amount)?;
        match kind {
            CreditKind::TopUp => next.total_topped_up = add(next.total_topped_up, amount)?,
            CreditKind::Return => next.total_returned = add(next.total_returned, amount)?,
            CreditKind::Unattributed => {
                next.total_unattributed = add(next.total_unattributed, amount)?
            }
        }
        self.commit(next)
    }

    /// Owner withdrawal: only unreserved cash can leave.
    pub fn begin_withdraw(&mut self, amount: u128) -> Result<(), LedgerError> {
        if amount > self.available() {
            return Err(LedgerError::InsufficientFunds);
        }
        let mut next = self.clone();
        next.cash = sub(next.cash, amount)?;
        next.total_withdrawn = add(next.total_withdrawn, amount)?;
        self.commit(next)
    }

    /// The withdrawal transfer provably failed: the cash is still here.
    pub fn fail_withdraw(&mut self, amount: u128) -> Result<(), LedgerError> {
        let mut next = self.clone();
        next.cash = add(next.cash, amount)?;
        next.total_withdrawn = sub(next.total_withdrawn, amount)?;
        self.commit(next)
    }

    pub fn autonomous_fits(&self, amount: u128, day: u32, budget: u128) -> bool {
        add(self.autonomous_day.current(day), amount).is_ok_and(|total| total <= budget)
    }

    pub fn take_autonomous(&mut self, amount: u128, day: u32) -> Result<(), LedgerError> {
        self.autonomous_day.add(day, amount)
    }

    pub fn trust_fits(&self, amount: u128, day: u32, budget: u128) -> bool {
        add(self.trust_day.current(day), amount).is_ok_and(|total| total <= budget)
    }

    pub fn take_trust(&mut self, amount: u128, day: u32) -> Result<(), LedgerError> {
        self.trust_day.add(day, amount)
    }

    /// Return trust budget taken on `day` (no-op once that day is over).
    pub fn release_trust(&mut self, amount: u128, day: u32) -> Result<(), LedgerError> {
        self.trust_day.sub_if_same(day, amount)
    }

    fn commit(&mut self, next: Ledger) -> Result<(), LedgerError> {
        next.check_invariants()?;
        *self = next;
        Ok(())
    }
}

pub fn add(a: u128, b: u128) -> Result<u128, LedgerError> {
    a.checked_add(b).ok_or(LedgerError::Overflow)
}

pub fn sub(a: u128, b: u128) -> Result<u128, LedgerError> {
    a.checked_sub(b).ok_or(LedgerError::Underflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = NS_PER_DAY;
    /// 2026-11-01T00:00:00Z
    const NOV_1_2026: u64 = 1_793_491_200 * 1_000_000_000;

    fn caps() -> Caps {
        Caps { daily: 1_000, monthly: 5_000 }
    }

    #[test]
    fn civil_dates_match_known_values() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(day_of(NOV_1_2026)), (2026, 11, 1));
        assert_eq!(civil_from_days(day_of(NOV_1_2026) - 1), (2026, 10, 31));
        // 2028-02-29 exists (leap year), 2100-02-29 does not.
        assert_eq!(civil_from_days(21_243), (2028, 2, 29));
        assert_eq!(civil_from_days(47_541), (2100, 3, 1));
        assert_eq!(month_of(NOV_1_2026), 2026 * 12 + 10);
        assert_eq!(month_of(NOV_1_2026 - 1), 2026 * 12 + 9);
    }

    #[test]
    fn period_counter_resets_on_new_period_only() {
        let mut c = PeriodCounter::default();
        c.add(10, 5).unwrap();
        c.add(10, 7).unwrap();
        assert_eq!(c.current(10), 12);
        assert_eq!(c.current(11), 0);
        // An earlier period is counted conservatively in the later one.
        c.add(9, 1).unwrap();
        assert_eq!(c.current(10), 13);
        c.add(11, 2).unwrap();
        assert_eq!(c.current(11), 2);
        c.sub_if_same(10, 13).unwrap(); // past period: no-op
        assert_eq!(c.current(11), 2);
        assert_eq!(c.sub_if_same(11, 3), Err(LedgerError::Underflow));
    }

    #[test]
    fn available_excludes_reserved_but_not_in_flight_twice() {
        // PLAN §9: "60 of 100 in flight → available = cash − reserved, no double subtraction".
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(100, CreditKind::TopUp).unwrap();
        l.reserve(60, at, caps()).unwrap();
        l.fund(60, at).unwrap();
        assert_eq!(l.cash, 40);
        assert_eq!(l.in_flight, 60);
        assert_eq!(l.reserved, 0);
        assert_eq!(l.available(), 40);
    }

    #[test]
    fn reservations_never_exceed_cash() {
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(100, CreditKind::TopUp).unwrap();
        l.reserve(70, at, caps()).unwrap();
        assert_eq!(l.reserve(31, at, caps()), Err(LedgerError::InsufficientFunds));
        l.reserve(30, at, caps()).unwrap();
        assert_eq!(l.available(), 0);
        assert_eq!(l.begin_withdraw(1), Err(LedgerError::InsufficientFunds));
    }

    #[test]
    fn caps_count_charges_and_reservations() {
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(10_000, CreditKind::TopUp).unwrap();
        l.reserve(600, at, caps()).unwrap();
        l.fund(600, at).unwrap();
        l.reserve(400, at, caps()).unwrap();
        assert_eq!(l.check_reserve(1, at, caps()), Err(LedgerError::OverDailyCap));
        // Next day only the reservation still counts.
        let tomorrow = Period::at(NOV_1_2026 + DAY);
        l.reserve(600, tomorrow, caps()).unwrap();
        assert_eq!(l.check_reserve(1, tomorrow, caps()), Err(LedgerError::OverDailyCap));
    }

    #[test]
    fn slack_stays_reserved_until_confirmation() {
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(100, CreditKind::TopUp).unwrap();
        l.reserve(50, at, caps()).unwrap(); // max_in
        l.fund(45, at).unwrap(); // amount_in; slack 5 still reserved
        assert_eq!(l.reserved, 5);
        assert_eq!(l.available(), 50);
        l.confirm_sent(5).unwrap();
        assert_eq!(l.reserved, 0);
        assert_eq!(l.available(), 55);
    }

    #[test]
    fn proven_failure_restores_everything_in_the_same_period() {
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(100, CreditKind::TopUp).unwrap();
        l.reserve(50, at, caps()).unwrap();
        let before = l.clone();
        l.fund(45, at).unwrap();
        // Someone else takes the freed-up funds meanwhile.
        l.reserve(50, at, caps()).unwrap();
        let restored = l.fail_transfer(45, at, at, caps(), true).unwrap();
        assert!(restored);
        assert_eq!(l.cash, before.cash);
        assert_eq!(l.in_flight, 0);
        assert_eq!(l.reserved, 100);
        assert_eq!(l.spent_day.current(at.day), 0);
        assert_eq!(l.total_charged, 0);
    }

    #[test]
    fn failure_across_midnight_rechecks_caps() {
        let day1 = Period::at(NOV_1_2026 + DAY - 1);
        let day2 = Period::at(NOV_1_2026 + DAY);
        let mut l = Ledger::default();
        l.credit(10_000, CreditKind::TopUp).unwrap();
        l.reserve(600, day1, caps()).unwrap();
        l.fund(600, day1).unwrap();
        // Day 2: the owner approves up to the cap.
        l.reserve(1_000, day2, caps()).unwrap();
        let restored = l.fail_transfer(600, day1, day2, caps(), true).unwrap();
        assert!(!restored, "restoring would exceed day 2's cap");
        assert_eq!(l.committed_day(day2.day).unwrap(), 1_000);
        assert_eq!(l.in_flight, 0);
        l.check_invariants().unwrap();
    }

    #[test]
    fn failed_operations_leave_the_ledger_unchanged() {
        let at = Period::at(NOV_1_2026);
        let mut l = Ledger::default();
        l.credit(10, CreditKind::TopUp).unwrap();
        let before = l.clone();
        assert!(l.fund(5, at).is_err()); // nothing reserved
        assert_eq!(l, before);
        assert!(l.release(1).is_err());
        assert!(l.land(1).is_err());
        assert_eq!(l, before);
    }

    #[test]
    fn withdraw_failure_restores_cash() {
        let mut l = Ledger::default();
        l.credit(10, CreditKind::TopUp).unwrap();
        l.begin_withdraw(10).unwrap();
        assert_eq!(l.cash, 0);
        l.fail_withdraw(10).unwrap();
        assert_eq!(l.cash, 10);
        assert_eq!(l.total_withdrawn, 0);
    }

    #[test]
    fn budgets_are_per_day() {
        let day = day_of(NOV_1_2026);
        let mut l = Ledger::default();
        assert!(l.autonomous_fits(50, day, 50));
        l.take_autonomous(50, day).unwrap();
        assert!(!l.autonomous_fits(1, day, 50));
        assert!(l.autonomous_fits(50, day + 1, 50));
        l.take_trust(3, day).unwrap();
        assert!(!l.trust_fits(3, day, 5));
        l.release_trust(3, day).unwrap();
        assert!(l.trust_fits(5, day, 5));
    }
}
