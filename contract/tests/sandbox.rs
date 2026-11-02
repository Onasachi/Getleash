//! Sandbox integration test: the real wasm on a local NEAR node (`near-sandbox`), paying through a
//! mock NEP-141 token that stands in for USDC (`tests/mock-ft`).
//!
//! It covers what the unit tests cannot: JSON at the contract boundary, the `#[payable]` and
//! `#[private]` wrappers, gas, real cross-contract promises and callbacks, a real failed
//! `ft_transfer`, the key-less setup batch, and an owner upgrade.

use std::sync::{Arc, OnceLock};

use near_api::types::transaction::actions::{
    Action, CreateAccountAction, DeployContractAction, FunctionCallAction, TransferAction,
};
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer, Transaction};
use near_sdk::serde_json::{self, json, Value};

const USDC: u128 = 1_000_000;

/// Both contracts, built once per test binary.
fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    WASMS.get_or_init(|| {
        let policy = cargo_near_build::build_with_cli(Default::default()).expect("build policy contract");
        let token = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
            manifest_path: Some("tests/mock-ft/Cargo.toml".into()),
            no_abi: true,
            no_locked: true,
            ..Default::default()
        })
        .expect("build mock token");
        (std::fs::read(policy).unwrap(), std::fs::read(token).unwrap())
    })
}

struct Chain {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
}

impl Chain {
    async fn start() -> testresult::TestResult<Self> {
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
        )?;
        Ok(Self { _sandbox: sandbox, net, signer })
    }

    async fn account(&self, name: &str, near: u128) -> testresult::TestResult<AccountId> {
        let id: AccountId = name.parse()?;
        self._sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(near)).send().await?;
        Ok(id)
    }

    /// Sends one function call. `ok` is true only if every receipt succeeded; `final_ok` is the
    /// transaction's final status alone (for `fund_*` that is the callback's result).
    async fn call(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        tgas: u64,
    ) -> Outcome {
        let result = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(tgas))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .expect("transaction sent");
        let full = result.into_full().expect("final execution result");
        let receipt_failed = !full.receipt_failures().is_empty();
        match full.into_result() {
            Ok(success) => Outcome {
                ok: !receipt_failed,
                final_ok: true,
                value: success.json::<Value>().unwrap_or(Value::Null),
            },
            Err(_) => Outcome { ok: false, final_ok: false, value: Value::Null },
        }
    }

    async fn owner_call(&self, owner: &AccountId, policy: &AccountId, method: &str, args: Value) -> Value {
        let out = self.call(owner, policy, method, args.clone(), yocto(1), 100).await;
        assert!(out.ok, "owner call {method}({args}) failed");
        out.value
    }

    async fn view<T: serde::de::DeserializeOwned + Send + Sync + 'static>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> T {
        Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await
            .expect("view call")
            .data
    }
}

