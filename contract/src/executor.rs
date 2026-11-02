//! Executor methods (PLAN §4.1.4, §4.2): attempts, funding and its callback, delivery reports,
//! flags, sweeps and pruning. Also `ft_on_transfer`, the treasury top-up entry point.
//!
//! The executor is a function-call key: it cannot attach deposits, and nothing it calls takes a
//! free amount or address at funding time. Funding moves exactly the committed `amount_in` to the
//! committed `pay_to`.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Promise, PromiseError};

use crate::ledger::{CreditKind, Period};
use crate::types::*;
use crate::{
    checked, events, hash, ledger_ok, validate, Contract, ContractExt, FT_STORAGE_DEPOSIT,
    GAS_FT_TRANSFER, GAS_STORAGE_DEPOSIT, GAS_TRANSFER_CALLBACK, MIN_GAS_FOR_FUNDING, ONE_YOCTO,
};

/// Longest a quote deadline may lie in the future.
const MAX_QUOTE_HORIZON_NS: u64 = 86_400_000_000_000;

#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepResult {
    pub expired: u32,
    pub invalidated: u32,
    pub voided_attempts: u32,
}

#[near]
impl Contract {
    /// Native payout attempt. Amount and recipient come from the intent; there is nothing to choose.
    pub fn create_attempt_native(&mut self, intent_id: IntentId) -> AttemptId {
        let (mut intent, now) = self.begin_attempt(intent_id);
        require!(intent.terms.kind == PayoutKind::Native, "NOT_NATIVE");
        require!(intent.terms.max_in == intent.terms.amount_out, "NATIVE_AMOUNT_MISMATCH");
        let pay_to: AccountId = intent
            .terms
            .recipient
            .parse()
            .unwrap_or_else(|_| env::panic_str("BAD_RECIPIENT"));
        let authorization = if intent.terms.test_payment {
            AttemptAuth::OwnerRequired
        } else {
            AttemptAuth::NativeAuto
        };
        let terms = AttemptTerms {
            id: self.next_attempt_id,
            intent_id,
            intent_hash: intent.intent_hash,
            kind: PayoutKind::Native,
            pay_to,
            amount_in: intent.terms.amount_out,
            quote_deadline: None,
            deposit_type: None,
            recipient_type: None,
            refund_type: None,
            refund_to: None,
            destination_asset: intent.terms.asset_id.clone(),
            final_recipient: intent.terms.recipient.clone(),
            expected_out: intent.terms.amount_out,
            quote_ref: None,
            created_at: now,
        };
        self.finish_attempt(&mut intent, terms, authorization, None, now)
    }

    /// Cross-chain attempt from a non-dry 1Click quote. The contract commits the deposit account,
    /// amount and deadline; whether the quote really pays the supplier is what the owner signs off
    /// above the executor-trust budget (PLAN §4.2 trust statement).
    pub fn create_attempt_crosschain(
        &mut self,
        intent_id: IntentId,
        deposit_address: AccountId,
        amount_in: U128,
        quote_deadline: U64,
        quote_ref: String,
    ) -> AttemptId {
        let (mut intent, now) = self.begin_attempt(intent_id);
        require!(intent.terms.kind == PayoutKind::CrossChain, "NOT_CROSSCHAIN");
        let amount_in = amount_in.0;
        require!(amount_in > 0 && amount_in <= intent.terms.max_in, "AMOUNT_IN_ABOVE_MAX");
        let deadline = quote_deadline.0;
        require!(
            deadline >= now.saturating_add(self.policy.quote_min_validity_ns),
            "QUOTE_DEADLINE_TOO_SOON"
        );
        require!(deadline <= now.saturating_add(MAX_QUOTE_HORIZON_NS), "QUOTE_DEADLINE_TOO_FAR");
        require!(validate::validate_ref(&quote_ref, MAX_QUOTE_REF_LEN), "BAD_QUOTE_REF");
        let me = env::current_account_id();
        require!(
            deposit_address != me
                && deposit_address != self.treasury_token
                && deposit_address != self.owner_id
                && deposit_address != self.agent_id
                && deposit_address != self.executor_id,
            "BAD_DEPOSIT_ADDRESS"
        );
        // A quote, and a deposit account, can back only one attempt ever.
        require!(self.used_refs.insert(hash::tagged_key("quote", &quote_ref)), "QUOTE_REUSED");
        require!(
            self.used_refs.insert(hash::tagged_key("deposit", deposit_address.as_str())),
            "DEPOSIT_ADDRESS_REUSED"
        );

        let day = Period::at(now).day;
        let (authorization, trust_day) = if intent.terms.test_payment || self.hosted_mode {
            (AttemptAuth::OwnerRequired, None)
        } else if self
            .ledger
            .trust_fits(amount_in, day, self.policy.executor_trust_daily_budget)
        {
            ledger_ok(self.ledger.take_trust(amount_in, day));
            (AttemptAuth::TrustBudget, Some(day))
        } else {
            (AttemptAuth::OwnerRequired, None)
        };

        let terms = AttemptTerms {
            id: self.next_attempt_id,
            intent_id,
            intent_hash: intent.intent_hash,
            kind: PayoutKind::CrossChain,
            pay_to: deposit_address,
            amount_in,
            quote_deadline: Some(deadline),
            deposit_type: Some(DepositType::OriginChain),
            recipient_type: Some(RecipientType::DestinationChain),
            refund_type: Some(RefundType::OriginChain),
            refund_to: Some(me),
            destination_asset: intent.terms.asset_id.clone(),
            final_recipient: intent.terms.recipient.clone(),
            expected_out: intent.terms.amount_out,
            quote_ref: Some(quote_ref),
            created_at: now,
        };
        self.finish_attempt(&mut intent, terms, authorization, trust_day, now)
    }

