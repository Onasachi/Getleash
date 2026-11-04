//! The GetLeash factory (docs/decisions.md D-32).
//!
//! HOT Wallet marks any request that deploys a contract as dangerous and has the user type CONFIRM, even
//! when the contract goes into a brand-new account. So a business's wallet deploys nothing: it makes one call,
//!
//!   create({"agent":"<64 hex>","executor":"<64 hex>"}), with exactly the setup's cost attached,
//!
//! and the factory sets GetLeash up for the caller, who becomes its owner:
//!   - `<name>-agent.<factory>` and `<name>-executor.<factory>`, each with NEAR for gas and exactly one key, the
//!     one given (the GetLeash service's), which can only call the owner's contract's role methods;
//!   - `<name>.<factory>`, the contract: created with the installer, which copies the release from the store,
//!     checks its SHA-256 and initialises it with arguments the factory writes: the caller as owner, the two
//!     accounts above, USDC and GetLeash's default limits. It never has an access key;
//!   - its registration on USDC.
//! `<name>` is the caller's account id with its dots made dashes (onasachi.tg → onasachi-tg). The factory
//! keeps one record per name and refuses a name it set up before, and a name ending in `-agent` or
//! `-executor` (so no contract's name is ever another setup's role account), so nothing it creates already
//! exists (only it can create accounts under its own name), and a refused call costs nothing. Two owners
//! whose ids differ only by a dot where the other has a dash share a name: the second is refused.
//! `retry_install`, for the recorded owner only, asks the installer again with all the gas the owner
//! attaches, should a contract ever be left without the release. The factory has no keys and no other
//! method, so it can't touch a contract once created: from then on only the owner's wallet can change it.
//!
//! What it sets up (amounts, methods, the token, the limits, the installer) is built in from shared/
//! (`src/config.rs`, written by `pnpm build:installer`), so its code hash says all of it.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod config;

#[cfg(target_arch = "wasm32")]
mod factory {
    use crate::config::*;

    // NEAR host functions. A length of u64::MAX takes the value from the register whose id is passed as
    // the pointer.
    unsafe extern "C" {
        fn input(register_id: u64);
        fn read_register(register_id: u64, ptr: u64);
        fn register_len(register_id: u64) -> u64;
        fn current_account_id(register_id: u64);
        fn predecessor_account_id(register_id: u64);
        fn attached_deposit(balance_ptr: u64);
        fn panic_utf8(len: u64, ptr: u64) -> !;
        fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
        fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
        fn storage_has_key(key_len: u64, key_ptr: u64) -> u64;
        fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
        fn promise_batch_action_create_account(promise_index: u64);
        fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
        fn promise_batch_action_deploy_contract(promise_index: u64, code_len: u64, code_ptr: u64);
        fn promise_batch_action_function_call(
            promise_index: u64,
            method_name_len: u64,
            method_name_ptr: u64,
            arguments_len: u64,
            arguments_ptr: u64,
            amount_ptr: u64,
            gas: u64,
        );
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
        fn promise_batch_action_add_key_with_function_call(
            promise_index: u64,
            public_key_len: u64,
            public_key_ptr: u64,
            nonce: u64,
            allowance_ptr: u64,
            receiver_id_len: u64,
            receiver_id_ptr: u64,
            method_names_len: u64,
            method_names_ptr: u64,
        );
    }

    // Registers.
    const SELF: u64 = 0;
    const CALLER: u64 = 1;
    const DATA: u64 = 2;
    const SCRATCH: u64 = 3;

    /// The setup's cost: what the three accounts get, the USDC registration, and this factory's record.
    const TOTAL: u128 = AGENT_BALANCE + EXECUTOR_BALANCE + POLICY_BALANCE + REGISTRATION_DEPOSIT + RECORD;

    static NO_DEPOSIT: [u8; 16] = [0; 16];
    static AGENT_NEAR: [u8; 16] = AGENT_BALANCE.to_le_bytes();
    static AGENT_KEY_ALLOWANCE: [u8; 16] = AGENT_ALLOWANCE.to_le_bytes();
    static EXECUTOR_NEAR: [u8; 16] = EXECUTOR_BALANCE.to_le_bytes();
    static EXECUTOR_KEY_ALLOWANCE: [u8; 16] = EXECUTOR_ALLOWANCE.to_le_bytes();
    static POLICY_NEAR: [u8; 16] = POLICY_BALANCE.to_le_bytes();
    static REGISTRATION_NEAR: [u8; 16] = REGISTRATION_DEPOSIT.to_le_bytes();

