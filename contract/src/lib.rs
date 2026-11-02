//! GetLeash policy contract, v2 ("lean", docs/decisions.md D-28).
//!
//! One business's treasury. An AI agent proposes payments; the contract decides within the owner's
//! rules; native payouts are sent in the call that approves them; cross-chain payouts are funded
//! by an executor only to a 1Click deposit the owner signed for or that fits the executor-trust
//! budget. The contract account has no access keys; code changes only through the owner-signed
//! `upgrade`. Bookkeeping that v1 kept on-chain (ledger, reconciliation, listings) is off-chain.
//!
//! Module map:
//! - `budget`, `rules` pure arithmetic and the routing rule (no `env`), property-tested
//! - `agent`    `propose`
//! - `executor` `create_attempt`, `fund`, `forget`
//! - `owner`    decisions, authorizations, suppliers, policy, pause, roles, withdrawals
//! - `views`    `get_state`, `get_suppliers`, `get_intents` (Borsh)

pub mod budget;
pub mod events;
pub mod json;
pub mod rules;
pub mod types;
pub mod validate;

mod agent;
mod executor;
mod owner;
mod views;

#[cfg(test)]
mod tests;

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, assert_one_yocto, env, near,
    require,
};

use crate::budget::{day_of, fits, min_in};
use crate::events::{Event, status_code};
use crate::rules::in_cooldown;
use crate::types::*;
use crate::validate::{ft_transfer_args, storage_deposit_args, to_hex};

pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub(crate) const GAS_ON_PAID: Gas = Gas::from_tgas(10);
pub(crate) const GAS_MIGRATE: Gas = Gas::from_tgas(50);
/// A payout must leave room for the method, the token calls and the callback.
pub(crate) const MIN_GAS_FOR_PAYOUT: Gas = Gas::from_tgas(60);
pub(crate) const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// USDC on NEAR: `storage_balance_bounds` min = max = 0.00125 NEAR (docs/verified-facts.md).
pub(crate) const FT_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEAR kept back from `withdraw_near` beyond storage staking, for gas and new records.
pub(crate) const NEAR_RESERVE: NearToken = NearToken::from_millinear(50);
pub(crate) const HOUR: u64 = 3_600_000_000_000;
pub(crate) const DAY: u64 = 24 * HOUR;
/// Obligation value meaning "rejected, and the intent has since been forgotten".
pub(crate) const REJECTED_OBLIGATION: IntentId = IntentId::MAX;
/// Largest review flag (1 ADDRESS_MISMATCH, 2 UNCERTAIN_MATCH, 3 AMBIGUOUS_EXTRACTION,
/// 4 UNUSUAL_AMOUNT; 0 = none).
pub(crate) const MAX_FLAG: u8 = 4;

// Storage key prefixes of the records kept outside the root state. Never reuse a prefix.
const P_SUPPLIER: u8 = b's';
const P_INTENT: u8 = b'i';
const P_OBLIGATION: u8 = b'o';

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    agent_id: AccountId,
    executor_id: AccountId,
    /// NEP-141 treasury token (USDC).
    token_id: AccountId,
    token_decimals: u8,
    paused: bool,
    /// Bumped whenever the executor changes; trust-funded attempts of an old executor are void.
    executor_epoch: u32,
    policy: Policy,
    budgets: Budgets,
    next_supplier_id: SupplierId,
    next_intent_id: IntentId,
    stored_intents: u32,
    /// Payouts sent whose callback has not been seen (upgrades wait for zero).
    paying: u32,
}

