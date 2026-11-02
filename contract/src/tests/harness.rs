//! A small simulated chain for unit and property tests.
//!
//! `World::call` runs one method as one receipt: the contract is read from mocked storage, the
//! method runs inside `catch_unwind`, and the state is written back only if it returned. On a panic
//! the in-memory contract is forgotten without flushing, which mirrors how NEAR reverts a failed
//! receipt. Outgoing `ft_transfer` promises are recorded so tests can check every debit.

use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, Gas, NearToken, PromiseResult};

use crate::types::*;
use crate::Contract;

thread_local! {
    /// Set while a simulated receipt runs, so expected panics do not flood the test output.
    static QUIET: Cell<bool> = const { Cell::new(false) };
}
static HOOK: Once = Once::new();

/// Installs (once) a panic hook that stays silent for panics inside `World::call` on this thread
/// and behaves normally everywhere else, so real test failures still print.
fn install_quiet_hook() {
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if !QUIET.with(|q| q.get()) {
                eprintln!("{info}");
            }
        }));
    });
}

/// 2026-11-01T00:00:00Z
pub const NOV_1_2026: u64 = 1_793_491_200 * 1_000_000_000;
pub const SECOND: u64 = 1_000_000_000;
pub const MINUTE: u64 = 60 * SECOND;
pub const HOUR: u64 = 60 * MINUTE;
pub const DAY: u64 = 24 * HOUR;
pub const USDC: u128 = 1_000_000;
pub const TRON_USDT: &str = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
pub const TRON_RECIPIENT: &str = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
pub const TRON_RECIPIENT_2: &str = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

pub fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub fn contract_id() -> AccountId {
    acc("getleash.biz.near")
}
pub fn owner() -> AccountId {
    acc("biz.near")
}
pub fn agent() -> AccountId {
    acc("agent-1.biz.near")
}
pub fn executor() -> AccountId {
    acc("executor-1.biz.near")
}
pub fn usdc() -> AccountId {
    acc("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")
}
pub fn stranger() -> AccountId {
    acc("mallory.near")
}
pub fn usdc_asset() -> String {
    format!("nep141:{}", usdc())
}

pub fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}
pub fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}

/// An `ft_transfer` the contract asked the treasury token to make.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Debit {
    pub receiver: AccountId,
    pub amount: u128,
    pub memo: Option<String>,
    /// Attempt id passed to the `on_transfer_complete` callback in the same batch, if any.
    pub callback_attempt: Option<AttemptId>,
    /// Amount passed to `on_withdraw_complete`, if this was a withdrawal.
    pub callback_withdraw: Option<u128>,
}

pub struct World {
    pub now: u64,
    /// Every debit ever requested, in order.
    pub debits: Vec<Debit>,
    /// Storage registrations requested (`storage_deposit` receipts).
    pub registrations: Vec<AccountId>,
}

