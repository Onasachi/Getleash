//! The agent's single method: `propose_payment` (PLAN §4.1.4).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::ledger::Period;
use crate::types::*;
use crate::{events, hash, ledger_ok, validate, Contract, ContractExt};

#[near]
impl Contract {
    /// Propose paying `amount_out` (destination base units) to an allowlisted supplier.
    ///
    /// The agent supplies no destination: it comes from the supplier record. `obligation_id` is
    /// the ingestion HMAC (64 hex chars). `review_flag` can only force owner review.
    ///
    /// Order (F-08): caller check, input checks and quotas all panic before any write; rule
    /// failures are recorded (bounded ring buffer + event) and returned, not panicked.
    pub fn propose_payment(
        &mut self,
        obligation_id: String,
        supplier_id: SupplierId,
        amount_out: U128,
        review_flag: Option<ReviewFlag>,
    ) -> ProposeResult {
        self.assert_agent();
        let obligation_id = hash::parse_hex32(&obligation_id)
            .unwrap_or_else(|| env::panic_str("BAD_OBLIGATION_ID"));
        let amount_out = amount_out.0;
        require!(amount_out > 0 && amount_out <= MAX_AMOUNT, "BAD_AMOUNT");

        let now = env::block_timestamp();
        let period = Period::at(now);
        require!(
            self.open_intents.len() < self.policy.max_open_intents,
            "QUOTA_OPEN_INTENTS"
        );
        Self::take_quota(
            &mut self.quotas.proposals,
            period.day,
            self.policy.max_proposals_per_day,
            "QUOTA_PROPOSALS",
        );

        match self.evaluate_proposal(&obligation_id, supplier_id, amount_out, now) {
            Err(reason) => {
                self.record_rejection(Rejection {
                    at: now,
                    obligation_id,
                    supplier_id,
                    amount_out,
                    reason,
                });
                ProposeResult {
                    accepted: false,
                    intent_id: None,
                    status: None,
                    route: None,
                    intent_hash: None,
                    reason: Some(reason),
                }
            }
            Ok(candidate) => self.create_intent(obligation_id, candidate, review_flag, now),
        }
    }
}

/// A proposal that passed the rules, with its derived amounts.
pub(crate) struct Candidate {
    pub supplier: Supplier,
    pub kind: PayoutKind,
    pub amount_out: u128,
    pub value: u128,
    pub max_in: u128,
    pub test_payment: bool,
}

impl Contract {
    fn evaluate_proposal(
        &self,
        obligation_id: &Hash32,
        supplier_id: SupplierId,
        amount_out: u128,
        now: u64,
    ) -> Result<Candidate, RejectReason> {
        if self.paused {
            return Err(RejectReason::Paused);
        }
        let supplier = self.suppliers.get(&supplier_id).cloned().ok_or(RejectReason::UnknownSupplier)?;
        if !supplier.active {
            return Err(RejectReason::InactiveSupplier);
        }
        let asset = match self.assets.get(&supplier.asset_id) {
            Some(asset) if asset.enabled => asset.clone(),
            _ => return Err(RejectReason::AssetDisabled),
        };
        self.check_obligation(obligation_id)?;

        let kind = self.payout_kind(&supplier);
        let value = validate::to_treasury_units(amount_out, asset.decimals, self.treasury_decimals)
            .filter(|v| *v <= MAX_AMOUNT)
            .ok_or(RejectReason::OverPerPaymentCap)?;
        let max_in = validate::max_in(kind, value, self.policy.max_fee_bps, asset.max_fixed_fee)
            .ok_or(RejectReason::OverPerPaymentCap)?;
        let test_payment = self.in_cooldown(&supplier, now);
        self.check_payment_rules(&supplier, amount_out, value, max_in, test_payment, now)?;
        Ok(Candidate { supplier, kind, amount_out, value, max_in, test_payment })
    }

