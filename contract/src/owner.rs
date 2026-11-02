//! Owner methods (PLAN §4.1.4). Every one is `#[payable]` and requires exactly 1 yoctoNEAR plus the
//! owner as caller, so it needs a full-access key and a wallet confirmation.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseError};

use crate::ledger::{CreditKind, Period};
use crate::types::*;
use crate::{
    checked, events, hash, ledger_ok, validate, validate_policy, Contract, ContractExt,
    GAS_FT_TRANSFER, GAS_TRANSFER_CALLBACK, MIN_GAS_FOR_FUNDING, NEAR_RESERVE, ONE_YOCTO,
};

#[near]
impl Contract {
    // ── Intents ────────────────────────────────────────────────────────────────────────────────

    /// Approve a pending intent. `expected_intent_hash` must match what the owner was shown; the
    /// rules are re-checked against current state and `max_in` is reserved.
    #[payable]
    pub fn approve(&mut self, intent_id: IntentId, expected_intent_hash: String) {
        self.assert_owner_call();
        self.assert_not_paused();
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(intent.status == IntentStatus::Pending, "INTENT_NOT_PENDING");
        require!(now < intent.terms.expires_at, "INTENT_EXPIRED");
        let expected = hash::parse_hex32(&expected_intent_hash)
            .unwrap_or_else(|| env::panic_str("BAD_HASH"));
        require!(expected == intent.intent_hash, "INTENT_HASH_MISMATCH");
        let mut supplier = self.load_supplier(intent.terms.supplier_id);
        require!(supplier.revision == intent.terms.supplier_revision, "SUPPLIER_CHANGED");
        self.commit_approval(&mut intent, &mut supplier, now)
            .unwrap_or_else(|reason| env::panic_str(reason.code()));
        self.suppliers.insert(supplier.id, supplier);
        self.intents.insert(intent_id, intent);
        events::emit("intent_approved", json!({ "intent_id": intent_id }));
    }

    /// Refuse a pending intent. Its obligation id stays blocked (D-07).
    #[payable]
    pub fn reject(&mut self, intent_id: IntentId) {
        self.assert_owner_call();
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(intent.status == IntentStatus::Pending, "INTENT_NOT_PENDING");
        self.close_intent(&mut intent, IntentStatus::Rejected, now);
        self.intents.insert(intent_id, intent);
    }

    /// Cancel a pending or approved (unfunded) intent and release its reservation.
    #[payable]
    pub fn cancel(&mut self, intent_id: IntentId) {
        self.assert_owner_call();
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(
            matches!(intent.status, IntentStatus::Pending | IntentStatus::Approved),
            "INTENT_NOT_CANCELLABLE"
        );
        let mut supplier = self.suppliers.get(&intent.terms.supplier_id).cloned();
        self.release_unfunded(&mut intent, supplier.as_mut(), now);
        self.close_intent(&mut intent, IntentStatus::Cancelled, now);
        if let Some(s) = supplier {
            self.suppliers.insert(s.id, s);
        }
        self.intents.insert(intent_id, intent);
    }

