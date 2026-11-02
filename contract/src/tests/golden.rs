//! Golden Borsh vectors shared with the TypeScript decoders (`shared/test/borsh.test.ts`): the
//! same values must encode to the same bytes on both sides. Regenerate after a deliberate layout
//! change with `GOLDEN_WRITE=1 cargo test golden`.

use near_sdk::borsh;
use near_sdk::serde_json::{self, Map, Value};

use super::harness::*;
use crate::types::*;
use crate::validate::to_hex;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/test/fixtures/borsh-golden.json");

fn hex<T: near_sdk::borsh::BorshSerialize>(value: &T) -> Value {
    Value::String(to_hex(&borsh::to_vec(value).unwrap()))
}

fn vectors() -> Map<String, Value> {
    let intent = |status, route, flag, attempt| Intent {
        supplier_id: 2,
        revision: 1,
        obligation: [0xab; 32],
        amount_out: 2_000_000,
        value: 2_000_000,
        max_in: 3_520_000,
        status,
        route,
        flag,
        since: NOV_1_2026,
        created_at: NOV_1_2026,
        attempt,
    };
    let attempt = Attempt { deposit: [0x07; 32], amount_in: 2_300_000, deadline: NOV_1_2026 + HOUR, authorized: true, epoch: 1 };
    let supplier = |chain, asset: &str, recipient: &str, active, revision, changed_at| Supplier {
        chain,
        asset_id: asset.to_string(),
        recipient: recipient.to_string(),
        decimals: 6,
        active,
        revision,
        changed_at,
    };
    let mut m = Map::new();
    m.insert("propose_args".into(), hex(&([0x11u8; 32], 7u32, 18_000_000u128, 4u8)));
    m.insert("create_attempt_args".into(), hex(&(42u64, [0x5au8; 32], 2_300_000u128, NOV_1_2026 + HOUR)));
    m.insert("id_arg".into(), hex(&42u64));
    m.insert("ids_arg".into(), hex(&vec![1u64, 2, 300]));
    m.insert("range_u64_args".into(), hex(&(1u64, 50u32)));
    m.insert("range_u32_args".into(), hex(&(1u32, 50u32)));
    m.insert(
        "propose_result_accepted".into(),
        hex(&ProposeResult { accepted: true, intent_id: 9, status: Status::Paying, route: Route::Autonomous, reason: Reason::None }),
    );
    m.insert(
        "propose_result_refused".into(),
        hex(&ProposeResult { accepted: false, intent_id: 0, status: Status::Rejected, route: Route::Autonomous, reason: Reason::UnknownSupplier }),
    );
    m.insert(
        "intents".into(),
        hex(&vec![
            (3u64, intent(Status::Approved, Route::Autonomous, 0, Some(attempt))),
            (4u64, intent(Status::Pending, Route::ReviewFlag, 1, None)),
        ]),
    );
    m.insert(
        "suppliers".into(),
        hex(&vec![
            (1u32, supplier(Chain::Near, "nep141:usdc.near", "acme.near", true, 1, 1)),
            (2u32, supplier(Chain::Tron, TRON_USDT, TRON_RECIPIENT, false, 3, 2)),
        ]),
    );
    m.insert(
        "state".into(),
        hex(&StateView {
            owner_id: owner(),
            agent_id: agent(),
            executor_id: executor(),
            token_id: usdc(),
            token_decimals: 6,
            paused: false,
            executor_epoch: 2,
            policy: test_policy(),
            budgets: Budgets { day: 20_758, autonomous: 18_000_000, outflow: 20_300_000, trust: 2_300_000, proposals: 3 },
            next_supplier_id: 3,
            next_intent_id: 5,
            stored_intents: 2,
            paying: 0,
        }),
    );
    m
}

#[test]
fn golden_vectors_match_the_shared_fixture() {
    let vectors = Value::Object(vectors());
    if std::env::var("GOLDEN_WRITE").is_ok() {
        std::fs::write(FIXTURE, serde_json::to_string_pretty(&vectors).unwrap() + "\n").unwrap();
    }
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).expect("fixture")).unwrap();
    assert_eq!(fixture, vectors, "Borsh layout changed: update the TypeScript decoders, then GOLDEN_WRITE=1");
}
