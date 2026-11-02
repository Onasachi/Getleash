//! Term hashes that owner signatures bind to (docs/decisions.md D-18), and hex helpers.
//!
//! `hash = sha256(domain ‖ borsh(contract_account_id) ‖ borsh(terms))`. The domain prefix keeps intent
//! and attempt hashes apart; the contract id stops an approval for one deployment (say, the public
//! demo) being replayed against another.

use near_sdk::{borsh, env, AccountId};

use crate::types::{AttemptTerms, Hash32, IntentTerms};

const INTENT_DOMAIN: &[u8] = b"getleash:intent:v1\0";
const ATTEMPT_DOMAIN: &[u8] = b"getleash:attempt:v1\0";

pub fn intent_hash(contract_id: &AccountId, terms: &IntentTerms) -> Hash32 {
    domain_hash(INTENT_DOMAIN, contract_id, terms)
}

pub fn attempt_hash(contract_id: &AccountId, terms: &AttemptTerms) -> Hash32 {
    domain_hash(ATTEMPT_DOMAIN, contract_id, terms)
}

fn domain_hash<T: borsh::BorshSerialize>(domain: &[u8], contract_id: &AccountId, terms: &T) -> Hash32 {
    let mut preimage = Vec::with_capacity(512);
    preimage.extend_from_slice(domain);
    borsh::to_writer(&mut preimage, contract_id).expect("borsh into Vec cannot fail");
    borsh::to_writer(&mut preimage, terms).expect("borsh into Vec cannot fail");
    env::sha256_array(&preimage)
}

/// sha256 of a tagged string, used as a compact uniqueness key (quote refs, deposit accounts).
pub fn tagged_key(tag: &str, value: &str) -> Hash32 {
    let mut preimage = Vec::with_capacity(tag.len() + 1 + value.len());
    preimage.extend_from_slice(tag.as_bytes());
    preimage.push(0);
    preimage.extend_from_slice(value.as_bytes());
    env::sha256_array(&preimage)
}

const HEX: &[u8; 16] = b"0123456789abcdef";

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Parses exactly 64 hex characters (either case) into 32 bytes.
pub fn parse_hex32(text: &str) -> Option<Hash32> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks_exact(2).enumerate() {
        out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let bytes: Hash32 = core::array::from_fn(|i| (i * 7) as u8);
        let text = to_hex(&bytes);
        assert_eq!(text.len(), 64);
        assert_eq!(parse_hex32(&text), Some(bytes));
        assert_eq!(parse_hex32(&text.to_uppercase()), Some(bytes));
        assert_eq!(parse_hex32(&text[..63]), None);
        assert_eq!(parse_hex32(&format!("{}g", &text[..63])), None);
    }
}
