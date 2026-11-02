//! A small simulated chain for unit and property tests.
//!
//! `World::call` runs one method as one receipt: storage is snapshotted, the contract is read,
//! the method runs inside `catch_unwind`, and on success the root state is written back; on a
//! panic the snapshot is restored, which mirrors how NEAR reverts a failed receipt (the v2
//! contract writes records straight to storage, so the snapshot matters). Outgoing token calls,
//! registrations and callbacks are recorded so tests can check every debit.

use std::cell::Cell;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use near_sdk::borsh::BorshDeserialize;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, Gas, MockedBlockchain, NearToken, PromiseResult, env};

use crate::Contract;
use crate::types::*;

thread_local! {
    /// Set while a simulated receipt runs, so expected panics do not flood the test output.
    static QUIET: Cell<bool> = const { Cell::new(false) };
}
static HOOK: Once = Once::new();

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
/// Circle USDC on mainnet: itself a 64-hex (implicit-looking) account id.
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

/// A deterministic 64-hex deposit account for tests.
pub fn deposit(n: u8) -> [u8; 32] {
    [n; 32]
}
pub fn deposit_hex(n: u8) -> String {
    crate::validate::to_hex(&deposit(n))
}

/// An `ft_transfer` the contract asked the treasury token to make.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Debit {
    pub receiver: String,
    pub amount: u128,
    /// `(intent_id, since)` of the `on_paid` callback chained after it, if any.
    pub callback: Option<(IntentId, u64)>,
    /// Whether a `storage_deposit` for the receiver was in the same receipt.
    pub registered: bool,
    pub at: u64,
}

pub struct World {
    pub now: u64,
    pub debits: Vec<Debit>,
    pub near_transfers: Vec<(String, u128)>,
    pub deploys: usize,
    pub logs: Vec<String>,
    pub prepaid_gas: Gas,
}

impl World {
    pub fn new(policy: &Policy) -> Self {
        let world = World {
            now: NOV_1_2026,
            debits: Vec::new(),
            near_transfers: Vec::new(),
            deploys: 0,
            logs: Vec::new(),
            prepaid_gas: Gas::from_tgas(300),
        };
        let mut init = policy_json(policy);
        let fields = init.as_object_mut().unwrap();
        fields.insert("owner_id".into(), json!(owner()));
        fields.insert("agent_id".into(), json!(agent()));
        fields.insert("executor_id".into(), json!(executor()));
        fields.insert("token_id".into(), json!(usdc()));
        fields.insert("token_decimals".into(), json!(6));
        // `testing_env!` carries storage over, and proptest runs many worlds on one thread:
        // start every world from empty storage.
        world.install(
            &owner(),
            zero(),
            init.to_string().into_bytes(),
            Vec::new(),
            HashMap::new(),
        );
        let contract = Contract::new();
        env::state_write(&contract);
        world
    }

    fn context(
        &self,
        caller: &AccountId,
        deposit: NearToken,
        input: Vec<u8>,
    ) -> near_sdk::VMContext {
        let mut context = VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(caller.clone())
            .predecessor_account_id(caller.clone())
            .block_timestamp(self.now)
            .attached_deposit(deposit)
            .prepaid_gas(self.prepaid_gas)
            .account_balance(NearToken::from_near(2))
            .storage_usage(2_000)
            .build();
        context.input = input.into();
        context
    }

    fn install(
        &self,
        caller: &AccountId,
        deposit: NearToken,
        input: Vec<u8>,
        results: Vec<PromiseResult>,
        storage: HashMap<Vec<u8>, Vec<u8>>,
    ) {
        env::set_blockchain_interface(MockedBlockchain::new(
            self.context(caller, deposit, input),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            results,
            storage,
            Default::default(),
            None,
        ));
    }

