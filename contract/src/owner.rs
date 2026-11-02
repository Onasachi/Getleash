//! Owner methods. Every one needs the owner's account and exactly 1 yoctoNEAR, which only a
//! full-access key can attach, and both are checked before the arguments are read. Arguments are
//! flat JSON, parsed strictly by `json.rs`, so the owner's wallet shows exactly what is signed.

use near_sdk::{AccountId, NearToken, Promise, env, near, require};

use crate::events::{Event, status_code};
use crate::json::{self, Args};
use crate::types::*;
use crate::validate::{ft_transfer_args, is_tron_format, parse_hex32, valid_asset_id};
use crate::*;

#[near]
impl Contract {
    // ── Intents ────────────────────────────────────────────────────────────────────────────────

    /// `{intent_id, action, amount_out, supplier_id}`: the owner's decision on one intent.
    /// `amount_out` and `supplier_id` must repeat the intent's terms, so what the wallet shows
    /// is what is approved.
    /// - APPROVE a pending intent (a native one is paid in this call);
    /// - REJECT a pending or approved-unfunded one (its invoice stays blocked, D-07);
    /// - RETRY a failed one, or a cross-chain one the swap refunded (budgets are charged again);
    /// - MARK_PAID / MARK_FAILED a payout whose callback has not come back within the grace time.
    #[payable]
    pub fn decide(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let intent_id = a.u64("intent_id");
        let action = Action::parse(a.str("action"));
        let amount_out = a.u128("amount_out");
        let supplier_id = a.u32("supplier_id");
        a.done();

        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(
            intent.amount_out == amount_out && intent.supplier_id == supplier_id,
            "TERMS_MISMATCH"
        );
        match action {
            Action::Approve => {
                require!(intent.status == Status::Pending, "NOT_PENDING");
                require!(!self.expired(&intent, now), "INTENT_EXPIRED");
                let supplier = self.load_supplier(intent.supplier_id);
                self.check_owner_payable(&intent, &supplier, now);
                if self.is_native(&supplier) {
                    self.start_payout(intent_id, &mut intent, &supplier, now);
                } else {
                    intent.status = Status::Approved;
                    intent.since = now;
                    write(&intent_key(intent_id), &intent);
                }
            }
            Action::Reject => {
                require!(
                    matches!(intent.status, Status::Pending | Status::Approved),
                    "NOT_REJECTABLE"
                );
                intent.status = Status::Rejected;
                intent.since = now;
                write(&intent_key(intent_id), &intent);
            }
            Action::Retry => {
                let supplier = self.load_supplier(intent.supplier_id);
                let native = self.is_native(&supplier);
                require!(
                    intent.status == Status::Failed || (intent.status == Status::Paid && !native),
                    "NOT_RETRYABLE"
                );
                self.check_owner_payable(&intent, &supplier, now);
                intent.since = now;
                if native {
                    self.start_payout(intent_id, &mut intent, &supplier, now);
                } else {
                    intent.status = Status::Approved;
                    intent.attempt = None;
                    write(&intent_key(intent_id), &intent);
                }
            }
            Action::MarkPaid | Action::MarkFailed => {
                require!(
                    intent.status == Status::Paying
                        && now >= intent.since.saturating_add(self.policy.callback_grace_ns),
                    "NOT_STUCK"
                );
                intent.status = if action == Action::MarkPaid {
                    Status::Paid
                } else {
                    Status::Failed
                };
                intent.since = now;
                self.paying = checked(self.paying.checked_sub(1));
                write(&intent_key(intent_id), &intent);
            }
        }
        Event::new()
            .num("intent_id", intent_id.into())
            .text("status", status_code(intent.status))
            .emit("intent_decided");
    }

