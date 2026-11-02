//! The agent's one method. Its key can call nothing else.

use near_sdk::{env, near, require};

use crate::budget::{day_of, max_in, to_treasury_units};
use crate::events::{Event, reason_code, route_code};
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    /// Proposes paying `amount_out` (in the supplier's asset units) for the invoice whose keyed
    /// id is `obligation`. The flag is the only model-influenced input (an enum). Refusals store
    /// nothing; an accepted proposal either waits for the owner or, within the agent's limits,
    /// is approved now, and a native one is paid in this same call.
    #[result_serializer(borsh)]
    pub fn propose(
        &mut self,
        #[serializer(borsh)] obligation: Hash32,
        #[serializer(borsh)] supplier_id: SupplierId,
        #[serializer(borsh)] amount_out: u128,
        #[serializer(borsh)] flag: u8,
    ) -> ProposeResult {
        require!(env::predecessor_account_id() == self.agent_id, "ONLY_AGENT");
        require!(amount_out > 0 && amount_out <= MAX_AMOUNT, "BAD_AMOUNT");
        require!(flag <= MAX_FLAG, "BAD_FLAG");
        let now = env::block_timestamp();
        let mut b = self.budgets.at(day_of(now));
        require!(
            b.proposals < self.policy.max_proposals_per_day,
            "QUOTA_PROPOSALS"
        );
        b.proposals += 1;
        self.budgets = b;

        let (supplier, value, max_in) = match self.evaluate(&obligation, supplier_id, amount_out) {
            Ok(found) => found,
            Err(reason) => {
                Event::new()
                    .num("supplier_id", supplier_id.into())
                    .text("reason", reason_code(reason))
                    .emit("proposal_refused");
                return ProposeResult {
                    accepted: false,
                    intent_id: 0,
                    status: Status::Rejected,
                    route: Route::Autonomous,
                    reason,
                };
            }
        };

        let native = self.is_native(&supplier);
        let route = crate::rules::route(
            &self.policy,
            &b,
            value,
            max_in,
            flag != 0,
            self.in_cooldown(&supplier, now),
        );
        let intent_id = self.next_intent_id;
        self.next_intent_id = checked(intent_id.checked_add(1));
        self.stored_intents = checked(self.stored_intents.checked_add(1));
        write(&obligation_key(&obligation), &intent_id);
        let mut intent = Intent {
            supplier_id,
            revision: supplier.revision,
            obligation,
            amount_out,
            value,
            max_in,
            status: if route == Route::Autonomous {
                Status::Approved
            } else {
                Status::Pending
            },
            route,
            flag,
            since: now,
            created_at: now,
            attempt: None,
        };
        if route == Route::Autonomous {
            b.autonomous = checked(b.autonomous.checked_add(max_in));
            self.budgets = b;
        }
        Event::new()
            .num("intent_id", intent_id.into())
            .num("supplier_id", supplier_id.into())
            .amount("amount_out", amount_out)
            .text("route", route_code(route))
            .emit("intent_created");
        if route == Route::Autonomous && native {
            self.start_payout(intent_id, &mut intent, &supplier, now);
        } else {
            write(&intent_key(intent_id), &intent);
        }
        ProposeResult {
            accepted: true,
            intent_id,
            status: intent.status,
            route,
            reason: Reason::None,
        }
    }
}

impl Contract {
    /// The refusals: everything that stores nothing.
    fn evaluate(
        &self,
        obligation: &Hash32,
        supplier_id: SupplierId,
        amount_out: u128,
    ) -> Result<(Supplier, u128, u128), Reason> {
        if self.paused {
            return Err(Reason::Paused);
        }
        // Supplier id 0 never exists: unknown payees are proposed as 0 so the refusal is recorded (D-20).
        let supplier: Supplier = read(&supplier_key(supplier_id)).ok_or(Reason::UnknownSupplier)?;
        if !supplier.active {
            return Err(Reason::InactiveSupplier);
        }
        if let Some(existing) = read::<IntentId>(&obligation_key(obligation)) {
            let rejected = existing == REJECTED_OBLIGATION
                || read::<Intent>(&intent_key(existing))
                    .is_some_and(|i| i.status == Status::Rejected);
            return Err(if rejected {
                Reason::ObligationRejected
            } else {
                Reason::ObligationOpenOrPaid
            });
        }
        if self.stored_intents >= MAX_STORED_INTENTS {
            return Err(Reason::StorageFull);
        }
        let value = to_treasury_units(amount_out, supplier.decimals, self.token_decimals)
            .filter(|v| *v > 0 && *v <= MAX_AMOUNT)
            .ok_or(Reason::BadAmount)?;
        let max_in = if self.is_native(&supplier) {
            value
        } else {
            max_in(value, self.policy.max_fee_bps, self.policy.max_fixed_fee)
                .filter(|m| *m <= MAX_AMOUNT)
                .ok_or(Reason::BadAmount)?
        };
        Ok((supplier, value, max_in))
    }
}
