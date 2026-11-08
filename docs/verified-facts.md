# Verified facts

Facts the code depends on, checked against live sources (PLAN §5.1 rule 5). Each entry names its source and
the date it was checked. Anything not confirmed is marked **UNVERIFIED**; do not build on it without checking.
When a skill under `.agents/skills/` disagrees with a live source, the live source wins and the conflict is listed
at the bottom.

## Hackathon (checked 2026-11-01)

Source: https://nearhackathon.com/ and https://nearhackathon.com/HACKATHON.md (the live rules file says to re-read it before submitting).

- Submission window: 2026-11-01T00:00:00Z → **2026-11-14T23:59:00Z**. Judging 2026-11-16 → results by 2026-11-18T23:59Z.
- Required: a **public repository** link and a **public X post** with the demo video or screenshots (tag `@NEARProtocol`, `#NEARHackathon`, say it was built at NEAR HACKATHON). One submission per project; it cannot be edited.
- Track ids used by this project: `realworld`, `business`, `security`, `privacy`, `agents`.
- Screening: "Claude Code & Codex screen every project first: they check that it runs and does what the README says." Humans decide. The README must be written for a machine reader too: what it is, the problem, and "do X → see Y" steps. No marketing.
- Q-005: AI-generated code and libraries are allowed; list them in the README. Q-014: add a LICENSE file (MIT is fine).
- Q-007: **there is no NEAR Intents testnet.** Use mainnet, separate dev accounts, tiny amounts, `dry: true` quotes for previews.
- Q-006 (hackathon FAQ): "1Click JWT? Not required. Without it, 0.2% fee." — superseded by the live 1Click docs below (0.25%).
- NEAR AI credits: buy in https://cloud.near.ai or claim $10 via https://nearbuilders.org/join (stated by the hackathon FAQ; not mentioned in NEAR AI's own docs — **UNVERIFIED** there).
- Hosted demo: keep it up until at least 2026-11-18, ideally 2026-11-25.

## NEAR / tooling (checked 2026-11-01)

| Fact | Value | Source |
|---|---|---|
| near-api-js | 7.4.0 (latest, 2026-11-02); defaults: views at `optimistic` finality, transactions wait for `EXECUTED_OPTIMISTIC` | npm, installed source |
| near-sandbox (npm) | 0.3.4, runs sandbox node 2.13.4; genesis accounts via `GenesisAccount`. The first `Sandbox.start` downloads the same archive as the Rust crate into the package's own `bin/near-sandbox-2.13.4/` under `node_modules`; `NEAR_SANDBOX_BIN_PATH` overrides it there too (checked 2026-11-08). The download goes to a temporary directory and is moved into place only when complete, so a broken download (`Failed to download binary`, or `Failed to acquire lock for downloading the binary` in a parallel worker) leaves only the empty `near-sandbox.lock`, and the next run downloads from the start; an empty `NEAR_SANDBOX_BIN_PATH` counts as unset (`if (pathFromEnv)`), checked 2026-11-08 | npm, installed types; package source (`dist/cjs/binaryExecution-*.cjs`) |
| near-sandbox (Rust crate, `contract/tests/sandbox.rs`) | 0.3.16 (`contract/Cargo.lock`); `DEFAULT_NEAR_SANDBOX_VERSION` is 2.13.4, downloaded into the build's `OUT_DIR` on the first run, at `contract/target/debug/build/near-sandbox-<hash>/out/.near/near-sandbox-2.13.4/near-sandbox` (`download_path`; unpacked to a temporary file, then renamed, so a file at that path is complete); `NEAR_SANDBOX_BIN_PATH` points it at a node fetched by hand (checked 2026-11-08). README step 3 points the npm package at that copy, so steps 3–5 skip the second download (38 tests passed that way, 2026-11-08). It sets the variable only when it finds the copy: set but empty, the variable is an error here (`Error resolving binary:  does not exists`, from `bin_path`; checked 2026-11-08), unlike in the npm package. The archive, `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/<OS>-<arch>/2.13.4/near-sandbox.tar.gz`, is 28,872,015 bytes for Darwin-arm64 and 35,195,883 for Linux-x86_64 (Content-Length, 2026-11-08); the Darwin binary unpacks to 71,535,200 bytes | crate source (`src/lib.rs`, `src/runner/mod.rs`); S3 |
| Testnet RPC | `https://rpc.testnet.fastnear.com` answers `status` (HTTP 200, 2026-11-02) | live |
| near-sdk (Rust) | 5.29.1 locked (5.30.0 latest on crates.io) | `cargo search`, `contract/Cargo.lock` |
| cargo-near | 0.22.0 installed (`cargo install --locked cargo-near`) | local |
| Contract scaffold | `cargo near new` template: edition 2024, toolchain pinned to Rust 1.93.0, `overflow-checks = true`, reproducible build image `sourcescan/cargo-near:0.21.1-rust-1.96.0` | generated `contract/Cargo.toml` |
| Reproducible build | The image `sourcescan/cargo-near:0.21.1-rust-1.96.0` (digest in `contract/Cargo.toml`) is linux/amd64 only: 499,023,511 bytes compressed, 2 GB unpacked. cargo-near clones the repository to a temporary directory and builds in a fresh container, which downloads every crate in `contract/Cargo.lock` (467 crates, 75.3 MB) on each run. On an M1 (emulated): 2 min 46 s and 2 min 58 s on a fast connection, 17 min 32 s at about 86 KB/s (checked 2026-11-08) | Docker Hub API; build logs |
| Integration tests | NEAR docs recommend **`near-sandbox` + `near-api`** (not `near-workspaces`) | https://docs.near.org/smart-contracts/testing/integration-test.md; skill `near-smart-contracts/rules/testing-integration-tests.md` |
| Callback results | `#[callback_result] Result<(), PromiseError>` treats an empty result as `Ok(())`, but a too-long success maps to `Err(TooLong)`. GetLeash reads `env::promise_result_checked` directly and treats only `PromiseError::Failed` as a failed transfer. | near-sdk-macros 5.29.1 `attr_sig_info.rs`, near-sdk 5.29.1 `env.rs` |
| Store collections | `near_sdk::store` collections flush on `Drop`; the `near` macro derives `JsonSchema`/`BorshSchema` on every non-wasm build | near-sdk 5.29.1 source |

