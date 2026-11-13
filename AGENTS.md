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
- **Every payout goes through `start_payout`** (contract/src/lib.rs): all checks, then state, then the transfer.
  The executor's `fund` takes **only an intent id**. Never add amount, receiver or address parameters to anything
  that moves money; the only executor-chosen terms (a 1Click deposit and amount) are recorded by `create_attempt`
  and bounded there and in `start_payout`.
- Every owner method is `#[payable]` and calls `assert_one_yocto()` plus the owner check **before reading its
  arguments**. Owner arguments are flat JSON read by the strict parser `contract/src/json.rs` (never serde_json in
  the contract, D-28); owner decisions repeat the terms they approve (`decide`: amount and supplier; `authorize`:
  deposit and amount).
- Unauthorized callers must **panic before any state write** (role checks first).
- The policy contract account has **no access keys**. Code changes only through the owner-signed `upgrade`,
  or once, at creation, through the installer (`contract/bootstrap`, D-31), which installs only the release
  whose SHA-256 is built into it, copied from the release store built into it, and only for its parent: the
  owner, or for hosted setups the factory (D-32), which writes `new`'s arguments with its caller as owner.
  The factory, the store and every account they create stay keyless; the factory adds only role keys.
- Budget counters **only go up**: refunds, returned change and failed transfers never give budget back.
- The agent's LLM output is untrusted. No model text goes on-chain, and the model never supplies an address or
  an id: a proposal carries the supplier id from a deterministic directory match, the obligation id (an HMAC
  computed by deterministic ingestion code), the amount the model read (flagged for review unless it appears
  in the invoice's text), and at most the enum `review_flag` (PLAN §4.3, step 7).
- The callback is `#[private] on_paid(intent_id, since)` (its arguments never change across upgrades): a no-op
  unless that payout is still `Paying` with the same `since`, **never panics**, and never grows storage.
- Checked arithmetic everywhere in accounting; no saturating subtraction to hide a bug. `budget.rs` and
  `rules.rs` stay pure (no `env::` calls) so they can be property-tested.
- The contract must stay small (mainnet storage, D-28): `devkit/test/setup.sandbox.test.ts` fails above 150 KB.
  No `format!`, `unwrap`/`expect`, `serde_json` or `near_sdk::store` in contract code; Borsh for machine callers
  and views.
- Never commit secrets: `.env`, key files and `~/.near-credentials` stay out of git. Use `.env.example`.

## Stack choices

- Contract: Rust, `near-sdk` 5.x, scaffolded with `cargo near new`, built with `cargo near build`.
- Contract tests stay in Rust: unit tests + `proptest` (pure rules, the JSON parser against serde_json, and
  random walks over the whole contract) + `near-sandbox`/`near-api` integration tests (docs/decisions.md D-05).
  Borsh layouts are pinned by golden vectors shared with TypeScript (`shared/test/fixtures/borsh-golden.json`).
- TypeScript services: **`near-api-js` only** (one NEAR SDK; do not mix in `near-kit` within a service).
- Verify anything a skill states about endpoints, field names, asset ids or contract addresses against live docs,
  and record it in `docs/verified-facts.md` with the date.

## Repository layout

```
contract/        Rust policy contract v2 (src/budget.rs, src/rules.rs pure; src/json.rs strict owner JSON)
                 bootstrap/: the factory, the installer and the release store, raw wasm without near-sdk (D-31, D-32)
shared/          Borsh types and decoders, role clients, 1Click client, setup flow, address checks.
                 "@getleash/shared" is browser-safe (the dashboard uses it); Node-only helpers
                 (key files, data dir) live in "@getleash/shared/node"
scripts/         owner CLIs (keygen, setup:owner, topup, seed, status, rotate), demo:mock, devnet
executor/        cross-chain payout loop over stored intents
mock-1click/     the executor's local 1Click stand-in
ingestion/       obligation HMAC, update dedupe, limits; PDF text in a plain-Node child process (pdf-worker.mjs, D-33)
agent/           extraction (NEAR AI Cloud; an offline reader for tests), deterministic checks, TEE verification
channels/        channel interface + Telegram (grammY) + MCP server (stdio, D-34)
web/             landing page and Next.js dashboard; the hosted read-only MCP server (/mcp, D-34)
devkit/          local NEAR node harness ("world") and every TypeScript integration test
deploy/          the mainnet policy
fixtures/        demo invoices
docs/            plan, decisions, audit response, verified facts, deployment runbook
.agents/skills/  near/agent-skills (do not edit; reinstall with npx skills)
```

## Commands

```bash
cd contract
cargo test                       # unit + scenario + property tests (~2 min)
PROPTEST_CASES=200 cargo test contract_invariants_hold   # deeper random walks (~10 min)
GOLDEN_WRITE=1 cargo test golden # after a deliberate Borsh layout change: rewrite the shared golden vectors
cargo test --test sandbox -- --ignored   # real wasm on a local NEAR node (needs cargo-near)
cargo near build non-reproducible-wasm --no-embed-abi   # dev build → target/near/getleash_policy.wasm
cargo near build reproducible-wasm       # release build (needs Docker), hash goes in the README

pnpm install
pnpm test               # TypeScript unit tests (no network)
pnpm test:sandbox       # TypeScript integration tests on a local node (devkit/test/*.sandbox.test.ts)
pnpm typecheck          # every package, including web/
pnpm demo:mock          # all fixtures through the whole pipeline, offline; exits 1 on any failed check
pnpm devnet             # long-running local deployment; then `pnpm dashboard` with the printed env
pnpm --silent mcp        # MCP server for AI assistants (stdout is the protocol: keep --silent)
pnpm --silent mcp:ask get_policy   # start it as a client would and print one tool's answer
pnpm build:installer    # build contract/bootstrap and refresh shared/src/installer-wasm.ts (--check: compare only)
pnpm publish:release    # the operator, once per release, on mainnet: the store the installer copies from
pnpm publish:factory    # the operator, once per release, on mainnet: getleash.near, keyless, which hosted setups call
```

**Never run the contract tests with `--release`.** near-sdk's unit-test mock unwinds panics
through host functions declared `extern "C"`; an LTO-optimised build treats them as non-unwinding
and drops the landing pads, so the harness can no longer catch expected panics. Debug builds work.
Plain `cargo build` is also refused by near-sdk; use `cargo near build` or `cargo test`.

## Conventions

- JSON (owner arguments, TypeScript objects): ids are numbers; amounts and ns timestamps are decimal strings;
  32-byte values are 64-char lowercase hex (D-17). Machine interfaces are Borsh (D-28).
- Reason codes are SCREAMING_SNAKE_CASE enums; never put free text from a model on-chain.
- Every behaviour change to the contract needs a test; adversarial cases from PLAN §9 are named after the table row.
- The README is read by an AI screener: keep claims exact and give "do X → see Y" steps. No marketing.
- Disclose AI assistance and reused code in the README ("Tools and AI assistance").
- TypeScript: amounts are bigint or decimal strings, never floats (`shared/src/units.ts`). Decode every
  view result with the strict Borsh decoders in `shared/src/types.ts`, and parse every external response with zod. Call `fetch` unbound
  (`(i, init) => fetch(i, init)`); browsers reject it as a method of another object.
- Any behaviour that touches the chain gets a test in `devkit/test/` against the real wasm; the
  offline demo's expectations are part of the test surface too.
