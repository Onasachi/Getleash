//! A strict parser for the owner's JSON arguments (and `new`), so the contract links no
//! `serde_json` (≈70 KB of wasm, D-28) while wallets still show readable JSON.
//!
//! Accepted: one flat object whose values are strings, non-negative integers (as numbers or
//! digit strings) or booleans. Rejected: anything else, including duplicate keys (a wallet could
//! show one value while the contract read the other), unknown or missing keys, escapes and
//! control characters in strings, signs, fractions, exponents, nesting, `null`, and trailing
//! bytes. Every rejection panics before any state is written.

use near_sdk::{AccountId, env};

const MAX_KEYS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value<'a> {
    Str(&'a str),
    /// Digits of a JSON number, as written.
    Num(&'a str),
    Bool(bool),
}

pub struct Args<'a> {
    pairs: Vec<(&'a str, Value<'a>)>,
}

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn ws(&mut self) {
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.at += 1;
        }
    }

    fn peek(&self) -> u8 {
        if self.at < self.bytes.len() {
            self.bytes[self.at]
        } else {
            0
        }
    }

    fn expect(&mut self, b: u8) {
        if self.peek() != b {
            fail("BAD_JSON");
        }
        self.at += 1;
    }

    /// A string without escapes or control characters; returns its contents.
    fn string(&mut self) -> &'a str {
        self.expect(b'"');
        let start = self.at;
        while self.peek() != b'"' {
            // End of input reads as 0, which is a control character too.
            let c = self.peek();
            if c < 0x20 || c == b'\\' {
                fail("BAD_JSON");
            }
            self.at += 1;
        }
        let text =
            core::str::from_utf8(&self.bytes[start..self.at]).unwrap_or_else(|_| fail("BAD_JSON"));
        self.at += 1;
        text
    }

    fn literal(&mut self, word: &[u8]) {
        if !self.bytes[self.at..].starts_with(word) {
            fail("BAD_JSON");
        }
        self.at += word.len();
    }

    fn value(&mut self) -> Value<'a> {
        match self.peek() {
            b'"' => Value::Str(self.string()),
            b't' => {
                self.literal(b"true");
                Value::Bool(true)
            }
            b'f' => {
                self.literal(b"false");
                Value::Bool(false)
            }
            b'0'..=b'9' => {
                let start = self.at;
                while self.peek().is_ascii_digit() {
                    self.at += 1;
                }
                // Digits only: a following '.', 'e' or 'E' is rejected by the caller's next
                // expected byte (',' or '}').
                Value::Num(
                    core::str::from_utf8(&self.bytes[start..self.at])
                        .unwrap_or_else(|_| fail("BAD_JSON")),
                )
            }
            _ => fail("BAD_JSON"),
        }
    }
}

impl<'a> Args<'a> {
    pub fn parse(bytes: &'a [u8]) -> Args<'a> {
        let mut c = Cursor { bytes, at: 0 };
        let mut pairs: Vec<(&'a str, Value<'a>)> = Vec::new();
        c.ws();
        c.expect(b'{');
        c.ws();
        if c.peek() == b'}' {
            c.at += 1;
        } else {
            loop {
                c.ws();
                let key = c.string();
                if pairs.iter().any(|(k, _)| *k == key) {
                    fail("DUPLICATE_ARG");
                }
                if pairs.len() >= MAX_KEYS {
                    fail("TOO_MANY_ARGS");
                }
                c.ws();
                c.expect(b':');
                c.ws();
                let value = c.value();
                pairs.push((key, value));
                c.ws();
                match c.peek() {
                    b',' => c.at += 1,
                    b'}' => {
                        c.at += 1;
                        break;
                    }
                    _ => fail("BAD_JSON"),
                }
            }
        }
        c.ws();
        if c.at != bytes.len() {
            fail("BAD_JSON");
        }
        Args { pairs }
    }

    fn take(&mut self, key: &str) -> Value<'a> {
        match self.pairs.iter().position(|(k, _)| *k == key) {
            Some(i) => self.pairs.swap_remove(i).1,
            None => fail("MISSING_ARG"),
        }
    }

    #[cfg(test)]
    pub fn pairs_for_tests(self) -> Vec<(&'a str, Value<'a>)> {
        self.pairs
    }

    /// Every key must have been read.
    pub fn done(self) {
        if !self.pairs.is_empty() {
            fail("UNKNOWN_ARG");
        }
    }

    pub fn str(&mut self, key: &str) -> &'a str {
        match self.take(key) {
            Value::Str(s) => s,
            _ => fail("BAD_ARG_TYPE"),
        }
    }

    pub fn bool(&mut self, key: &str) -> bool {
        match self.take(key) {
            Value::Bool(b) => b,
            _ => fail("BAD_ARG_TYPE"),
        }
    }

    /// A non-negative integer given as a JSON number or a digit string (D-17 writes u128 and u64
    /// amounts as strings).
    pub fn u128(&mut self, key: &str) -> u128 {
        let digits = match self.take(key) {
            Value::Num(d) | Value::Str(d) => d,
            Value::Bool(_) => fail("BAD_ARG_TYPE"),
        };
        parse_u128(digits).unwrap_or_else(|| fail("BAD_NUMBER"))
    }

    pub fn u64(&mut self, key: &str) -> u64 {
        u64::try_from(self.u128(key)).unwrap_or_else(|_| fail("BAD_NUMBER"))
    }

    pub fn u32(&mut self, key: &str) -> u32 {
        u32::try_from(self.u128(key)).unwrap_or_else(|_| fail("BAD_NUMBER"))
    }

    pub fn u16(&mut self, key: &str) -> u16 {
        u16::try_from(self.u128(key)).unwrap_or_else(|_| fail("BAD_NUMBER"))
    }

    pub fn u8(&mut self, key: &str) -> u8 {
        u8::try_from(self.u128(key)).unwrap_or_else(|_| fail("BAD_NUMBER"))
    }

    pub fn account(&mut self, key: &str) -> AccountId {
        self.str(key)
            .parse()
            .unwrap_or_else(|_| fail("BAD_ACCOUNT_ID"))
    }

    pub fn string(&mut self, key: &str) -> String {
        self.str(key).to_string()
    }
}

/// Digits only, no leading zeros except "0", at most u128.
pub fn parse_u128(digits: &str) -> Option<u128> {
    let bytes = digits.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 || (bytes.len() > 1 && bytes[0] == b'0') {
        return None;
    }
    let mut n: u128 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        n = n.checked_mul(10)?.checked_add(u128::from(b - b'0'))?;
    }
    Some(n)
}

/// Reads this call's JSON arguments.
pub fn input() -> Vec<u8> {
    env::input().unwrap_or_default()
}
