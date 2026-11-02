//! Input checks and small encoders. No `serde_json` and no `format!`: both cost wasm size.

use crate::types::{Hash32, MAX_ASSET_ID_LEN};

const HEX: &[u8; 16] = b"0123456789abcdef";
const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Shape of a Tron address: `T` + 33 base58 characters. The base58check checksum is verified
/// off-chain (seed script, dashboard); a bad one only makes 1Click refuse the quote.
pub fn is_tron_format(text: &str) -> bool {
    text.len() == 34 && text.starts_with('T') && text.bytes().all(|b| BASE58.contains(&b))
}

/// 1Click asset ids look like `nep141:…`; short printable ASCII without spaces.
pub fn valid_asset_id(asset_id: &str) -> bool {
    !asset_id.is_empty()
        && asset_id.len() <= MAX_ASSET_ID_LEN
        && asset_id.bytes().all(|b| b.is_ascii_graphic())
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Exactly 64 lowercase hex characters (the form of a NEAR implicit account) into 32 bytes.
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
        _ => None,
    }
}

/// Appends the decimal digits of `n`.
pub fn push_u128(out: &mut String, mut n: u128) {
    let mut buf = [0u8; 39];
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    for &b in &buf[i..] {
        out.push(b as char);
    }
}

/// `{"receiver_id":"…","amount":"…"}` for NEP-141 `ft_transfer`. Account ids contain only
/// `[a-z0-9._-]`, so nothing needs escaping.
pub fn ft_transfer_args(receiver_id: &str, amount: u128) -> Vec<u8> {
    let mut s = String::with_capacity(64 + receiver_id.len());
    s.push_str("{\"receiver_id\":\"");
    s.push_str(receiver_id);
    s.push_str("\",\"amount\":\"");
    push_u128(&mut s, amount);
    s.push_str("\"}");
    s.into_bytes()
}

/// `{"account_id":"…","registration_only":true}` for NEP-145 `storage_deposit`.
pub fn storage_deposit_args(account_id: &str) -> Vec<u8> {
    let mut s = String::with_capacity(48 + account_id.len());
    s.push_str("{\"account_id\":\"");
    s.push_str(account_id);
    s.push_str("\",\"registration_only\":true}");
    s.into_bytes()
}
