//! Sandbox integration test (v2): the real wasm on a local NEAR node (`near-sandbox`), paying
//! through a mock NEP-141 token that stands in for USDC (`tests/mock-ft`).
//!
//! It covers what the unit tests cannot: the JSON and Borsh boundaries, the `#[payable]` and
//! `#[private]` wrappers, gas at the minimum the contract accepts, real promises and callbacks
//! (a native transfer, a cross-chain batch that registers a fresh deposit account, a real failed
//! transfer), the keyless setup batch funded with only 1.2 NEAR, and an owner upgrade.

use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use getleash_policy::types::{Intent, IntentId, ProposeResult, Route, StateView, Status};
use near_api::types::transaction::actions::{
    Action, CreateAccountAction, DeployContractAction, FunctionCallAction, TransferAction,
};
use near_api::{
    Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer, Transaction,
};
use near_sdk::borsh;
use near_sdk::serde_json::{self, Value, json};

const USDC: u128 = 1_000_000;
const TRON_USDT: &str = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

/// Both contracts, built once per test binary.
fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    WASMS.get_or_init(|| {
        let policy = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
            no_embed_abi: true,
            ..Default::default()
        })
        .expect("build policy contract");
        let token = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
            manifest_path: Some("tests/mock-ft/Cargo.toml".into()),
            no_abi: true,
            no_locked: true,
            ..Default::default()
        })
        .expect("build mock token");
        (
            std::fs::read(policy).unwrap(),
            std::fs::read(token).unwrap(),
        )
    })
}

struct Chain {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
}

struct Outcome {
    /// Every receipt succeeded.
    ok: bool,
    /// The transaction's own final status (a payout's token receipt may still have failed).
    final_ok: bool,
    bytes: Vec<u8>,
}

impl Chain {
    async fn start() -> testresult::TestResult<Self> {
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
                .parse()
                .unwrap(),
        )?;
        Ok(Self {
            _sandbox: sandbox,
            net,
            signer,
        })
    }

    async fn account(&self, name: &str, near: u128) -> testresult::TestResult<AccountId> {
        let id: AccountId = name.parse()?;
        self._sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
        Ok(id)
    }

    async fn call(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Vec<u8>,
        deposit: NearToken,
        tgas: u64,
    ) -> Outcome {
        let result = Contract(contract.clone())
            .call_function_raw(method, args)
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
                bytes: success.raw_bytes().unwrap_or_default(),
            },
            Err(_) => Outcome {
                ok: false,
                final_ok: false,
                bytes: Vec::new(),
            },
        }
    }

    async fn json_call(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        tgas: u64,
    ) -> Outcome {
        self.call(
            from,
            contract,
            method,
            serde_json::to_vec(&args).unwrap(),
            deposit,
            tgas,
        )
        .await
    }

    async fn owner(
        &self,
        owner: &AccountId,
        policy: &AccountId,
        method: &str,
        args: Value,
    ) -> Vec<u8> {
        let out = self
            .json_call(owner, policy, method, args.clone(), yocto(1), 100)
            .await;
        assert!(out.ok, "owner call {method}({args}) failed");
        out.bytes
    }

    async fn view_json<T: serde::de::DeserializeOwned + Send + Sync + 'static>(
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
            .expect("view")
            .data
    }

    async fn state(&self, policy: &AccountId) -> StateView {
        Contract(policy.clone())
            .call_function_raw("get_state", Vec::new())
            .read_only_borsh()
            .fetch_from(&self.net)
            .await
            .expect("view")
            .data
    }

    async fn intent(&self, policy: &AccountId, id: IntentId) -> Intent {
        let args = borsh::to_vec(&(id, 1u32)).unwrap();
        let list: Vec<(IntentId, Intent)> = Contract(policy.clone())
            .call_function_raw("get_intents", args)
            .read_only_borsh()
            .fetch_from(&self.net)
            .await
            .expect("view")
            .data;
        list.into_iter().next().expect("intent").1
    }

    async fn balance(&self, token: &AccountId, account: &str) -> u128 {
        let b: String = self
            .view_json(token, "ft_balance_of", json!({ "account_id": account }))
            .await;
        b.parse().unwrap()
    }
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

fn propose_args(obligation: u8, supplier_id: u32, amount: u128) -> Vec<u8> {
    borsh::to_vec(&([obligation; 32], supplier_id, amount, 0u8)).unwrap()
}

