# GetLeash

**An AI agent that pays a business's suppliers across chains, under on-chain rules it cannot break.**

> GetLeash is self-custodial: each business's treasury is a contract controlled only by its own
> wallet, and GetLeash holds no key that can withdraw or redirect funds. It limits autonomous
> payments to authorized destinations and budgets, binds approvals to specific payment terms, and
> makes its remaining settlement trust dependencies explicit.

Built for the NEAR Hackathon (1–14 Nov 2026). Tracks: `realworld`, `business`, `security`,
`privacy`, `agents`.

## The problem

A small importer pays suppliers in USDC on NEAR and USDT on Tron. Paying invoices by hand is slow,
and invoice fraud (fake invoices, swapped bank or wallet details) is common. Handing an AI agent a
wallet would fix the speed and make the fraud worse: one prompt injection and the money is gone.

## How GetLeash works

- The **policy contract** (NEAR, Rust) holds the business's USDC and decides every payment. It
  pays only suppliers the owner allowlisted, within daily, monthly, autonomous and per-supplier
  budgets, and only on terms the owner's approval is bound to by hash.
- The **agent** (TypeScript, private inference on NEAR AI Cloud) reads invoices sent to a Telegram
  bot and calls `propose_payment(obligation_id, supplier_id, amount, review_flag)`. It never
  supplies an address: the supplier id comes from a deterministic directory match, the obligation
  id is a keyed HMAC of supplier and invoice number computed by ingestion code, and the only
  model-influenced value on-chain is an enum review flag that can only force review.
- The **executor** (TypeScript, no LLM) funds what the contract committed: native USDC transfers,
  or NEAR Intents 1Click swaps for other chains (non-dry `EXACT_OUTPUT` quotes, refunds to the
  contract). Its funding methods take only an attempt id.
- The **dashboard** (Next.js) reads the chain from the owner's browser, recomputes every hash
  before offering a signature, and cross-checks cross-chain attempts against 1Click's own status
  for the deposit address.
- The **owner's wallet** holds every power that matters: approvals (bound to an intent hash),
  supplier changes, policy, withdrawals, upgrades. Each owner call needs 1 yoctoNEAR, so it needs
  a wallet confirmation. The contract account itself has no access keys.

What a compromised component can do, at most:

| Component | Worst case |
|---|---|
| Agent key / host | Propose payments to **already allowlisted** suppliers, auto-approved only up to the daily autonomous budget. |
| Executor key (hosted mode) | Fund attempts the owner already signed. It cannot send funds to a new destination. |
| Executor key (self-hosted, opt-in) | Redirect cross-chain payments up to the owner-set daily executor-trust budget (default 0). |
| GetLeash the company | Nothing: it holds no key on any customer account. |

Settlement trust that remains: during a cross-chain swap, funds sit briefly with NEAR Intents /
1Click; USDC is issued by Circle, which can freeze tokens.

## Status (2 Nov 2026)

| Part | State |
|---|---|
| Policy contract (`contract/`) | **Implemented.** 65 Rust tests (unit, PLAN §9 adversarial rows, property tests with token conservation) plus a real-node test. |
| Setup and owner scripts (`scripts/`, `shared/`) | **Implemented.** Keyless policy account in one owner transaction; role accounts with function-call keys only; top-up, seeding, status, rotation. Tested on a local node. |
| Executor + mock 1Click (`executor/`, `mock-1click/`) | **Implemented.** Native and cross-chain payouts, trust budget vs owner-signed attempts, change and refunds, outages, restart recovery. Tested on a local node. |
| Agent, ingestion, Telegram (`agent/`, `ingestion/`, `channels/`) | **Implemented.** NEAR AI Cloud extraction with TEE verification badges, deterministic checks, obligation HMAC, update dedupe, limits, bot commands. Checked live against NEAR AI Cloud on 2 Nov: all 13 fixture invoices read by `Qwen/Qwen3.8-27B`, each with "Model response verified" (Intel PCS and NVIDIA NRAS). Telegram is exercised with fakes only. |
| Dashboard (`web/`) | **Implemented.** Public view, approve, attempt, reconcile, pause, NEP-413 private view. Checked against a local node; wallet signing not yet tried on testnet/mainnet. |
| Mainnet deployment, `demo-getleash` panel | Not yet. |

## Try it

Prerequisites: [Rust via rustup](https://rustup.rs) (the pinned toolchain, 1.93.0, installs
itself), `cargo install --locked cargo-near`, Node.js ≥ 22 and pnpm (`corepack enable`).
Nothing below touches mainnet, NEAR AI Cloud or the real 1Click API.

1. **Contract tests.**
   ```bash
   cd contract && cargo test
   ```
   → `test result: ok. 65 passed` in about 2 minutes. Run in debug mode, not `--release`
   (see `AGENTS.md`). Single adversarial rows: `cargo test executor_supplies_its_own_deposit_address_above_the_trust_budget`,
   `cargo test autonomous_budget_caps_a_fabricated_small_invoice_stream`; the full mapping is in
   `docs/audit-response.md`. Deeper random walks: `PROPTEST_CASES=300 cargo test contract_invariants_hold`.

2. **TypeScript unit tests.**
   ```bash
   pnpm install && pnpm test
   ```
   → `Tests 35 passed`: term hashes, outcome parsing, 1Click quote checks (against the shape of a
   live quote), obligation ids, input limits, the Telegram channel (replayed update processed
   once, allowlist, size limits) and the TEE verification policy (stale, invalid or missing
   evidence never earns a "verified" badge).

