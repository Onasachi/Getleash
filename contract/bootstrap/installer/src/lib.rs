//! The GetLeash installer (docs/decisions.md D-31).
//!
//! A browser wallet can't carry the GetLeash release in a setup request: HOT Wallet's connector would take
//! hours to encode its 84 KB, and gives a request 60 seconds. So a business's setup deploys this installer
//! instead, about a kilobyte, in the same keyless batch as before:
//!
//!   CreateAccount getleash.<owner>, Transfer, DeployContract(installer), FunctionCall install(<new's arguments>)
//!
//! The installer installs one thing only: the release whose SHA-256 is `RELEASE_SHA256`, which it copies
//! from the store `STORE` (both built in: `pnpm build:installer`). `install` (the owner only: the account
//! this one is a sub-account of) keeps `new`'s arguments and asks the store for the code. `on_code`, this
//! account's own callback, deploys that code only if its SHA-256 is the release's, and calls `new` with the
//! owner's arguments, both in one batch: either both happen or neither. From then on the account runs the
//! release and this code is gone. The account never has an access key. If the code never comes, nothing is
//! deployed: the owner can call `install` again, or `abandon`, which deletes the account and sends its NEAR
//! back to the owner, and only while the installer is still its code (its batch first calls `still_installer`,
//! which the release doesn't have, so it fails whole once the release is in).
//!
//! Call `install` again only when the installer is stuck. One sent while another is between `on_code` and
//! the deploy (about a block) lands after `on_code` removed the arguments, keeps its own, and the release
//! starts with them still stored under `i`: harmless (the release's keys are longer, nothing reads `i`,
//! about 0.007 NEAR stays locked) and owner-only, but nothing can remove them short of an upgrade. Nothing
//! here can prevent it without leaving a key of its own: once the release runs, no code of the installer's
//! can delete anything. The setup page never sends `install` twice.
//!
//! Small on purpose (the wallet request carries it): the code and `new`'s arguments stay in NEAR's
//! registers and storage; only the two account ids and the code's hash are read into memory.
#![cfg_attr(target_arch = "wasm32", no_std)]

/// The release's SHA-256, from 64 lowercase hex characters, checked when this is compiled.
#[allow(dead_code)]
const fn hex32(hex: &str) -> [u8; 32] {
    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("GETLEASH_RELEASE_SHA256 must be 64 lowercase hex characters"),
        }
    }
    let bytes = hex.as_bytes();
    assert!(bytes.len() == 64, "GETLEASH_RELEASE_SHA256 must be 64 lowercase hex characters");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(bytes[2 * i]) << 4) | nibble(bytes[2 * i + 1]);
        i += 1;
    }
    out
}

