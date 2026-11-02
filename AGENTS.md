# AGENTS.md — rules for coding agents working on GetLeash

GetLeash is an AI agent that pays a business's suppliers across chains under on-chain rules it cannot break.
A NEAR policy contract holds the treasury and decides every payment; the agent only proposes, the executor only
funds terms already committed on-chain, and the owner's wallet holds every key that matters.

## Sources of truth, in order

1. [`docs/PLAN.md`](docs/PLAN.md): the implementation plan (v3, post-audit).
2. [`docs/decisions.md`](docs/decisions.md): where the code deliberately departs from or tightens the plan.
3. `docs/audit-response.md` (once written): audit finding → fix → test.
4. [`docs/verified-facts.md`](docs/verified-facts.md): endpoints, field names, asset ids, fees, checked against live docs.
5. The skills in `.agents/skills/` (installed with `npx skills add near/agent-skills`). They show generic patterns.
   **When a skill conflicts with 1–4, 1–4 win.**

## Hard rules (security; never relax without updating docs/decisions.md and the tests)

- Executions use **non-dry** 1Click quotes with explicit `depositType=ORIGIN_CHAIN`, `recipientType=DESTINATION_CHAIN`,
  `refundType=ORIGIN_CHAIN`, `refundTo=<policy contract>`. `dry: true` is for previews only.
- Executor funding methods (`fund_native`, `fund_crosschain`) take **only an attempt id**. Never add amount, receiver
  or address parameters to anything that moves money.
- Every owner method is `#[payable]` and calls `assert_one_yocto()` plus the owner check.
- Unauthorized callers must **panic before any state write** (`assert_owner/agent/executor` first).
- The policy contract account has **no access keys**. Code changes only through the owner-signed `upgrade`.
- Refunds and returned change **never restore budgets**. Only the owner credits returned funds (`reconcile_inflows`).
- The agent's LLM output is untrusted. Nothing model-generated goes on-chain except the enum `review_flag`; the
  obligation id is an HMAC computed by deterministic ingestion code.
- Callbacks are `#[private]`, take the attempt id, are no-ops unless the attempt is still `FundingPending`, and
  **never panic** (compute on copies, commit at the end, log and return on error).
- Checked arithmetic everywhere in accounting; no saturating subtraction to hide a bug. `ledger.rs` stays pure
  (no `env::` calls) so it can be property-tested.
- Never commit secrets: `.env`, key files and `~/.near-credentials` stay out of git. Use `.env.example`.

## Stack choices

- Contract: Rust, `near-sdk` 5.x, scaffolded with `cargo near new`, built with `cargo near build`.
- Contract tests stay in Rust: unit tests + `proptest` (ledger and full contract state machine) +
  `near-sandbox`/`near-api` integration tests (docs/decisions.md D-05).
- TypeScript services: **`near-api-js` only** (one NEAR SDK; do not mix in `near-kit` within a service).
- Verify anything a skill states about endpoints, field names, asset ids or contract addresses against live docs,
  and record it in `docs/verified-facts.md` with the date.

## Repository layout

```
contract/        Rust policy contract (src/ledger.rs = pure accounting core)
shared/          contract types (zod), role clients, term hashes, 1Click client, setup flow.
                 "@getleash/shared" is browser-safe (the dashboard uses it); Node-only helpers
                 (key files, data dir) live in "@getleash/shared/node"
scripts/         owner CLIs (keygen, setup:owner, topup, seed, status, rotate), demo:mock, devnet
executor/        payout loop over get_open_work(); mock-1click/ is its local 1Click stand-in
ingestion/       obligation HMAC, update dedupe, limits; agent/ extraction, checks, TEE verification
channels/        channel interface + Telegram (grammY); web/ Next.js dashboard
devkit/          local NEAR node harness ("world") and every TypeScript integration test
fixtures/        demo invoices; docs/ plan, decisions, audit response, verified facts
.agents/skills/  near/agent-skills (do not edit; reinstall with npx skills)
```

## Commands

```bash
cd contract
cargo test                       # unit + scenario + property tests (~2 min)
PROPTEST_CASES=500 cargo test contract_invariants_hold   # deeper random walks
cargo test --test sandbox -- --ignored   # real wasm on a local NEAR node (needs cargo-near)
cargo near build non-reproducible-wasm   # dev build → target/near/getleash_policy.wasm
cargo near build reproducible-wasm       # release build (needs Docker), hash goes in the README

pnpm install
pnpm test               # TypeScript unit tests (no network)
pnpm test:sandbox       # TypeScript integration tests on a local node (devkit/test/*.sandbox.test.ts)
pnpm typecheck          # every package, including web/
pnpm demo:mock          # all fixtures through the whole pipeline, offline; exits 1 on any failed check
pnpm devnet             # long-running local deployment; then `pnpm dashboard` with the printed env
```

**Never run the contract tests with `--release`.** near-sdk's unit-test mock unwinds panics
through host functions declared `extern "C"`; an LTO-optimised build treats them as non-unwinding
and drops the landing pads, so the harness can no longer catch expected panics. Debug builds work.
Plain `cargo build` is also refused by near-sdk; use `cargo near build` or `cargo test`.

## Conventions

- JSON: ids are numbers; amounts and ns timestamps are decimal strings; hashes are 64-char hex (D-17).
- Reason codes are SCREAMING_SNAKE_CASE enums; never put free text from a model on-chain.
- Every behaviour change to the contract needs a test; adversarial cases from PLAN §9 are named after the table row.
- The README is read by an AI screener: keep claims exact and give "do X → see Y" steps. No marketing.
- Disclose AI assistance and reused code in the README ("Tools and AI assistance").
- TypeScript: amounts are bigint or decimal strings, never floats (`shared/src/units.ts`). Parse
  every view result and every external response with zod. Call `fetch` unbound
  (`(i, init) => fetch(i, init)`); browsers reject it as a method of another object.
- Any behaviour that touches the chain gets a test in `devkit/test/` against the real wasm; the
  offline demo's expectations are part of the test surface too.