impl World {
    pub fn new(policy: Option<Policy>, hosted_mode: bool) -> Self {
        let world = World { now: NOV_1_2026, debits: Vec::new(), registrations: Vec::new() };
        // `testing_env!` carries storage over, and proptest runs many worlds on one thread:
        // start every world from empty storage.
        near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            world.context(&owner(), zero()),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Vec::new(),
            Default::default(),
            Default::default(),
            None,
        ));
        let contract = Contract::new(owner(), agent(), executor(), usdc(), 6, hosted_mode, policy);
        env::state_write(&contract);
        drop(contract);
        world
    }

    fn context(&self, caller: &AccountId, deposit: NearToken) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(caller.clone())
            .predecessor_account_id(caller.clone())
            .block_timestamp(self.now)
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(20))
            .build()
    }

    fn set_context(&self, caller: &AccountId, deposit: NearToken, results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(caller.clone())
            .predecessor_account_id(caller.clone())
            .block_timestamp(self.now)
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(20))
            .build();
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    /// Runs `f` as one receipt from `caller` with `deposit` attached and `results` as the promise
    /// results visible to a callback. Returns the panic message on failure (state unchanged).
    pub fn call<R>(
        &mut self,
        caller: &AccountId,
        deposit: NearToken,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        self.set_context(caller, deposit, results);
        let mut contract: Contract = env::state_read().expect("contract state");
        install_quiet_hook();
        QUIET.with(|q| q.set(true));
        let outcome = catch_unwind(AssertUnwindSafe(|| f(&mut contract)));
        QUIET.with(|q| q.set(false));
        match outcome {
            Ok(value) => {
                env::state_write(&contract);
                drop(contract); // flushes collection caches
                self.record_receipts();
                Ok(value)
            }
            Err(payload) => {
                std::mem::forget(contract); // a failed receipt writes nothing
                Err(panic_message(payload))
            }
        }
    }

    /// Read-only access (a view call).
    pub fn view<R>(&mut self, f: impl FnOnce(&Contract) -> R) -> R {
        self.set_context(&stranger(), zero(), Vec::new());
        let contract: Contract = env::state_read().expect("contract state");
        let value = f(&contract);
        std::mem::forget(contract);
        value
    }

    pub fn advance(&mut self, ns: u64) {
        self.now += ns;
    }

    // ── Role shorthands ────────────────────────────────────────────────────────────────────────

    pub fn owner<R>(&mut self, f: impl FnOnce(&mut Contract) -> R) -> Result<R, String> {
        self.call(&owner(), one_yocto(), Vec::new(), f)
    }

    pub fn agent<R>(&mut self, f: impl FnOnce(&mut Contract) -> R) -> Result<R, String> {
        self.call(&agent(), zero(), Vec::new(), f)
    }

    pub fn executor<R>(&mut self, f: impl FnOnce(&mut Contract) -> R) -> Result<R, String> {
        self.call(&executor(), zero(), Vec::new(), f)
    }

    /// Delivers the transfer callback for `attempt_id` with the given outcome.
    pub fn transfer_callback(&mut self, attempt_id: AttemptId, ok: bool) -> Result<(), String> {
        let result = if ok { PromiseResult::Successful(Vec::new()) } else { PromiseResult::Failed };
        self.call(&contract_id(), zero(), vec![result], |c| c.on_transfer_complete(attempt_id))
    }

    pub fn withdraw_callback(&mut self, amount: u128, ok: bool) -> Result<(), String> {
        let result = if ok { PromiseResult::Successful(Vec::new()) } else { PromiseResult::Failed };
        self.call(&contract_id(), zero(), vec![result], |c| c.on_withdraw_complete(U128(amount)))
    }

    /// Simulates a top-up through `ft_transfer_call` on the treasury token.
    pub fn top_up(&mut self, amount: u128) -> Result<U128, String> {
        self.call(&usdc(), zero(), Vec::new(), |c| {
            c.ft_on_transfer(owner(), U128(amount), String::new())
        })
    }

    // ── Common setup ───────────────────────────────────────────────────────────────────────────

    pub fn add_tron_asset(&mut self, max_fixed_fee: u128) {
        self.owner(|c| c.add_asset(TRON_USDT.to_string(), Chain::Tron, 6, U128(max_fixed_fee)))
            .unwrap();
    }

    pub fn add_supplier(&mut self, chain: Chain, asset: &str, recipient: &str, cap: u128, monthly: u128) -> SupplierId {
        let asset = asset.to_string();
        let recipient = recipient.to_string();
        self.owner(|c| c.add_supplier(chain, asset, recipient, U128(cap), U128(monthly)))
            .unwrap()
    }

    /// Verify a supplier at its current revision.
    pub fn verify(&mut self, supplier_id: SupplierId) {
        let revision = self.view(|c| c.get_supplier(supplier_id).unwrap().revision);
        self.owner(|c| c.verify_supplier(supplier_id, revision)).unwrap();
    }

    pub fn propose(
        &mut self,
        obligation: u8,
        supplier_id: SupplierId,
        amount: u128,
        flag: Option<ReviewFlag>,
    ) -> Result<ProposeResult, String> {
        let obligation = obligation_hex(obligation);
        self.agent(|c| c.propose_payment(obligation, supplier_id, U128(amount), flag))
    }

    pub fn intent(&mut self, id: IntentId) -> Intent {
        self.view(|c| c.get_intent(id)).expect("intent")
    }

    pub fn attempt(&mut self, id: AttemptId) -> Attempt {
        self.view(|c| c.get_attempt(id)).expect("attempt")
    }

    pub fn approve(&mut self, intent_id: IntentId) -> Result<(), String> {
        let hash = crate::hash::to_hex(&self.intent(intent_id).intent_hash);
        self.owner(|c| c.approve(intent_id, hash))
    }

    pub fn authorize(&mut self, attempt_id: AttemptId) -> Result<(), String> {
        let hash = crate::hash::to_hex(&self.attempt(attempt_id).attempt_hash);
        self.owner(|c| c.authorize_attempt(attempt_id, hash))
    }

    fn record_receipts(&mut self) {
        let receipts = get_created_receipts();
        // Callback receipts in the same batch carry the attempt id / withdraw amount.
        let mut callback_attempt = None;
        let mut callback_withdraw = None;
        for r in &receipts {
            for a in &r.actions {
                if let MockAction::FunctionCallWeight { method_name, args, .. } = a {
                    let args: Value = serde_json::from_slice(args).unwrap_or(Value::Null);
                    match method_name.as_slice() {
                        b"on_transfer_complete" => {
                            callback_attempt = args["attempt_id"].as_u64();
                        }
                        b"on_withdraw_complete" => {
                            callback_withdraw =
                                args["amount"].as_str().and_then(|s| s.parse::<u128>().ok());
                        }
                        _ => {}
                    }
                }
            }
        }
        for r in receipts {
            for a in r.actions {
                if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = a {
                    let args: Value = serde_json::from_slice(&args).unwrap_or(Value::Null);
                    match method_name.as_slice() {
                        b"ft_transfer" => {
                            assert_eq!(r.receiver_id, usdc(), "ft_transfer must target the treasury token");
                            assert_eq!(attached_deposit, one_yocto(), "ft_transfer needs exactly 1 yocto");
                            self.debits.push(Debit {
                                receiver: args["receiver_id"].as_str().unwrap().parse().unwrap(),
                                amount: args["amount"].as_str().unwrap().parse().unwrap(),
                                memo: args["memo"].as_str().map(str::to_string),
                                callback_attempt,
                                callback_withdraw,
                            });
                        }
                        b"storage_deposit" => {
                            assert_eq!(r.receiver_id, usdc());
                            self.registrations
                                .push(args["account_id"].as_str().unwrap().parse().unwrap());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Deterministic 64-hex obligation id for tests (the real one is an HMAC from ingestion).
pub fn obligation_hex(n: u8) -> String {
    crate::hash::to_hex(&[n; 32])
}

pub fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        "<non-string panic>".to_string()
    }
}

/// Asserts that a call failed with a message containing `code`.
#[track_caller]
pub fn expect_err<T: std::fmt::Debug>(result: Result<T, String>, code: &str) {
    match result {
        Ok(v) => panic!("expected failure {code}, got Ok({v:?})"),
        Err(msg) => assert!(msg.contains(code), "expected {code}, got: {msg}"),
    }
}

/// A policy convenient for tests: no cooldown surprises unless a test sets one.
pub fn test_policy() -> Policy {
    let mut p = Policy::defaults(6);
    p.autonomous_daily_budget = 50 * USDC;
    p.approval_threshold = 25 * USDC;
    p.daily_cap = 200 * USDC;
    p.monthly_cap = 2_000 * USDC;
    p.unverified_cumulative_budget = 10 * USDC;
    p.test_payment_max = USDC / 2;
    p.new_supplier_cooldown_ns = 2 * DAY;
    p
}

/// A funded treasury with one verified native supplier and one verified Tron supplier, both past
/// their cooldown. Returns (world, native_supplier, tron_supplier).
pub fn standard_world(policy: Policy, hosted_mode: bool) -> (World, SupplierId, SupplierId) {
    let mut w = World::new(Some(policy), hosted_mode);
    w.add_tron_asset(3 * USDC / 2);
    let native = w.add_supplier(Chain::Near, &usdc_asset(), "acme.near", 100 * USDC, 1_000 * USDC);
    let tron = w.add_supplier(Chain::Tron, TRON_USDT, TRON_RECIPIENT, 100 * USDC, 1_000 * USDC);
    w.top_up(500 * USDC).unwrap();
    w.advance(3 * DAY);
    w.verify(native);
    w.verify(tron);
    (w, native, tron)
}
