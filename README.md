# GetLeash

**An AI agent that pays a business's suppliers across chains, under on-chain rules it cannot break.**

> GetLeash is self-custodial: each business's treasury is a contract controlled only by its own
> wallet, and GetLeash holds no key that can withdraw or redirect funds. It limits autonomous
> payments to authorized destinations and budgets, makes the owner's approvals name the exact
> payment terms, and makes its remaining settlement trust dependencies explicit.

Built for the NEAR Hackathon (1–14 Nov 2026). Tracks: `realworld`, `business`, `security`,
`privacy`, `agents`.

## The problem

A small importer pays suppliers in USDC on NEAR and USDT on Tron. Paying invoices by hand is slow,
and invoice fraud (fake invoices, swapped bank or wallet details) is common. Handing an AI agent a
wallet would fix the speed and make the fraud worse: one prompt injection and the money is gone.

## How GetLeash works

- The **policy contract** (NEAR, Rust, 84 KB of wasm) holds the business's USDC and decides every
  payment. It pays only suppliers the owner allowlisted, within the agent's approval threshold, its
  daily autonomous budget and an overall daily cap; after a supplier's address changes, every
  payment to it waits for the owner, who can approve at most a small test payment until the
  cooldown ends. Budget counters only go up: refunds and failed transfers never give budget back.
- The **agent** (TypeScript, private inference on NEAR AI Cloud) reads invoices sent to a Telegram
  bot and calls `propose(obligation, supplier_id, amount, review_flag)`. It never supplies an
  address: the supplier id comes from a deterministic directory match, the obligation id is a
  keyed HMAC of supplier and invoice number computed by ingestion code, and the only
  model-influenced value on-chain is an enum review flag that can only force review. A native USDC
  payment within the agent's limits is sent by the contract in that same call.
- The **executor** (TypeScript, no LLM) handles cross-chain payouts through NEAR Intents 1Click:
  non-dry `EXACT_OUTPUT` quotes with refunds to the contract. It records the quote's deposit
  address with `create_attempt` and funds it with `fund(intent_id)`, which takes only an id. The
  contract sends the money only if the owner signed that exact deposit and amount, or if it fits
  the owner's daily executor-trust budget (default 0).
- The **dashboard** (Next.js) reads the chain from the owner's browser and, before offering a
  signature for a cross-chain payment, fetches 1Click's own record of the deposit address and
  compares it field by field with what the contract committed.
- The **owner's wallet** holds every power that matters: approvals, supplier changes, policy,
  pause, role rotation, withdrawals, upgrades. Each owner call needs 1 yoctoNEAR, so it needs a
  wallet confirmation, and its JSON arguments name what is signed: `decide` repeats the intent's
  amount and supplier, `authorize` the deposit address and amount. The contract account itself has
  no access keys.

What a compromised component can do, at most:

| Component | Worst case |
|---|---|
| Agent key / host / model | Propose payments to **already allowlisted** suppliers, paid without the owner only up to the approval threshold per payment and the autonomous budget per day. New or changed suppliers have no separate verification step: their cooldown is the gate. |
| Executor key, trust budget 0 (the default) | Fund cross-chain attempts the owner already signed. It cannot choose a destination. |
| Executor key, trust budget > 0 (opt-in) | Send cross-chain payments to deposit addresses it chose, up to the daily trust budget. Rotating the executor voids its unsigned attempts. |
| A dashboard host serving false data | Show false terms; the wallet still shows the JSON being signed, and the daily cap bounds what any approval can send. |
| GetLeash the company | Nothing: it holds no key on any customer account. |

Settlement trust that remains: during a cross-chain swap, funds sit briefly with NEAR Intents /
1Click; USDC is issued by Circle, which can freeze tokens.

**Privacy:**