    /// Replace an intent with a new pending one for the same obligation (for example a corrected
    /// invoice amount). An open original is cancelled. The new intent snapshots the supplier as it
    /// is now and always needs approval. Returns the new intent id.
    #[payable]
    pub fn amend_intent(&mut self, intent_id: IntentId, amount_out: U128) -> IntentId {
        self.assert_owner_call();
        let now = env::block_timestamp();
        let amount_out = amount_out.0;
        require!(amount_out > 0 && amount_out <= MAX_AMOUNT, "BAD_AMOUNT");
        let mut old = self.load_intent(intent_id);
        require!(
            !matches!(old.status, IntentStatus::Funding | IntentStatus::Done),
            "INTENT_NOT_AMENDABLE"
        );
        let obligation_id = old.terms.obligation_id;
        require!(
            self.obligations.get(&obligation_id) == Some(&intent_id),
            "NOT_LATEST_FOR_OBLIGATION"
        );
        if old.status.is_open() {
            let mut supplier = self.suppliers.get(&old.terms.supplier_id).cloned();
            self.release_unfunded(&mut old, supplier.as_mut(), now);
            self.close_intent(&mut old, IntentStatus::Cancelled, now);
            if let Some(s) = supplier {
                self.suppliers.insert(s.id, s);
            }
            self.intents.insert(intent_id, old.clone());
        }
        require!(self.open_intents.len() < self.policy.max_open_intents, "QUOTA_OPEN_INTENTS");

        let supplier = self.load_supplier(old.terms.supplier_id);
        require!(supplier.active, "INACTIVE_SUPPLIER");
        let asset = self
            .assets
            .get(&supplier.asset_id)
            .filter(|a| a.enabled)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ASSET_DISABLED"));
        let kind = self.payout_kind(&supplier);
        let value = validate::to_treasury_units(amount_out, asset.decimals, self.treasury_decimals)
            .filter(|v| *v <= MAX_AMOUNT)
            .unwrap_or_else(|| env::panic_str("BAD_AMOUNT"));
        let max_in = checked(validate::max_in(kind, value, self.policy.max_fee_bps, asset.max_fixed_fee));
        let test_payment = self.in_cooldown(&supplier, now);
        require!(!test_payment || value <= self.policy.test_payment_max, "SUPPLIER_COOLDOWN");

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
            route: Route::NeedsApproval(ApprovalReason::OwnerAmended),
            review_flag: None,
            test_payment,
        };
        let intent_hash = hash::intent_hash(&env::current_account_id(), &terms);
        self.intents.insert(
            id,
            Intent {
                terms,
                intent_hash,
                status: IntentStatus::Pending,
                reserved: 0,
                live_attempt: None,
                attempt_ids: Vec::new(),
                approved_at: None,
                updated_at: now,
            },
        );
        self.obligations.insert(obligation_id, id);
        self.open_intents.insert(id);
        events::emit(
            "intent_amended",
            json!({ "old_intent_id": intent_id, "intent_id": id, "intent_hash": hash::to_hex(&intent_hash) }),
        );
        id
    }

    // ── Attempts ───────────────────────────────────────────────────────────────────────────────

    /// Sign off an attempt that needs the owner (cross-chain above the trust budget, or a test
    /// payment). `expected_attempt_hash` must match the attempt the owner checked.
    #[payable]
    pub fn authorize_attempt(&mut self, attempt_id: AttemptId, expected_attempt_hash: String) {
        self.assert_owner_call();
        self.assert_not_paused();
        let now = env::block_timestamp();
        let mut attempt = self.load_attempt(attempt_id);
        require!(attempt.status == AttemptStatus::AwaitingOwner, "ATTEMPT_NOT_AWAITING_OWNER");
        let expected = hash::parse_hex32(&expected_attempt_hash)
            .unwrap_or_else(|| env::panic_str("BAD_HASH"));
        require!(expected == attempt.attempt_hash, "ATTEMPT_HASH_MISMATCH");
        let intent = self.load_intent(attempt.terms.intent_id);
        require!(
            intent.status == IntentStatus::Approved && intent.live_attempt == Some(attempt_id),
            "INTENT_NOT_FUNDABLE"
        );
        if let Some(deadline) = attempt.terms.quote_deadline {
            require!(
                now.saturating_add(self.policy.funding_margin_ns) <= deadline,
                "QUOTE_TOO_CLOSE_TO_DEADLINE"
            );
        }
        attempt.status = AttemptStatus::Authorized;
        attempt.authorization = AttemptAuth::OwnerSigned;
        attempt.updated_at = now;
        self.attempts.insert(attempt_id, attempt);
        events::emit("attempt_authorized", json!({ "attempt_id": attempt_id }));
    }

    /// Rule on an attempt in `NeedsReconciliation` (D-09). Works while paused.
    #[payable]
    pub fn resolve_reconciliation(&mut self, attempt_id: AttemptId, outcome: ReconcileOutcome) {
        self.assert_owner_call();
        let now = env::block_timestamp();
        let mut attempt = self.load_attempt(attempt_id);
        require!(
            attempt.status == AttemptStatus::NeedsReconciliation,
            "ATTEMPT_NOT_IN_RECONCILIATION"
        );
        let kind = attempt.terms.kind;
        match outcome {
            ReconcileOutcome::NotSent => {
                require!(!attempt.transfer_confirmed, "TRANSFER_ALREADY_CONFIRMED");
                self.apply_transfer_failed(&mut attempt, now)
                    .unwrap_or_else(|code| env::panic_str(code));
            }
            ReconcileOutcome::Sent => {
                if attempt.transfer_confirmed {
                    attempt.status = AttemptStatus::Funded;
                    attempt.updated_at = now;
                    self.attempts.insert(attempt_id, attempt);
                } else {
                    self.apply_transfer_sent(&mut attempt, now)
                        .unwrap_or_else(|code| env::panic_str(code));
                }
            }
            ReconcileOutcome::Delivered { delivered_amount, dest_tx } => {
                require!(validate::validate_ref(&dest_tx, MAX_TX_REF_LEN), "BAD_DEST_TX");
                require!(delivered_amount <= MAX_AMOUNT, "BAD_AMOUNT");
                if !attempt.transfer_confirmed {
                    self.apply_transfer_sent(&mut attempt, now)
                        .unwrap_or_else(|code| env::panic_str(code));
                }
                if kind == PayoutKind::CrossChain {
                    self.mark_delivered(&mut attempt, delivered_amount, dest_tx, now);
                }
            }
            ReconcileOutcome::SwapFailed => {
                require!(kind == PayoutKind::CrossChain, "NOT_CROSSCHAIN");
                if !attempt.transfer_confirmed {
                    self.apply_transfer_sent(&mut attempt, now)
                        .unwrap_or_else(|code| env::panic_str(code));
                }
                self.mark_swap_failed(&mut attempt, now);
            }
        }
        events::emit("attempt_resolved", json!({ "attempt_id": attempt_id }));
    }

    /// Recognise USDC that arrived by plain transfer: top-ups, refunds and returned change for an
    /// attempt, or unattributed inflow. Never restores budgets (F-02). At most 20 entries.
    #[payable]
    pub fn reconcile_inflows(&mut self, entries: Vec<InflowEntry>) {
        self.assert_owner_call();
        require!(
            !entries.is_empty() && entries.len() <= MAX_RECONCILE_ENTRIES,
            "BAD_ENTRY_COUNT"
        );
        for entry in entries {
            require!(entry.amount > 0 && entry.amount <= MAX_AMOUNT, "BAD_AMOUNT");
            match entry.attribution {
                InflowAttribution::TopUp => ledger_ok(self.ledger.credit(entry.amount, CreditKind::TopUp)),
                InflowAttribution::Unattributed => {
                    ledger_ok(self.ledger.credit(entry.amount, CreditKind::Unattributed))
                }
                InflowAttribution::AttemptReturn { attempt_id } => {
                    let mut attempt = self.load_attempt(attempt_id);
                    require!(attempt.terms.kind == PayoutKind::CrossChain, "NOT_CROSSCHAIN");
                    require!(attempt.transfer_confirmed, "ATTEMPT_FUNDS_NOT_SENT");
                    let total = checked(attempt.returned_amount.checked_add(entry.amount));
                    require!(total <= attempt.terms.amount_in, "RETURN_EXCEEDS_AMOUNT_IN");
                    attempt.returned_amount = total;
                    attempt.updated_at = env::block_timestamp();
                    self.attempts.insert(attempt_id, attempt);
                    ledger_ok(self.ledger.credit(entry.amount, CreditKind::Return));
                }
            }
            events::emit(
                "inflow_reconciled",
                json!({ "amount": entry.amount.to_string(), "attribution": entry.attribution }),
            );
        }
    }

    // ── Assets and suppliers ───────────────────────────────────────────────────────────────────

    #[payable]
    pub fn add_asset(&mut self, asset_id: String, chain: Chain, decimals: u8, max_fixed_fee: U128) {
        self.assert_owner_call();
        validate::validate_asset_id(&asset_id).unwrap_or_else(|code| env::panic_str(code));
        require!(!self.assets.contains_key(&asset_id), "ASSET_EXISTS");
        require!(self.assets.len() < MAX_ASSETS, "TOO_MANY_ASSETS");
        require!(decimals <= 24, "BAD_DECIMALS");
        require!(max_fixed_fee.0 <= MAX_AMOUNT, "BAD_AMOUNT");
        self.assets.insert(
            asset_id.clone(),
            AssetInfo { chain, decimals, max_fixed_fee: max_fixed_fee.0, enabled: true },
        );
        events::emit("asset_added", json!({ "asset_id": asset_id, "chain": chain }));
    }

    #[payable]
    pub fn set_asset(&mut self, asset_id: String, max_fixed_fee: U128, enabled: bool) {
        self.assert_owner_call();
        require!(max_fixed_fee.0 <= MAX_AMOUNT, "BAD_AMOUNT");
        let mut asset = self
            .assets
            .get(&asset_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("UNKNOWN_ASSET"));
        asset.max_fixed_fee = max_fixed_fee.0;
        asset.enabled = enabled;
        self.assets.insert(asset_id.clone(), asset);
        events::emit("asset_updated", json!({ "asset_id": asset_id, "enabled": enabled }));
    }

    /// Add a supplier. It starts unverified, in cooldown (test payments only).
    #[payable]
    pub fn add_supplier(
        &mut self,
        chain: Chain,
        asset_id: String,
        recipient: String,
        per_payment_cap: U128,
        monthly_cap: U128,
    ) -> SupplierId {
        self.assert_owner_call();
        require!(self.suppliers.len() < MAX_SUPPLIERS, "TOO_MANY_SUPPLIERS");
        self.check_destination(chain, &asset_id, &recipient);
        check_caps(per_payment_cap.0, monthly_cap.0);
        let id = self.next_supplier_id;
        self.next_supplier_id += 1;
        let supplier = Supplier {
            id,
            revision: 1,
            chain,
            asset_id,
            recipient,
            per_payment_cap: per_payment_cap.0,
            monthly_cap: monthly_cap.0,
            changed_at: env::block_timestamp(),
            verified: false,
            active: true,
            reserved_out: 0,
            month_out: Default::default(),
            unverified_committed: 0,
        };
        self.suppliers.insert(id, supplier);
        events::emit("supplier_added", json!({ "supplier_id": id, "chain": chain }));
        id
    }

    /// Change a supplier's destination: bumps the revision, restarts the cooldown, clears
    /// verification, and invalidates every open, unfunded intent for it (D-06).
    #[payable]
    pub fn update_supplier(&mut self, supplier_id: SupplierId, chain: Chain, asset_id: String, recipient: String) {
        self.assert_owner_call();
        let now = env::block_timestamp();
        let mut supplier = self.load_supplier(supplier_id);
        self.check_destination(chain, &asset_id, &recipient);

        let open: Vec<IntentId> = self.open_intents.iter().copied().collect();
        let mut invalidated = 0u32;
        for id in open {
            let mut intent = self.load_intent(id);
            if intent.terms.supplier_id != supplier_id
                || !matches!(intent.status, IntentStatus::Pending | IntentStatus::Approved)
            {
                continue;
            }
            self.release_unfunded(&mut intent, Some(&mut supplier), now);
            self.close_intent(&mut intent, IntentStatus::Invalidated, now);
            self.intents.insert(id, intent);
            invalidated += 1;
        }

        supplier.revision = checked(supplier.revision.checked_add(1));
        supplier.chain = chain;
        supplier.asset_id = asset_id;
        supplier.recipient = recipient;
        supplier.changed_at = now;
        supplier.verified = false;
        supplier.unverified_committed = 0;
        let revision = supplier.revision;
        self.suppliers.insert(supplier_id, supplier);
        events::emit(
            "supplier_updated",
            json!({ "supplier_id": supplier_id, "revision": revision, "invalidated_intents": invalidated }),
        );
    }

    /// Change a supplier's caps. Caps are not part of intent terms, so nothing is invalidated.
    #[payable]
    pub fn set_supplier_caps(&mut self, supplier_id: SupplierId, per_payment_cap: U128, monthly_cap: U128) {
        self.assert_owner_call();
        check_caps(per_payment_cap.0, monthly_cap.0);
        let mut supplier = self.load_supplier(supplier_id);
        supplier.per_payment_cap = per_payment_cap.0;
        supplier.monthly_cap = monthly_cap.0;
        self.suppliers.insert(supplier_id, supplier);
        events::emit("supplier_caps_updated", json!({ "supplier_id": supplier_id }));
    }

    /// Mark a supplier verified after it confirmed a test payment over a previously established
    /// channel. Bound to `revision` so a newer destination is never verified by mistake.
    /// Verification does not end the cooldown.
    #[payable]
    pub fn verify_supplier(&mut self, supplier_id: SupplierId, revision: u32) {
        self.assert_owner_call();
        let mut supplier = self.load_supplier(supplier_id);
        require!(supplier.revision == revision, "REVISION_MISMATCH");
        supplier.verified = true;
        self.suppliers.insert(supplier_id, supplier);
        events::emit("supplier_verified", json!({ "supplier_id": supplier_id, "revision": revision }));
    }

    /// Activate or deactivate a supplier. Inactive suppliers get no proposals and no funding.
    #[payable]
    pub fn set_supplier_active(&mut self, supplier_id: SupplierId, active: bool) {
        self.assert_owner_call();
        let mut supplier = self.load_supplier(supplier_id);
        supplier.active = active;
        self.suppliers.insert(supplier_id, supplier);
        events::emit("supplier_active", json!({ "supplier_id": supplier_id, "active": active }));
    }

    // ── Policy and control ─────────────────────────────────────────────────────────────────────

    /// Replace the policy. Refuses a non-zero executor-trust budget while hosted.
    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner_call();
        validate_policy(&policy, self.hosted_mode);
        self.policy = policy;
        events::emit("policy_updated", json!({}));
    }

    /// Switch between hosted (trust budget forced to 0) and self-hosted mode. Entering hosted mode
    /// voids every unfunded attempt authorised under the trust budget (D-19).
    #[payable]
    pub fn set_hosted_mode(&mut self, hosted_mode: bool) {
        self.assert_owner_call();
        self.hosted_mode = hosted_mode;
        let mut voided = 0;
        if hosted_mode {
            self.policy.executor_trust_daily_budget = 0;
            voided = self.void_trust_attempts(env::block_timestamp());
        }
        events::emit("hosted_mode", json!({ "hosted_mode": hosted_mode, "voided_attempts": voided }));
    }

    /// Blocks proposals, approvals, attempt creation and funding. Callbacks, reconciliation,
    /// withdrawals and views keep working; funds already in settlement cannot be recalled.
    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner_call();
        self.paused = true;
        events::emit("paused", json!({}));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_call();
        self.paused = false;
        events::emit("unpaused", json!({}));
    }

    #[payable]
    pub fn rotate_agent(&mut self, new_agent_id: AccountId) {
        self.assert_owner_call();
        self.check_role_account(&new_agent_id);
        require!(new_agent_id != self.executor_id, "ROLES_MUST_DIFFER");
        self.agent_id = new_agent_id.clone();
        events::emit("agent_rotated", json!({ "agent_id": new_agent_id }));
    }

    /// Replace the executor. Unfunded attempts the old executor authorised under the trust budget
    /// are voided: their deposit accounts were chosen by a key the owner no longer trusts (D-19).
    #[payable]
    pub fn rotate_executor(&mut self, new_executor_id: AccountId) {
        self.assert_owner_call();
        self.check_role_account(&new_executor_id);
        require!(new_executor_id != self.agent_id, "ROLES_MUST_DIFFER");
        self.executor_id = new_executor_id.clone();
        let voided = self.void_trust_attempts(env::block_timestamp());
        events::emit(
            "executor_rotated",
            json!({ "executor_id": new_executor_id, "voided_attempts": voided }),
        );
    }

    // ── Withdrawals ────────────────────────────────────────────────────────────────────────────

    /// Withdraw unreserved USDC to the owner. Not blocked by pause: the owner can always exit.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner_call();
        require!(env::prepaid_gas() >= MIN_GAS_FOR_FUNDING, "NOT_ENOUGH_GAS");
        require!(amount.0 > 0, "BAD_AMOUNT");
        ledger_ok(self.ledger.begin_withdraw(amount.0));
        events::emit("withdraw", json!({ "amount": amount.0.to_string() }));
        let args = json!({
            "receiver_id": self.owner_id,
            "amount": amount.0.to_string(),
            "memo": "getleash withdraw",
        });
        Promise::new(self.treasury_token.clone())
            .function_call("ft_transfer", args.to_string().into_bytes(), ONE_YOCTO, GAS_FT_TRANSFER)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_TRANSFER_CALLBACK)
                    .on_withdraw_complete(amount),
            )
    }

    /// Restores `cash` if the withdrawal transfer provably failed. Never panics.
    #[private]
    pub fn on_withdraw_complete(&mut self, amount: U128) {
        if env::promise_results_count() != 1 {
            env::log_str("CALLBACK_UNEXPECTED_RESULTS");
            return;
        }
        if matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed)) {
            match self.ledger.fail_withdraw(amount.0) {
                Ok(()) => events::emit("withdraw_failed", json!({ "amount": amount.0.to_string() })),
                Err(e) => env::log_str(&format!("CALLBACK_DEFERRED:{}", e.code())),
            }
        }
    }

    /// Withdraw NEAR above storage staking and a small reserve.
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.assert_owner_call();
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let free = env::account_balance().saturating_sub(storage).saturating_sub(NEAR_RESERVE);
        require!(amount.0 > 0 && amount.0 <= free.as_yoctonear(), "NOT_ENOUGH_NEAR");
        events::emit("withdraw_near", json!({ "amount": amount.0.to_string() }));
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
}