#[tokio::test]
#[ignore = "needs cargo-near and downloads the near-sandbox node; run: cargo test --test sandbox -- --ignored"]
async fn payouts_end_to_end_on_a_real_node() -> testresult::TestResult<()> {
    let (policy_wasm, token_wasm) = wasms();
    let chain = Chain::start().await?;
    let owner = chain.account("biz.sandbox", 50).await?;
    let agent = chain.account("agent.sandbox", 5).await?;
    let executor = chain.account("executor.sandbox", 5).await?;
    let usdc = chain.account("usdc.sandbox", 10).await?;
    let acme = chain.account("acme.sandbox", 5).await?;
    let ghost = chain.account("ghost.sandbox", 5).await?;

    near_api::Contract::deploy(usdc.clone())
        .use_code(token_wasm.clone())
        .with_init_call(
            "new",
            json!({ "owner_id": owner, "total_supply": (1_000_000 * USDC).to_string() }),
        )?
        .with_signer(chain.signer.clone())
        .send_to(&chain.net)
        .await?
        .assert_success();

    // ── Setup batch (D-11), funded with 1.2 NEAR: create, fund, deploy, initialise. No key.
    let policy: AccountId = format!("getleash.{owner}").parse()?;
    let init = json!({
        "owner_id": owner, "agent_id": agent, "executor_id": executor, "token_id": usdc, "token_decimals": 6,
        "autonomous_daily_budget": (50 * USDC).to_string(), "approval_threshold": (25 * USDC).to_string(),
        "daily_cap": (200 * USDC).to_string(), "executor_trust_daily_budget": (5 * USDC).to_string(),
        "cooldown_max": (USDC / 2).to_string(), "max_fixed_fee": (3 * USDC / 2).to_string(), "max_fee_bps": 100,
        // No cooldown, so the test can pay new suppliers at once (sandbox time barely moves).
        "cooldown_ns": "0", "intent_ttl_ns": "259200000000000", "quote_min_validity_ns": "300000000000",
        "funding_margin_ns": "180000000000", "callback_grace_ns": "3600000000000",
        "retention_ns": "604800000000000", "max_proposals_per_day": 20,
    });
    Transaction::construct(owner.clone(), policy.clone())
        .add_action(Action::CreateAccount(CreateAccountAction {}))
        .add_action(Action::Transfer(TransferAction {
            deposit: NearToken::from_millinear(1_200),
        }))
        .add_action(Action::DeployContract(DeployContractAction {
            code: policy_wasm.clone(),
        }))
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "new".to_string(),
            args: serde_json::to_vec(&init)?,
            gas: NearGas::from_tgas(100),
            deposit: yocto(0),
        })))
        .with_signer(chain.signer.clone())
        .send_to(&chain.net)
        .await?
        .assert_success();
    // PLAN §9: "Policy contract account after setup → no full-access key exists".
    let keys = Account(policy.clone())
        .list_keys()
        .fetch_from(&chain.net)
        .await?
        .data;
    assert!(
        keys.is_empty(),
        "the policy account must have no access keys, found {keys:?}"
    );

    // Register the treasury and acme on the token; top up with a plain ft_transfer.
    let storage = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
    for account in [&policy, &acme] {
        assert!(
            chain
                .json_call(
                    &owner,
                    &usdc,
                    "storage_deposit",
                    json!({ "account_id": account }),
                    storage,
                    30
                )
                .await
                .ok
        );
    }
    assert!(
        chain
            .json_call(
                &owner,
                &usdc,
                "ft_transfer",
                json!({ "receiver_id": policy, "amount": (100 * USDC).to_string() }),
                yocto(1),
                30
            )
            .await
            .ok
    );

    // Suppliers: acme and ghost (native; ghost not registered on the token), one on Tron.
    let asset = format!("nep141:{usdc}");
    let mut ids = Vec::new();
    for (chain_name, asset_id, recipient) in [
        ("NEAR", asset.as_str(), acme.as_str()),
        ("NEAR", asset.as_str(), ghost.as_str()),
        ("TRON", TRON_USDT, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    ] {
        let bytes = chain
            .owner(&owner, &policy, "add_supplier", json!({ "chain": chain_name, "asset_id": asset_id, "recipient": recipient, "decimals": 6 }))
            .await;
        ids.push(borsh::from_slice::<u32>(&bytes)?);
    }
    assert_eq!(ids, vec![1, 2, 3]);

    // ── Native, paid inside the agent's call, at exactly the minimum gas the contract accepts.
    let out = chain
        .call(
            &agent,
            &policy,
            "propose",
            propose_args(1, 1, 10 * USDC),
            yocto(0),
            60,
        )
        .await;
    assert!(out.ok, "propose failed at 60 TGas");
    let r: ProposeResult = borsh::from_slice(&out.bytes)?;
    assert_eq!(
        (r.accepted, r.status, r.route),
        (true, Status::Paying, Route::Autonomous)
    );
    assert_eq!(
        chain.intent(&policy, r.intent_id).await.status,
        Status::Paid
    );
    assert_eq!(
        chain.balance(&usdc, acme.as_str()).await,
        10 * USDC,
        "the supplier received exactly amount_out"
    );
    let too_little = chain
        .call(
            &agent,
            &policy,
            "propose",
            propose_args(9, 1, USDC),
            yocto(0),
            59,
        )
        .await;
    assert!(
        !too_little.final_ok,
        "below the minimum gas the payout is refused before any write"
    );

    // ── A real failed transfer: ghost is not registered, the token panics, the callback records it.
    let out = chain
        .call(
            &agent,
            &policy,
            "propose",
            propose_args(2, 2, 5 * USDC),
            yocto(0),
            100,
        )
        .await;
    assert!(
        out.final_ok && !out.ok,
        "the token's ft_transfer receipt fails; the transaction itself succeeds"
    );
    let ghost_intent: ProposeResult = borsh::from_slice(&out.bytes)?;
    let i = chain.intent(&policy, ghost_intent.intent_id).await;
    assert_eq!(i.status, Status::Failed);
    assert_eq!(chain.state(&policy).await.paying, 0);
    // The owner registers ghost and retries; the retry is counted against today's budgets again.
    assert!(
        chain
            .json_call(
                &owner,
                &usdc,
                "storage_deposit",
                json!({ "account_id": ghost }),
                storage,
                30
            )
            .await
            .ok
    );
    chain
        .owner(&owner, &policy, "decide", json!({ "intent_id": ghost_intent.intent_id, "action": "RETRY", "amount_out": (5 * USDC).to_string(), "supplier_id": 2 }))
        .await;
    assert_eq!(
        chain.intent(&policy, ghost_intent.intent_id).await.status,
        Status::Paid
    );
    assert_eq!(chain.balance(&usdc, ghost.as_str()).await, 5 * USDC);
    assert_eq!(chain.state(&policy).await.budgets.outflow, 20 * USDC);

    // ── Cross-chain: the executor's fresh deposit account is registered and funded in one receipt.
    let out = chain
        .call(
            &agent,
            &policy,
            "propose",
            propose_args(3, 3, 2 * USDC),
            yocto(0),
            100,
        )
        .await;
    let cross: ProposeResult = borsh::from_slice(&out.bytes)?;
    assert_eq!(cross.status, Status::Approved);
    let deposit = [0x5au8; 32];
    let attempt = borsh::to_vec(&(
        cross.intent_id,
        deposit,
        2_300_000u128,
        now_ns() + 3_600_000_000_000,
    ))?;
    assert!(
        chain
            .call(&executor, &policy, "create_attempt", attempt, yocto(0), 30)
            .await
            .ok
    );
    let fund = borsh::to_vec(&cross.intent_id)?;
    assert!(
        chain
            .call(&executor, &policy, "fund", fund, yocto(0), 100)
            .await
            .ok,
        "fund failed"
    );
    assert_eq!(
        chain.intent(&policy, cross.intent_id).await.status,
        Status::Paid
    );
    assert_eq!(
        chain.balance(&usdc, &"5a".repeat(32)).await,
        2_300_000,
        "the deposit account got exactly amount_in"
    );

    // ── Boundary checks on the real runtime.
    let paused = json!({ "paused": true });
    assert!(
        !chain
            .json_call(&owner, &policy, "set_paused", paused.clone(), yocto(0), 30)
            .await
            .ok,
        "owner calls need 1 yoctoNEAR"
    );
    assert!(
        !chain
            .json_call(&agent, &policy, "set_paused", paused, yocto(1), 30)
            .await
            .ok,
        "only the owner pauses"
    );
    let callback = borsh::to_vec(&(cross.intent_id, 0u64))?;
    assert!(
        !chain
            .call(&executor, &policy, "on_paid", callback, yocto(0), 30)
            .await
            .ok,
        "callbacks are #[private]"
    );
    assert!(
        !chain
            .call(
                &executor,
                &policy,
                "propose",
                propose_args(4, 1, USDC),
                yocto(0),
                100
            )
            .await
            .ok,
        "only the agent proposes"
    );
    assert!(
        !chain
            .call(
                &agent,
                &policy,
                "propose",
                propose_args(4, 1, USDC),
                yocto(1),
                100
            )
            .await
            .ok,
        "agent calls cannot carry a deposit"
    );

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
    assert!(
        upgrade(agent.clone()).await?.into_result().is_err(),
        "only the owner upgrades"
    );
    let before = chain.state(&policy).await;
    upgrade(owner.clone()).await?.assert_success();
    assert_eq!(chain.state(&policy).await, before, "upgrade keeps state");

    // What the lean deployment costs: code plus data after these payouts.
    let account = Account(policy.clone())
        .view()
        .fetch_from(&chain.net)
        .await?
        .data;
    println!(
        "policy account: {} bytes of storage ({} of them code), balance {}",
        account.storage_usage,
        policy_wasm.len(),
        account.amount
    );
    assert!(
        account.storage_usage < 100_000,
        "the lean contract fits in under 1 NEAR of storage"
    );
    Ok(())
}
