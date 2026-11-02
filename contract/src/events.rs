//! NEP-297 events, written by hand (no `serde_json::Value`, which costs wasm size):
//! `EVENT_JSON:{"standard":"getleash","version":"2.0.0","event":…,"data":[{…}]}`.
//! Values are numbers, decimal-string amounts, and fixed codes or account ids that never need
//! escaping.

use near_sdk::env;

use crate::types::{Reason, Route, Status};
use crate::validate::push_u128;

pub struct Event {
    data: String,
}

impl Event {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            data: String::with_capacity(96),
        }
    }

    fn key(&mut self, key: &str) {
        if !self.data.is_empty() {
            self.data.push(',');
        }
        self.data.push('"');
        self.data.push_str(key);
        self.data.push_str("\":");
    }

    pub fn num(mut self, key: &str, value: u128) -> Self {
        self.key(key);
        push_u128(&mut self.data, value);
        self
    }

    /// An amount as a decimal string (D-17).
    pub fn amount(mut self, key: &str, value: u128) -> Self {
        self.key(key);
        self.data.push('"');
        push_u128(&mut self.data, value);
        self.data.push('"');
        self
    }

    /// Only for fixed codes and account ids.
    pub fn text(mut self, key: &str, value: &str) -> Self {
        self.key(key);
        self.data.push('"');
        self.data.push_str(value);
        self.data.push('"');
        self
    }

    pub fn emit(self, event: &str) {
        let mut log = String::with_capacity(96 + self.data.len());
        log.push_str("EVENT_JSON:{\"standard\":\"getleash\",\"version\":\"2.0.0\",\"event\":\"");
        log.push_str(event);
        log.push_str("\",\"data\":[{");
        log.push_str(&self.data);
        log.push_str("}]}");
        env::log_str(&log);
    }
}

pub fn status_code(s: Status) -> &'static str {
    match s {
        Status::Pending => "PENDING",
        Status::Approved => "APPROVED",
        Status::Paying => "PAYING",
        Status::Paid => "PAID",
        Status::Failed => "FAILED",
        Status::Rejected => "REJECTED",
    }
}

pub fn route_code(r: Route) -> &'static str {
    match r {
        Route::Autonomous => "AUTONOMOUS",
        Route::AboveThreshold => "ABOVE_THRESHOLD",
        Route::AutonomousBudgetUsed => "AUTONOMOUS_BUDGET_USED",
        Route::DailyCap => "DAILY_CAP",
        Route::ReviewFlag => "REVIEW_FLAG",
        Route::SupplierCooldown => "SUPPLIER_COOLDOWN",
    }
}

pub fn reason_code(r: Reason) -> &'static str {
    match r {
        Reason::None => "NONE",
        Reason::Paused => "PAUSED",
        Reason::UnknownSupplier => "UNKNOWN_SUPPLIER",
        Reason::InactiveSupplier => "INACTIVE_SUPPLIER",
        Reason::ObligationOpenOrPaid => "OBLIGATION_OPEN_OR_PAID",
        Reason::ObligationRejected => "OBLIGATION_REJECTED",
        Reason::StorageFull => "STORAGE_FULL",
        Reason::BadAmount => "BAD_AMOUNT",
    }
}
