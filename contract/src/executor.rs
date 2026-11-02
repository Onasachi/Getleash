//! The executor's methods: propose a 1Click deposit for a cross-chain intent, fund it by intent
//! id only, and forget old intents. Its key can call nothing else, and nothing it sends can name
//! an amount or address that moves money except through these checked terms.

use near_sdk::{env, near, require};

use crate::budget::min_in;
use crate::events::Event;
use crate::types::*;
use crate::validate::to_hex;
use crate::*;

#[near]
impl Contract {
    /// Records the deposit a fresh 1Click quote returned for an approved cross-chain intent,
    /// replacing an unfunded one (never with the same deposit, so an owner's authorization of
    /// the old terms cannot carry over). Funding still needs the owner's `authorize` or room in
    /// the executor-trust budget.
    pub fn create_attempt(
        &mut self,
        #[serializer(borsh)] intent_id: IntentId,
        #[serializer(borsh)] deposit: Hash32,
        #[serializer(borsh)] amount_in: u128,
        #[serializer(borsh)] deadline: u64,
    ) {
        require!(
            env::predecessor_account_id() == self.executor_id,
            "ONLY_EXECUTOR"
        );
        require!(!self.paused, "PAUSED");
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(intent.status == Status::Approved, "INTENT_NOT_APPROVED");
        require!(!self.expired(&intent, now), "INTENT_EXPIRED");
        let supplier = self.load_supplier(intent.supplier_id);
        require!(!self.is_native(&supplier), "NOT_CROSS_CHAIN");
        require!(
            supplier.active && supplier.revision == intent.revision,
            "SUPPLIER_CHANGED"
        );
        require!(self.is_outside_account(&to_hex(&deposit)), "BAD_DEPOSIT");
        if let Some(previous) = &intent.attempt {
            require!(previous.deposit != deposit, "SAME_DEPOSIT");
        }
        require!(
            deadline >= now.saturating_add(self.policy.quote_min_validity_ns)
                && deadline <= now.saturating_add(DAY),
            "BAD_DEADLINE"
        );
        require!(
            amount_in >= min_in(intent.value, self.policy.max_fee_bps)
                && amount_in <= intent.max_in,
            "FEE_BOUND"
        );
        intent.attempt = Some(Attempt {
            deposit,
            amount_in,
            deadline,
            authorized: false,
            epoch: self.executor_epoch,
        });
        write(&intent_key(intent_id), &intent);
        Event::new()
            .num("intent_id", intent_id.into())
            .text("deposit", &to_hex(&deposit))
            .amount("amount_in", amount_in)
            .num("deadline", deadline.into())
            .emit("attempt_created");
    }

    /// Sends an approved cross-chain intent's committed `amount_in` to its committed deposit.
    /// Takes only the id: nothing the executor passes here can redirect money.
    pub fn fund(&mut self, #[serializer(borsh)] intent_id: IntentId) {
        require!(
            env::predecessor_account_id() == self.executor_id,
            "ONLY_EXECUTOR"
        );
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(intent.status == Status::Approved, "INTENT_NOT_APPROVED");
        let supplier = self.load_supplier(intent.supplier_id);
        require!(!self.is_native(&supplier), "NOT_CROSS_CHAIN");
        self.start_payout(intent_id, &mut intent, &supplier, now);
    }

    /// Deletes intents nobody needs any more, returning how many. Paid and rejected ones go after
    /// `retention_ns` and keep blocking their invoice; never-funded ones that expired or whose
    /// supplier changed go at once and free their invoice. Others are skipped.
    #[payable]
    #[result_serializer(borsh)]
    pub fn forget(&mut self, #[serializer(borsh)] intent_ids: Vec<IntentId>) -> u32 {
        self.assert_executor_or_owner();
        require!(intent_ids.len() <= MAX_BATCH as usize, "TOO_MANY");
        let now = env::block_timestamp();
        let mut removed = 0u32;
        for id in intent_ids {
            let key = intent_key(id);
            let Some(intent) = read::<Intent>(&key) else {
                continue;
            };
            let closed = matches!(intent.status, Status::Paid | Status::Rejected)
                && now >= intent.since.saturating_add(self.policy.retention_ns);
            let dead = matches!(
                intent.status,
                Status::Pending | Status::Approved | Status::Failed
            ) && (self.expired(&intent, now)
                || self.load_supplier(intent.supplier_id).revision != intent.revision);
            if !closed && !dead {
                continue;
            }
            env::storage_remove(&key);
            let okey = obligation_key(&intent.obligation);
            if dead {
                if read::<IntentId>(&okey) == Some(id) {
                    env::storage_remove(&okey);
                }
            } else if intent.status == Status::Rejected {
                write(&okey, &REJECTED_OBLIGATION);
            }
            self.stored_intents = checked(self.stored_intents.checked_sub(1));
            removed += 1;
            Event::new()
                .num("intent_id", id.into())
                .emit("intent_forgotten");
        }
        removed
    }
}
