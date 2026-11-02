//! The pure routing rule for a new proposal (no `env`): may the agent approve it on its own, or
//! must it wait for the owner, and why. Property-tested in `tests/props.rs`.

use crate::budget::fits;
use crate::types::{Budgets, Policy, Route};

/// `b` must be today's counters. Order matters only for the reason reported: every non-autonomous
/// route waits for the owner.
pub fn route(
    p: &Policy,
    b: &Budgets,
    value: u128,
    max_in: u128,
    flagged: bool,
    in_cooldown: bool,
) -> Route {
    if flagged {
        Route::ReviewFlag
    } else if in_cooldown {
        Route::SupplierCooldown
    } else if value > p.approval_threshold {
        Route::AboveThreshold
    } else if !fits(b.autonomous, max_in, p.autonomous_daily_budget) {
        Route::AutonomousBudgetUsed
    } else if !fits(b.outflow, max_in, p.daily_cap) {
        Route::DailyCap
    } else {
        Route::Autonomous
    }
}

/// A supplier is in cooldown for `cooldown_ns` after it was added or changed.
pub fn in_cooldown(changed_at: u64, cooldown_ns: u64, now: u64) -> bool {
    // Saturating: if this ever overflowed, the cooldown would simply never end.
    now < changed_at.saturating_add(cooldown_ns)
}