    /// Storage-registers the attempt's committed payee on the treasury token (D-12). Paid from the
    /// contract's NEAR, bounded by `max_registrations_per_day`.
    pub fn register_recipient(&mut self, attempt_id: AttemptId) -> Promise {
        self.assert_executor();
        let day = Period::at(env::block_timestamp()).day;
        Self::take_quota(
            &mut self.quotas.registrations,
            day,
            self.policy.max_registrations_per_day,
            "QUOTA_REGISTRATIONS",
        );
        let attempt = self.load_attempt(attempt_id);
        require!(attempt.status.is_unfunded(), "ATTEMPT_NOT_UNFUNDED");
        let args = json!({ "account_id": attempt.terms.pay_to, "registration_only": true });
        Promise::new(self.treasury_token.clone()).function_call(
            "storage_deposit",
            args.to_string().into_bytes(),
            FT_STORAGE_DEPOSIT,
            GAS_STORAGE_DEPOSIT,
        )
    }

    /// Pays a native attempt: exactly `amount_in` to the supplier, nothing else to choose.
    pub fn fund_native(&mut self, attempt_id: AttemptId) -> Promise {
        self.fund(attempt_id, PayoutKind::Native)
    }

    /// Sends a cross-chain attempt's committed `amount_in` to its committed 1Click deposit account.
    pub fn fund_crosschain(&mut self, attempt_id: AttemptId) -> Promise {
        self.fund(attempt_id, PayoutKind::CrossChain)
    }

