# getleash-policy (v2)

The GetLeash policy contract: one business's USDC treasury and the rules an AI agent cannot break.
Spec: [`../docs/PLAN.md`](../docs/PLAN.md) §4.1, as changed by [`../docs/decisions.md`](../docs/decisions.md)
**D-28** (the lean v2 for a ~1.5 NEAR mainnet deployment; v1 is git tag `v1-full-contract`).

```bash
cargo test                                               # unit, scenario and property tests (debug mode only)
cargo test --test sandbox -- --ignored                   # the real wasm on a local NEAR node
cargo near build non-reproducible-wasm --no-embed-abi    # → target/near/getleash_policy.wasm (≈86 KB)
```

## Roles

| Caller | Key | Methods | Arguments |
|---|---|---|---|
| owner | full access, exactly 1 yoctoNEAR per call | everything under "Owner" | flat JSON, read strictly (`src/json.rs`) |
| agent | function-call key | `propose` | Borsh |
| executor | function-call key (no deposits) | `create_attempt`, `fund`, `forget` | Borsh |
| this contract | — | `on_paid`, `migrate` | Borsh |

## Lifecycle

```
propose ─refused─▶ nothing stored (reason returned and logged)
propose ─within the agent's limits─▶ native: PAYING (paid in this call) │ cross-chain: APPROVED
propose ─otherwise─▶ PENDING ─decide APPROVE─▶ native: PAYING │ cross-chain: APPROVED
APPROVED ─create_attempt (executor: 1Click deposit + amount)─▶ APPROVED with an attempt
         ─authorize(deposit, amount) by the owner, or room in the trust budget─▶ fund ─▶ PAYING
PAYING ─on_paid(intent, since)─▶ PAID │ FAILED          (stuck past callback_grace_ns: MARK_PAID / MARK_FAILED)
FAILED, or cross-chain PAID that 1Click refunded ─decide RETRY─▶ native: PAYING │ cross-chain: APPROVED
PENDING │ APPROVED ─decide REJECT─▶ REJECTED (the invoice stays blocked)
```

Every payout goes through `start_payout`: not paused; supplier active at the intent's revision; not
expired; the invoice still maps to this intent; ≥ 60 TGas; within the daily cap; for cross-chain, a
live quote, the fee bound and either the owner's signature or room in today's executor-trust budget
at the current executor epoch, outside the supplier's cooldown. Native payouts are one
`ft_transfer`; cross-chain payouts are one receipt `[storage_deposit, ft_transfer]` to the token.

## Methods

**Agent**
- `propose(obligation: [u8; 32], supplier_id: u32, amount_out: u128, flag: u8) → ProposeResult`.
  Refusals store nothing: `PAUSED`, `UNKNOWN_SUPPLIER`, `INACTIVE_SUPPLIER`,
  `OBLIGATION_OPEN_OR_PAID`, `OBLIGATION_REJECTED`, `STORAGE_FULL`, `BAD_AMOUNT`. Accepted intents
  are routed `AUTONOMOUS` or wait for the owner with `ABOVE_THRESHOLD`, `AUTONOMOUS_BUDGET_USED`,
  `DAILY_CAP`, `REVIEW_FLAG` or `SUPPLIER_COOLDOWN`. Panics (before any write) on `ONLY_AGENT`,
  `BAD_AMOUNT`, `BAD_FLAG`, `QUOTA_PROPOSALS`.

**Executor**
- `create_attempt(intent_id: u64, deposit: [u8; 32], amount_in: u128, deadline: u64)`: cross-chain
  intents only; `value − fee% ≤ amount_in ≤ max_in`; deadline within (now + quote validity, now + 1 day];
  never the contract, the token or a role; replaces an unfunded attempt but never with the same deposit.
- `fund(intent_id: u64)`: id only.
- `forget(ids: Vec<u64>) → u32` (also the owner): closed intents after `retention_ns`; never-funded
  expired or stale ones at once, freeing their invoice; never a payout in flight.

**Owner** (exactly 1 yoctoNEAR; JSON)
- `decide {intent_id, action, amount_out, supplier_id}` with `APPROVE`, `REJECT`, `RETRY`,
  `MARK_PAID`, `MARK_FAILED`; the amount and supplier must repeat the intent's.
- `authorize {intent_id, deposit, amount_in}`: signs exactly that 1Click deposit.
- `add_supplier {chain, asset_id, recipient, decimals} → u32` (Borsh result), `update_supplier
  {supplier_id, …}` (bumps the revision, restarts the cooldown), `set_supplier_active {supplier_id, active}`.
- `set_policy {…the policy's fields}`, `set_paused {paused}`, `set_roles {agent_id, executor_id}`
  (a new executor bumps the epoch), `withdraw {amount}`, `withdraw_near {amount}`, `upgrade` (raw wasm
  as input; refused while a payout is in flight; deploys and migrates in one receipt).
- `new {owner_id, agent_id, executor_id, token_id, token_decimals, …the policy's fields}` once, in the
  setup batch.

**Views** (Borsh): `get_state`, `get_suppliers(from: u32, limit: u32)`, `get_intents(from: u64, limit: u32)`.

## Source map

| File | What |
|---|---|
| `src/budget.rs` | Pure: per-day counters, unit conversion, fee bounds |
| `src/rules.rs` | Pure: the routing rule and the cooldown |
| `src/json.rs` | Strict flat-JSON reader for the owner's arguments |
| `src/types.rs` | Policy, suppliers, intents, attempts, results, views |
| `src/lib.rs` | State, init, upgrade/migrate, raw storage, `start_payout`, `on_paid` |
| `src/agent.rs` | `propose` |
| `src/executor.rs` | `create_attempt`, `fund`, `forget` |
| `src/owner.rs` | Owner methods |
| `src/views.rs` | Views |
| `src/validate.rs`, `src/events.rs` | Input checks and encoders; NEP-297 events written by hand |
| `src/tests/` | Simulated-chain harness, unit tests, property tests, JSON fuzzing, golden Borsh vectors |
| `tests/sandbox.rs` | The real wasm on a local node |
| `bootstrap/` | Not this contract: the installer a setup from a browser wallet deploys, which copies this release from the release store and calls `new` from the account itself (`INIT_ONLY_BY_OWNER` allows that caller), and the store (docs/decisions.md D-31; tests in `devkit/test/installer.sandbox.test.ts`) |
