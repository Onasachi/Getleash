//! Read-only methods (PLAN §4.1.4 "Views").

use near_sdk::near;

use crate::ledger::Ledger;
use crate::types::*;
use crate::{hash, Contract, ContractExt};

#[near]
impl Contract {
    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            executor_id: self.executor_id.clone(),
            treasury_token: self.treasury_token.clone(),
            treasury_asset_id: self.treasury_asset_id.clone(),
            treasury_decimals: self.treasury_decimals,
            paused: self.paused,
            hosted_mode: self.hosted_mode,
            policy: self.policy.clone(),
            open_intents: self.open_intents.len(),
            supplier_count: self.suppliers.len(),
            next_intent_id: self.next_intent_id,
            next_attempt_id: self.next_attempt_id,
        }
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_ledger(&self) -> Ledger {
        self.ledger.clone()
    }

    /// Today's budgets: limit, used and remaining for each, plus call quotas.
    pub fn get_budgets_today(&self) -> BudgetsView {
        let period = self.period_now();
        let line = |limit: u128, used: u128| BudgetLine {
            limit,
            used,
            remaining: limit.saturating_sub(used),
        };
        let p = &self.policy;
        let l = &self.ledger;
        BudgetsView {
            period,
            daily: line(p.daily_cap, l.committed_day(period.day).unwrap_or(u128::MAX)),
            monthly: line(p.monthly_cap, l.committed_month(period.month).unwrap_or(u128::MAX)),
            autonomous: line(p.autonomous_daily_budget, l.autonomous_day.current(period.day)),
            executor_trust: line(p.executor_trust_daily_budget, l.trust_day.current(period.day)),
            available: l.available(),
            proposals_today: count(self.quotas.proposals.current(period.day)),
            attempts_today: count(self.quotas.attempts.current(period.day)),
            registrations_today: count(self.quotas.registrations.current(period.day)),
        }
    }

    pub fn get_supplier(&self, supplier_id: SupplierId) -> Option<Supplier> {
        self.suppliers.get(&supplier_id).cloned()
    }

    pub fn list_suppliers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Supplier> {
        self.suppliers
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(MAX_SUPPLIERS) as usize)
            .cloned()
            .collect()
    }

    pub fn list_assets(&self) -> Vec<(String, AssetInfo)> {
        self.assets.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_intent(&self, intent_id: IntentId) -> Option<Intent> {
        self.intents.get(&intent_id).cloned()
    }

    pub fn get_attempt(&self, attempt_id: AttemptId) -> Option<Attempt> {
        self.attempts.get(&attempt_id).cloned()
    }

    /// The latest intent for an obligation id (64 hex chars), if any.
    pub fn get_obligation(&self, obligation_id: String) -> Option<IntentId> {
        hash::parse_hex32(&obligation_id).and_then(|id| self.obligations.get(&id).copied())
    }

    /// Every non-terminal intent with its live attempt. Bounded by `max_open_intents`, so workers
    /// can rebuild their whole queue from this after a restart.
    pub fn get_open_work(&self) -> Vec<OpenWorkItem> {
        self.open_intents
            .iter()
            .filter_map(|id| self.intents.get(id))
            .map(|intent| OpenWorkItem {
                attempt: intent.live_attempt.and_then(|a| self.attempts.get(&a).cloned()),
                intent: intent.clone(),
            })
            .collect()
    }

    /// The last rejected proposals, oldest first.
    pub fn get_recent_rejections(&self) -> Vec<Rejection> {
        let len = self.rejections.len();
        let start = if len < REJECTION_RING { 0 } else { self.rejection_cursor };
        (0..len)
            .filter_map(|i| self.rejections.get((start + i) % len))
            .cloned()
            .collect()
    }
}

fn count(value: u128) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