    /// Attempt-bound callback for `fund_*`. A no-op unless the attempt is still `FundingPending`.
    /// Never panics: anything unexpected leaves the attempt for reconciliation.
    #[private]
    pub fn on_transfer_complete(&mut self, attempt_id: AttemptId) {
        let Some(mut attempt) = self.attempts.get(&attempt_id).cloned() else {
            env::log_str("CALLBACK_UNKNOWN_ATTEMPT");
            return;
        };
        if attempt.status != AttemptStatus::FundingPending {
            env::log_str("CALLBACK_STALE");
            return;
        }
        if env::promise_results_count() != 1 {
            env::log_str("CALLBACK_UNEXPECTED_RESULTS");
            return;
        }
        // Only an explicit failure means the tokens did not move (D-10).
        let sent = !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed));
        let now = env::block_timestamp();
        let outcome = if sent {
            self.apply_transfer_sent(&mut attempt, now)
        } else {
            self.apply_transfer_failed(&mut attempt, now)
        };
        if let Err(code) = outcome {
            env::log_str(&format!("CALLBACK_DEFERRED:{code}"));
        }
    }

    /// Cross-chain delivery observed by the executor. Informational: it closes the intent but
    /// credits nothing and restores no budget.
    pub fn report_delivery(&mut self, attempt_id: AttemptId, delivered_amount: U128, dest_tx: String) {
        self.assert_executor();
        require!(validate::validate_ref(&dest_tx, MAX_TX_REF_LEN), "BAD_DEST_TX");
        require!(delivered_amount.0 <= MAX_AMOUNT, "BAD_AMOUNT");
        let mut attempt = self.load_attempt(attempt_id);
        require!(
            attempt.terms.kind == PayoutKind::CrossChain && attempt.status == AttemptStatus::Funded,
            "ATTEMPT_NOT_FUNDED"
        );
        let now = env::block_timestamp();
        self.mark_delivered(&mut attempt, delivered_amount.0, dest_tx, now);
    }

    /// Outcome unknown: hand the attempt to the owner. A stuck `FundingPending` can be flagged only
    /// after `reconcile_grace_ns`, so a callback that is merely slow is not pre-empted.
    #[payable]
    pub fn flag_reconciliation(&mut self, attempt_id: AttemptId) {
        self.assert_executor_or_owner();
        let now = env::block_timestamp();
        let mut attempt = self.load_attempt(attempt_id);
        let allowed = match attempt.status {
            AttemptStatus::Funded => true,
            AttemptStatus::FundingPending => attempt
                .funded_at
                .is_some_and(|t| now >= t.saturating_add(self.policy.reconcile_grace_ns)),
            _ => false,
        };
        require!(allowed, "CANNOT_FLAG");
        attempt.status = AttemptStatus::NeedsReconciliation;
        attempt.updated_at = now;
        self.attempts.insert(attempt_id, attempt);
        events::emit("attempt_flagged", json!({ "attempt_id": attempt_id }));
    }

    /// Cancels an unfunded attempt (for example a stale quote). The intent keeps its reservation.
    #[payable]
    pub fn cancel_attempt(&mut self, attempt_id: AttemptId) {
        self.assert_executor_or_owner();
        let now = env::block_timestamp();
        let mut attempt = self.load_attempt(attempt_id);
        require!(attempt.status.is_unfunded(), "ATTEMPT_NOT_UNFUNDED");
        let mut intent = self.load_intent(attempt.terms.intent_id);
        require!(intent.live_attempt == Some(attempt_id), "NOT_LIVE_ATTEMPT");
        self.void_attempt(&mut attempt, now);
        intent.live_attempt = None;
        intent.updated_at = now;
        self.attempts.insert(attempt_id, attempt);
        self.intents.insert(intent.terms.id, intent);
    }

    /// Housekeeping, allowed while paused: expires unfunded intents past `expires_at`, invalidates
    /// approved intents whose supplier changed, and voids attempts whose quote is too close to its
    /// deadline. Processes at most `limit` changes.
    #[payable]
    pub fn sweep(&mut self, limit: u32) -> SweepResult {
        self.assert_executor_or_owner();
        let now = env::block_timestamp();
        let mut result = SweepResult::default();
        let ids: Vec<IntentId> = self.open_intents.iter().copied().collect();
        for id in ids {
            if result.expired + result.invalidated + result.voided_attempts >= limit {
                break;
            }
            let mut intent = self.load_intent(id);
            if !matches!(intent.status, IntentStatus::Pending | IntentStatus::Approved) {
                continue;
            }
            let mut supplier = self.suppliers.get(&intent.terms.supplier_id).cloned();
            let stale = supplier
                .as_ref()
                .is_none_or(|s| s.revision != intent.terms.supplier_revision);
            if now >= intent.terms.expires_at || stale {
                self.release_unfunded(&mut intent, supplier.as_mut(), now);
                let status = if now >= intent.terms.expires_at {
                    result.expired += 1;
                    IntentStatus::Expired
                } else {
                    result.invalidated += 1;
                    IntentStatus::Invalidated
                };
                self.close_intent(&mut intent, status, now);
            } else if let Some(attempt_id) = intent.live_attempt {
                let mut attempt = self.load_attempt(attempt_id);
                let too_late = attempt
                    .terms
                    .quote_deadline
                    .is_some_and(|d| now.saturating_add(self.policy.funding_margin_ns) > d);
                if attempt.status.is_unfunded() && too_late {
                    self.void_attempt(&mut attempt, now);
                    self.attempts.insert(attempt_id, attempt);
                    intent.live_attempt = None;
                    intent.updated_at = now;
                    result.voided_attempts += 1;
                } else {
                    continue;
                }
            } else {
                continue;
            }
            if let Some(s) = supplier {
                self.suppliers.insert(s.id, s);
            }
            self.intents.insert(id, intent);
        }
        result
    }

    /// Deletes closed intents (and their attempts) older than `retention_ns`, oldest first.
    /// Obligation ids of done, rejected or cancelled intents stay blocked after pruning.
    #[payable]
    pub fn prune(&mut self, limit: u32) -> u32 {
        self.assert_executor_or_owner();
        let now = env::block_timestamp();
        let mut pruned = 0;
        while pruned < limit && self.closed_head < self.closed_tail {
            let Some(id) = self.closed_queue.get(&self.closed_head).copied() else { break };
            if let Some(intent) = self.intents.get(&id).cloned() {
                if now < intent.updated_at.saturating_add(self.policy.retention_ns) {
                    break; // the queue is in closing order, so everything after is newer
                }
                for attempt_id in &intent.attempt_ids {
                    self.attempts.remove(attempt_id);
                }
                if matches!(intent.status, IntentStatus::Expired | IntentStatus::Invalidated)
                    && self.obligations.get(&intent.terms.obligation_id) == Some(&id)
                {
                    self.obligations.remove(&intent.terms.obligation_id);
                }
                self.intents.remove(&id);
            }
            self.closed_queue.remove(&self.closed_head);
            self.closed_head += 1;
            pruned += 1;
        }
        pruned
    }

    /// NEP-141 receiver: top-ups via `ft_transfer_call` on the treasury token. Any other token is
    /// refused (the panic makes the token contract refund the sender).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(env::predecessor_account_id() == self.treasury_token, "UNSUPPORTED_TOKEN");
        require!(amount.0 > 0 && amount.0 <= MAX_AMOUNT, "BAD_AMOUNT");
        let _ = msg;
        ledger_ok(self.ledger.credit(amount.0, CreditKind::TopUp));
        events::emit(
            "top_up",
            json!({ "sender_id": sender_id, "amount": amount.0.to_string() }),
        );
        U128(0)
    }
}

