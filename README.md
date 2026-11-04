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
- **Suppliers are added from Telegram**: `/addsupplier Acme acme.near`, or `/invite`, a one-time link
  through which the supplier sends its own address. The bot checks the address (Tron checksum, that the
  NEAR account exists, not already listed) and replies with a button. The button opens the dashboard's page,
  where the owner's wallet signs `add_supplier` with those exact terms. The bot then saves the name in
  the off-chain directory. It never offers to add the address an unknown supplier's invoice asks to be
  paid at (docs/decisions.md D-29).
- **Other businesses set up their own GetLeash from the same bot** (D-30, D-32): they send `/start`, tap
  "Set up GetLeash", and on the dashboard's `/setup` page their own wallet makes one call to GetLeash's
  factory (`getleash.near`, keyless), sending 1.404 NEAR (about 1.43 NEAR in all; the wallet needs about
  1.491 while it signs, and the rest comes back). For that wallet as owner the factory creates their own
  keyless contract (`<their account, dots made dashes>.getleash.near`), agent and executor accounts
  holding only keys the bot generated for them, and the USDC registration. HOT Wallet shows a deployment
  or a new key in a wallet's request as a "dangerous request" to type CONFIRM for, and a call that sends
  NEAR with no warning, so the wallet signs only that call (D-32). The contract gets the 84 KB release
  from a 1.9 KB installer that copies it from GetLeash's store on NEAR, deploys it only if its SHA-256 is
  the release's, and initialises it with the owner as owner (D-31: no wallet request can carry the release,
  HOT Wallet's connector would take hours to encode it). The bot signs each setup link with its agent key, which the page checks against the
  chain. Their wallet signs a claim naming the setup and their Telegram account. The page's Finish then
  sends a one-time code through Telegram to the real bot's chat, from the account using the page, and they
  tap START. The bot serves a business only when the claim and the code both come from the account the setup
  is for. A lookalike bot that sends someone to the real page with its own link gets the claim but never the
  code, and a forwarded link fails the same way. The bot checks the claim and everything on-chain before it
  serves them, and serves each business only in its owner's private chat, with its own keys, directory and
  invoice store. The owner's wallet can move its GetLeash to another Telegram account at any time ("connect"
  on the same page), and the account it leaves is told.
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
| GetLeash the company | For a business that runs its own copy: nothing, it holds no key on that business's accounts. For a business it hosts (D-30): it holds that business's agent and executor keys, so at most the agent row and the trust-budget-0 executor row above, and it reads that business's invoices. No key it holds can withdraw, add a supplier or change a limit. |

Settlement trust that remains: during a cross-chain swap, funds sit briefly with NEAR Intents /
1Click; USDC is issued by Circle, which can freeze tokens.

**Privacy:**

| Data | Where | Protection | Not protected against |
|---|---|---|---|
| Invoice files and contents | Telegram → bot → OCR → inference → encrypted store (one key per business) | AES-256-GCM at rest; inference in a TEE, verified per response | Telegram cloud chats are not end-to-end encrypted; a compromise of the running bot process (which holds the key); for a hosted business (D-30), the operator who runs that process |
| Supplier names and contacts | Off-chain directory: the services' disk (names added in Telegram; a hosted business has its own file) and `GETLEASH_DIRECTORY_BASE64` (names from `pnpm seed`); never in a link | Shown only in the private view, after a NEP-413 signature by the owner, and in the bot's allowlisted chats (a hosted business's names only in its owner's chat) | Server compromise; Telegram cloud chats are not end-to-end encrypted |
| Invoice identity | On-chain keyed HMAC | Not guessable without `TENANT_SECRET` | Leak of `TENANT_SECRET` |
| Amounts, destination addresses, timing | On-chain | **Public** | Anyone; stated plainly |
| Refusal reasons | Event logs (enum codes) | No model text on-chain, so no exfiltration channel | — |

## Status (3 Nov 2026)