    /// `{intent_id, deposit, amount_in}`: signs for exactly this 1Click deposit and amount on an
    /// approved cross-chain intent. If the executor re-quoted since the owner looked, the terms
    /// differ and this fails.
    #[payable]
    pub fn authorize(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let intent_id = a.u64("intent_id");
        let deposit =
            parse_hex32(a.str("deposit")).unwrap_or_else(|| env::panic_str("BAD_DEPOSIT"));
        let amount_in = a.u128("amount_in");
        a.done();

        require!(!self.paused, "PAUSED");
        let now = env::block_timestamp();
        let mut intent = self.load_intent(intent_id);
        require!(intent.status == Status::Approved, "INTENT_NOT_APPROVED");
        let margin = self.policy.funding_margin_ns;
        let attempt = intent
            .attempt
            .as_mut()
            .unwrap_or_else(|| env::panic_str("NO_ATTEMPT"));
        require!(
            attempt.deposit == deposit && attempt.amount_in == amount_in,
            "TERMS_MISMATCH"
        );
        require!(
            now.saturating_add(margin) <= attempt.deadline,
            "QUOTE_TOO_CLOSE_TO_DEADLINE"
        );
        attempt.authorized = true;
        write(&intent_key(intent_id), &intent);
        Event::new()
            .num("intent_id", intent_id.into())
            .emit("attempt_authorized");
    }

    // ── Suppliers ──────────────────────────────────────────────────────────────────────────────

    /// `{chain, asset_id, recipient, decimals}`: adds a supplier; its cooldown starts now.
    /// Returns the id (Borsh u32).
    #[payable]
    #[result_serializer(borsh)]
    pub fn add_supplier(&mut self) -> SupplierId {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let supplier = self.supplier_from(&mut a, 1);
        a.done();
        let id = self.next_supplier_id;
        self.next_supplier_id = checked(id.checked_add(1));
        write(&supplier_key(id), &supplier);
        Event::new()
            .num("supplier_id", id.into())
            .num("revision", 1)
            .emit("supplier_added");
        id
    }

    /// `{supplier_id, chain, asset_id, recipient, decimals}`: changes where a supplier is paid.
    /// Bumps the revision (open intents for the old terms can no longer pay) and restarts the
    /// cooldown.
    #[payable]
    pub fn update_supplier(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let supplier_id = a.u32("supplier_id");
        let old = self.load_supplier(supplier_id);
        let mut supplier = self.supplier_from(&mut a, checked(old.revision.checked_add(1)));
        a.done();
        supplier.active = old.active;
        write(&supplier_key(supplier_id), &supplier);
        Event::new()
            .num("supplier_id", supplier_id.into())
            .num("revision", supplier.revision.into())
            .emit("supplier_updated");
    }

    /// `{supplier_id, active}`.
    #[payable]
    pub fn set_supplier_active(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let supplier_id = a.u32("supplier_id");
        let active = a.bool("active");
        a.done();
        let mut supplier = self.load_supplier(supplier_id);
        supplier.active = active;
        write(&supplier_key(supplier_id), &supplier);
        Event::new()
            .num("supplier_id", supplier_id.into())
            .num("active", active.into())
            .emit("supplier_active");
    }

    // ── Policy, pause, roles ───────────────────────────────────────────────────────────────────

    /// The policy's fields, flat (see `Policy`).
    #[payable]
    pub fn set_policy(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let policy = Policy::from_args(&mut a);
        a.done();
        validate_policy(&policy);
        self.policy = policy;
        Event::new().emit("policy_updated");
    }

    /// `{paused}`.
    #[payable]
    pub fn set_paused(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let paused = a.bool("paused");
        a.done();
        self.paused = paused;
        Event::new().num("paused", paused.into()).emit("paused");
    }