impl Contract {
    /// Shared preconditions for creating an attempt. Returns the intent and the time.
    fn begin_attempt(&mut self, intent_id: IntentId) -> (Intent, u64) {
        self.assert_executor();
        self.assert_not_paused();
        let now = env::block_timestamp();
        let intent = self.load_intent(intent_id);
        require!(intent.status == IntentStatus::Approved, "INTENT_NOT_APPROVED");
        require!(intent.live_attempt.is_none(), "LIVE_ATTEMPT_EXISTS");
        require!(now < intent.terms.expires_at, "INTENT_EXPIRED");
        require!(intent.attempt_ids.len() < MAX_ATTEMPTS_PER_INTENT, "TOO_MANY_ATTEMPTS");
        let supplier = self.load_supplier(intent.terms.supplier_id);
        require!(supplier.active, "INACTIVE_SUPPLIER");
        require!(supplier.revision == intent.terms.supplier_revision, "SUPPLIER_CHANGED");
        Self::take_quota(
            &mut self.quotas.attempts,
            Period::at(now).day,
            self.policy.max_attempts_per_day,
            "QUOTA_ATTEMPTS",
        );
        (intent, now)
    }

    fn finish_attempt(
        &mut self,
        intent: &mut Intent,
        terms: AttemptTerms,
        authorization: AttemptAuth,
        trust_day: Option<u32>,
        now: u64,
    ) -> AttemptId {
        let id = terms.id;
        self.next_attempt_id += 1;
        let attempt_hash = hash::attempt_hash(&env::current_account_id(), &terms);
        let status = if authorization == AttemptAuth::OwnerRequired {
            AttemptStatus::AwaitingOwner
        } else {
            AttemptStatus::Authorized
        };
        events::emit(
            "attempt_created",
            json!({
                "attempt_id": id,
                "intent_id": terms.intent_id,
                "kind": terms.kind,
                "pay_to": terms.pay_to,
                "amount_in": terms.amount_in.to_string(),
                "authorization": authorization,
                "attempt_hash": hash::to_hex(&attempt_hash),
            }),
        );
        let attempt = Attempt {
            terms,
            attempt_hash,
            authorization,
            status,
            trust_day,
            funded_at: None,
            charged: None,
            transfer_confirmed: false,
            delivered_amount: None,
            dest_tx: None,
            returned_amount: 0,
            updated_at: now,
        };
        intent.live_attempt = Some(id);
        intent.attempt_ids.push(id);
        intent.updated_at = now;
        self.attempts.insert(id, attempt);
        self.intents.insert(intent.terms.id, intent.clone());
        id
    }