| Part | State |
|---|---|
| Policy contract v2 (`contract/`) | **Implemented.** Rewritten lean to fit a ~1.5 NEAR mainnet deployment (docs/decisions.md D-28): the release wasm is 83,900 B instead of 370,399 B. 47 Rust tests (unit tests named after PLAN §9 rows, property tests including random walks over the whole contract, a fuzzed JSON parser, golden Borsh vectors) plus a real-node test. v1, with full on-chain accounting, is tagged `v1-full-contract`. |
| Setup and owner scripts (`scripts/`, `shared/`) | **Implemented.** Keyless policy account in one owner transaction; role accounts with function-call keys only; top-up, seeding, status, rotation. Tested on a local node. |
| Executor + mock 1Click (`executor/`, `mock-1click/`) | **Implemented.** Cross-chain payouts within the trust budget and owner-signed above it, change, refunds and retry, outages, restart recovery, re-quotes. Tested on a local node. |
| Agent, ingestion, Telegram (`agent/`, `ingestion/`, `channels/`) | **Implemented.** NEAR AI Cloud extraction with TEE verification badges, deterministic checks, obligation HMAC, update dedupe, limits, bot commands, adding suppliers from Telegram (`/addsupplier`, `/invite`; unit tests, not yet run live), other businesses setting up their own GetLeash from the bot (D-30: unit tests, and the page's exact transactions on a local node; not yet run live). Checked live against NEAR AI Cloud on 2 Nov: all 13 fixture invoices read by `Qwen/Qwen3.8-27B`, each with "Model response verified" (Intel PCS and NVIDIA NRAS). Telegram: unit tests with a fake Bot API, and the live bot on testnet (next rows). |
| Dashboard (`web/`) | **Implemented.** In plain words: the treasury, "Needs you" with one button per payment, and a payment page that says who gets what and why it needs you (approve, reject, retry, confirm a cross-chain transfer after a browser-side check of 1Click's record), with the checks and raw terms one click away; pause; a page that checks a new supplier's address and adds it with one wallet signature (`/suppliers/new`, opened from the bot); a page where another business's wallet sets up its own GetLeash (`/setup`, opened from the bot), and every page for a hosted business's contract (`?c=`), with a warning when that contract does not run the release; NEP-413 private view with supplier names. Checked against a local node, and on testnet with the owner signing through near-connect's "NEAR CLI" wallet (near-cli-rs); the add-supplier and setup pages were checked read-only against mainnet. On 4 Nov a HOT Wallet in Telegram (Android) signed a setup's claim on mainnet, but HOT's connector never showed the setup itself (it can't encode the 84 KB release in time, D-31); with the installer HOT showed it, as a "dangerous request" (any deployment is one to HOT, D-32), and the owner rejected it. The one call to the factory has not been signed on mainnet yet. |
| Testnet rehearsal | **Done 2 Nov** with the release wasm at `getleash.getleash-owner.testnet` and Circle's testnet USDC. Four invoices sent to the live bot, read by NEAR AI Cloud: 1.80 paid inside the agent's call; the same invoice re-sent as a reworded reminder, refused on-chain (`OBLIGATION_OPEN_OR_PAID`); 3.00 held (`ABOVE_THRESHOLD`) and paid when the owner approved it from the dashboard; 1.00 USDT to a Tron address, quoted by mock-1click (`pnpm mock:1click`; nothing reaches Tron), its deposit authorized by the owner and funded by the executor, with the contract registering the deposit account on USDC and paying it in one receipt. Gas and NEAR per step: `docs/verified-facts.md`. |
| Mainnet deployment | **Deployed 2 Nov** at `getleash.onanikes.near`: 0 access keys, code hash `AbwiVLX5f7regsZkTKWvHkYbN1ae8yj9Gsygrq7bTvV2` (the release wasm below), the one-tenth limits of `deploy/mainnet-policy.json`. Setup cost the owner 1.424 NEAR. One supplier added (in its 2-day cooldown until 4 Nov). First payment on 3 Nov: 0.50 USDC to that supplier, approved by the owner because of the cooldown (`propose` tx `AkcfngL6HZCe7ReW8TAquWCsDbr6pzZAqMsbc1cJtwk8`, `decide` tx `DxEyMM3QUomzVvNcet8waM5f5GYLVRpHWovuVtEPpPye`). The second, the same day, was approved from Telegram: the bot's button opened the payment page inside Telegram and the owner signed in HOT Wallet (`decide` tx `Fbwfukbhjhe5DDbtwM3EVFSJSDG2KzQCwzrvYCJwLbr9`); 3.91 USDC left in the treasury. |
| `demo-getleash` panel | Not yet. |

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
   → `Tests 163 passed`: the Borsh layout against golden vectors written by the Rust types, outcome
   parsing, 1Click quote checks (against the shape of a live quote), obligation ids, input limits,
   the Telegram channel (replayed update processed once, allowlist, size limits, replies in plain
   words with the enum code kept, payment pages and `/wallet` as Mini App buttons), adding suppliers
   from Telegram (details read without a model, bad or unknown addresses refused, one-time invites that
   strangers get no answer from, the name saved once the supplier is on-chain), another business's setup
   (the page's transactions are the CLI's; setup links are signed and checked against the agent key on
   the chain; a claim counts only when signed by the owner's full-access key for that setup and Telegram
   user, from that user's chat, with a finish code from the same account, so a lookalike bot that relays
   the claim and a forwarded link both fail; the owner's wallet moves its GetLeash to another account
   (its invites follow), and copied public keys never take someone else's open setup; display names
   can't pass for a username; the bot serves a business once, only after
   the chain shows its contract with the keys generated for it, answers each business only in its owner's
   chat, routes invites across businesses, keeps their keys 0600, and replays updates a restart
   interrupted), the installer, its store and the factory (the bytes are their pinned build, built for this
   release, this store, USDC and the default limits; a whole setup is one call to the factory under 1,000
   characters, with nothing HOT Wallet calls dangerous, where deploying the release took 960,000; the wallet
   is asked for the gas NEAR holds while it signs), supplier matching by address,
   owner notices sent once between the bot and the executor,
   near-cli-rs key files, the plain-language wording shared by the dashboard and Telegram, and the
   TEE verification policy (stale, invalid or missing evidence never earns a "verified" badge).

3. **Integration tests on a local NEAR node** (builds the wasm with cargo-near if needed,
   downloads `near-sandbox` once):
   ```bash
   pnpm test:sandbox
   ```
   → `Tests 37 passed` in about a minute, with the mainnet role balances. The setup test creates
   the policy account in one owner transaction and checks it has **no access keys**, that the role
   accounts hold exactly one function-call key, and that the protocol refuses those keys for other
   methods, other contracts, deposits and transfers; a native supplier is paid inside the agent's
   own call. The executor tests pay USDT on Tron through mock-1click within the trust budget, wait
   for the owner's signature of the exact deposit above it, let returned change and refunds land
   without restoring budgets, retry a refunded swap, report an unreachable provider without paying
   twice, recover after a worker restart, and refuse to carry a signature over to a re-quoted
   deposit. The hosted setup test signs the `/setup` page's exact transactions and checks that the
   result passes the bot's own check against the release, that someone else's keys do not, and that a
   setup link checks out against the agent's keys as the chain lists them only when that agent's key signed it.
   The installer tests (D-31) run the page's installer and the release store: before the store exists the
   contract is created keyless and keeps the installer, and nobody but its owner can install, call its
   callback or abandon it; abandon gives the owner the NEAR back, and its batch can't delete an account that
   runs the release; too little gas leaves the installer, and installing again works; the store is set once and gives the
   release to anyone; installing leaves the release, initialised with the owner's arguments and nothing of
   the installer; a store holding other code installs nothing; and a wallet holding what the page asks for
   completes the whole setup, while one holding only its cost runs out at the contract. The factory tests
   (D-32) publish the factory keyless and make one call per business: the bot's own check passes on the
   result (the release, no keys, the caller as owner, the roles with only their keys, USDC), the NEAR lands
   where it should, a second setup for the same name, a name ending like a role account's, a wrong deposit
   and bad keys are refused with the NEAR given back, a name someone registered on USDC first still sets
   up, only the recorded owner can retry an install, and a wallet holding the first live wallet's 1.498
   NEAR completes the setup.

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
   → open http://localhost:3000 (use `localhost`, not `127.0.0.1`, in dev mode). "Needs you"
   lists three payments. `/intent/5` reads "Confirm the transfer": 8.00 USDT on Tron, its cost from
   the treasury and its fee, and one button. Before the button works, the browser fetches 1Click's
   record of the deposit address and checks it against the 12 terms the contract committed, plus
   that no other payment uses the address ("Safety checks" → Show). Wallet buttons cannot sign on a
   local node.

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
   the commit is part of that record. The 37 integration tests and the offline demo pass with this
   exact file. The hosted setups' contracts (`contract/bootstrap`, D-31, D-32): the installer is 1,932
   bytes, sha256 `cfd051b8791ab61bf06dfba5abd41739b18b2efa019c831619895b814381f09c`; the factory 7,921
   bytes, sha256 `5de21f5bb8b9e0fbeb9a9650687abab82ae535082c0a29de69fc140197279228`; the release store's
   code 1,368 bytes, sha256 `60b5b24dc8b199e1b0a30e4e7e840d964384f6be83eb6b1dc2e1cc733f50eb61`.
   `pnpm build:installer --check` rebuilds them with the pinned toolchain and compares.

### Running it for real (owner's machine)

The full flow, with prerequisites, what each step prints and the measured costs, is in
[docs/deployment.md](docs/deployment.md). In short:

```bash
pnpm keygen --network mainnet --account agent-1.<you>.near        # on the machine that runs each service
pnpm keygen --network mainnet --account executor-1.<you>.near
pnpm setup:owner --network mainnet --owner <you>.near --wasm-sha256 8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d --policy deploy/mainnet-policy.json
pnpm seed --network mainnet --owner <you>.near --file <suppliers.json>   # or later, one by one: /addsupplier in Telegram
pnpm topup --network mainnet --owner <you>.near --amount 20
pnpm exec tsx --env-file=.env --env-file=.env.mainnet executor/src/main.ts       # and in another terminal:
pnpm exec tsx --env-file=.env --env-file=.env.mainnet channels/telegram/src/main.ts
pnpm status --network mainnet --policy getleash.<you>.near
```
A business can also use a running GetLeash without any of this: it sends `/start` to that GetLeash's
bot and signs the setup in its own wallet ("Let other businesses set up their own GetLeash" in the same
document). To host them instead (the executor and the bot on Render, the dashboard on Vercel), see "Host the
services and the dashboard" in the same document (`render.yaml`, `pnpm deploy:env`). The owner's key is read from the owner's own
near-cli credentials and is never configured in a service. Every script prints what it will sign, and its NEAR cost, and asks first. Setup cost 1.424 NEAR
on mainnet. Each cross-chain payment also costs the contract 0.00125 NEAR to register the 1Click deposit
account on USDC, and each accepted invoice keeps about 0.0008 NEAR of storage to block duplicates.

## Repository

```
contract/          NEAR policy contract v2 (Rust, near-sdk 5.29): src/budget.rs and src/rules.rs are pure, src/json.rs reads the owner's JSON strictly
  bootstrap/       the factory hosted setups call, the installer it deploys and the release store it copies from (raw wasm, no near-sdk; D-31, D-32)
shared/            Borsh types and decoders, role-scoped clients, 1Click client, setup flow, address checks
scripts/           owner CLIs: keygen, setup:owner, topup, seed, status, rotate, publish:release, publish:factory; demo:mock, devnet, build:installer
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