    // One call at a time: plain memory, zero at the start of each call.
    static mut OWNER: [u8; 64] = [0; 64];
    static mut ME: [u8; 64] = [0; 64];
    static mut STORED: [u8; 64] = [0; 64];
    static mut POLICY: [u8; 64] = [0; 64];
    static mut AGENT: [u8; 64] = [0; 64];
    static mut EXECUTOR: [u8; 64] = [0; 64];
    static mut RECORD_KEY: [u8; 65] = [0; 65];
    static mut ARGS: [u8; 160] = [0; 160];
    static mut KEYS: [u8; 66] = [0; 66];
    static mut INIT: [u8; 1024] = [0; 1024];
    static mut REGISTRATION_ARGS: [u8; 128] = [0; 128];
    static mut DEPOSIT: [u8; 16] = [0; 16];

    fn fail(code: &str) -> ! {
        unsafe { panic_utf8(code.len() as u64, code.as_ptr() as u64) }
    }

    fn same(a: &[u8], b: &[u8]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
    }

    /// A register's value, read into `buf` (refused if it doesn't fit).
    fn read(register: u64, buf: &'static mut [u8]) -> &'static [u8] {
        let len = unsafe { register_len(register) };
        if len > buf.len() as u64 {
            fail("TOO_LONG");
        }
        unsafe { read_register(register, buf.as_mut_ptr() as u64) };
        &buf[..len as usize]
    }

    /// Bytes written one after another into a fixed buffer, which they may not overflow.
    struct Out {
        buf: &'static mut [u8],
        len: usize,
    }

    impl Out {
        fn into(buf: &'static mut [u8]) -> Out {
            Out { buf, len: 0 }
        }

        fn put(mut self, bytes: &[u8]) -> Out {
            let end = self.len + bytes.len();
            if end > self.buf.len() {
                fail("TOO_LONG");
            }
            self.buf[self.len..end].copy_from_slice(bytes);
            self.len = end;
            self
        }

        /// The owner's account id as a name: its dots made dashes.
        fn name(mut self, owner: &[u8]) -> Out {
            for &b in owner {
                self = self.put(if b == b'.' { b"-" } else { core::slice::from_ref(&b) });
            }
            self
        }

        fn done(self) -> &'static [u8] {
            let buf: &'static [u8] = self.buf;
            &buf[..self.len]
        }
    }