    fn fund(&mut self, attempt_id: AttemptId, kind: PayoutKind) -> Promise {
        self.assert_executor();
        self.assert_not_paused();
        require!(env::prepaid_gas() >= MIN_GAS_FOR_FUNDING, "NOT_ENOUGH_GAS");
        let now = env::block_timestamp();
        let period = Period::at(now);
        let mut attempt = self.load_attempt(attempt_id);
        require!(attempt.terms.kind == kind, "WRONG_FUNDING_METHOD");
        require!(attempt.status == AttemptStatus::Authorized, "ATTEMPT_NOT_AUTHORIZED");
        require!(
            !(self.hosted_mode && attempt.authorization == AttemptAuth::TrustBudget),
            "TRUST_BUDGET_DISABLED_IN_HOSTED_MODE"
        );
        let mut intent = self.load_intent(attempt.terms.intent_id);
        require!(
            intent.status == IntentStatus::Approved && intent.live_attempt == Some(attempt_id),
            "INTENT_NOT_FUNDABLE"
        );
        require!(now < intent.terms.expires_at, "INTENT_EXPIRED");
        let mut supplier = self.load_supplier(intent.terms.supplier_id);
        require!(supplier.active, "INACTIVE_SUPPLIER");
        require!(supplier.revision == intent.terms.supplier_revision, "SUPPLIER_CHANGED");
        if let Some(deadline) = attempt.terms.quote_deadline {
            require!(
                now.saturating_add(self.policy.funding_margin_ns) <= deadline,
                "QUOTE_TOO_CLOSE_TO_DEADLINE"
            );
        }
        let amount_in = attempt.terms.amount_in;
        require!(
            intent.reserved == intent.terms.max_in && amount_in <= intent.reserved,
            "RESERVATION_MISMATCH"
        );

        // State first, then the external call (reentrancy-safe ordering).
        ledger_ok(self.ledger.fund(amount_in, period));
        intent.reserved = checked(intent.reserved.checked_sub(amount_in));
        intent.status = IntentStatus::Funding;
        intent.updated_at = now;
        supplier.reserved_out = checked(supplier.reserved_out.checked_sub(intent.terms.amount_out));
        ledger_ok(supplier.month_out.add(period.month, intent.terms.amount_out));
        attempt.status = AttemptStatus::FundingPending;
        attempt.funded_at = Some(now);
        attempt.charged = Some(period);
        attempt.updated_at = now;

        let receiver = attempt.terms.pay_to.clone();
        let memo = match kind {
            PayoutKind::Native => Some(format!("getleash intent {} attempt {}", intent.terms.id, attempt_id)),
            PayoutKind::CrossChain => None,
        };
        events::emit(
            "attempt_funding",
            json!({
                "attempt_id": attempt_id,
                "intent_id": intent.terms.id,
                "pay_to": receiver,
                "amount_in": amount_in.to_string(),
            }),
        );
        self.attempts.insert(attempt_id, attempt);
        self.intents.insert(intent.terms.id, intent);
        self.suppliers.insert(supplier.id, supplier);

        let args = json!({ "receiver_id": receiver, "amount": amount_in.to_string(), "memo": memo });
        Promise::new(self.treasury_token.clone())
            .function_call("ft_transfer", args.to_string().into_bytes(), ONE_YOCTO, GAS_FT_TRANSFER)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_TRANSFER_CALLBACK)
                    .on_transfer_complete(attempt_id),
            )
    }

    /// The treasury transfer happened: release the fee slack. Native payouts are delivered on the
    /// spot; cross-chain ones wait for delivery. All-or-nothing, never panics.
    pub(crate) fn apply_transfer_sent(&mut self, attempt: &mut Attempt, now: u64) -> Result<(), &'static str> {
        let mut intent = self.intents.get(&attempt.terms.intent_id).cloned().ok_or("INTENT_MISSING")?;
        let mut ledger = self.ledger.clone();
        ledger.confirm_sent(intent.reserved).map_err(|e| e.code())?;
        intent.reserved = 0;
        intent.updated_at = now;
        attempt.transfer_confirmed = true;
        attempt.updated_at = now;
        let close = match attempt.terms.kind {
            PayoutKind::Native => {
                ledger.land(attempt.terms.amount_in).map_err(|e| e.code())?;
                attempt.status = AttemptStatus::Delivered;
                attempt.delivered_amount = Some(attempt.terms.amount_in);
                true
            }
            PayoutKind::CrossChain => {
                attempt.status = AttemptStatus::Funded;
                false
            }
        };
        // Commit.
        self.ledger = ledger;
        if close {
            self.close_intent(&mut intent, IntentStatus::Done, now);
        }
        events::emit(
            "attempt_sent",
            json!({ "attempt_id": attempt.terms.id, "status": attempt.status }),
        );
        self.attempts.insert(attempt.terms.id, attempt.clone());
        self.intents.insert(intent.terms.id, intent);
        Ok(())
    }

    /// The treasury transfer provably failed: undo the charge and restore the reservation when it
    /// still fits (D-01, D-08); otherwise send the intent back for approval. All-or-nothing.
    pub(crate) fn apply_transfer_failed(&mut self, attempt: &mut Attempt, now: u64) -> Result<(), &'static str> {
        let mut intent = self.intents.get(&attempt.terms.intent_id).cloned().ok_or("INTENT_MISSING")?;
        let mut supplier = self
            .suppliers
            .get(&intent.terms.supplier_id)
            .cloned()
            .ok_or("SUPPLIER_MISSING")?;
        let charged = attempt.charged.ok_or("NOT_CHARGED")?;
        let amount_in = attempt.terms.amount_in;
        let amount_out = intent.terms.amount_out;
        let at = Period::at(now);

        let mut ledger = self.ledger.clone();
        supplier.month_out.sub_if_same(charged.month, amount_out).map_err(|e| e.code())?;
        let supplier_fits = supplier
            .month_out
            .current(at.month)
            .checked_add(supplier.reserved_out)
            .and_then(|t| t.checked_add(amount_out))
            .is_some_and(|t| t <= supplier.monthly_cap);
        let restored = ledger
            .fail_transfer(amount_in, charged, at, self.caps(), supplier_fits)
            .map_err(|e| e.code())?;
        if let Some(day) = attempt.trust_day {
            ledger.release_trust(amount_in, day).map_err(|e| e.code())?;
        }
        if restored {
            intent.reserved = intent.reserved.checked_add(amount_in).ok_or("ARITHMETIC")?;
            supplier.reserved_out = supplier.reserved_out.checked_add(amount_out).ok_or("ARITHMETIC")?;
            intent.status = IntentStatus::Approved;
        } else {
            ledger.release(intent.reserved).map_err(|e| e.code())?;
            intent.reserved = 0;
            intent.status = IntentStatus::Pending;
            intent.approved_at = None;
        }
        intent.live_attempt = None;
        intent.updated_at = now;
        attempt.status = AttemptStatus::Failed;
        attempt.updated_at = now;

        // Commit.
        self.ledger = ledger;
        events::emit(
            "attempt_failed",
            json!({
                "attempt_id": attempt.terms.id,
                "intent_id": intent.terms.id,
                "intent_status": intent.status,
            }),
        );
        self.attempts.insert(attempt.terms.id, attempt.clone());
        self.intents.insert(intent.terms.id, intent);
        self.suppliers.insert(supplier.id, supplier);
        Ok(())
    }

    /// Cross-chain delivery (reported or owner-confirmed): close the intent. Credits nothing.
    pub(crate) fn mark_delivered(&mut self, attempt: &mut Attempt, delivered: u128, dest_tx: String, now: u64) {
        let mut intent = self.load_intent(attempt.terms.intent_id);
        ledger_ok(self.ledger.land(attempt.terms.amount_in));
        attempt.status = AttemptStatus::Delivered;
        attempt.delivered_amount = Some(delivered);
        attempt.dest_tx = Some(dest_tx);
        attempt.updated_at = now;
        self.close_intent(&mut intent, IntentStatus::Done, now);
        events::emit(
            "attempt_delivered",
            json!({ "attempt_id": attempt.terms.id, "delivered_amount": delivered.to_string() }),
        );
        self.attempts.insert(attempt.terms.id, attempt.clone());
        self.intents.insert(intent.terms.id, intent);
    }
}