## NEAR gas and storage costs (measured 2026-11-02 on near-sandbox 2.13.4)

- A transaction is refused up front (`NotEnoughBalance`) unless the signer can pay the **attached** gas at a
  worst-case price: a 100 TGas call by an account holding 0.1 NEAR failed with "cost 100919285708330000000000"
  (≈0.001 NEAR per TGas, about 10× the base price), although only the gas actually burned is charged and the
  rest is refunded. So role accounts attach no more gas than a call needs (propose 70, fund 80 TGas) and hold
  0.15 / 0.2 NEAR (D-28).
- The v2 contract pays a native supplier inside `propose` at exactly 60 TGas attached; 59 TGas is refused by
  the contract's own check before any write (`contract/tests/sandbox.rs`).
- Storage staking is 10^19 yocto per byte (1 NEAR per 100 kB). The v2 policy account held 87,392 bytes after
  the sandbox run (85,809 of them code): ≈0.87 NEAR locked. Mainnet values to re-check on the first deploy.

## USDC on NEAR (checked 2026-11-01)

| Fact | Value | Source |
|---|---|---|
| Mainnet contract | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses ; 1Click `/v0/tokens` |
| Testnet contract | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | Circle (same page) |
| Decimals | **6** (`ft_metadata` → `{"spec":"ft-1.0.0","name":"USDC","symbol":"USDC","decimals":6}`) | mainnet RPC view call, https://rpc.mainnet.fastnear.com |
| `storage_balance_bounds` | min = max = `1250000000000000000000` yocto (**0.00125 NEAR**) | mainnet RPC view call |
| Testnet contract, same values | decimals 6; bounds min = max = 0.00125 NEAR (checked 2026-11-02) | testnet RPC view calls, https://rpc.testnet.near.org |
| Testnet faucet | https://faucet.circle.com (USDC, NEAR Testnet) sent **20 USDC** in one request; the receiving account was already registered (2026-11-02) | observed |
| `storage_deposit` gas (testnet, `registration_only`, new account) | **2.04 TGas** burned in the token's receipt; 2.57 TGas for the whole transaction (conversion + refund receipt); result `{"total":"1250000000000000000000","available":"0"}` (2026-11-02) | tx `2HwRgBQFVZAe5PMpUnP3xVaaXUaCAysKgdjSiB2p1qRe` (owner registering itself) |

## GetLeash v2 on testnet (measured 2026-11-02, release wasm 8eaccbf1…640a3d)