fn check_caps(per_payment_cap: u128, monthly_cap: u128) {
    require!(
        per_payment_cap > 0 && monthly_cap > 0 && per_payment_cap <= MAX_AMOUNT && monthly_cap <= MAX_AMOUNT,
        "BAD_CAPS"
    );
}

impl Contract {
    /// The asset must exist on the supplier's chain, and the recipient must be valid for it. A NEAR
    /// recipient may not be this contract, the treasury token, the agent or the executor.
    fn check_destination(&self, chain: Chain, asset_id: &str, recipient: &str) {
        let asset = self
            .assets
            .get(asset_id)
            .unwrap_or_else(|| env::panic_str("UNKNOWN_ASSET"));
        require!(asset.chain == chain, "ASSET_CHAIN_MISMATCH");
        validate::validate_recipient(chain, recipient).unwrap_or_else(|code| env::panic_str(code));
        if chain == Chain::Near {
            let blocked = [
                env::current_account_id(),
                self.treasury_token.clone(),
                self.agent_id.clone(),
                self.executor_id.clone(),
            ];
            require!(blocked.iter().all(|a| a.as_str() != recipient), "BAD_RECIPIENT");
        }
    }

    fn check_role_account(&self, account: &AccountId) {
        require!(
            *account != self.owner_id
                && *account != env::current_account_id()
                && *account != self.treasury_token,
            "BAD_ROLE_ACCOUNT"
        );
    }

