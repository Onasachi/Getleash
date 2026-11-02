# Implementation decisions

Where the code deliberately departs from, or makes precise, something in [`PLAN.md`](PLAN.md). Each entry says what
we do and why. If the plan and this file disagree, this file describes the code; fix one or the other, never leave
both.

## Contract accounting

**D-01 · The fee headroom ("slack") stays reserved until the transfer is confirmed.**
At funding, the contract moves only `amount_in` out of `reserved` (and out of `cash`). The rest of the reservation,
`max_in − amount_in`, stays reserved until the transfer callback succeeds. On a proven transfer failure the full
`max_in` is reserved again, so the intent can be retried at once and `reserved ≤ cash` still holds.
*Why:* the plan releases the whole `max_in` at funding; if other approvals then used that headroom, a failed transfer
could not be retried without breaking `reserved ≤ cash`.

**D-02 · `max_in` has a fixed-fee term per destination asset.**
`max_in = ceil(value × (10 000 + max_fee_bps) / 10 000) + asset.max_fixed_fee` for cross-chain intents, and
`max_in = amount_out` for native payouts.
*Why:* the live 1Click quote for USDC→USDT(Tron) carries a ~0.85 USDT withdrawal fee regardless of size
(`docs/verified-facts.md`). A percentage-only bound would either block small Tron payouts or need a huge `max_fee_bps`
that weakens the bound for large ones.