- Setup (`pnpm setup:owner --network testnet`): the owner spent **1.425 NEAR** in all: 1.05 + 0.15 + 0.2 moved
  into the policy, agent and executor accounts, 0.0025 for two USDC registrations, 0.0227 gas (each role
  account 0.0071, the policy create+deploy+init batch 0.0082, the policy's USDC registration 0.0002). The policy
  account then held 84,442 bytes (0.844 NEAR locked, 0.206 free); two suppliers added 328 bytes.
- Native autonomous payout inside `propose` (70 TGas attached), tx `HC6L8yJukFH8W9hvAqX5zvwpjP9EabvSQZ4SQvVBeqBu`:
  **7.33 TGas burnt = 0.00067 NEAR** (propose 2.56, Circle USDC `ft_transfer` 2.30, `on_paid` 1.50, refund
  receipts 0.66). The contract reserves 15 TGas for the transfer and 10 for the callback.
- A refused proposal (`OBLIGATION_OPEN_OR_PAID`, the reworded duplicate) burnt 2.05 TGas (0.00018 NEAR); a
  proposal left PENDING (`ABOVE_THRESHOLD`) 2.20 TGas (0.0002 NEAR).
- The owner approving that PENDING intent from the dashboard (`decide` APPROVE, 3 USDC, 80 TGas, 1 yoctoNEAR),
  tx `Gd68CW37c78Lj2UuBe94NJs9QnzVkQUXajmYi2DoRPa3`: **7.25 TGas burnt = 0.00066 NEAR**, paid in the same
  transaction (`decide` 2.47, `ft_transfer` 2.30, `on_paid` 1.50).
- Cross-chain payout of 1.00 USDT to a Tron supplier through mock-1click (`pnpm mock:1click`, real Circle
  testnet USDC; nothing reaches Tron). The trust budget is 0, so the owner authorized it:
  - `create_attempt` by the executor (30 TGas attached), tx `F5BV8B4UXdjsM7xbykXKAqAS51PmZvL2s1Lyx6W3uwsn`:
    2.16 TGas = 0.00019 NEAR. Deposit `62e30341…5529e99`, 1.206121 USDC in.
  - `authorize` by the owner (30 TGas, 1 yoctoNEAR), tx `H2ccUpJZpKB6KcAbewxajQnaTZLz7Q62BSe5FH6fSFL5`: 2.03 TGas
    = 0.00018 NEAR.
  - `fund(3)` by the executor (80 TGas attached), tx `6gkUxMGr649mf6RFmrR2wbNotbfqJSarnTTFp8WmwB1U`:
    **9.33 TGas = 0.00087 NEAR** (fund 2.65, USDC 4.19, `on_paid` 1.51, refund receipts 0.66).
    Circle's USDC ran the batch `[storage_deposit(registration_only), ft_transfer]` in **one receipt (4.19 TGas)**
    and sent no storage refund. The deposit account then showed
    `storage_balance_of = {"total":"1250000000000000000000","available":"0"}` and held the 1.206121 USDC.
    The registration was paid from the policy contract's own NEAR, 1.05 → 1.04875.
  - mock-1click marked the deposit PROCESSING, and 15 s later moved it to its solver and reported SUCCESS.
- NEAR AI extracted the first three invoices with signatures verified (seen in the bot's replies); the signed
  responses named the model `Qwen/Qwen3.8-27B`.

## GetLeash v2 on mainnet (deployed 2026-11-02)

- `pnpm setup:owner --network mainnet --owner onanikes.near --wasm-sha256 8eaccbf1…640a3d --policy
  deploy/mainnet-policy.json`, signed by the owner with near-cli credentials, in four transactions:
  agent account `8LDu8ci9tWXp98gMdLshpL4wMCXguZaX8a6FFT22vZ4H`, executor account
  `Fm9fo8Cc3veMx5qr9JEbsMDQLvbGNAch5m1G9UpPKUpx`, policy create + deploy + init in one batch
  `6eQEDGzNLfKKWX7h21mZzoGYawAHdSJ5veNJm3ThepZr`, policy registered on USDC
  `BZpggyY7ugTDUuXsaWCFHcri9WxBHJoSvHAX3bLdwJ6h`.
- Chain state afterwards: `getleash.onanikes.near` has **0 access keys**, code hash
  `AbwiVLX5f7regsZkTKWvHkYbN1ae8yj9Gsygrq7bTvV2` (sha256 `8eaccbf1…640a3d`, the release wasm), 1.05 NEAR
  of which 0.844 NEAR covers 84,415 bytes; `agent-1.onanikes.near` (0.15 NEAR) and
  `executor-1.onanikes.near` (0.20 NEAR) each hold one function-call key for their methods only.
- Cost to the owner: **1.424 NEAR** (4.0359 → 2.6120), the same as on testnet.
- `pnpm seed` added supplier 1 (`chisolu.near`, native USDC; the owner registered it on USDC for 0.00125
  NEAR), whose 2-day cooldown ends 2026-11-04T21:49:22Z. `pnpm topup --amount 4.91` moved 4.91 USDC into the
  treasury (tx `6rxAqroYRBpzbkXPUw67HyhhSn7G52jNqzphqSJ6Vq5t`). Both together cost the owner 0.0019 NEAR.
- First payment, 2026-11-03: invoice CH-0001 for 0.50 USDC from Chisolu, sent to the bot on Render. The
  agent proposed it at 09:41:59Z (tx `AkcfngL6HZCe7ReW8TAquWCsDbr6pzZAqMsbc1cJtwk8`); it waited for the
  owner (route `SUPPLIER_COOLDOWN`), who approved it at 09:42:24Z (`decide`, tx
  `DxEyMM3QUomzVvNcet8waM5f5GYLVRpHWovuVtEPpPye`). Intent 1 is `PAID`; `chisolu.near` holds 0.50 USDC and
  the treasury 4.41 USDC.
- First payment approved from Telegram, 2026-11-03: invoice CH-0002 for 0.50 USDC, proposed at 14:20:02Z
  (tx `5UQddBayhgRd7qQafDRvdEtGUmdkc6WCQ8WHwTfNegR1`, route `SUPPLIER_COOLDOWN`). The owner tapped the
  bot's "Review and approve" button, which opened the payment page as a Mini App, and signed `decide` in
  HOT Wallet at 14:20:55Z (tx `Fbwfukbhjhe5DDbtwM3EVFSJSDG2KzQCwzrvYCJwLbr9`); the bot then replied "✅ Paid
  Chisolu 0.50 USDC (payment #2)". Intent 2 is `PAID`; `chisolu.near` holds 1.00 USDC and the treasury
  3.91 USDC.

## near-cli-rs (checked 2026-11-02, version 0.30.1)

- `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair
  save-to-legacy-keychain network-config testnet create` created `getleash-owner.testnet` with **10 NEAR**.
- The legacy keychain writes `~/.near-credentials/<network>/<account>.json` and
  `<account>/ed25519_<key>.json` with `{seed_phrase_hd_path, master_seed_phrase, implicit_account_id,
  public_key, private_key}`: **no `account_id`**, the seed phrase in plain text, file mode 0644.
  `@getleash/shared/node` takes the account from the file name in that case and drops the seed phrase.
- Installed with `npm install -g near-cli-rs` under asdf-managed Node, the `near` command appears only after
  `asdf reshim nodejs`.
- The "NEAR CLI" wallet in near-connect (executor `near/near-cli-connect` `dist/near-cli.js`) prints a
  `near contract call-function as-transaction …` command, ending in `sign-with-keychain` and no `send`, and then
  takes the transaction hash. It writes 1 yoctoNEAR as `'0.000000000000000000000001 NEAR'`. The same command with
  `sign-with-legacy-keychain send` signed with the faucet account's `~/.near-credentials` key without prompting.

## NEAR Intents 1Click API (checked 2026-11-01)

Sources: OpenAPI https://1click.chaindefuser.com/docs/v0/openapi.yaml (info.version 0.1.10), https://docs.near-intents.org/integration/distribution-channels/1click-api/* pages, https://1click.chaindefuser.com/v0/tokens, live dry quotes.

**Base URL:** `https://1click.chaindefuser.com`

**Auth:** partner JWT sent as `X-API-Key: <jwt>` (recommended) or `Authorization: Bearer <jwt>` (legacy, still accepted). Get it from the Partner Dashboard https://partners.near-intents.org/ (WorkOS sign-in).

**Fees:**
- Unauthenticated: an extra **0.25% (25 bps)** on every non-`ANY_INPUT` quote, per the docs. **Observed
  2026-11-02 10:35Z:** a dry `EXACT_OUTPUT` quote for 2 USDT (Tron) came back identical with and without our
  partner key sent as `X-API-Key`: `amountIn` 2215489, `withdrawFee` 206302, and the same echoed
  `appFees: [{recipient: "5880ad2b…47dd", fee: 1}]` (1 bp). The documented 0.25% did not appear on this route.
  1Click also answers without a key, so an HTTP 200 alone does not show the key was recognised.
- Authenticated: partner schedule, "typically 20 bps, or **1 bp on stablecoin** and same-asset multichain routes". USDC→USDT is a stablecoin pair, so the JWT matters for small payments.
- Destination withdrawal fees are separate and can dominate small payments (see the Tron quote below).

**Endpoints:**

| Method | Path | Notes |
|---|---|---|
| GET | `/v0/tokens` | public; array of `{assetId, decimals, blockchain, symbol, price, priceUpdatedAt, contractAddress, coingeckoId}` |
| POST | `/v0/quote` | body `QuoteRequest`; returns `QuoteResponse` |
| POST | `/v0/deposit/submit` | `{txHash, depositAddress, nearSenderAccount?, memo?}`; optional, speeds up processing |
| GET | `/v0/status?depositAddress=…[&depositMemo=…]` | returns `GetExecutionStatusResponse` |

**`QuoteRequest` required fields:** `dry` (bool), `swapType` (`EXACT_INPUT`|`EXACT_OUTPUT`|`FLEX_INPUT`|`ANY_INPUT`), `slippageTolerance` (number, **basis points**), `originAsset`, `depositType` (`ORIGIN_CHAIN`|`INTENTS`|`CONFIDENTIAL_INTENTS`), `destinationAsset`, `amount` (integer string, smallest units; for `EXACT_OUTPUT` it is the output amount), `refundTo`, `refundType` (`ORIGIN_CHAIN`|`INTENTS`|`CONFIDENTIAL_INTENTS`), `recipient`, `recipientType` (`DESTINATION_CHAIN`|`INTENTS`|`CONFIDENTIAL_INTENTS`), `deadline` (ISO 8601). Optional: `depositMode` (`SIMPLE`|`MEMO`), `referral`, `appFees[{recipient, fee(bps)}]`, `quoteWaitingTimeMs`, `sessionId`, `connectedWallets`, `confidentiality`, `insured`, `virtualChain*`, `customRecipientMsg`.

**`QuoteResponse`:** `correlationId`, `timestamp`, `signature`, `quoteRequest`, `quote{ amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut, timeEstimate, depositAddress?, depositMemo?, deadline?, timeWhenInactive?, refundFee?, withdrawFee? }`.
- `dry: true` responses **omit `depositAddress`, `timeWhenInactive` and `deadline`** → never execute against a dry quote.
- `quote.deadline`: "Time when the deposit address becomes inactive and funds may be lost." Funding must land well before it.
- `withdrawFee` "is already accounted for in the final amountOut result" (for `EXACT_OUTPUT` it shows up on the input side).

**`EXACT_OUTPUT` semantics:** `amountOut` is fixed; slippage is applied to the input side, so `amountIn ≈ minAmountIn × (1 + slippage)`. Deposit above `amountIn` → swap runs and the excess is refunded to `refundTo`. Deposit below `minAmountIn` → refunded by the deadline. Deposit between `minAmountIn` and `amountIn`: **UNVERIFIED**. GetLeash deposits exactly `amountIn` and treats the excess that comes back as returned change (owner-reconciled).

**Status enum:** `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED`. Terminal: `SUCCESS`, `REFUNDED`, `FAILED`, `INCOMPLETE_DEPOSIT`. `swapDetails` includes `amountIn`, `amountOut`, `refundedAmount`, `refundReason`, `depositedAmount`, `withdrawFee`, `slippage`, `intentHashes`, `nearTxHashes`, `originChainTxHashes[{hash, explorerUrl}]`, `destinationChainTxHashes[{hash, explorerUrl}]`. The status response echoes the original `quoteResponse` (including `quoteRequest`), which the attempt page uses to cross-check recipient, refund address and types.

**NEAR-origin deposit:** `ft_transfer` on the token contract to `depositAddress`, attaching **1 yoctoNEAR** (skill `near-intents/rules/deposit-near.md`). Include `nearSenderAccount` in `/v0/deposit/submit`. The deposit address is a 64-hex implicit account that is not yet registered on USDC (verified 2026-11-02, below), so GetLeash registers it (`register_recipient`) before funding.

**Quote signature:** "a Base58-encoded SHA-256 hash of a deterministic JSON object" built from `stringify({ ...quoteRequest, ...quoteResponse, timestamp })` with `json-stable-stringify`; SDK helper `verifyQuoteSignature(quoteResponse)` in `@defuse-protocol/one-click-sdk-typescript` ≥ 0.1.24. Live responses carry `signature: "ed25519:…"` (2026-11-02), so the scheme is ed25519; the signer public key is **UNVERIFIED** (needed before the stretch on-chain verifier).

**Asset ids** (from `GET /v0/tokens`):

| Asset | `assetId` | decimals | notes |
|---|---|---|---|
| USDC on NEAR (treasury) | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 6 | contract = Circle USDC |
| USDT on Tron | `nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near` | 6 | Tron contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |

**Live dry quotes, USDC (NEAR) → USDT (Tron), unauthenticated, `slippageTolerance: 50`, 2026-11-01 22:22Z:**

| swapType | amount | amountIn | minAmountIn | amountOut | withdrawFee |
|---|---|---|---|---|---|
| `EXACT_INPUT` | 2.000000 USDC | 2.000000 | 2.000000 | 1.147806 USDT | **0.853706** |
| `EXACT_OUTPUT` | 2.000000 USDT | **2.865850** | 2.851520 | 2.000000 USDT | **0.853706** |

The Tron withdrawal fee is roughly fixed (≈0.85 USDT), so a percentage-only fee bound cannot cover small Tron payouts (a 2 USDT payout costs 43% extra). See `docs/decisions.md` D-02.

Also observed: a dry quote with `refundTo: "getleash.near"` and `recipient` = the USDT contract address returned HTTP 500 (`Internal server error`); the same quote with `refundTo: "intents.near"` and an ordinary Tron address succeeded. Which field caused the 500 is **UNVERIFIED**.

**Live non-dry quote, 2026-11-02 08:28Z** (USDC NEAR → 2 USDT Tron, `EXACT_OUTPUT`, unauthenticated, no funds sent):
- `quote.depositAddress` = `74374f46…8e262a`: a **64-hex implicit NEAR account id**, so it is a valid `AccountId` for
  `create_attempt_crosschain`. At quote time that account **does not exist** on-chain (`UNKNOWN_ACCOUNT`) and is **not
  registered on USDC** (`storage_balance_of` → `null`). A plain `ft_transfer` would fail, so GetLeash's
  `register_recipient` before funding is required, not optional. (The `near-intents` skill's NEAR deposit example
  omits this step.)
- `quote.deadline` = `quote.timeWhenInactive` = the requested `deadline` **+ 3 days**. The requested deadline (when
  refunds begin if the swap has not run) is echoed in `quoteRequest.deadline`. The executor commits the **requested**
  deadline as `quote_deadline`; the contract caps it at 1 day ahead.
- `signature` = `ed25519:<base58>`: the quote signature is **ed25519**. The signer's public key is still
  **UNVERIFIED**.
- `correlationId` is per HTTP response: `/v0/status` returns a different `correlationId`, and its echoed `quoteResponse`
  has only `{timestamp, signature, quoteRequest, quote}`. GetLeash therefore commits the quote **signature** as
  `quote_ref`, which the attempt page can match against `/v0/status`.
- `quoteRequest` echo adds defaults: `depositMode: "SIMPLE"`, `confidentiality: "public"`, `insured: false`,
  `quoteWaitingTimeMs: 0`, and `appFees: [{recipient: "5880ad2b…47dd", fee: 1}]` (1 bp) on this unauthenticated quote.
- `withdrawFee` was `205893` (0.21 USDT), against 0.85 USDT the day before: the Tron fee moves with network costs, so
  `max_fixed_fee` for Tron needs headroom (D-02).
- `/v0/status` for the unfunded address: `status: "PENDING_DEPOSIT"`, `swapDetails` with `null` amounts,
  `refundedAmount: "0"`, empty `originChainTxHashes`/`destinationChainTxHashes`.

**Rate limits:** no numeric limits published for quote/status (**UNVERIFIED**).

## NEAR AI Cloud (checked 2026-11-01)

Sources: https://docs.near.ai/cloud/* (quickstart, models, verification/*, api-reference/attestation/*), https://cloud-api.near.ai/v1/models (live), https://near.ai/models.

- Base URL `https://cloud-api.near.ai/v1`, `Authorization: Bearer <key>`, OpenAI-SDK compatible (override `base_url`). `GET /v1/models` needs no key.
- Model ids change: several ids in the docs are **not** in the live catalog (e.g. `zai-org/GLM-5.1-FP8`). **Resolve model ids at runtime from `/v1/models`.**
- Private-TEE models with image input and `structured_outputs` (candidates for invoice extraction): `z-ai/glm-5.3-flash`, `Qwen/Qwen3.8-27B`; also `Qwen/Qwen3-VL-30B-A3B-Instruct`. Do **not** use `*-abliterated` models.
- `response_format` is not named in the docs (the catalog flag is `structured_outputs`); the OpenAI shape `{type: "json_schema", json_schema: {name, strict: true, schema}}` works live (2026-11-02, below). PDF input is not documented → render PDF pages to images.
- Attestation: `GET /v1/attestation/report?signing_algo=ecdsa|ed25519&nonce=<64 hex>&model=<id>&provider=near&include_tls_fingerprint=false`, header `x-no-aliasing: true` for model evidence. Response: `gateway_attestation` (always) and `model_attestations[]` (only with `model=` and `provider=near`). Pass `signing_algo` explicitly (defaults differ).
- report_data (64 bytes): first 32 = signing identity zero-padded (ECDSA address is 20 bytes; Ed25519 key is 32), last 32 = client nonce. Read it from the **verified quote**, not the echoed JSON.
- Model checks: Intel TDX quote via `dcap-qvl` (`@phala/dcap-qvl` for Node), reject debug TDs, replay `event_log` (imr 3) into RTMR3 with SHA-384, MRCONFIGID = `01 ‖ sha256(info.tcb_info.app_compose raw string) ‖ 15 zero bytes`, GPU evidence via NRAS `POST https://nras.attestation.nvidia.com/v3/attest/gpu` (require JWT claim `x-nvidia-overall-att-result == true`). The docs publish **no accepted measurement list**; that is our policy to define.
- Response signatures: `GET /v1/signature/{chat_id}?model=<id>&signing_algo=ecdsa` → `{text, signature, signing_address, signing_algo, signature_kind?}`. `provider_tee`: `text = "<MODEL_ID>:<sha256(request body)>:<sha256(response body)>"`; `gateway`: `text = "<req_hash>:<resp_hash>"`, lowercase hex over **exact bytes** (no re-serialization; send `Accept-Encoding: identity`). ECDSA: EIP-191 recover and compare with `signing_address`. Streamed responses get `gateway`-kind signatures only.
- A `gateway` signature proves the gateway signed the bytes the client received, not that the verified model produced them. Instances of a model share a signing key, so a matching signer does not prove the same serving instance.

## NEAR AI Cloud model catalog (checked 2026-11-02)

Source: `GET https://cloud-api.near.ai/v1/models` (no key needed), 64 entries.
- Each entry has `owned_by`. NEAR-hosted models are `owned_by: "nearai"` (12 entries); others are
  `"attested 3p"` (5) or proxied providers (`openai`, `anthropic`, `google`, …). GetLeash uses only
  `"nearai"` models (D-24).
- NEAR-hosted, ready, with image input and `structured_outputs`: `Qwen/Qwen3-VL-30B-A3B-Instruct`
  (16k context, no reasoning, $0.15/$0.55 per M tokens), `Qwen/Qwen3.8-27B` (reasoning),
  `z-ai/glm-5.3-flash` (reasoning, also `json_mode`). `*-abliterated` variants exist and are excluded.
- Entries also carry `input_modalities`, `supported_features`, `is_ready` (sometimes `null`),
  `context_length`, `pricing`.

## NEAR AI Cloud, live run (checked 2026-11-02)

- Without credits, `POST /v1/chat/completions` answers HTTP 402 with `type: "no_limit_configured"`
  ("No spending limit configured. Please contact support to set up credits."). `GET /v1/models`
  needs no key.
- `Qwen/Qwen3-VL-30B-A3B-Instruct` was listed `is_ready: true` but did not answer a one-word
  completion within 150 s (two tries, ~12:00Z). `Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash` and
  `Qwen/Qwen3.6-35B-A3B-FP8` answered in about 1 s. A catalog entry does not prove a model is
  serving, so the extractor falls back to the next model (D-24).
- `chat_template_kwargs: {"enable_thinking": false}` (used in NEAR AI's verification docs) is
  honoured by `Qwen/Qwen3.8-27B` and `z-ai/glm-5.3-flash` (`reasoning_tokens: 0`). With reasoning on,
  one invoice took 45 s on Qwen3.8-27B and its signature was still "not found" after 5 lookups over
  ~5 s; with it off, the completion takes ~3 s and the signature is found on the first lookup. GLM
  with reasoning off still writes prose into `content` unless a JSON schema constrains it.
- `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}` is honoured.
- Completions carry `id` (32 hex) and the headers `x-serving-provider: near` and `inference-id`.
  `GET /v1/signature/{id}?model=…&signing_algo=ecdsa` returned `provider_tee` signatures whose
  text equals `model:sha256(request):sha256(response)` of the exact bytes sent and received.
- End to end, all 13 fixture invoices earned "Model response verified": the EIP-191 signer is the
  attested signing address, TDX report_data = signer ‖ our nonce, debug off, the quote verifies
  against Intel PCS with TCB `UpToDate` (FMSPC `90C06F000000`), and NVIDIA NRAS reports an overall
  pass with our nonce. One extraction took 9–24 s, of which the model ~3 s; Intel PCS collateral
  and NRAS are the slow calls.
- The extracted fields equal the offline reader's on 11 of 13 fixtures. On 05 and 06 the model
  labelled the Tron address `other` instead of `tron_address`; the value is the same, and the
  checks in `agent/src/rules.ts` use only the value.
- Catalog pricing for `Qwen/Qwen3.8-27B`: $0.04 per million input tokens, $1.35 per million output.

## Browser access (checked 2026-11-02)

- `GET https://1click.chaindefuser.com/v0/status` and `POST https://rpc.mainnet.fastnear.com` both
  answer `access-control-allow-origin: *`, so the attempt page can query them directly from the
  owner's browser. The mock 1Click sends the same header.
- `@hot-labs/near-connect` 0.12.0: `NearConnector({ network, features })`, `wallet.signAndSendTransaction({ receiverId,
  actions })` accepting `{ type: "FunctionCall", params: { methodName, args, gas, deposit } }`, and
  `wallet.signMessage({ message, recipient, nonce })` returning `{ accountId, publicKey, signature }`
  (signature base64). Not yet exercised with a real wallet.
- Public mainnet RPCs (checked 2026-11-03): FastNEAR (`rpc.mainnet.fastnear.com`) turned the bot on Render
  away with HTTP 429 and the body `{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits
  exceeded. ..."}, "id": "1"}`; near-api-js 7.4.0 retries only HTTP 500, 503 and 408 (installed source,
  `retryConfig`), so the error reached the owner. A view call answered on `rpc.mainnet.near.org` and
  `near.drpc.org` (both allow browser requests); `near.lava.build` answered HTTP 410 "This endpoint has been
  discontinued"; `1rpc.io/near` does not offer `query`. `rpc.testnet.near.org` answered `status`.
- HOT Wallet in Telegram (checked 2026-11-03): near-connect's manifest lists `hot-wallet` as the only wallet
  with a Telegram Mini App (`platform.tga` = `https://t.me/hot_wallet/app`); `t.me/hot_wallet` is titled
  "HOT Wallet". `connector.connect({ walletId: "hot-wallet" })` skips the wallet list: in a desktop browser
  with simulated Telegram launch data, HOT's own "Scan in HOT Wallet" screen came up directly, offering
  "Open via Telegram". Inside a Mini App near-connect opens t.me links through Telegram
  (`web_app_open_tg_link`). Used for real on 2026-11-03: the owner approved payment #2 this way (above).
- `@hot-labs/near-connect` 0.12.0 also has `wallet.signAndSendTransactions({ transactions: [{ receiverId,
  actions }] })`, returning one outcome per transaction, and each wallet's manifest declares
  `features.signAndSendTransactions` (installed types). The add-supplier page sends its two calls
  (`storage_deposit`, `add_supplier`) that way when the wallet declares it, else one after another. Not yet
  exercised with a real wallet.
- near-api-js 7.4.0 `verifyMessage` (NEP-413) requires the signing key to be a **FullAccess** key of
  the account, then checks the signature (installed source).
- Next.js 16.4 dev server blocks its dev resources for origins other than `localhost` unless listed
  in `allowedDevOrigins`; open the dev dashboard at `http://localhost:…`.

## Telegram Bot API (checked 2026-11-03)

- `ForceReply` (https://core.telegram.org/bots/api#forcereply): `force_reply` (type True) "shows reply
  interface to the user, as if they had manually selected the bot's message and tapped 'Reply'";
  `input_field_placeholder` is optional, 1-64 characters. `sendMessage` accepts it as `reply_markup`. The bot
  asks /addsupplier's and an invite's questions this way, and reads the answer from `reply_to_message`.
- Deep links (https://core.telegram.org/bots/features#deep-linking): `https://t.me/<bot>?start=<parameter>`,
  where "A-Z, a-z, 0-9, _ and - are allowed" and "the parameter can be up to 64 characters long". Opening
  one sends the bot `/start <parameter>` in a private chat. Invites are `join_` and 22 base64url characters.
- Share links (https://core.telegram.org/api/links#share-links): `t.me/share/url?url=<url>&text=<text>` opens
  a chat picker and puts the URL, then the text on a new line, in the chosen chat's text field. /invite's
  "Share the invite" button is one.
- Keyboard-button Mini Apps (Bot API 10.3, 24 Aug 2026; https://core.telegram.org/bots/api#keyboardbutton,
  https://core.telegram.org/bots/webapps#keyboard-button-mini-apps): a `KeyboardButton` with `web_app`
  ("If specified, the described Web App will be launched when the button is pressed") is "Available in
  private chats only". Such a Mini App can send the bot data with `Telegram.WebApp.sendData`, "up to 4096
  bytes", "only available for Mini Apps launched via a Keyboard button", after which "the Mini App is
  closed". The bot receives it as a service message, `Message.web_app_data` (`WebAppData`: `data` and
  `button_text`), and the docs warn that "a bad client can send arbitrary data in this field": the bot
  only takes it as a claim to check on-chain. Without Telegram's script, the raw event is
  `web_app_data_send` with `{"data": "<string>"}` (https://core.telegram.org/api/web-events#web-app-data-send).
  `ReplyKeyboardMarkup` takes `keyboard` and optional `is_persistent`, `resize_keyboard`,
  `one_time_keyboard`, `input_field_placeholder`, `selective`, `force_reply`; `ReplyKeyboardRemove` is
  `{"remove_keyboard": true}`. `WebAppInfo.url` is "An HTTPS URL". The setup offer (D-30) uses all of this.
- A keyboard-button Mini App gets no user data (https://core.telegram.org/bots/webapps#webappinitdata):
  WebAppInitData "is empty if the Mini App was launched from a keyboard button". So the setup page can't
  learn who opened it from Telegram's launch data. The bot puts the account it recorded at /start in the
  page's link, and checks the signed claim against its own record. For the same reason the bot can't
  check `initData`. That check is "HMAC_SHA256(<bot_token>, "WebAppData")" as the secret key, then the
  hex HMAC of the alphabetically sorted `key=value` lines (#validating-data-received-via-the-mini-app).
  The dashboard detects Telegram by any `tgWebApp…` launch parameter (`tgWebAppVersion`,
  `tgWebAppPlatform`), not only `tgWebAppData`. near-connect 0.12 (`build/helpers/telegram.js`) counts
  `window.TelegramWebviewProxy` or a stored `__telegram__initParams` as a Mini App.
- Checked 2026-11-04 (https://core.telegram.org/bots/webapps): `openTelegramLink(url)` "opens a telegram
  link inside the Telegram app. The Mini App will not be closed after this method is called. Up to Bot API
  7.0 The Mini App will be closed after this method is called" (changelog, Bot API 7.0, 29 Dec 2023: "Mini
  Apps no longer close when the method WebApp.openTelegramLink is called"). The setup page's Finish opens
  `t.me/<bot>?start=finish_<code>` this way (raw event `web_app_open_tg_link` with `path_full`), then sends
  its claim with sendData, which closes it; below version 7.0 (`tgWebAppVersion`) it asks for an update.
  Deep links in private chats (https://core.telegram.org/bots/features#deep-linking): "When someone opens a
  chat with your bot via this link, you will receive: /start <parameter>", from that person. `finish_` and
  43 base64url characters (32 bytes) is 50 characters.
- Telegram for Android, read in its source on 2026-11-04 (github.com/DrKLO/Telegram, master):
  `ui/web/BotWebViewContainer.java` handles `web_app_open_tg_link` with
  `onOpenUri(Uri.parse("https://t.me/" + pathFull), null, false, true, force_request)`, and `onOpenUri`
  returns without opening anything when `System.currentTimeMillis() - lastClickMs > 10_000 && suppressPopup`;
  otherwise it sets `lastClickMs = 0` and opens the link. `lastClickMs` is set when the web view is touched
  (`ACTION_DOWN`) and by the Mini App's main, secondary and settings buttons. So a Mini App on Android opens a
  t.me link only within 10 seconds of a tap on it, and once per tap, with no error when it doesn't. HOT
  Wallet's connector asks for its own tap (its popup in the page) and opens HOT with it, so after the wallet
  has signed, the page's own `openTelegramLink` is dropped. Seen live the same day (onasachi.tg): the claim
  reached the bot as `web_app_data`, the finish code never did. The setup page therefore opens the chat from
  a tap of its own, after the wallet has signed.
- In the same source, `ui/LaunchActivity.java`: a bot link with a start parameter, when the chat on screen is
  that bot's (`sameDialogId`, the chat under the Mini App), calls `minimizeBotWebViews` and
  `ChatActivity.setBotUser(botUser)`, which calls `sendBotStart(currentUser, botUser = value)`: Android
  sends `/start <parameter>` by itself and shows no START button. Other chats open with START.
- Mini App theme, checked 2026-11-05 (https://core.telegram.org/api/bots/webapps,
  https://core.telegram.org/api/web-events, https://telegram.org/js/telegram-web-app.js): the launch fragment
  carries `tgWebAppThemeParams` (JSON), and Telegram's script sets `colorScheme` to dark when `bg_color`'s
  brightness `sqrt(0.299 r² + 0.587 g² + 0.114 b²)` is below 120. Clients send `theme_changed` with
  `{theme_params}` by calling `window.Telegram.WebView.receiveEvent(eventType, eventData)`; Telegram Web posts
  `JSON.stringify({eventType, eventData})` from the parent frame. A Mini App asks for it with
  `web_app_request_theme`, and colours Telegram's own bars with `web_app_set_header_color` (`{color_key:
  "bg_color" | "secondary_bg_color"}` or `{color: "#rrggbb"}`, not both), `web_app_set_background_color`
  (`{color}`) and `web_app_set_bottom_bar_color` (`{color}`). The dashboard follows that theme (web/lib/theme.ts).

## Hosted setup from a browser wallet (checked 2026-11-03)

- @hot-labs/near-connect 0.12.0 (`build/actions/types.d.ts` in the installed package) declares the actions
  a dapp can ask a wallet to sign: `CreateAccount`, `DeployContract` (`params.code`, a `Uint8Array`),
  `FunctionCall`, `Transfer`, `Stake`, `AddKey` (a function-call permission is
  `{receiverId, allowance?, methodNames?}`), `DeleteKey`, `DeleteAccount`, `UseGlobalContract`,
  `DeployGlobalContract` and the gas-key actions. The `/setup` page sends `CreateAccount`, `Transfer`,
  `AddKey`, `DeployContract` and `FunctionCall` (`walletActions` in `shared/src/setup.ts`). HOT Wallet
  signed a NEP-413 message from the Mini App on Android on 2026-11-04 (the setup claim, which the page
  checks exactly as the bot does). Whether it signs a contract deployment is still untried: the 84 KB one
  never reached it (next section).
- near-api-js 7.4 `verifyMessage` (`near-api-js/nep413`, `lib/nep413/index.js`) reads the signer's access key
  with `viewAccessKey`, refuses it unless `permission === "FullAccess"`, then checks the ed25519 signature
  over SHA-256 of the Borsh payload `{message, nonce[32], recipient, callbackUrl?}` behind the prefix
  2147484061 (2^31 + 413). `checkSetupClaim` reads the key itself, so an RPC failure is not mistaken for a
  bad signature, and tests it with signatures made by `KeyPairSigner.signNep413Message`.
- `query` with `request_type: "view_code"` for `getleash.onanikes.near` returns 83,900 bytes whose SHA-256
  is the release's (`8eaccbf1…`), both from Node (near-api-js `viewContractCode`) and from a browser page
  on another origin (FastNEAR's RPC allows it). The setup page copied the code this way until D-31.
- `storage_balance_of` on USDC returns `null` for an account that does not exist yet
  (`getleash.chisolu.near`), and near-api-js 7.4 `viewAccount` reports `amount`, `locked` and
  `storage_usage`. A small account can hold less than its storage costs (`chisolu.near`: 0.0018 NEAR
  less, NEP-448), so the page never counts a balance below zero.

## HOT Wallet's connector, and the installer (checked 2026-11-04)

- The connector near-connect loads for HOT Wallet (`repository/manifest.json` 1.1.0 in hot-dao/near-selector,
  wallet `hot-wallet` 1.0.4, executor `repository/hotwallet.js`, read 2026-11-04) handles every request the
  same way: `JSON.stringify({method, request, deadline: now + 60 s, id, $hot, origin})`, base58 of that
  (base-x 3, bundled), POST to `https://h4n.app/<sha1>/request`, then buttons (in Telegram,
  `t.me/hot_wallet/app?startapp=hotcall-<id>`), then a poll of `https://h4n.app/<id>/response` every 3 s
  with no timeout. Near-connect hands it the request by `postMessage`, so a `Uint8Array` arrives intact
  and `JSON.stringify` writes it as an object with one key per byte.
- base-x's base58 is quadratic. Measured in Node on this Mac with bs58 4.0.1 (the same base-x): 32,000
  characters 2.7 s. The setup page's batch deploying the 83,900-byte release was 960,190 characters: about
  41 minutes here (extrapolated), hours on a phone, so HOT's prompt never appeared (the first live setup,
  Android, 4 Nov; nothing was signed but the claim, and `onasachi.tg` kept its 1.50 NEAR). The batch with
  the installer (1,932 bytes) is 20,688 characters: 1.0–1.3 s here.
- On near-sandbox 2.13.4 (`devkit/test/installer.sandbox.test.ts` and measurements alongside), gas price
  10^8 yocto as on mainnet (checked 2026-11-04): publishing the store burns 16.6 Tgas; a policy batch with
  the installer burns 29.6 Tgas in all (the creating receipt 9.4, the store's `get` 7.2, `on_code` 4.2, the
  deploy and `new` 6.9); `install` needs 28 Tgas attached (with 15 for `get`); the contract then uses
  84,348 bytes of storage, the store 85,409.
- NEAR charges a transaction's attached gas up front at about 10× the gas price and refunds what wasn't
  burned one or two blocks later: a 60 Tgas `install` moved the balance down 0.0425 NEAR beyond its deposit
  and 0.0334 came back 3 s later. Sent back to back, the four setup transactions needed the cost plus 0.055
  to 0.06 NEAR in the wallet (plus 0.05 ran out at the contract, plus 0.06 completed). With 1.50 NEAR and
  182 bytes of storage (`onasachi.tg`'s), the installer's setup completed and the direct deploy (100 Tgas on
  `new`) was refused at the contract: balance 1.135, cost 1.164 NEAR.
- Global contracts (https://docs.near.org/smart-contracts/global-contracts, read 2026-11-04): publishing
  costs 10 NEAR per 100 KB, burned, not refundable; using one costs under 0.001 NEAR. For the release, about
  8.4 NEAR (D-31, rejected).

## HOT Wallet's review screen, and the factory (checked 2026-11-04)

- The installer setup reached HOT on Android (4 Nov): "Review transaction · Actions in request: 11", a red
  "Deploying a contract replaces your account code. A malicious contract can take over the account.", a
  yellow "The app gets a key to call getleash.onasachi.tg without asking you. It can't attach deposits.", and
  "Dangerous request … To continue, type CONFIRM". The owner rejected it; nothing was spent.
- HOT's web app (`https://app.hot-labs.org`, bundle `source/index-rLzeNhYW.js`, read 2026-11-04) rates each
  action: `DeployContract` and `UseGlobalContract` "danger" (that red text), whatever account they target;
  `DeployGlobalContract` "danger" by account, "warning" by hash; a full-access `AddKey` "danger"; a
  function-call `AddKey` "warning" (the yellow text; "danger" when it may call the signer's own account);
  `DeleteKey` and `DeleteAccount`, `Stake` and unknown actions "danger"; `CreateAccount` and `Transfer`
  nothing. A `FunctionCall` gets a warning only for some methods (`nft_approve`, a forced
  `storage_unregister`, NEAR Intents keys); otherwise HOT shows the NEAR it sends. A request needs CONFIRM
  when any action is "danger" (`requiresConfirmation: o.some(c => c.severity === "danger")`).
- The `near` account runs near/near-linkdrop 0.1.1 (its `contract_source_metadata`), which exports
  `create_account`; its code names the arguments `new_account_id` and `new_public_key`. `getleash.near` did
  not exist on mainnet (2026-11-04).
- The factory on near-sandbox 2.13.4 (`devkit/test/factory.sandbox.test.ts` and measurements alongside):
  `create` needs 74 Tgas attached (72 failed with "Exceeded the prepaid gas"); at 80 Tgas it burnt 50.5 Tgas,
  0.0237 NEAR, in all. Each new account's receipt burns about 7.4 Tgas and 0.007 NEAR (the same as when the
  owner created them: a plain `CreateAccount` + `Transfer` transaction cost 0.0071 NEAR here). Attaching 85
  Tgas, the deposit of 1.40325 NEAR needs 1.489 available; at 100 Tgas a wallet with 1.5 NEAR was refused
  ("cost 1.50417": attached gas held at 10.06 times the gas price), at 85 one with 1.498 available completed.
  The factory with its name checks is 7,921 bytes; a review run put `create`'s minimum at 73.25 Tgas.
- NEP-145 `storage_deposit` (the repo's mock token, the standard implementation) registers an account id
  that doesn't exist yet; registering it again refunds the deposit to the caller.

## Skill vs live-doc conflicts

| Skill says | Live source says | We follow |
|---|---|---|
| `near-intents/api-quote.md`: `EXACT_OUTPUT` responses include `maxAmountIn` | The live OpenAPI `Quote` schema has no `maxAmountIn`; `amountIn` is the upper bound and excess is refunded | live spec |
| `near-intents/api-quote.md`: `deadline`, `slippageTolerance`, `depositType`, `recipientType`, `refundType` optional with defaults | All are **required** in the live `QuoteRequest` schema | live spec (we always send them explicitly anyway) |
| `near-smart-contracts`: near-sdk "latest 5.29.x" | crates.io has 5.30.0 | 5.29.1 as scaffolded by `cargo near new` |
| PLAN §5.1 rule 4: `near-workspaces` | NEAR docs and skill: `near-sandbox` + `near-api` | docs (see `docs/decisions.md` D-05) |
| `near-api-js` skill: `actions.addFunctionAccessKey(publicKey: string, …)` | near-api-js 7.4.0 exports `actions.addFunctionCallAccessKey(publicKey: PublicKey, receiverId, methodNames, allowance?)` | installed package |
| `near-intents/rules/deposit-near.md`: deposit with a plain `ft_transfer` | the deposit account is unregistered on USDC at quote time; a plain `ft_transfer` would fail | live chain state (`register_recipient` first) |