struct Outcome {
    ok: bool,
    final_ok: bool,
    value: Value,
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn policy_json() -> Value {
    json!({
        "autonomous_daily_budget": (50 * USDC).to_string(),
        "approval_threshold": (25 * USDC).to_string(),
        "daily_cap": (200 * USDC).to_string(),
        "monthly_cap": (2_000 * USDC).to_string(),
        "executor_trust_daily_budget": "0",
        "unverified_cumulative_budget": (10 * USDC).to_string(),
        "test_payment_max": (USDC / 2).to_string(),
        "max_fee_bps": 100,
        // No cooldown so the test can pay a new supplier at once (sandbox time barely moves).
        "new_supplier_cooldown_ns": "0",
        "intent_ttl_ns": "259200000000000",
        "quote_min_validity_ns": "300000000000",
        "funding_margin_ns": "180000000000",
        "reconcile_grace_ns": "600000000000",
        "retention_ns": "2592000000000000",
        "max_open_intents": 50,
        "max_proposals_per_day": 100,
        "max_attempts_per_day": 100,
        "max_registrations_per_day": 20,
    })
}

#[tokio::test]
#[ignore = "needs cargo-near and downloads the near-sandbox node; run: cargo test --test sandbox -- --ignored"]
async fn native_payouts_end_to_end_on_a_real_node() -> testresult::TestResult<()> {
    let (policy_wasm, token_wasm) = wasms();
    let chain = Chain::start().await?;
    let owner = chain.account("biz.sandbox", 50).await?;
    let agent = chain.account("agent.sandbox", 5).await?;
    let executor = chain.account("executor.sandbox", 5).await?;
    let usdc = chain.account("usdc.sandbox", 10).await?;
    let acme = chain.account("acme.sandbox", 5).await?;
    let ghost = chain.account("ghost.sandbox", 5).await?;

    // Mock USDC, all supply to the owner.
    near_api::Contract::deploy(usdc.clone())
        .use_code(token_wasm.clone())
        .with_init_call("new", json!({ "owner_id": owner, "total_supply": (1_000_000 * USDC).to_string() }))?
        .with_signer(chain.signer.clone())
        .send_to(&chain.net)
        .await?
        .assert_success();

    // ── Setup batch (docs/decisions.md D-11): one transaction from the owner creates, funds,
    //    deploys and initialises the policy account. No access key is ever added.
    let policy: AccountId = format!("getleash.{owner}").parse()?;
    let init = json!({
        "owner_id": owner,
        "agent_id": agent,
        "executor_id": executor,
        "treasury_token": usdc,
        "treasury_decimals": 6,
        "hosted_mode": false,
        "policy": policy_json(),
    });
    Transaction::construct(owner.clone(), policy.clone())
        .add_action(Action::CreateAccount(CreateAccountAction {}))
        .add_action(Action::Transfer(TransferAction { deposit: NearToken::from_near(5) }))
        .add_action(Action::DeployContract(DeployContractAction { code: policy_wasm.clone() }))
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "new".to_string(),
            args: serde_json::to_vec(&init)?,
            gas: NearGas::from_tgas(100),
            deposit: NearToken::from_yoctonear(0),
        })))
        .with_signer(chain.signer.clone())
        .send_to(&chain.net)
        .await?
        .assert_success();

    // PLAN §9: "Policy contract account after setup → no full-access key exists".
    let keys = Account(policy.clone()).list_keys().fetch_from(&chain.net).await?.data;
    assert!(keys.is_empty(), "the policy account must have no access keys, found {keys:?}");

    // Register the treasury and one supplier on the token, then top up via ft_transfer_call.
    let storage = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
    for account in [&policy, &acme] {
        assert!(chain.call(&owner, &usdc, "storage_deposit", json!({ "account_id": account }), storage, 30).await.ok);
    }
    let top_up = chain
        .call(&owner, &usdc, "ft_transfer_call",
              json!({ "receiver_id": policy, "amount": (100 * USDC).to_string(), "msg": "" }), yocto(1), 100)
        .await;
    assert!(top_up.ok, "top-up failed");
    let ledger: Value = chain.view(&policy, "get_ledger", json!({})).await;
    assert_eq!(ledger["cash"], json!((100 * USDC).to_string()), "ft_on_transfer credited the top-up");

    // Owner: allowlist two suppliers (acme is registered on the token, ghost is not).
    let asset = format!("nep141:{usdc}");
    let mut supplier_ids = Vec::new();
    for recipient in [&acme, &ghost] {
        let id = chain
            .owner_call(&owner, &policy, "add_supplier", json!({
                "chain": "NEAR", "asset_id": asset, "recipient": recipient,
                "per_payment_cap": (100 * USDC).to_string(), "monthly_cap": (1_000 * USDC).to_string(),
            }))
            .await;
        chain.owner_call(&owner, &policy, "verify_supplier", json!({ "supplier_id": id, "revision": 1 })).await;
        supplier_ids.push(id);
    }

    // ── Happy path: agent proposes, contract auto-approves, executor pays exactly that.
    let out = chain
        .call(&agent, &policy, "propose_payment", json!({
            "obligation_id": "aa".repeat(32), "supplier_id": supplier_ids[0], "amount_out": (10 * USDC).to_string(),
        }), yocto(0), 50)
        .await;
    assert!(out.ok, "propose_payment failed");
    let proposal = out.value;
    assert_eq!(proposal["accepted"], json!(true));
    assert_eq!(proposal["status"], json!("APPROVED"));
    assert_eq!(proposal["route"], json!("AUTONOMOUS"));
    let intent_id = proposal["intent_id"].clone();

    let out = chain.call(&executor, &policy, "create_attempt_native", json!({ "intent_id": intent_id }), yocto(0), 50).await;
    assert!(out.ok);
    let attempt_id = out.value;
    let out = chain.call(&executor, &policy, "fund_native", json!({ "attempt_id": attempt_id }), yocto(0), 100).await;
    assert!(out.ok, "fund_native failed");

    let attempt: Value = chain.view(&policy, "get_attempt", json!({ "attempt_id": attempt_id })).await;
    assert_eq!(attempt["status"], json!("DELIVERED"));
    let acme_balance: String = chain.view(&usdc, "ft_balance_of", json!({ "account_id": acme })).await;
    assert_eq!(acme_balance, (10 * USDC).to_string(), "the supplier received exactly amount_out");
    let ledger: Value = chain.view(&policy, "get_ledger", json!({})).await;
    assert_eq!(ledger["cash"], json!((90 * USDC).to_string()));
    assert_eq!(ledger["in_flight"], json!("0"));
    assert_eq!(ledger["reserved"], json!("0"));

    // ── A real failed transfer: ghost is not registered on the token, so ft_transfer panics in
    //    the token contract and the callback restores the ledger.
    let proposal = chain
        .call(&agent, &policy, "propose_payment", json!({
            "obligation_id": "bb".repeat(32), "supplier_id": supplier_ids[1], "amount_out": (5 * USDC).to_string(),
        }), yocto(0), 50)
        .await
        .value;
    let ghost_intent = proposal["intent_id"].clone();
    let failing_attempt = chain
        .call(&executor, &policy, "create_attempt_native", json!({ "intent_id": ghost_intent }), yocto(0), 50)
        .await
        .value;
    let out = chain.call(&executor, &policy, "fund_native", json!({ "attempt_id": failing_attempt }), yocto(0), 100).await;
    assert!(out.final_ok && !out.ok, "the token's ft_transfer receipt fails; the callback still succeeds");
    let attempt: Value = chain.view(&policy, "get_attempt", json!({ "attempt_id": failing_attempt })).await;
    assert_eq!(attempt["status"], json!("FAILED"), "callback saw the failure");
    let intent: Value = chain.view(&policy, "get_intent", json!({ "intent_id": ghost_intent })).await;
    assert_eq!(intent["status"], json!("APPROVED"), "ready for a retry");
    let ledger: Value = chain.view(&policy, "get_ledger", json!({})).await;
    assert_eq!(ledger["cash"], json!((90 * USDC).to_string()), "cash restored");
    assert_eq!(ledger["in_flight"], json!("0"));

    // Retry: a new attempt, register the committed payee, fund.
    let out = chain.call(&executor, &policy, "create_attempt_native", json!({ "intent_id": ghost_intent }), yocto(0), 50).await;
    assert!(out.ok);
    let retry = out.value;
    let out = chain.call(&executor, &policy, "register_recipient", json!({ "attempt_id": retry }), yocto(0), 50).await;
    assert!(out.ok, "register_recipient failed");
    let out = chain.call(&executor, &policy, "fund_native", json!({ "attempt_id": retry }), yocto(0), 100).await;
    assert!(out.ok);
    let ghost_balance: String = chain.view(&usdc, "ft_balance_of", json!({ "account_id": ghost })).await;
    assert_eq!(ghost_balance, (5 * USDC).to_string());

    // ── Boundary checks on the real runtime.
    let out = chain.call(&owner, &policy, "pause", json!({}), yocto(0), 30).await;
    assert!(!out.ok, "owner call without 1 yoctoNEAR must fail");
    let out = chain.call(&agent, &policy, "pause", json!({}), yocto(1), 30).await;
    assert!(!out.ok, "non-owner pause must fail");
    let out = chain.call(&executor, &policy, "on_transfer_complete", json!({ "attempt_id": attempt_id }), yocto(0), 30).await;
    assert!(!out.ok, "callbacks are #[private]");
    let out = chain
        .call(&agent, &policy, "ft_on_transfer", json!({ "sender_id": agent, "amount": "1", "msg": "" }), yocto(0), 30)
        .await;
    assert!(!out.ok, "only the treasury token can credit top-ups");
    let out = chain
        .call(&executor, &policy, "propose_payment", json!({
            "obligation_id": "cc".repeat(32), "supplier_id": supplier_ids[0], "amount_out": "1",
        }), yocto(0), 30)
        .await;
    assert!(!out.ok, "only the agent proposes");

    // ── Owner upgrade: raw wasm as input, deploy + migrate in one receipt, state preserved.
    let upgrade = |from: AccountId| {
        Transaction::construct(from, policy.clone())
            .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: "upgrade".to_string(),
                args: policy_wasm.clone(),
                gas: NearGas::from_tgas(300),
                deposit: yocto(1),
            })))
            .with_signer(chain.signer.clone())
            .send_to(&chain.net)
    };
    assert!(upgrade(agent.clone()).await?.into_result().is_err(), "only the owner upgrades");
    let before: Value = chain.view(&policy, "get_ledger", json!({})).await;
    upgrade(owner.clone()).await?.assert_success();
    let after: Value = chain.view(&policy, "get_ledger", json!({})).await;
    assert_eq!(before, after, "upgrade keeps state");
    let config: Value = chain.view(&policy, "get_config", json!({})).await;
    assert_eq!(config["owner_id"], json!(owner));
    Ok(())
}