| Data | Where | Protection | Not protected against |
|---|---|---|---|
| Invoice files and contents | Telegram → bot → OCR → inference → encrypted store | AES-256-GCM at rest; inference in a TEE, verified per response | Telegram cloud chats are not end-to-end encrypted; a compromise of the running bot process (which holds the key) |
| Supplier names and contacts | Off-chain directory | Shown only in the private view, after a NEP-413 signature by the owner | Server compromise |
| Invoice identity | On-chain keyed HMAC | Not guessable without `TENANT_SECRET` | Leak of `TENANT_SECRET` |
| Amounts, destination addresses, timing | On-chain | **Public** | Anyone; stated plainly |
| Refusal reasons | Event logs (enum codes) | No model text on-chain, so no exfiltration channel | — |

## Status (2 Nov 2026)

| Part | State |
|---|---|
| Policy contract v2 (`contract/`) | **Implemented.** Rewritten lean to fit a ~1.5 NEAR mainnet deployment (docs/decisions.md D-28): the release wasm is 83,900 B instead of 370,399 B. 47 Rust tests (unit tests named after PLAN §9 rows, property tests including random walks over the whole contract, a fuzzed JSON parser, golden Borsh vectors) plus a real-node test. v1, with full on-chain accounting, is tagged `v1-full-contract`. |
| Setup and owner scripts (`scripts/`, `shared/`) | **Implemented.** Keyless policy account in one owner transaction; role accounts with function-call keys only; top-up, seeding, status, rotation. Tested on a local node. |
| Executor + mock 1Click (`executor/`, `mock-1click/`) | **Implemented.** Cross-chain payouts within the trust budget and owner-signed above it, change, refunds and retry, outages, restart recovery, re-quotes. Tested on a local node. |
| Agent, ingestion, Telegram (`agent/`, `ingestion/`, `channels/`) | **Implemented.** NEAR AI Cloud extraction with TEE verification badges, deterministic checks, obligation HMAC, update dedupe, limits, bot commands. Checked live against NEAR AI Cloud on 2 Nov: all 13 fixture invoices read by `Qwen/Qwen3.8-27B`, each with "Model response verified" (Intel PCS and NVIDIA NRAS). Telegram: unit tests with a fake Bot API, and the live bot on testnet (next rows). |
| Dashboard (`web/`) | **Implemented.** Overview, intent page (approve, reject, retry, sign a 1Click deposit after a browser-side check), pause, NEP-413 private view. Checked against a local node, and on testnet with the owner signing through near-connect's "NEAR CLI" wallet (near-cli-rs). |
| Testnet rehearsal | **Done 2 Nov** with the release wasm at `getleash.getleash-owner.testnet` and Circle's testnet USDC. Four invoices sent to the live bot, read by NEAR AI Cloud: 1.80 paid inside the agent's call; the same invoice re-sent as a reworded reminder, refused on-chain (`OBLIGATION_OPEN_OR_PAID`); 3.00 held (`ABOVE_THRESHOLD`) and paid when the owner approved it from the dashboard; 1.00 USDT to a Tron address, quoted by mock-1click (`pnpm mock:1click`; nothing reaches Tron), its deposit authorized by the owner and funded by the executor, with the contract registering the deposit account on USDC and paying it in one receipt. Gas and NEAR per step: `docs/verified-facts.md`. |
| Mainnet deployment, `demo-getleash` panel | Not yet. Expected cost: about 1.4 NEAR (1.05 for the contract account, of which 0.84 covers its code, plus 0.15 and 0.2 for the agent and executor accounts, which pay their own gas). |

## Try it

Prerequisites: [Rust via rustup](https://rustup.rs) (the pinned toolchain, 1.93.0, installs
itself), `cargo install --locked cargo-near`, Node.js ≥ 22 and pnpm (`corepack enable`).
Nothing below touches mainnet, NEAR AI Cloud or the real 1Click API.

