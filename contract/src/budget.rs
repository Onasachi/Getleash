//! Pure per-day budget counters and amount arithmetic (no `env`, no storage), property-tested in
//! `tests/props.rs`. Counters only ever go up within a UTC day; a later day starts from zero.
//! Refunds and failed transfers never give budget back (docs/decisions.md D-28).

use crate::types::Budgets;

pub const NS_PER_DAY: u64 = 86_400_000_000_000;

/// UTC day number (days since 1970-01-01) of a nanosecond timestamp.
pub fn day_of(ts_ns: u64) -> u32 {
    // u64::MAX ns is ~213 503 days, so this always fits.
    (ts_ns / NS_PER_DAY) as u32
}

impl Budgets {
    /// The counters as of `day`: unchanged within the same day, zero from a later day on. An
    /// earlier day (block time never goes back) keeps today's counters, which errs strict.
    pub fn at(self, day: u32) -> Budgets {
        if day > self.day {
            Budgets {
                day,
                ..Budgets::default()
            }
        } else {
            self
        }
    }
}

/// `used + amount ≤ limit`, false on overflow.
pub fn fits(used: u128, amount: u128, limit: u128) -> bool {
    used.checked_add(amount).is_some_and(|total| total <= limit)
}

/// Converts an amount in an asset with `asset_decimals` into treasury base units, rounding up.
/// Only meaningful for USD-pegged assets (the only kind the owner should add).
pub fn to_treasury_units(amount: u128, asset_decimals: u8, treasury_decimals: u8) -> Option<u128> {
    if asset_decimals >= treasury_decimals {
        let divisor = 10u128.checked_pow(u32::from(asset_decimals - treasury_decimals))?;
        Some(amount.div_ceil(divisor))
    } else {
        let factor = 10u128.checked_pow(u32::from(treasury_decimals - asset_decimals))?;
        amount.checked_mul(factor)
    }
}

/// Most the treasury may send for a cross-chain payment worth `value` (D-02).
pub fn max_in(value: u128, max_fee_bps: u16, max_fixed_fee: u128) -> Option<u128> {
    value
        .checked_mul(10_000 + u128::from(max_fee_bps))?
        .div_ceil(10_000)
        .checked_add(max_fixed_fee)
}

/// Least a cross-chain funding may send: `value` minus the percentage fee bound. Stops an
/// executor marking intents paid with dust.
pub fn min_in(value: u128, max_fee_bps: u16) -> u128 {
    // value ≤ MAX_AMOUNT (1e15) and bps ≤ 5000, so the product fits.
    value - value * u128::from(max_fee_bps) / 10_000
}