#[near]
impl Contract {
    /// Initialise the treasury. Called in the owner's setup batch (CreateAccount, Transfer,
    /// DeployContract, `new`), so the account never has an access key (D-11). JSON arguments:
    /// `owner_id`, `agent_id`, `executor_id`, `token_id`, `token_decimals` and the policy fields.
    #[init]
    pub fn new() -> Self {
        let input = json::input();
        let mut a = json::Args::parse(&input);
        let owner_id = a.account("owner_id");
        let agent_id = a.account("agent_id");
        let executor_id = a.account("executor_id");
        let token_id = a.account("token_id");
        let token_decimals = a.u8("token_decimals");
        let policy = Policy::from_args(&mut a);
        a.done();
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(caller == owner_id || caller == me, "INIT_ONLY_BY_OWNER");
        require!(
            owner_id != agent_id && owner_id != executor_id && agent_id != executor_id,
            "ROLES_MUST_DIFFER"
        );
        require!(
            owner_id != me && agent_id != me && executor_id != me && token_id != me,
            "ROLE_IS_CONTRACT"
        );
        require!(
            token_id != owner_id && token_id != agent_id && token_id != executor_id,
            "ROLE_IS_TOKEN"
        );
        require!(token_decimals <= 24, "BAD_DECIMALS");
        validate_policy(&policy);
        Event::new()
            .text("owner_id", owner_id.as_str())
            .text("token_id", token_id.as_str())
            .emit("initialized");
        Self {
            owner_id,
            agent_id,
            executor_id,
            token_id,
            token_decimals,
            paused: false,
            executor_epoch: 0,
            policy,
            budgets: Budgets::default(),
            next_supplier_id: 1,
            next_intent_id: 1,
            stored_intents: 0,
            paying: 0,
        }
    }

    /// Owner-only code upgrade; the transaction's raw input is the new wasm. Refused while a
    /// payout's callback is outstanding, so no callback ever meets code it was not sent by. The
    /// deploy and `migrate` share one receipt, so a failed migration also reverts the deploy.
    #[payable]
    pub fn upgrade(&mut self) {
        self.assert_owner_call();
        require!(self.paying == 0, "PAYOUTS_IN_FLIGHT");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "NO_CODE");
        Event::new()
            .text("code_sha256", &to_hex(&env::sha256_array(&code)))
            .emit("upgrade");
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate", Vec::new(), NearToken::from_near(0), GAS_MIGRATE)
            .detach();
    }

    /// Runs after `upgrade` deploys new code. The state layout is unchanged in 2.0.0.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let state: Contract = env::state_read().unwrap_or_else(|| env::panic_str("NO_STATE"));
        Event::new()
            .text("version", env!("CARGO_PKG_VERSION"))
            .emit("migrated");
        state
    }

    /// Transfer callback, bound to the intent and the moment its payout started. Never panics; a
    /// no-op unless that payout is still the one in flight. Its arguments must never change
    /// across upgrades.
    #[private]
    pub fn on_paid(
        &mut self,
        #[serializer(borsh)] intent_id: IntentId,
        #[serializer(borsh)] since: u64,
    ) {
        let key = intent_key(intent_id);
        let Some(mut intent) = read::<Intent>(&key) else {
            env::log_str("CALLBACK_UNKNOWN_INTENT");
            return;
        };
        if intent.status != Status::Paying || intent.since != since {
            env::log_str("CALLBACK_STALE");
            return;
        }
        if env::promise_results_count() != 1 {
            env::log_str("CALLBACK_UNEXPECTED_RESULTS");
            return;
        }
        // Only an explicit failure means the tokens did not move (D-10).
        let sent = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        intent.status = if sent { Status::Paid } else { Status::Failed };
        intent.since = env::block_timestamp();
        match self.paying.checked_sub(1) {
            Some(n) => self.paying = n,
            None => env::log_str("PAYING_COUNTER"),
        }
        // Same width as before: this write never needs more storage.
        write(&key, &intent);
        Event::new()
            .num("intent_id", intent_id.into())
            .text("status", status_code(intent.status))
            .emit("payout");
    }
}