    fn take_storage() -> HashMap<Vec<u8>, Vec<u8>> {
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage())
    }

    /// Runs `f` as one receipt from `caller` with `deposit`, JSON/raw `input` and the promise
    /// `results` a callback sees. Returns the panic message on failure (storage unchanged).
    pub fn call<R>(
        &mut self,
        caller: &AccountId,
        deposit: NearToken,
        input: Vec<u8>,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        let snapshot = Self::take_storage();
        self.install(caller, deposit, input, results, snapshot.clone());
        let mut contract: Contract = env::state_read().expect("contract state");
        install_quiet_hook();
        QUIET.with(|q| q.set(true));
        let outcome = catch_unwind(AssertUnwindSafe(|| f(&mut contract)));
        QUIET.with(|q| q.set(false));
        match outcome {
            Ok(value) => {
                env::state_write(&contract);
                self.logs.extend(get_logs());
                self.record_receipts();
                Ok(value)
            }
            Err(payload) => {
                // A failed receipt writes nothing.
                self.install(caller, deposit, Vec::new(), Vec::new(), snapshot);
                Err(panic_message(payload))
            }
        }
    }

    /// Read-only access (a view call).
    pub fn view<R>(&mut self, f: impl FnOnce(&Contract) -> R) -> R {
        let storage = Self::take_storage();
        self.install(&stranger(), zero(), Vec::new(), Vec::new(), storage);
        let contract: Contract = env::state_read().expect("contract state");
        f(&contract)
    }

    pub fn advance(&mut self, ns: u64) {
        self.now += ns;
    }

    // ── Owner (JSON arguments, 1 yocto) ───────────────────────────────────────────────────────

    pub fn owner_json<R>(
        &mut self,
        args: Value,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        self.call(
            &owner(),
            one_yocto(),
            args.to_string().into_bytes(),
            Vec::new(),
            f,
        )
    }

    pub fn decide(&mut self, intent_id: IntentId, action: &str) -> Result<(), String> {
        let i = self.intent(intent_id);
        self.decide_terms(intent_id, action, i.amount_out, i.supplier_id)
    }

    pub fn decide_terms(
        &mut self,
        intent_id: IntentId,
        action: &str,
        amount_out: u128,
        supplier_id: SupplierId,
    ) -> Result<(), String> {
        let args = json!({
            "intent_id": intent_id,
            "action": action,
            "amount_out": amount_out.to_string(),
            "supplier_id": supplier_id,
        });
        self.owner_json(args, |c| c.decide())
    }

    pub fn authorize(&mut self, intent_id: IntentId) -> Result<(), String> {
        let a = self.intent(intent_id).attempt.expect("attempt");
        self.authorize_terms(intent_id, &crate::validate::to_hex(&a.deposit), a.amount_in)
    }

    pub fn authorize_terms(
        &mut self,
        intent_id: IntentId,
        deposit: &str,
        amount_in: u128,
    ) -> Result<(), String> {
        let args = json!({ "intent_id": intent_id, "deposit": deposit, "amount_in": amount_in.to_string() });
        self.owner_json(args, |c| c.authorize())
    }

    pub fn add_supplier(
        &mut self,
        chain: &str,
        asset: &str,
        recipient: &str,
        decimals: u8,
    ) -> Result<SupplierId, String> {
        let args = json!({ "chain": chain, "asset_id": asset, "recipient": recipient, "decimals": decimals });
        self.owner_json(args, |c| c.add_supplier())
    }

    pub fn update_supplier(
        &mut self,
        id: SupplierId,
        chain: &str,
        asset: &str,
        recipient: &str,
        decimals: u8,
    ) -> Result<(), String> {
        let args = json!({ "supplier_id": id, "chain": chain, "asset_id": asset, "recipient": recipient, "decimals": decimals });
        self.owner_json(args, |c| c.update_supplier())
    }

    pub fn set_policy(&mut self, policy: &Policy) -> Result<(), String> {
        self.owner_json(policy_json(policy), |c| c.set_policy())
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<(), String> {
        self.owner_json(json!({ "paused": paused }), |c| c.set_paused())
    }

    pub fn set_roles(
        &mut self,
        agent_id: &AccountId,
        executor_id: &AccountId,
    ) -> Result<(), String> {
        self.owner_json(
            json!({ "agent_id": agent_id, "executor_id": executor_id }),
            |c| c.set_roles(),
        )
    }

    // ── Agent and executor (Borsh arguments, no deposit) ──────────────────────────────────────

    pub fn propose(
        &mut self,
        obligation: u8,
        supplier_id: SupplierId,
        amount: u128,
        flag: u8,
    ) -> Result<ProposeResult, String> {
        self.call(&agent(), zero(), Vec::new(), Vec::new(), |c| {
            c.propose([obligation; 32], supplier_id, amount, flag)
        })
    }

    pub fn create_attempt(
        &mut self,
        intent_id: IntentId,
        deposit_n: u8,
        amount_in: u128,
        deadline: u64,
    ) -> Result<(), String> {
        self.call(&executor(), zero(), Vec::new(), Vec::new(), |c| {
            c.create_attempt(intent_id, deposit(deposit_n), amount_in, deadline)
        })
    }

    pub fn fund(&mut self, intent_id: IntentId) -> Result<(), String> {
        self.call(&executor(), zero(), Vec::new(), Vec::new(), |c| {
            c.fund(intent_id)
        })
    }

    pub fn forget(&mut self, ids: Vec<IntentId>) -> Result<u32, String> {
        self.call(&executor(), zero(), Vec::new(), Vec::new(), |c| {
            c.forget(ids)
        })
    }

    /// Delivers the transfer callback recorded for the last debit of `intent_id`.
    pub fn settle(&mut self, intent_id: IntentId, ok: bool) -> Result<(), String> {
        let since = self
            .debits
            .iter()
            .rev()
            .find_map(|d| d.callback.filter(|(i, _)| *i == intent_id))
            .expect("callback")
            .1;
        self.callback(intent_id, since, ok)
    }

    pub fn callback(&mut self, intent_id: IntentId, since: u64, ok: bool) -> Result<(), String> {
        let result = if ok {
            PromiseResult::Successful(Vec::new())
        } else {
            PromiseResult::Failed
        };
        self.call(&contract_id(), zero(), Vec::new(), vec![result], |c| {
            c.on_paid(intent_id, since)
        })
    }

    // ── Views ──────────────────────────────────────────────────────────────────────────────────

    pub fn state(&mut self) -> StateView {
        self.view(|c| c.get_state())
    }

    pub fn intent(&mut self, id: IntentId) -> Intent {
        self.try_intent(id).expect("intent")
    }

    pub fn try_intent(&mut self, id: IntentId) -> Option<Intent> {
        self.view(|c| c.get_intents(id, 1))
            .into_iter()
            .next()
            .map(|(_, i)| i)
    }

    pub fn supplier(&mut self, id: SupplierId) -> Supplier {
        self.view(|c| c.get_suppliers(id, 1))
            .into_iter()
            .next()
            .expect("supplier")
            .1
    }

    fn record_receipts(&mut self) {
        let receipts = get_created_receipts();
        let mut callback = None;
        for r in &receipts {
            for a in &r.actions {
                if let MockAction::FunctionCallWeight {
                    method_name, args, ..
                } = a
                    && method_name == b"on_paid"
                {
                    let mut slice = args.as_slice();
                    let id = u64::deserialize(&mut slice).unwrap();
                    let since = u64::deserialize(&mut slice).unwrap();
                    callback = Some((id, since));
                }
            }
        }
        for r in receipts {
            let mut registered = false;
            for a in r.actions {
                match a {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        ..
                    } => {
                        let args: Value = serde_json::from_slice(&args).unwrap_or(Value::Null);
                        match method_name.as_slice() {
                            b"storage_deposit" => {
                                assert_eq!(r.receiver_id, usdc());
                                assert_eq!(args["registration_only"], json!(true));
                                registered = true;
                            }
                            b"ft_transfer" => {
                                assert_eq!(
                                    r.receiver_id,
                                    usdc(),
                                    "ft_transfer must target the treasury token"
                                );
                                assert_eq!(
                                    attached_deposit,
                                    one_yocto(),
                                    "ft_transfer needs exactly 1 yocto"
                                );
                                let receiver = args["receiver_id"].as_str().unwrap().to_string();
                                if registered {
                                    assert_eq!(args["receiver_id"], json!(receiver));
                                }
                                self.debits.push(Debit {
                                    receiver,
                                    amount: args["amount"].as_str().unwrap().parse().unwrap(),
                                    callback,
                                    registered,
                                    at: self.now,
                                });
                            }
                            _ => {}
                        }
                    }
                    MockAction::Transfer { deposit, .. } => {
                        self.near_transfers
                            .push((r.receiver_id.to_string(), deposit.as_yoctonear()));
                    }
                    MockAction::DeployContract { .. } => self.deploys += 1,
                    _ => {}
                }
            }
        }
    }
}

