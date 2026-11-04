//! The GetLeash release store (docs/decisions.md D-31).
//!
//! The operator creates it once, keyless, in one batch: CreateAccount release-<hash>.<operator>, Transfer,
//! DeployContract(this), FunctionCall set(<the release's wasm, as raw bytes>). `set` works once, and only
//! for the account this one is a sub-account of; `get` returns the code to anyone. The installer of each
//! new GetLeash asks for it, and deploys it only if its SHA-256 is the one the business's owner named. The
//! store has no keys and no other method, so what it holds never changes.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod store {
    unsafe extern "C" {
        fn input(register_id: u64);
        fn read_register(register_id: u64, ptr: u64);
        fn register_len(register_id: u64) -> u64;
        fn current_account_id(register_id: u64);
        fn predecessor_account_id(register_id: u64);
        fn panic_utf8(len: u64, ptr: u64) -> !;
        fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
        fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
        fn storage_has_key(key_len: u64, key_ptr: u64) -> u64;
        fn value_return(value_len: u64, value_ptr: u64);
    }

    /// As a length: "the value is in a register".
    const IN_REGISTER: u64 = u64::MAX;
    // Registers.
    const SELF: u64 = 0;
    const CALLER: u64 = 1;
    const DATA: u64 = 2;
    const SCRATCH: u64 = 3;

    const CODE: &[u8] = b"c";

    fn fail(code: &str) -> ! {
        unsafe { panic_utf8(code.len() as u64, code.as_ptr() as u64) }
    }

    fn read(register: u64, buf: &mut [u8; 64]) -> usize {
        let len = unsafe { register_len(register) };
        if len > 64 {
            fail("TOO_LONG");
        }
        unsafe { read_register(register, buf.as_mut_ptr() as u64) };
        len as usize
    }

    /// Once, by the account this one is a sub-account of: keeps the input, the release's wasm, for good.
    #[unsafe(no_mangle)]
    pub extern "C" fn set() {
        let mut me = [0u8; 64];
        let mut caller = [0u8; 64];
        unsafe {
            current_account_id(SELF);
            predecessor_account_id(CALLER);
        }
        let me_len = read(SELF, &mut me);
        let caller_len = read(CALLER, &mut caller);
        let Some(dot) = me[..me_len].iter().position(|&b| b == b'.') else { fail("NO_OWNER") };
        if caller[..caller_len] != me[dot + 1..me_len] {
            fail("NOT_OWNER");
        }
        unsafe {
            if storage_has_key(CODE.len() as u64, CODE.as_ptr() as u64) == 1 {
                fail("ALREADY_SET");
            }
            input(DATA);
            if register_len(DATA) == 0 {
                fail("EMPTY");
            }
            storage_write(CODE.len() as u64, CODE.as_ptr() as u64, IN_REGISTER, DATA, SCRATCH);
        }
    }

    /// Anyone: the release's wasm.
    #[unsafe(no_mangle)]
    pub extern "C" fn get() {
        unsafe {
            if storage_read(CODE.len() as u64, CODE.as_ptr() as u64, DATA) != 1 {
                fail("EMPTY");
            }
            value_return(IN_REGISTER, DATA);
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