/// Validates a policy; panics with a code on the first problem.
pub(crate) fn validate_policy(p: &Policy) {
    let amounts = [
        p.autonomous_daily_budget,
        p.approval_threshold,
        p.daily_cap,
        p.executor_trust_daily_budget,
        p.cooldown_max,
        p.max_fixed_fee,
    ];
    require!(
        amounts.iter().all(|a| *a <= MAX_AMOUNT),
        "POLICY_AMOUNT_TOO_LARGE"
    );
    require!(
        p.autonomous_daily_budget <= p.daily_cap
            && p.executor_trust_daily_budget <= p.daily_cap
            && p.cooldown_max <= p.daily_cap
            && p.max_fixed_fee <= p.daily_cap,
        "POLICY_ABOVE_DAILY_CAP"
    );
    require!(p.max_fee_bps <= 5_000, "POLICY_FEE_BPS");
    require!(p.cooldown_ns <= 90 * DAY, "POLICY_COOLDOWN");
    require!(
        p.intent_ttl_ns >= HOUR && p.intent_ttl_ns <= 30 * DAY,
        "POLICY_INTENT_TTL"
    );
    require!(
        p.funding_margin_ns <= p.quote_min_validity_ns,
        "POLICY_QUOTE_MARGINS"
    );
    require!(p.quote_min_validity_ns <= DAY, "POLICY_QUOTE_VALIDITY");
    require!(
        p.callback_grace_ns >= HOUR && p.callback_grace_ns <= 30 * DAY,
        "POLICY_CALLBACK_GRACE"
    );
    require!(
        p.retention_ns >= DAY && p.retention_ns <= 365 * DAY,
        "POLICY_RETENTION"
    );
    require!(
        p.max_proposals_per_day >= 1 && p.max_proposals_per_day <= HARD_MAX_PROPOSALS_PER_DAY,
        "POLICY_MAX_PROPOSALS"
    );
}

// ── Raw storage for records outside the root state ─────────────────────────────────────────────

pub(crate) fn supplier_key(id: SupplierId) -> [u8; 5] {
    let mut k = [P_SUPPLIER; 5];
    k[1..].copy_from_slice(&id.to_le_bytes());
    k
}

pub(crate) fn intent_key(id: IntentId) -> [u8; 9] {
    let mut k = [P_INTENT; 9];
    k[1..].copy_from_slice(&id.to_le_bytes());
    k
}

pub(crate) fn obligation_key(obligation: &Hash32) -> [u8; 33] {
    let mut k = [P_OBLIGATION; 33];
    k[1..].copy_from_slice(obligation);
    k
}

pub(crate) fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    let bytes = env::storage_read(key)?;
    Some(T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("CORRUPT_STATE")))
}

pub(crate) fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    let bytes = borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("SERIALIZE"));
    env::storage_write(key, &bytes);
}

/// Unwraps checked arithmetic in a method that may panic.
pub(crate) fn checked<T>(value: Option<T>) -> T {
    value.unwrap_or_else(|| env::panic_str("ARITHMETIC"))
}

/// Internal helpers shared by the method modules.
impl Contract {
    pub(crate) fn assert_owner_call(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        assert_one_yocto();
    }