#[cfg(target_arch = "wasm32")]
mod installer {
    // NEAR host functions. A length of u64::MAX takes the value from the register whose id is passed as
    // the pointer.
    unsafe extern "C" {
        fn input(register_id: u64);
        fn read_register(register_id: u64, ptr: u64);
        fn register_len(register_id: u64) -> u64;
        fn current_account_id(register_id: u64);
        fn predecessor_account_id(register_id: u64);
        fn panic_utf8(len: u64, ptr: u64) -> !;
        fn sha256(value_len: u64, value_ptr: u64, register_id: u64);
        fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
        fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
        fn storage_remove(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
        fn promise_result(result_idx: u64, register_id: u64) -> u64;
        fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
        fn promise_batch_then(promise_index: u64, account_id_len: u64, account_id_ptr: u64) -> u64;
        fn promise_batch_action_deploy_contract(promise_index: u64, code_len: u64, code_ptr: u64);
        fn promise_batch_action_function_call_weight(
            promise_index: u64,
            method_name_len: u64,
            method_name_ptr: u64,
            arguments_len: u64,
            arguments_ptr: u64,
            amount_ptr: u64,
            gas: u64,
            gas_weight: u64,
        );
        fn promise_batch_action_delete_account(promise_index: u64, beneficiary_id_len: u64, beneficiary_id_ptr: u64);
    }

    /// The store the release is copied from, and the release's SHA-256.
    const STORE: &str = env!("GETLEASH_RELEASE_STORE");
    const RELEASE_SHA256: [u8; 32] = super::hex32(env!("GETLEASH_RELEASE_SHA256"));

    /// As a length: "the value is in a register".
    const IN_REGISTER: u64 = u64::MAX;
    // Registers.
    const SELF: u64 = 0;
    const CALLER: u64 = 1;
    const INIT: u64 = 2;
    const CODE: u64 = 3;
    const HASH: u64 = 4;
    const SCRATCH: u64 = 5;

    /// Where `install` keeps `new`'s arguments for `on_code`; removed before the release is deployed.
    const KEY_INIT: &[u8] = b"i";
    /// Gas for the store's `get` (it burns about 7 Tgas). What `install` leaves goes to `on_code`, and what
    /// `on_code` leaves goes to `new`.
    const GET_GAS: u64 = 15_000_000_000_000;
    static NO_DEPOSIT: [u8; 16] = [0; 16];

    // One call at a time: plain memory, zero at the start of each call.
    static mut ME: [u8; 64] = [0; 64];
    static mut CALLER_ID: [u8; 64] = [0; 64];
    static mut GOT: [u8; 32] = [0; 32];

    fn fail(code: &str) -> ! {
        unsafe { panic_utf8(code.len() as u64, code.as_ptr() as u64) }
    }

    fn same(a: &[u8], b: &[u8]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
    }

    /// An account id from a register (at most 64 bytes, as NEAR guarantees).
    fn account(register: u64, buf: &'static mut [u8; 64]) -> &'static [u8] {
        let len = unsafe { register_len(register) };
        if len > 64 {
            fail("TOO_LONG");
        }
        unsafe { read_register(register, buf.as_mut_ptr() as u64) };
        &buf[..len as usize]
    }

    /// This account's id (also left in register SELF).
    fn me() -> &'static [u8] {
        unsafe { current_account_id(SELF) };
        account(SELF, unsafe { &mut *(&raw mut ME) })
    }

    /// The account this one is a sub-account of.
    fn owner_of(me: &'static [u8]) -> &'static [u8] {
        match me.iter().position(|&b| b == b'.') {
            Some(dot) => &me[dot + 1..],
            None => fail("NO_OWNER"),
        }
    }

    fn require_caller(expected: &[u8], code: &str) {
        unsafe { predecessor_account_id(CALLER) };
        if !same(account(CALLER, unsafe { &mut *(&raw mut CALLER_ID) }), expected) {
            fail(code);
        }
    }

    fn call(promise: u64, method: &[u8], args_len: u64, args_ptr: u64, gas: u64, weight: u64) {
        unsafe { promise_batch_action_function_call_weight(promise, method.len() as u64, method.as_ptr() as u64, args_len, args_ptr, NO_DEPOSIT.as_ptr() as u64, gas, weight) }
    }

    /// The owner, with `new`'s arguments: keeps them, and asks the store for the release, with `on_code` after.
    #[unsafe(no_mangle)]
    pub extern "C" fn install() {
        require_caller(owner_of(me()), "NOT_OWNER");
        unsafe {
            input(INIT);
            storage_write(KEY_INIT.len() as u64, KEY_INIT.as_ptr() as u64, IN_REGISTER, INIT, SCRATCH);
            let get = promise_batch_create(STORE.len() as u64, STORE.as_ptr() as u64);
            call(get, b"get", 0, 0, GET_GAS, 0);
            let then = promise_batch_then(get, IN_REGISTER, SELF);
            call(then, b"on_code", 0, 0, 0, 1);
        }
    }

    /// This account's callback, with the store's code: deploys it if it is the release, and calls `new` with
    /// the owner's arguments, in one batch.
    #[unsafe(no_mangle)]
    pub extern "C" fn on_code() {
        require_caller(me(), "NOT_SELF");
        let got = unsafe { &mut *(&raw mut GOT) };
        unsafe {
            if promise_result(0, CODE) != 1 {
                fail("NO_CODE");
            }
            sha256(IN_REGISTER, CODE, HASH);
            read_register(HASH, got.as_mut_ptr() as u64);
        }
        if !same(got, &RELEASE_SHA256) {
            fail("NOT_THE_RELEASE");
        }
        unsafe {
            if storage_read(KEY_INIT.len() as u64, KEY_INIT.as_ptr() as u64, INIT) != 1 {
                fail("NOT_INSTALLING");
            }
            storage_remove(KEY_INIT.len() as u64, KEY_INIT.as_ptr() as u64, SCRATCH);
            let batch = promise_batch_create(IN_REGISTER, SELF);
            promise_batch_action_deploy_contract(batch, IN_REGISTER, CODE);
            call(batch, b"new", IN_REGISTER, INIT, 0, 1);
        }
    }

    /// The owner: deletes this account and sends its NEAR back to the owner, if the installer is still its
    /// code when that batch runs (a deploy already on its way may land first).
    #[unsafe(no_mangle)]
    pub extern "C" fn abandon() {
        let owner = owner_of(me());
        require_caller(owner, "NOT_OWNER");
        unsafe {
            let batch = promise_batch_create(IN_REGISTER, SELF);
            call(batch, b"still_installer", 0, 0, 0, 1);
            promise_batch_action_delete_account(batch, owner.len() as u64, owner.as_ptr() as u64);
        }
    }

    /// Does nothing, for anyone, and only the installer has it: in `abandon`'s batch, it fails the deletion
    /// once the release has replaced the installer.
    #[unsafe(no_mangle)]
    pub extern "C" fn still_installer() {}
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
