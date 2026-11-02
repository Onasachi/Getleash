# getleash-policy

The GetLeash policy contract: one business's USDC treasury and the rules an AI agent cannot break.
Spec: [`../docs/PLAN.md`](../docs/PLAN.md) §4.1. Deviations: [`../docs/decisions.md`](../docs/decisions.md).

```bash
cargo test                                # unit + scenario + property tests (debug mode only)
cargo near build non-reproducible-wasm    # → target/near/getleash_policy.wasm (+ ABI)
```

## Roles

| Caller | Key | Methods |
|---|---|---|
| owner | full access, 1 yoctoNEAR per call | everything under "Owner" |
| agent | function-call key | `propose_payment` |
| executor | function-call key (no deposits) | everything under "Executor" |
| treasury token (USDC) | — | `ft_on_transfer` |
| this contract | — | callbacks, `migrate` |

## Lifecycle

```
propose_payment ─▶ Intent Pending ──approve(hash)──▶ Approved ◀── (auto-approved if Autonomous)
Approved ─create_attempt_*─▶ Attempt Authorized | AwaitingOwner ──authorize_attempt(hash)──▶ Authorized
Authorized ─fund_*─▶ FundingPending ─callback ok─▶ Delivered (native) | Funded (cross-chain) ─report_delivery─▶ Delivered
                                    └ callback failed ─▶ Failed (ledger restored, intent Approved again)
FundingPending (stuck) | Funded ─flag_reconciliation─▶ NeedsReconciliation ─resolve_reconciliation (owner)─▶ …
Pending | Approved ─expires / cancel / supplier changed─▶ Expired | Cancelled | Invalidated
```

## Methods

JSON conventions: ids are numbers; amounts and nanosecond timestamps are decimal strings; hashes and
obligation ids are 64-char hex.

**Agent**
- `propose_payment(obligation_id, supplier_id, amount_out, review_flag?) → ProposeResult`.
  Rejections are returned (and recorded) rather than panicked: `PAUSED`, `UNKNOWN_SUPPLIER`,
  `INACTIVE_SUPPLIER`, `ASSET_DISABLED`, `OBLIGATION_OPEN_OR_PAID`, `OBLIGATION_REJECTED`,
  `SUPPLIER_COOLDOWN`, `OVER_UNVERIFIED_BUDGET`, `OVER_PER_PAYMENT_CAP`, `OVER_MONTHLY_SUPPLIER_CAP`,
  `OVER_DAILY_CAP`, `OVER_MONTHLY_CAP`, `INSUFFICIENT_FUNDS`.

**Executor**
- `create_attempt_native(intent_id) → attempt_id`
- `create_attempt_crosschain(intent_id, deposit_address, amount_in, quote_deadline, quote_ref) → attempt_id`
- `register_recipient(attempt_id)`: storage-registers the attempt's committed payee on USDC
- `fund_native(attempt_id)`, `fund_crosschain(attempt_id)`: attach ≥ 60 TGas
- `report_delivery(attempt_id, delivered_amount, dest_tx)`: informational, credits nothing
- `flag_reconciliation(attempt_id)`, `cancel_attempt(attempt_id)`, `sweep(limit)`, `prune(limit)`
  (these four also accept the owner)

**Owner** (all need exactly 1 yoctoNEAR)
- Intents: `approve(intent_id, expected_intent_hash)`, `reject`, `cancel`, `amend_intent(intent_id, amount_out)`
- Attempts: `authorize_attempt(attempt_id, expected_attempt_hash)`, `resolve_reconciliation(attempt_id, outcome)`
- Money: `reconcile_inflows(entries)`, `withdraw(amount)`, `withdraw_near(amount)`
- Suppliers: `add_supplier`, `update_supplier` (destination; bumps revision, restarts cooldown,
  invalidates open intents), `set_supplier_caps`, `verify_supplier(supplier_id, revision)`, `set_supplier_active`
- Assets: `add_asset(asset_id, chain, decimals, max_fixed_fee)`, `set_asset`
- Control: `set_policy`, `set_hosted_mode`, `pause`, `unpause`, `rotate_agent`, `rotate_executor`,
  `upgrade` (raw wasm as input; deploys and migrates in one receipt)

**Views**: `get_config`, `get_policy`, `get_ledger`, `get_budgets_today`, `get_supplier`,
`list_suppliers`, `list_assets`, `get_intent`, `get_attempt`, `get_obligation`, `get_open_work`,
`get_recent_rejections`.

## Source map

| File | What |
|---|---|
| `src/ledger.rs` | Pure accounting: `cash`, `reserved`, `in_flight`, period counters, invariants |
| `src/types.rs` | Suppliers, intents, attempts, policy, result shapes |
| `src/lib.rs` | State, init, upgrade/migrate, shared rule checks and helpers |
| `src/agent.rs` | `propose_payment` and routing |
| `src/executor.rs` | Attempts, funding, the transfer callback, sweeps, pruning, `ft_on_transfer` |
| `src/owner.rs` | Owner methods |
| `src/views.rs` | Views |
| `src/hash.rs`, `src/validate.rs`, `src/events.rs` | Term hashes, input validation and fee bounds, NEP-297 events |
| `src/tests/` | Simulated-chain harness, scenario tests, property tests |