1. **Contract tests.**
   ```bash
   cd contract && cargo test
   ```
   → `test result: ok. 47 passed` in about 2 minutes. Run in debug mode, not `--release` (see
   `AGENTS.md`). Single adversarial rows: `cargo test executor_supplies_its_own_deposit_address_above_the_trust_budget`,
   `cargo test autonomous_budget_caps_a_fabricated_small_invoice_stream`; the full mapping is in
   `docs/audit-response.md`. Deeper random walks: `PROPTEST_CASES=200 cargo test contract_invariants_hold`
   (about 10 minutes). Real node: `cargo test --test sandbox -- --ignored`.

2. **TypeScript unit tests.**
   ```bash
   pnpm install && pnpm test
   ```
   → `Tests 55 passed`: the Borsh layout against golden vectors written by the Rust types, outcome
   parsing, 1Click quote checks (against the shape of a live quote), obligation ids, input limits,
   the Telegram channel (replayed update processed once, allowlist, size limits), owner notices
   sent once between the bot and the executor, near-cli-rs key files, and the TEE verification
   policy (stale, invalid or missing evidence never earns a "verified" badge).

3. **Integration tests on a local NEAR node** (builds the wasm with cargo-near if needed,
   downloads `near-sandbox` once):
   ```bash
   pnpm test:sandbox
   ```
   → `Tests 13 passed` in about a minute, with the mainnet role balances. The setup test creates
   the policy account in one owner transaction and checks it has **no access keys**, that the role
   accounts hold exactly one function-call key, and that the protocol refuses those keys for other
   methods, other contracts, deposits and transfers; a native supplier is paid inside the agent's
   own call. The executor tests pay USDT on Tron through mock-1click within the trust budget, wait
   for the owner's signature of the exact deposit above it, let returned change and refunds land
   without restoring budgets, retry a refunded swap, report an unreachable provider without paying
   twice, recover after a worker restart, and refuse to carry a signature over to a re-quoted
   deposit.

4. **The whole pipeline, offline.**
   ```bash
   pnpm demo:mock
   ```
   → 14 invoices from `fixtures/invoices/` go through ingestion → agent → contract (→ executor) on
   a local node, each checked against its expected outcome, ending in `All checks passed.` You see,
   among others: a clean invoice paid in the agent's own call; a USDT payout on Tron; the same
   invoice re-sent in another format and with an edited total, refused on-chain
   (`OBLIGATION_OPEN_OR_PAID`); a prompt injection refused on-chain (`UNKNOWN_SUPPLIER`); a
   swapped wallet held for review (`ADDRESS_MISMATCH`); a fabricated small invoice to a real
   supplier **paid**, the next one held because the day's autonomous budget is spent; and after an
   address change, a normal invoice held (`SUPPLIER_COOLDOWN`) that even the owner cannot approve
   (`OVER_COOLDOWN_MAX`), while a 0.50 test payment goes through only after the owner approves it
   and signs its exact 1Click deposit. The agent here is an offline text reader, so every badge
   reads "Verification unavailable".

5. **The dashboard against a local node.**
   ```bash
   pnpm devnet          # terminal 1: node + contract + executor + mock 1Click, prints the env for terminal 2
   NEXT_PUBLIC_NEAR_NETWORK=testnet NEXT_PUBLIC_NEAR_RPC_URL=… NEXT_PUBLIC_POLICY_CONTRACT_ID=getleash.biz.near NEXT_PUBLIC_ONECLICK_URL=… pnpm dashboard
   ```
   → open http://localhost:3000 (use `localhost`, not `127.0.0.1`, in dev mode). `/intent/5` shows
   an 8 USDT payment on Tron above the trust budget: the browser fetches 1Click's record of its
   deposit address and checks 12 committed terms before offering the signature. Wallet buttons
   cannot sign on a local node.

6. **Build the contract.**
   ```bash
   cd contract && cargo near build non-reproducible-wasm --no-embed-abi
   ```
   → `target/near/getleash_policy.wasm` (about 86 KB) and `target/near/getleash_policy_abi.json`.

