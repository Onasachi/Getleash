//! Input validation and amount arithmetic shared by the contract methods.

use near_sdk::{env, AccountId};

use crate::types::{Chain, PayoutKind, MAX_ASSET_ID_LEN};

/// A NEAR account, or a Tron base58check address (`T…`, 34 characters, valid checksum).
pub fn validate_recipient(chain: Chain, recipient: &str) -> Result<(), &'static str> {
    match chain {
        Chain::Near => recipient
            .parse::<AccountId>()
            .map(|_| ())
            .map_err(|_| "BAD_NEAR_RECIPIENT"),
        Chain::Tron => {
            if is_tron_address(recipient) { Ok(()) } else { Err("BAD_TRON_RECIPIENT") }
        }
    }
}

/// Tron addresses are base58check of `0x41 ‖ 20-byte hash`, checksum = first 4 bytes of
/// sha256(sha256(payload)).
pub fn is_tron_address(text: &str) -> bool {
    if text.len() != 34 || !text.starts_with('T') {
        return false;
    }
    let Some(bytes) = base58_decode(text) else { return false };
    if bytes.len() != 25 || bytes[0] != 0x41 {
        return false;
    }
    let (payload, checksum) = bytes.split_at(21);
    let digest = env::sha256_array(&env::sha256_array(payload));
    digest[..4] == *checksum
}

fn base58_decode(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut number: Vec<u8> = Vec::with_capacity(32); // big-endian
    for c in text.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for byte in number.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            number.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let leading_zeros = text.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0u8; leading_zeros];
    out.extend(number);
    Some(out)
}

/// 1Click asset ids look like `nep141:…`; we only require short printable ASCII without spaces.
pub fn validate_asset_id(asset_id: &str) -> Result<(), &'static str> {
    let ok = !asset_id.is_empty()
        && asset_id.len() <= MAX_ASSET_ID_LEN
        && asset_id.bytes().all(|b| b.is_ascii_graphic());
    if ok { Ok(()) } else { Err("BAD_ASSET_ID") }
}

/// Short printable ASCII reference (quote ids, transaction hashes).
pub fn validate_ref(text: &str, max_len: usize) -> bool {
    !text.is_empty() && text.len() <= max_len && text.bytes().all(|b| b.is_ascii_graphic())
}

/// Converts an amount in an asset with `asset_decimals` into treasury base units, rounding up.
/// Only meaningful for USD-pegged assets (the only kind the owner should list).
pub fn to_treasury_units(amount: u128, asset_decimals: u8, treasury_decimals: u8) -> Option<u128> {
    use core::cmp::Ordering;
    match asset_decimals.cmp(&treasury_decimals) {
        Ordering::Equal => Some(amount),
        Ordering::Greater => {
            let divisor = 10u128.checked_pow(u32::from(asset_decimals - treasury_decimals))?;
            Some(amount.div_ceil(divisor))
        }
        Ordering::Less => {
            let factor = 10u128.checked_pow(u32::from(treasury_decimals - asset_decimals))?;
            amount.checked_mul(factor)
        }
    }
}

/// Most the treasury may spend on an intent (D-02). Native payouts cost exactly their value.
pub fn max_in(kind: PayoutKind, value: u128, max_fee_bps: u16, max_fixed_fee: u128) -> Option<u128> {
    match kind {
        PayoutKind::Native => Some(value),
        PayoutKind::CrossChain => value
            .checked_mul(10_000 + u128::from(max_fee_bps))?
            .div_ceil(10_000)
            .checked_add(max_fixed_fee),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tron_addresses_need_a_valid_checksum() {
        // USDT's TRC-20 contract and Tron's all-zero address are both valid base58check.
        assert!(is_tron_address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"));
        assert!(is_tron_address("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"));
        // One changed character breaks the checksum.
        assert!(!is_tron_address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"));
        assert!(!is_tron_address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6")); // too short
        assert!(!is_tron_address("0x76b4c56085ED136a8744D52bE956396624a730E8"));
        assert!(!is_tron_address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60")); // '0' is not base58
    }

    #[test]
    fn near_recipients_must_be_account_ids() {
        assert!(validate_recipient(Chain::Near, "supplier.near").is_ok());
        assert!(validate_recipient(Chain::Near, &"a".repeat(64)).is_ok());
        assert!(validate_recipient(Chain::Near, "Bad Account").is_err());
        assert!(validate_recipient(Chain::Near, &"a".repeat(65)).is_err());
    }

    #[test]
    fn unit_conversion_rounds_up() {
        assert_eq!(to_treasury_units(1_234_567, 6, 6), Some(1_234_567));
        assert_eq!(to_treasury_units(1_000_000_000_000_000_001, 18, 6), Some(1_000_001));
        assert_eq!(to_treasury_units(5, 2, 6), Some(50_000));
    }

    #[test]
    fn max_in_adds_percentage_and_fixed_fee() {
        assert_eq!(max_in(PayoutKind::Native, 2_000_000, 100, 1_500_000), Some(2_000_000));
        // 2 USDT to Tron with 1% headroom + 1.5 USDC fixed: 2.02 + 1.5 = 3.52 ≥ the live quote's 2.86585.
        assert_eq!(max_in(PayoutKind::CrossChain, 2_000_000, 100, 1_500_000), Some(3_520_000));
        assert_eq!(max_in(PayoutKind::CrossChain, 1, 1, 0), Some(2)); // rounds up
    }
}