**D-03 · Which number each limit applies to.**
- Invoice value (`amount_out`, converted to treasury units where compared with treasury numbers): `approval_threshold`,
  `test_payment_max`, supplier `per_payment_cap` and supplier `monthly_cap` (the last two in the supplier's own asset units).
- Treasury outflow (`max_in` when committed, `amount_in` when charged): `daily_cap`, `monthly_cap`,
  `autonomous_daily_budget`, `executor_trust_daily_budget`, `unverified_cumulative_budget`.
*Why:* owners think about invoice limits in invoice terms; budgets must bound what can actually leave the treasury,
fees included.

**D-04 · How each budget is consumed.**
- `daily_cap` / `monthly_cap`: `charged in the current period + everything currently reserved + the new max_in` must
  fit. Funding converts a reservation into a charge, so the sum never grows; a new day or month starts from zero
  charges. Charges are removed only on a proven transfer failure, never by refunds (F-02).
- `autonomous_daily_budget`: consumed by `max_in` at auto-approval and never returned the same day, even if the
  intent later expires. Conservative on purpose: it bounds what the agent can commit on its own per day.
- `executor_trust_daily_budget`: consumed by `amount_in` when a cross-chain attempt is authorized under the trust
  budget; returned only if that attempt is voided before funding or its transfer provably fails (same day only).
- `unverified_cumulative_budget`: consumed by `max_in` when an intent to an unverified supplier is approved; never
  returned. It resets only when the supplier's destination changes (a new destination starts a new history).

**D-08 · A failed transfer across midnight re-checks the caps.**
If the transfer failure is reported in a later day or month than the charge, the reservation is restored only if it
fits the current period's caps. Otherwise the intent goes back to `Pending` and needs the owner's approval again.
*Why:* restoring it unconditionally could let one day's committed total exceed `daily_cap`.

**D-16 · Inflows are reconciled in batches.**
`reconcile_inflows` takes up to 20 entries, each a top-up, a return for a specific attempt, or unattributed. Every
exact-output swap returns a little change, so one call per payment would be tedious. Per attempt, the total returned
can never exceed `amount_in`. Returns never restore budgets.

## Contract lifecycle

**D-06 · Changing a supplier's caps does not bump its revision.**
`update_supplier` changes the destination (chain, asset, recipient): it bumps `revision`, restarts the cooldown,
clears verification and the unverified budget, and invalidates every open, unfunded intent for that supplier.
`set_supplier_caps` changes only the caps and does none of that.
*Why:* caps are not part of an intent's terms, so changing them does not change what an approval means. Restarting
the cooldown when an owner lowers a cap would punish the safe action.

**D-07 · Owner rejection is final for an obligation id.**
If the owner rejects or cancels an intent, re-proposing the same obligation id is refused with a new reason code,
`OBLIGATION_REJECTED`; only `amend_intent` can revive it. Expired or invalidated obligations may be re-proposed.
Also added: `ASSET_DISABLED` (the supplier's asset is disabled or unknown).
*Why:* otherwise an agent could re-propose a rejected invoice and, if small, have it auto-approved.

**D-09 · After funding, the executor reports and the owner decides.**
The executor may only `report_delivery` (informational: `Funded → Delivered`) or `flag_reconciliation`. The owner
resolves a flagged attempt with `resolve_reconciliation`: `NotSent` (the transfer never happened: restore, as for a
proven failure), `Sent`, `Delivered`, or `SwapFailed` (money left but the swap failed: the intent is re-reserved for a
retry if it fits, otherwise goes back to `Pending`; the charge stays). Returned funds come back only through
`reconcile_inflows`.
*Why:* a compromised executor must never be able to make the contract pay the same invoice twice.

**D-10 · The transfer callback reads the promise result itself.**
`on_transfer_complete` uses `env::promise_result_checked` and treats only `PromiseError::Failed` as a failed
transfer. A success whose result is too long still counts as success.
*Why:* the SDK's `#[callback_result]` maps "too long" to an error, which would restore funds that actually left.

**D-12 · `register_deposit` is `register_recipient`.**
It storage-registers the attempt's committed payee on USDC: the 1Click deposit account for cross-chain attempts, or
the supplier's NEAR account for native ones. Bounded by `max_registrations_per_day`.

**D-14 · Unfunded attempts can be cancelled.**
The executor may cancel its own unfunded attempt (to replace a stale quote); the owner may cancel any unfunded
attempt. Creation is bounded by `max_attempts_per_day` and 10 attempts per intent.

**D-15 · Test payments always need the owner twice.**
During a cooldown, a payment of at most `test_payment_max` is accepted as a test payment: the intent needs owner
approval and its attempt needs an owner signature, native or cross-chain, as the plan says.

**D-19 · Rotating the executor, or entering hosted mode, voids its trust-budget attempts.**
`rotate_executor` and `set_hosted_mode(true)` void every unfunded attempt authorised under the
executor-trust budget (returning the budget), and funding refuses trust-budget attempts while hosted.
*Why:* those attempts' deposit accounts were chosen by the old executor. If it was compromised, the
new, honest executor's loop would otherwise fund them, which defeats the point of rotating.

**D-18 · Hash construction.**
`intent_hash = sha256("getleash:intent:v1\0" ‖ borsh(contract_account_id) ‖ borsh(IntentTerms))`, and the same shape
with `"getleash:attempt:v1\0"` and `AttemptTerms` for attempts. The domain prefix and the contract id stop a
signature for one contract (for example the demo) being replayed on another.

## Setup and custody

**D-11 · The policy account never has an access key.**
The owner's setup transaction is one batch from `<business>.near`: `CreateAccount`, `Transfer`, `DeployContract`,
`FunctionCall new`. No key is ever added, which is stronger than adding one and deleting it. The plan's version
(deploy + init + `DeleteKey` in one batch) remains the fallback for an account that already exists.

**D-13 · No delete method in v1.**
Exit is `withdraw` (USDC) plus `withdraw_near`. Deleting the account while unreconciled USDC remains on the token
contract would strand it, and the contract cannot read its own token balance synchronously.

## Tooling and interfaces

**D-05 · Integration tests use `near-sandbox` + `near-api`.**
Current NEAR docs and the installed skill recommend them over `near-workspaces` (PLAN §5.1 rule 4 predates that).

**D-17 · JSON conventions.**
Ids (supplier, intent, attempt) are JSON numbers. Amounts and nanosecond timestamps are decimal strings. 32-byte
hashes and obligation ids are 64-character lowercase hex.

## Services (TypeScript)

**D-20 · An invoice from an unknown supplier is proposed as supplier 0.**
When no directory entry matches, the agent still proposes, with `supplier_id = 0` (ids start at 1,
so 0 never exists). The contract refuses it with `UNKNOWN_SUPPLIER` and records the refusal in its
ring buffer and events, so every invoice that reaches the agent leaves either an intent or an
on-chain reason code. Ambiguous matches (two candidates) and invoices without a reliable invoice
number are not proposed; the owner is asked instead.
*Why:* the model never picks a supplier id, so a prompt injection cannot name a destination; the
on-chain record makes attempted fraud visible on the public dashboard. Bounded by the proposal quota.

**D-21 · `quote_ref` is the 1Click quote signature.**
The plan allowed "quote id/signature". `correlationId` differs per HTTP response and `/v0/status`
does not echo the quote's, while it does echo the signature (docs/verified-facts.md, 2026-11-02).
Committing the signature lets the attempt page match the on-chain attempt to 1Click's own record,
and is what the stretch on-chain verifier would check.

**D-22 · The executor commits the requested deadline, and asks for a longer one when the owner must sign.**
1Click's `quote.deadline` is three days after the deadline in the request; the request's deadline
is when refunds start, so that is what `quote_deadline` commits (the contract caps it at one day).
Attempts that will need the owner's signature (hosted mode, test payments, above the remaining
trust budget) are quoted with a 4-hour window; trust-budget attempts with 20 minutes. If the
window passes, `sweep` voids the attempt and the executor re-quotes into a new one.

**D-23 · Invoice-number normal form.**
NFKC, upper case, separators removed, leading zeros dropped from every digit run, leading labels
("INVOICE", "INV", "NO", "NUMBER", …) stripped: "INV-00042", "Invoice No. 42" and "inv 0042" are all
"42". The extracted number must also appear in the document text. Distinct invoices that normalise
alike for the same supplier would collide; that blocks the second one (the owner can amend), it can
never pay twice.

**D-24 · Only NEAR-hosted models, and a precise badge policy.**
The extractor uses models whose live catalog entry says `owned_by: "nearai"` and that support
structured outputs (preferring `Qwen/Qwen3-VL-30B-A3B-Instruct`); proxied third-party models are
refused even if configured. "Model response verified" requires: the TEE's EIP-191 signature over
`model:sha256(request):sha256(response)` of our exact bytes, a fresh attestation whose TDX
report_data binds that signer and our nonce, a non-debug TD, the quote verified against Intel PCS,
and NVIDIA NRAS passing with our nonce. Anything that cannot be checked gives "Verification
unavailable"; anything that fails gives "Verification failed". No measurement allow-list is pinned,
because NEAR AI publishes none; the README says what the badge does and does not prove.

**D-25 · TypeScript integration tests run on `near-sandbox` (npm) with an offline reader.**
`devkit/` starts a local node with genesis accounts, deploys the real wasm and runs the real setup
functions; mock-1click settles real mock-token transfers on that node. The offline demo and tests
use a deterministic text reader in place of the model, so they need no API key.

**D-26 · Private data stays where the services run.**
The supplier directory and the encrypted invoice store (AES-256-GCM, `INVOICE_STORE_KEY`) are local
files of the self-hosted services. The dashboard's public pages and the approve, attempt, reconcile
and pause pages use chain data only (read from the owner's browser) and the owner's wallet, so they
can be hosted anywhere. The private view exists only on a server that has the data directory, and
requires a NEP-413 signature by a full-access key of the contract's owner account.

**D-27 · Telegram stays on grammY; WhatsApp will use Chat SDK.**
Chat SDK 4.43 (checked 2026-11-02) fits the Telegram intake (polling or verified webhooks, attachment
sizes before download, commands), but its deduplication is a TTL in its state store and it has no
chat allowlist, so GetLeash's durable update log and chat checks would stay anyway. Its value is
WhatsApp (Cloud API webhooks, `X-Hub-Signature-256`, template messages outside the 24-hour window),
which PLAN §2 puts after the hackathon. It will be added then as a second implementation of
`channels/core`; the hackathon build keeps the tested grammY channel.