3. **Integration tests on a local NEAR node** (builds the wasm with cargo-near if needed, downloads
   `near-sandbox` once):
   ```bash
   pnpm test:sandbox
   ```
   → `Tests 11 passed` in under a minute. The setup test creates the policy account in one owner
   transaction and checks it has **no access keys**, that the role accounts hold exactly one
   function-call key, and that the protocol refuses those keys for other methods, other contracts,
   deposits and transfers. The executor tests pay a native supplier, pay USDT on Tron through
   mock-1click within the trust budget, wait for the owner's signature above it, keep returned
   change unreconciled until the owner attributes it, flag a failed swap and an unreachable
   provider instead of paying twice, and recover after a worker restart.

4. **The whole pipeline, offline.**
   ```bash
   pnpm demo:mock
   ```
   → 14 invoices from `fixtures/invoices/` go through ingestion → agent → contract → executor on a
   local node, each checked against its expected outcome, ending in `All checks passed.` You see,
   among others: a clean invoice paid; a USDT payout on Tron; the same invoice re-sent in another
   format and with an edited total, refused on-chain (`OBLIGATION_OPEN_OR_PAID`); a prompt
   injection refused on-chain (`UNKNOWN_SUPPLIER`); a swapped wallet held for review
   (`ADDRESS_MISMATCH`); a fabricated small invoice to a real supplier **paid**, the next one held
   because the day's autonomous budget is spent; and after an address change, a normal invoice
   refused (`SUPPLIER_COOLDOWN`) while a 0.50 test payment goes through only with two owner
   signatures. The agent here is an offline text reader, so every badge reads "Verification
   unavailable".

5. **The dashboard against a local node.**
   ```bash
   pnpm devnet          # terminal 1: node + contract + executor + mock 1Click, prints the env for terminal 2
   NEXT_PUBLIC_NEAR_NETWORK=testnet NEXT_PUBLIC_NEAR_RPC_URL=… NEXT_PUBLIC_POLICY_CONTRACT_ID=getleash.biz.near NEXT_PUBLIC_ONECLICK_URL=… pnpm dashboard
   ```
   → open http://localhost:3000 (use `localhost`, not `127.0.0.1`, in dev mode). `/attempt/3`
   shows a cross-chain attempt whose committed terms the browser compares, field by field, with
   1Click's status for the deposit address. Wallet buttons cannot sign on a local node.

6. **Build the contract.**
   ```bash
   cd contract && cargo near build non-reproducible-wasm
   ```
   → `target/near/getleash_policy.wasm` and `target/near/getleash_policy_abi.json`.

### Running it for real (owner's machine)

```bash
pnpm keygen --network mainnet --account agent-1.<you>.near        # on the machine that runs each service
pnpm keygen --network mainnet --account executor-1.<you>.near
pnpm setup:owner --network mainnet --owner <you>.near --wasm-sha256 <published hash>
pnpm topup --network mainnet --owner <you>.near --amount 20
pnpm seed --network mainnet --owner <you>.near --file <suppliers.json>
pnpm executor        # and in another terminal: pnpm bot
pnpm status --network mainnet --policy getleash.<you>.near
```
The owner's key is read from the owner's own near-cli credentials and is never configured in a
service. Every script prints what it will sign and asks first.

## Repository

```
contract/          NEAR policy contract (Rust, near-sdk 5.29); src/ledger.rs is the pure accounting core
shared/            contract types (zod), role-scoped clients, term hashes, 1Click client, setup flow
scripts/           owner CLIs: keygen, setup:owner, topup, seed, status, rotate; demo:mock, devnet
executor/          deterministic payout loop over get_open_work(), journal, owner notices
mock-1click/       local 1Click stand-in that settles real (mock) tokens on a local node
ingestion/         obligation-id HMAC, update dedupe, input limits, PDF text layer
agent/             extraction (NEAR AI Cloud), deterministic checks, TEE verification, encrypted store
channels/          channel interface + Telegram bot (grammY)
web/               dashboard (Next.js): public view, approve, attempt, reconcile, pause, private view
devkit/            local NEAR node harness and the integration tests
fixtures/invoices/ demo invoices (clean, duplicates, injection, address swap, fabricated, NGN, …)
docs/              PLAN.md (the spec), decisions.md, audit-response.md, verified-facts.md
AGENTS.md          rules for coding agents (CLAUDE.md imports it)
.agents/skills/    near/agent-skills, installed with `npx skills add near/agent-skills`
```

## Non-goals

WhatsApp, fiat ramps, NGN invoices or FX, KYC, multi-tenant onboarding, automatic refund-based
budget restoration, a second cross-chain route (Base is a stretch goal).

## Tools and AI assistance

- Code in this repository is written with AI coding assistance (Claude Code), reviewed and directed
  by the team. The hackathon rules allow this and ask for disclosure.
- [near/agent-skills](https://github.com/near/agent-skills) (MIT) guide the coding agent; installed
  under `.agents/skills/`, not shipped in the contract.
- Contract scaffold from `cargo near new`. Libraries: `near-sdk` 5.29, `serde`, and for tests
  `proptest`, `near-sandbox`, `near-api`.
- TypeScript libraries: `near-api-js` 7.4, `near-sandbox` (npm), `zod`, `@noble/hashes`,
  `@noble/curves`, `grammy`, `pdfjs-dist`, `@phala/dcap-qvl` (Intel TDX quote verification),
  `jose` (NVIDIA NRAS JWTs), `next`, `react`, `@hot-labs/near-connect`; `vitest` and `tsx` for
  tests and scripts.

## License

MIT, see `LICENSE`.
