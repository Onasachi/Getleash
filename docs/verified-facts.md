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
| near-sandbox (npm) | 0.3.4, runs sandbox node 2.13.4; genesis accounts via `GenesisAccount` | npm, installed types |
| Testnet RPC | `https://rpc.testnet.fastnear.com` answers `status` (HTTP 200, 2026-11-02) | live |
| near-sdk (Rust) | 5.29.1 locked (5.30.0 latest on crates.io) | `cargo search`, `contract/Cargo.lock` |
| cargo-near | 0.22.0 installed (`cargo install --locked cargo-near`) | local |
| Contract scaffold | `cargo near new` template: edition 2024, toolchain pinned to Rust 1.93.0, `overflow-checks = true`, reproducible build image `sourcescan/cargo-near:0.21.1-rust-1.96.0` | generated `contract/Cargo.toml` |
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
- near-api-js 7.4.0 `verifyMessage` (NEP-413) requires the signing key to be a **FullAccess** key of
  the account, then checks the signature (installed source).
- Next.js 16.4 dev server blocks its dev resources for origins other than `localhost` unless listed
  in `allowedDevOrigins`; open the dev dashboard at `http://localhost:…`.

## Skill vs live-doc conflicts

| Skill says | Live source says | We follow |
|---|---|---|
| `near-intents/api-quote.md`: `EXACT_OUTPUT` responses include `maxAmountIn` | The live OpenAPI `Quote` schema has no `maxAmountIn`; `amountIn` is the upper bound and excess is refunded | live spec |
| `near-intents/api-quote.md`: `deadline`, `slippageTolerance`, `depositType`, `recipientType`, `refundType` optional with defaults | All are **required** in the live `QuoteRequest` schema | live spec (we always send them explicitly anyway) |
| `near-smart-contracts`: near-sdk "latest 5.29.x" | crates.io has 5.30.0 | 5.29.1 as scaffolded by `cargo near new` |
| PLAN §5.1 rule 4: `near-workspaces` | NEAR docs and skill: `near-sandbox` + `near-api` | docs (see `docs/decisions.md` D-05) |
| `near-api-js` skill: `actions.addFunctionAccessKey(publicKey: string, …)` | near-api-js 7.4.0 exports `actions.addFunctionCallAccessKey(publicKey: PublicKey, receiverId, methodNames, allowance?)` | installed package |
| `near-intents/rules/deposit-near.md`: deposit with a plain `ft_transfer` | the deposit account is unregistered on USDC at quote time; a plain `ft_transfer` would fail | live chain state (`register_recipient` first) |
