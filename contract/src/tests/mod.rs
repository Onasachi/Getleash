//! Unit, scenario and property tests for the v2 contract. Run in debug (the release profile's
//! `panic = "abort"` would break the harness's `catch_unwind`).

pub mod harness;
mod golden;
mod json;
mod props;
mod unit;