7. **Reproduce the release wasm** (needs Docker).
   ```bash
   git checkout b11e68a && cd contract && cargo near build reproducible-wasm && shasum -a 256 target/near/getleash_policy.wasm
   ```
   → 83,900 bytes, sha256 `8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d`
   (NEAR shows it as code hash `AbwiVLX5f7regsZkTKWvHkYbN1ae8yj9Gsygrq7bTvV2`). The wasm records
   its source commit and build image (NEP-330); a deployed contract returns them from the
   `contract_source_metadata` view. Rebuilding at any other commit gives a different hash, because
   the commit is part of that record. The 13 integration tests and the offline demo pass with this
   exact file.

### Running it for real (owner's machine)

```bash
pnpm keygen --network mainnet --account agent-1.<you>.near        # on the machine that runs each service
pnpm keygen --network mainnet --account executor-1.<you>.near
pnpm setup:owner --network mainnet --owner <you>.near --wasm-sha256 8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d --policy deploy/mainnet-policy.json
pnpm topup --network mainnet --owner <you>.near --amount 20
pnpm seed --network mainnet --owner <you>.near --file <suppliers.json>
pnpm executor        # and in another terminal: pnpm bot
pnpm status --network mainnet --policy getleash.<you>.near
```
The owner's key is read from the owner's own near-cli credentials and is never configured in a
service. Every script prints what it will sign, and its NEAR cost, and asks first. Each
cross-chain payment also costs the contract 0.00125 NEAR to register the 1Click deposit account on
USDC, and each accepted invoice keeps about 0.0008 NEAR of storage to block duplicates.

## Repository

```
contract/          NEAR policy contract v2 (Rust, near-sdk 5.29): src/budget.rs and src/rules.rs are pure, src/json.rs reads the owner's JSON strictly
shared/            Borsh types and decoders, role-scoped clients, 1Click client, setup flow, address checks
scripts/           owner CLIs: keygen, setup:owner, topup, seed, status, rotate; demo:mock, devnet
executor/          deterministic cross-chain payout loop, journal, owner notices
mock-1click/       local 1Click stand-in that settles real (mock) tokens on a local node
ingestion/         obligation-id HMAC, update dedupe, input limits, PDF text layer
agent/             extraction (NEAR AI Cloud), deterministic checks, TEE verification, encrypted store
channels/          channel interface + Telegram bot (grammY)
web/               dashboard (Next.js): overview, intent page, pause, private view
devkit/            local NEAR node harness and the integration tests
deploy/            the mainnet policy (one tenth of v1's default limits)
fixtures/invoices/ demo invoices (clean, duplicates, injection, address swap, fabricated, NGN, …)
docs/              PLAN.md (the spec), decisions.md, audit-response.md, verified-facts.md
AGENTS.md          rules for coding agents (CLAUDE.md imports it)
.agents/skills/    near/agent-skills, installed with `npx skills add near/agent-skills`
```

## Non-goals

WhatsApp, fiat ramps, NGN invoices or FX, KYC, multi-tenant onboarding, on-chain accounting
(v1's ledger, reservations and reconciliation are off-chain in v2), a second cross-chain route
(Base is a stretch goal).

## Tools and AI assistance

- Code in this repository is written with AI coding assistance (Claude Code), reviewed and directed
  by the team. The hackathon rules allow this and ask for disclosure.
- [near/agent-skills](https://github.com/near/agent-skills) (MIT) guide the coding agent; installed
  under `.agents/skills/`, not shipped in the contract.
- Contract scaffold from `cargo near new`. Libraries: `near-sdk` 5.29 and for tests `proptest`,
  `near-sandbox`, `near-api`, `cargo-near-build`.
- TypeScript libraries: `near-api-js` 7.4, `near-sandbox` (npm), `zod`, `@noble/hashes`,
  `@noble/curves`, `grammy`, `pdfjs-dist`, `@phala/dcap-qvl` (Intel TDX quote verification),
  `jose` (NVIDIA NRAS JWTs), `next`, `react`, `@hot-labs/near-connect`; `vitest` and `tsx` for
  tests and scripts.

## License

MIT, see `LICENSE`.
