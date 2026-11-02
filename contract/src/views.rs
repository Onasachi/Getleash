//! Read-only methods. Arguments and results are Borsh (D-28): read them with `pnpm status`, the
//! dashboard or `@getleash/shared`'s decoders.

use near_sdk::{env, near};

use crate::budget::day_of;
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    #[result_serializer(borsh)]
    pub fn get_state(&self) -> StateView {
        StateView {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            executor_id: self.executor_id.clone(),
            token_id: self.token_id.clone(),
            token_decimals: self.token_decimals,
            paused: self.paused,
            executor_epoch: self.executor_epoch,
            policy: self.policy.clone(),
            budgets: self.budgets.at(day_of(env::block_timestamp())),
            next_supplier_id: self.next_supplier_id,
            next_intent_id: self.next_intent_id,
            stored_intents: self.stored_intents,
            paying: self.paying,
        }
    }

    /// Suppliers with ids in `[from, from + limit)`, at most `MAX_BATCH`.
    #[result_serializer(borsh)]
    pub fn get_suppliers(
        &self,
        #[serializer(borsh)] from: SupplierId,
        #[serializer(borsh)] limit: u32,
    ) -> Vec<(SupplierId, Supplier)> {
        let end = from
            .saturating_add(limit.min(MAX_BATCH))
            .min(self.next_supplier_id);
        (from..end)
            .filter_map(|id| read::<Supplier>(&supplier_key(id)).map(|s| (id, s)))
            .collect()
    }

    /// Stored intents with ids in `[from, from + limit)`, at most `MAX_BATCH`. Forgotten ids are
    /// skipped.
    #[result_serializer(borsh)]
    pub fn get_intents(
        &self,
        #[serializer(borsh)] from: IntentId,
        #[serializer(borsh)] limit: u32,
    ) -> Vec<(IntentId, Intent)> {
        let end = from
            .saturating_add(u64::from(limit.min(MAX_BATCH)))
            .min(self.next_intent_id);
        (from..end)
            .filter_map(|id| read::<Intent>(&intent_key(id)).map(|i| (id, i)))
            .collect()
    }
}