    fn caller() -> &'static [u8] {
        unsafe { predecessor_account_id(CALLER) };
        read(CALLER, unsafe { &mut *(&raw mut OWNER) })
    }

    fn me() -> &'static [u8] {
        unsafe { current_account_id(SELF) };
        read(SELF, unsafe { &mut *(&raw mut ME) })
    }

    /// The accounts set up for `owner`: its contract, its agent and its executor, under this factory.
    struct Accounts {
        policy: &'static [u8],
        agent: &'static [u8],
        executor: &'static [u8],
    }

    fn accounts(owner: &[u8], me: &[u8]) -> Accounts {
        Accounts {
            policy: Out::into(unsafe { &mut *(&raw mut POLICY) }).name(owner).put(b".").put(me).done(),
            agent: Out::into(unsafe { &mut *(&raw mut AGENT) }).name(owner).put(b"-agent.").put(me).done(),
            executor: Out::into(unsafe { &mut *(&raw mut EXECUTOR) }).name(owner).put(b"-executor.").put(me).done(),
        }
    }

    fn record_key(owner: &[u8]) -> &'static [u8] {
        Out::into(unsafe { &mut *(&raw mut RECORD_KEY) }).put(b"o").name(owner).done()
    }

    /// `new`'s arguments, as `new` reads them: the owner, the two role accounts, the token, the default limits.
    fn init_args(owner: &[u8], accounts: &Accounts) -> &'static [u8] {
        Out::into(unsafe { &mut *(&raw mut INIT) })
            .put(b"{\"owner_id\":\"")
            .put(owner)
            .put(b"\",\"agent_id\":\"")
            .put(accounts.agent)
            .put(b"\",\"executor_id\":\"")
            .put(accounts.executor)
            .put(b"\",\"token_id\":\"")
            .put(TOKEN.as_bytes())
            .put(b"\",\"token_decimals\":")
            .put(TOKEN_DECIMALS.as_bytes())
            .put(b",")
            .put(POLICY_JSON.as_bytes())
            .put(b"}")
            .done()
    }

    fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => fail("BAD_ARGS"),
        }
    }

    /// The two public keys, exactly {"agent":"<64 hex>","executor":"<64 hex>"} (JSON.stringify's order and
    /// spacing), as NEAR's binary keys: ed25519 (0), then the 32 bytes. Agent at 0..33, executor at 33..66.
    fn keys(args: &[u8]) -> &'static [u8; 66] {
        const AGENT_AT: usize = b"{\"agent\":\"".len();
        const EXECUTOR_AT: usize = AGENT_AT + 64 + b"\",\"executor\":\"".len();
        if args.len() != EXECUTOR_AT + 64 + 2
            || !same(&args[..AGENT_AT], b"{\"agent\":\"")
            || !same(&args[AGENT_AT + 64..EXECUTOR_AT], b"\",\"executor\":\"")
            || !same(&args[EXECUTOR_AT + 64..], b"\"}")
        {
            fail("BAD_ARGS");
        }
        let keys = unsafe { &mut *(&raw mut KEYS) };
        for (at, hex) in [(0, AGENT_AT), (33, EXECUTOR_AT)] {
            keys[at] = 0;
            for i in 0..32 {
                keys[at + 1 + i] = (nibble(args[hex + 2 * i]) << 4) | nibble(args[hex + 2 * i + 1]);
            }
        }
        keys
    }

    fn call(promise: u64, method: &[u8], args: &[u8], deposit: &[u8; 16], gas: u64) {
        unsafe {
            promise_batch_action_function_call(
                promise,
                method.len() as u64,
                method.as_ptr() as u64,
                args.len() as u64,
                args.as_ptr() as u64,
                deposit.as_ptr() as u64,
                gas,
            )
        }
    }

    /// A role account: created, given NEAR for gas and the one key, which can call only `methods` on `policy`.
    fn role(account: &[u8], near: &[u8; 16], key: &[u8], allowance: &[u8; 16], policy: &[u8], methods: &str) {
        unsafe {
            let p = promise_batch_create(account.len() as u64, account.as_ptr() as u64);
            promise_batch_action_create_account(p);
            promise_batch_action_transfer(p, near.as_ptr() as u64);
            promise_batch_action_add_key_with_function_call(
                p,
                key.len() as u64,
                key.as_ptr() as u64,
                0,
                allowance.as_ptr() as u64,
                policy.len() as u64,
                policy.as_ptr() as u64,
                methods.len() as u64,
                methods.as_ptr() as u64,
            );
        }
    }

    /// Anyone, with exactly the setup's cost attached: sets up GetLeash for the caller (see above).
    #[unsafe(no_mangle)]
    pub extern "C" fn create() {
        let owner = caller();
        if [b".agent" as &[u8], b"-agent", b".executor", b"-executor"].iter().any(|end| owner.ends_with(end)) {
            fail("BAD_NAME");
        }
        let me = me();
        let accounts = accounts(owner, me);
        let deposit = unsafe {
            attached_deposit((&raw mut DEPOSIT) as u64);
            u128::from_le_bytes(*(&raw const DEPOSIT))
        };
        if deposit != TOTAL {
            fail("WRONG_DEPOSIT");
        }
        let record = record_key(owner);
        unsafe {
            if storage_has_key(record.len() as u64, record.as_ptr() as u64) == 1 {
                fail("TAKEN");
            }
            storage_write(record.len() as u64, record.as_ptr() as u64, owner.len() as u64, owner.as_ptr() as u64, SCRATCH);
            input(DATA);
        }
        let keys = keys(read(DATA, unsafe { &mut *(&raw mut ARGS) }));
        role(accounts.agent, &AGENT_NEAR, &keys[..33], &AGENT_KEY_ALLOWANCE, accounts.policy, AGENT_METHODS);
        role(accounts.executor, &EXECUTOR_NEAR, &keys[33..], &EXECUTOR_KEY_ALLOWANCE, accounts.policy, EXECUTOR_METHODS);
        unsafe {
            let p = promise_batch_create(accounts.policy.len() as u64, accounts.policy.as_ptr() as u64);
            promise_batch_action_create_account(p);
            promise_batch_action_transfer(p, POLICY_NEAR.as_ptr() as u64);
            promise_batch_action_deploy_contract(p, INSTALLER.len() as u64, INSTALLER.as_ptr() as u64);
            call(p, b"install", init_args(owner, &accounts), &NO_DEPOSIT, INSTALL_GAS);
            let registration = Out::into(&mut *(&raw mut REGISTRATION_ARGS))
                .put(b"{\"account_id\":\"")
                .put(accounts.policy)
                .put(b"\",\"registration_only\":true}")
                .done();
            let r = promise_batch_create(TOKEN.len() as u64, TOKEN.as_ptr() as u64);
            call(r, b"storage_deposit", registration, &REGISTRATION_NEAR, REGISTRATION_GAS);
        }
    }

    /// The recorded owner only: asks their contract's installer to install the release again, with all the gas
    /// this call has left (a no-op once the release runs there: it has no `install`).
    #[unsafe(no_mangle)]
    pub extern "C" fn retry_install() {
        let owner = caller();
        let me = me();
        let record = record_key(owner);
        unsafe {
            if storage_read(record.len() as u64, record.as_ptr() as u64, DATA) != 1 {
                fail("NOT_YOURS");
            }
        }
        if !same(read(DATA, unsafe { &mut *(&raw mut STORED) }), owner) {
            fail("NOT_YOURS");
        }
        let accounts = accounts(owner, me);
        let init = init_args(owner, &accounts);
        unsafe {
            let p = promise_batch_create(accounts.policy.len() as u64, accounts.policy.as_ptr() as u64);
            promise_batch_action_function_call_weight(p, 7, b"install".as_ptr() as u64, init.len() as u64, init.as_ptr() as u64, NO_DEPOSIT.as_ptr() as u64, 0, 1);
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