    /// The executor (function-call key, no deposit) or the owner (1 yocto).
    pub(crate) fn assert_executor_or_owner(&self) {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            assert_one_yocto();
        } else {
            require!(caller == self.executor_id, "ONLY_EXECUTOR_OR_OWNER");
        }
    }

    pub(crate) fn load_supplier(&self, id: SupplierId) -> Supplier {
        read(&supplier_key(id)).unwrap_or_else(|| env::panic_str("UNKNOWN_SUPPLIER"))
    }

    pub(crate) fn load_intent(&self, id: IntentId) -> Intent {
        read(&intent_key(id)).unwrap_or_else(|| env::panic_str("UNKNOWN_INTENT"))
    }

    /// Native = paid in the treasury token itself to a NEAR account: `nep141:<token>` on NEAR.
    pub(crate) fn is_native(&self, supplier: &Supplier) -> bool {
        let token = self.token_id.as_str();
        supplier.chain == Chain::Near
            && supplier.asset_id.len() == 7 + token.len()
            && supplier.asset_id.starts_with("nep141:")
            && &supplier.asset_id[7..] == token
    }

    /// Not this contract, the token, or a role: money must never be sent to those.
    pub(crate) fn is_outside_account(&self, account: &str) -> bool {
        account != env::current_account_id().as_str()
            && account != self.token_id.as_str()
            && account != self.owner_id.as_str()
            && account != self.agent_id.as_str()
            && account != self.executor_id.as_str()
    }

    pub(crate) fn in_cooldown(&self, supplier: &Supplier, now: u64) -> bool {
        in_cooldown(supplier.changed_at, self.policy.cooldown_ns, now)
    }

    pub(crate) fn expired(&self, intent: &Intent, now: u64) -> bool {
        now > intent.since.saturating_add(self.policy.intent_ttl_ns)
    }

    /// Every payout goes through here (AGENTS.md): all checks, then state, then the transfer.
    /// Writes the intent as `Paying`; the caller must not write it again.
    pub(crate) fn start_payout(
        &mut self,
        intent_id: IntentId,
        intent: &mut Intent,
        supplier: &Supplier,
        now: u64,
    ) {
        require!(!self.paused, "PAUSED");
        require!(supplier.active, "INACTIVE_SUPPLIER");
        require!(supplier.revision == intent.revision, "SUPPLIER_CHANGED");
        require!(!self.expired(intent, now), "INTENT_EXPIRED");
        require!(
            read::<IntentId>(&obligation_key(&intent.obligation)) == Some(intent_id),
            "OBLIGATION_MISMATCH"
        );
        require!(env::prepaid_gas() >= MIN_GAS_FOR_PAYOUT, "NOT_ENOUGH_GAS");
        let mut b = self.budgets.at(day_of(now));
        let native = self.is_native(supplier);
        let (receiver, amount) = if native {
            // Native suppliers use the token's decimals, so value == amount_out is what is sent.
            (supplier.recipient.clone(), intent.value)
        } else {
            let a = intent
                .attempt
                .as_ref()
                .unwrap_or_else(|| env::panic_str("NO_ATTEMPT"));
            require!(
                now.saturating_add(self.policy.funding_margin_ns) <= a.deadline,
                "QUOTE_TOO_CLOSE_TO_DEADLINE"
            );
            require!(
                a.amount_in <= intent.max_in
                    && a.amount_in >= min_in(intent.value, self.policy.max_fee_bps),
                "FEE_BOUND"
            );
            if !a.authorized {
                require!(a.epoch == self.executor_epoch, "STALE_EXECUTOR_EPOCH");
                require!(!self.in_cooldown(supplier, now), "COOLDOWN_NEEDS_OWNER");
                require!(
                    fits(
                        b.trust,
                        a.amount_in,
                        self.policy.executor_trust_daily_budget
                    ),
                    "OVER_TRUST_BUDGET"
                );
                b.trust = checked(b.trust.checked_add(a.amount_in));
            }
            (to_hex(&a.deposit), a.amount_in)
        };
        require!(
            fits(b.outflow, amount, self.policy.daily_cap),
            "OVER_DAILY_CAP"
        );
        b.outflow = checked(b.outflow.checked_add(amount));
        self.budgets = b;
        self.paying = checked(self.paying.checked_add(1));
        intent.status = Status::Paying;
        intent.since = now;
        write(&intent_key(intent_id), intent);
        Event::new()
            .num("intent_id", intent_id.into())
            .text("to", &receiver)
            .amount("amount", amount)
            .emit("paying");

        let mut transfer = Promise::new(self.token_id.clone());
        if !native {
            // One receipt: if the transfer fails, the registration is undone and refunded too.
            transfer = transfer.function_call(
                "storage_deposit",
                storage_deposit_args(&receiver),
                FT_STORAGE_DEPOSIT,
                GAS_STORAGE_DEPOSIT,
            );
        }
        transfer
            .function_call(
                "ft_transfer",
                ft_transfer_args(&receiver, amount),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAID)
                    .on_paid(intent_id, now),
            )
            .detach();
    }
}