/// The policy as flat JSON arguments (`new`, `set_policy`).
pub fn policy_json(p: &Policy) -> Value {
    json!({
        "autonomous_daily_budget": p.autonomous_daily_budget.to_string(),
        "approval_threshold": p.approval_threshold.to_string(),
        "daily_cap": p.daily_cap.to_string(),
        "executor_trust_daily_budget": p.executor_trust_daily_budget.to_string(),
        "cooldown_max": p.cooldown_max.to_string(),
        "max_fixed_fee": p.max_fixed_fee.to_string(),
        "max_fee_bps": p.max_fee_bps,
        "cooldown_ns": p.cooldown_ns.to_string(),
        "intent_ttl_ns": p.intent_ttl_ns.to_string(),
        "quote_min_validity_ns": p.quote_min_validity_ns.to_string(),
        "funding_margin_ns": p.funding_margin_ns.to_string(),
        "callback_grace_ns": p.callback_grace_ns.to_string(),
        "retention_ns": p.retention_ns.to_string(),
        "max_proposals_per_day": p.max_proposals_per_day,
    })
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

/// A policy convenient for tests (amounts like the contract-default demo, trust budget 5).
pub fn test_policy() -> Policy {
    Policy {
        autonomous_daily_budget: 50 * USDC,
        approval_threshold: 25 * USDC,
        daily_cap: 200 * USDC,
        executor_trust_daily_budget: 5 * USDC,
        cooldown_max: USDC / 2,
        max_fixed_fee: 3 * USDC / 2,
        max_fee_bps: 100,
        cooldown_ns: 2 * DAY,
        intent_ttl_ns: 3 * DAY,
        quote_min_validity_ns: 5 * MINUTE,
        funding_margin_ns: 3 * MINUTE,
        callback_grace_ns: HOUR,
        retention_ns: 7 * DAY,
        max_proposals_per_day: 100,
    }
}

/// A treasury with one native supplier (#1, acme.near) and one Tron supplier (#2), both past
/// their cooldown.
pub fn standard_world(policy: &Policy) -> (World, SupplierId, SupplierId) {
    let mut w = World::new(policy);
    let native = w
        .add_supplier("NEAR", &usdc_asset(), "acme.near", 6)
        .unwrap();
    let tron = w
        .add_supplier("TRON", TRON_USDT, TRON_RECIPIENT, 6)
        .unwrap();
    w.advance(3 * DAY);
    (w, native, tron)
}
