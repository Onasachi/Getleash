//! NEP-297 events: `EVENT_JSON:{"standard":"getleash","version":"1.0.0","event":…,"data":…}`.
//!
//! Events carry ids, amounts and enum codes only, never free text from the agent.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "getleash";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