    /// One open-or-paid intent per obligation id; owner rejections are final (D-07).
    pub(crate) fn check_obligation(&self, obligation_id: &Hash32) -> Result<(), RejectReason> {
        let Some(previous) = self.obligations.get(obligation_id) else { return Ok(()) };
        match self.intents.get(previous).map(|i| i.status) {
            Some(IntentStatus::Expired | IntentStatus::Invalidated) => Ok(()),
            Some(IntentStatus::Rejected | IntentStatus::Cancelled) => {
                Err(RejectReason::ObligationRejected)
            }
            // Open, done, or a closed intent that has been pruned.
            _ => Err(RejectReason::ObligationOpenOrPaid),
        }
    }

    pub(crate) fn payout_kind(&self, supplier: &Supplier) -> PayoutKind {
        if supplier.chain == Chain::Near && supplier.asset_id == self.treasury_asset_id {
            PayoutKind::Native
        } else {
            PayoutKind::CrossChain
        }
    }

    fn create_intent(
        &mut self,
        obligation_id: Hash32,
        candidate: Candidate,
        review_flag: Option<ReviewFlag>,
        now: u64,
    ) -> ProposeResult {
        let Candidate { mut supplier, kind, amount_out, value, max_in, test_payment } = candidate;
        let period = Period::at(now);
        let needs_approval = if review_flag.is_some() {
            Some(ApprovalReason::ReviewFlag)
        } else if test_payment {
            Some(ApprovalReason::TestPayment)
        } else if !supplier.verified {
            Some(ApprovalReason::UnverifiedSupplier)
        } else if value > self.policy.approval_threshold {
            Some(ApprovalReason::AboveThreshold)
        } else if !self.ledger.autonomous_fits(max_in, period.day, self.policy.autonomous_daily_budget) {
            Some(ApprovalReason::AutonomousBudgetUsed)
        } else {
            None
        };
        let route = match needs_approval {
            Some(reason) => Route::NeedsApproval(reason),
            None => Route::Autonomous,
        };

        let id = self.next_intent_id;
        self.next_intent_id += 1;
        let terms = IntentTerms {
            id,
            obligation_id,
            supplier_id: supplier.id,
            supplier_revision: supplier.revision,
            chain: supplier.chain,
            asset_id: supplier.asset_id.clone(),
            recipient: supplier.recipient.clone(),
            kind,
            amount_out,
            value,
            max_in,
            created_at: now,
            expires_at: now.saturating_add(self.policy.intent_ttl_ns),
            route,
            review_flag,
            test_payment,
        };
        let intent_hash = hash::intent_hash(&env::current_account_id(), &terms);
        let mut intent = Intent {
            terms,
            intent_hash,
            status: IntentStatus::Pending,
            reserved: 0,
            live_attempt: None,
            attempt_ids: Vec::new(),
            approved_at: None,
            updated_at: now,
        };

        if route == Route::Autonomous {
            // The rules passed a moment ago, so this cannot fail; if it did, revert everything.
            self.commit_approval(&mut intent, &mut supplier, now)
                .unwrap_or_else(|reason| env::panic_str(reason.code()));
            ledger_ok(self.ledger.take_autonomous(max_in, period.day));
        }

        self.suppliers.insert(supplier.id, supplier);
        self.obligations.insert(obligation_id, id);
        self.open_intents.insert(id);
        let status = intent.status;
        self.intents.insert(id, intent);
        events::emit(
            "intent_created",
            json!({
                "intent_id": id,
                "status": status,
                "route": route,
                "amount_out": amount_out.to_string(),
                "max_in": max_in.to_string(),
                "intent_hash": hash::to_hex(&intent_hash),
            }),
        );
        ProposeResult {
            accepted: true,
            intent_id: Some(id),
            status: Some(status),
            route: Some(route),
            intent_hash: Some(hash::to_hex(&intent_hash)),
            reason: None,
        }
    }

    fn record_rejection(&mut self, rejection: Rejection) {
        events::emit(
            "proposal_rejected",
            json!({
                "supplier_id": rejection.supplier_id,
                "amount_out": rejection.amount_out.to_string(),
                "reason": rejection.reason,
            }),
        );
        if self.rejections.len() < REJECTION_RING {
            self.rejections.push(rejection);
        } else {
            self.rejections.replace(self.rejection_cursor, rejection);
        }
        self.rejection_cursor = (self.rejection_cursor + 1) % REJECTION_RING;
    }
}