    /// Owner-resolved swap failure: the deposit left but delivery failed. The money is out of
    /// flight (it comes back through `reconcile_inflows`); the charge stays (F-02). The intent is
    /// re-reserved for a retry if the rules still allow it, otherwise it needs approval again.
    fn mark_swap_failed(&mut self, attempt: &mut Attempt, now: u64) {
        let mut intent = self.load_intent(attempt.terms.intent_id);
        ledger_ok(self.ledger.land(attempt.terms.amount_in));
        attempt.status = AttemptStatus::SwapFailed;
        attempt.updated_at = now;
        intent.live_attempt = None;
        intent.updated_at = now;
        match self.suppliers.get(&intent.terms.supplier_id).cloned() {
            Some(mut supplier) if supplier.revision == intent.terms.supplier_revision => {
                intent.status = IntentStatus::Pending;
                intent.approved_at = None;
                if self.commit_approval(&mut intent, &mut supplier, now).is_ok() {
                    self.suppliers.insert(supplier.id, supplier);
                }
            }
            _ => {
                intent.status = IntentStatus::Pending;
                self.close_intent(&mut intent, IntentStatus::Invalidated, now);
            }
        }
        events::emit(
            "attempt_swap_failed",
            json!({ "attempt_id": attempt.terms.id, "intent_status": intent.status }),
        );
        self.attempts.insert(attempt.terms.id, attempt.clone());
        self.intents.insert(intent.terms.id, intent);
    }

    /// Voids every unfunded attempt authorised under the executor-trust budget. Bounded by the
    /// open-intent cap. Returns how many were voided.
    fn void_trust_attempts(&mut self, now: u64) -> u32 {
        let open: Vec<IntentId> = self.open_intents.iter().copied().collect();
        let mut voided = 0;
        for id in open {
            let mut intent = self.load_intent(id);
            let Some(attempt_id) = intent.live_attempt else { continue };
            let mut attempt = self.load_attempt(attempt_id);
            if attempt.authorization == AttemptAuth::TrustBudget && attempt.status == AttemptStatus::Authorized {
                self.void_attempt(&mut attempt, now);
                self.attempts.insert(attempt_id, attempt);
                intent.live_attempt = None;
                intent.updated_at = now;
                self.intents.insert(id, intent);
                voided += 1;
            }
        }
        voided
    }

    /// Sums used in views.
    pub(crate) fn period_now(&self) -> Period {
        Period::at(env::block_timestamp())
    }
}
