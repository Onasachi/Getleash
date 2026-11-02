//! The owner-argument parser (`src/json.rs`) against `serde_json` as a reference: whatever it
//! accepts, serde_json reads identically, and it rejects anything a wallet could display
//! differently from what the contract reads.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

use near_sdk::serde_json::{self, Value as J};
use proptest::prelude::*;

use super::harness::panic_message;
use crate::json::{Args, Value, parse_u128};

/// The parser's reading of `input` as `key → "s:…" | "n:…" | "b:…"`, or its panic message.
fn accepts(input: &str) -> Result<BTreeMap<String, String>, String> {
    catch_unwind(AssertUnwindSafe(|| {
        Args::parse(input.as_bytes())
            .pairs_for_tests()
            .into_iter()
            .map(|(k, v)| {
                let v = match v {
                    Value::Str(s) => format!("s:{s}"),
                    Value::Num(n) => format!("n:{n}"),
                    Value::Bool(b) => format!("b:{b}"),
                };
                (k.to_string(), v)
            })
            .collect()
    }))
    .map_err(panic_message)
}

/// serde_json's reading of a flat object of strings, u64 numbers and booleans.
fn reference(input: &str) -> Option<BTreeMap<String, String>> {
    let J::Object(map) = serde_json::from_str::<J>(input).ok()? else {
        return None;
    };
    map.into_iter()
        .map(|(k, v)| {
            let v = match v {
                J::String(s) => format!("s:{s}"),
                J::Number(n) => format!("n:{}", n.as_u64()?),
                J::Bool(b) => format!("b:{b}"),
                _ => return None,
            };
            Some((k, v))
        })
        .collect()
}

#[test]
fn accepts_flat_objects() {
    let got = accepts(r#" { "a" : "x" , "b":12,"c":true,"d":false, "e":"0" } "#).unwrap();
    assert_eq!(got.len(), 5);
    assert_eq!(
        (got["a"].as_str(), got["b"].as_str(), got["c"].as_str()),
        ("s:x", "n:12", "b:true")
    );
    assert!(accepts("{}").unwrap().is_empty());
}

#[test]
fn rejects_ambiguous_or_unexpected_input() {
    for (input, code) in [
        (r#"{"a":1,"a":2}"#, "DUPLICATE_ARG"),
        (r#"{"a":"\u0041"}"#, "BAD_JSON"),
        (r#"{"a":"x\"y"}"#, "BAD_JSON"),
        (r#"{"a":-1}"#, "BAD_JSON"),
        (r#"{"a":1.5}"#, "BAD_JSON"),
        (r#"{"a":1e3}"#, "BAD_JSON"),
        (r#"{"a":null}"#, "BAD_JSON"),
        (r#"{"a":{"b":1}}"#, "BAD_JSON"),
        (r#"{"a":[1]}"#, "BAD_JSON"),
        (r#"{"a":1,}"#, "BAD_JSON"),
        (r#"{"a":1} {}"#, "BAD_JSON"),
        (r#"["a"]"#, "BAD_JSON"),
        ("{\"a\":\"line\nbreak\"}", "BAD_JSON"),
        (r#"{"a":tru}"#, "BAD_JSON"),
        ("", "BAD_JSON"),
        (r#"{"a":1"#, "BAD_JSON"),
    ] {
        let err = accepts(input).expect_err(input);
        assert!(err.contains(code), "{input}: expected {code}, got {err}");
    }
}

#[test]
fn numbers_are_strict() {
    assert_eq!(parse_u128("0"), Some(0));
    assert_eq!(
        parse_u128("340282366920938463463374607431768211455"),
        Some(u128::MAX)
    );
    assert_eq!(parse_u128("340282366920938463463374607431768211456"), None);
    assert_eq!(parse_u128("007"), None);
    assert_eq!(parse_u128(""), None);
    assert_eq!(parse_u128("1a"), None);
}

fn key() -> impl Strategy<Value = String> {
    "[a-z_]{1,6}"
}

fn scalar() -> impl Strategy<Value = J> {
    prop_oneof![
        "[ -!#-\\[\\]-~]{0,12}".prop_map(J::String),
        any::<u64>().prop_map(|n| J::Number(n.into())),
        any::<bool>().prop_map(J::Bool),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Every flat object serde_json writes (compact or pretty) is read back identically.
    #[test]
    fn round_trips_what_serde_writes(pairs in prop::collection::btree_map(key(), scalar(), 0..12), pretty in any::<bool>()) {
        let object = J::Object(pairs.into_iter().collect());
        let text = if pretty { serde_json::to_string_pretty(&object).unwrap() } else { object.to_string() };
        prop_assert_eq!(Some(accepts(&text).unwrap()), reference(&text));
    }

    /// Whatever it accepts, serde_json reads the same way.
    #[test]
    fn never_disagrees_with_serde(input in "[{}\":,a-c0-9 tfrueals\\\\.e-]{0,40}") {
        if let Ok(got) = accepts(&input) {
            prop_assert_eq!(Some(got), reference(&input), "input {:?}", input);
        }
    }
}