    /// `{agent_id, executor_id}`: replaces the agent and/or executor. A new executor bumps the
    /// epoch, so attempts the old one created can no longer be funded from the trust budget
    /// (D-19).
    #[payable]
    pub fn set_roles(&mut self) {
        self.assert_owner_call();
        let input = json::input();
        let mut a = Args::parse(&input);
        let agent_id = a.account("agent_id");
        let executor_id = a.account("executor_id");
        a.done();
        require!(
            agent_id != executor_id && agent_id != self.owner_id && executor_id != self.owner_id,
            "ROLES_MUST_DIFFER"
        );
        let me = env::current_account_id();
        require!(
            agent_id != me
                && executor_id != me
                && agent_id != self.token_id
                && executor_id != self.token_id,
            "BAD_ROLE"
        );
        if executor_id != self.executor_id {
            self.executor_epoch = checked(self.executor_epoch.checked_add(1));
        }
        self.agent_id = agent_id;
        self.executor_id = executor_id;
        Event::new()
            .text("agent_id", self.agent_id.as_str())
            .text("executor_id", self.executor_id.as_str())
            .num("executor_epoch", self.executor_epoch.into())
            .emit("roles_updated");
    }

    // ── Withdrawals (not blocked by pause: the owner can always take the money back) ────────────

    /// `{amount}` of the treasury token to the owner.
    #[payable]
    pub fn withdraw(&mut self) {
        self.assert_owner_call();
        let amount = Self::amount_arg();
        Event::new().amount("amount", amount).emit("withdraw");
        Promise::new(self.token_id.clone())
            .function_call(
                "ft_transfer",
                ft_transfer_args(self.owner_id.as_str(), amount),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .detach();
    }

    /// `{amount}` of NEAR above storage staking and a small reserve.
    #[payable]
    pub fn withdraw_near(&mut self) {
        self.assert_owner_call();
        let amount = Self::amount_arg();
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let free = env::account_balance()
            .saturating_sub(storage)
            .saturating_sub(NEAR_RESERVE);
        require!(amount <= free.as_yoctonear(), "NOT_ENOUGH_NEAR");
        Event::new().amount("amount", amount).emit("withdraw_near");
        Promise::new(self.owner_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}

impl Contract {
    fn amount_arg() -> u128 {
        let input = json::input();
        let mut a = Args::parse(&input);
        let amount = a.u128("amount");
        a.done();
        require!(amount > 0, "BAD_AMOUNT");
        amount
    }

    /// APPROVE and RETRY: not paused, supplier active at the intent's revision, and during the
    /// cooldown at most `cooldown_max` (a test payment), even for the owner.
    fn check_owner_payable(&self, intent: &Intent, supplier: &Supplier, now: u64) {
        require!(!self.paused, "PAUSED");
        require!(supplier.active, "INACTIVE_SUPPLIER");
        require!(supplier.revision == intent.revision, "SUPPLIER_CHANGED");
        if self.in_cooldown(supplier, now) {
            require!(
                intent.value <= self.policy.cooldown_max,
                "OVER_COOLDOWN_MAX"
            );
        }
    }

    /// Reads and checks a destination: NEAR suppliers get a real account that is not this
    /// contract, the token or a role; Tron suppliers a Tron-shaped address; native suppliers use
    /// the token's decimals, so the amount counted is the amount sent.
    fn supplier_from(&self, a: &mut Args, revision: u32) -> Supplier {
        let s = Supplier {
            chain: Chain::parse(a.str("chain")),
            asset_id: a.string("asset_id"),
            recipient: a.string("recipient"),
            decimals: a.u8("decimals"),
            active: true,
            revision,
            changed_at: env::block_timestamp(),
        };
        require!(valid_asset_id(&s.asset_id), "BAD_ASSET_ID");
        require!(s.decimals <= 24, "BAD_DECIMALS");
        match s.chain {
            Chain::Near => {
                let ok = s.recipient.parse::<AccountId>().is_ok()
                    && self.is_outside_account(&s.recipient);
                require!(ok, "BAD_NEAR_RECIPIENT");
                if self.is_native(&s) {
                    require!(s.decimals == self.token_decimals, "NATIVE_DECIMALS");
                }
            }
            Chain::Tron => require!(is_tron_format(&s.recipient), "BAD_TRON_RECIPIENT"),
        }
        s
    }
}
