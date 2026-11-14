# Implementation decisions

Where the code deliberately departs from, or makes precise, something in [`PLAN.md`](PLAN.md). Each entry says what
we do and why. If the plan and this file disagree, this file describes the code; fix one or the other, never leave
both.

D-01 … D-27 were written for contract v1 (git tag `v1-full-contract`). The contract was then rewritten lean for
the mainnet budget: **D-28** at the end describes v2, and where it differs from an earlier entry, D-28 wins.

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
structured outputs, in the order `Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash`,
`Qwen/Qwen3-VL-30B-A3B-Instruct`, with reasoning switched off (`enable_thinking: false`). A model
that times out, is unreachable or fails with a server error is skipped for 10 minutes and the next
one is tried, at most two per invoice. Account errors (401/402/403) stop at once, and a pinned
model (`NEAR_AI_MODEL`) is never swapped. Proxied third-party models are refused even if
configured. "Model response verified" requires: the TEE's EIP-191 signature over
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

## Contract v2 (lean)

**D-28 · A lean contract for a ~1.5 NEAR mainnet deployment.**
v1 compiled to 370 KB, which locks 3.7 NEAR of storage (≈4.3 NEAR all in); the owner can spend
about 2 NEAR. Measured on 2 Nov: the contract's own logic was ~103 KB of the pre-optimisation code,
JSON handling for 51 methods ~130 KB, and size flags were already maxed. v2 keeps the guarantees the
pitch rests on and moves bookkeeping off-chain; it compiles to 85,809 B and its account holds
87,392 B after a full sandbox run (≈0.87 NEAR locked). v1 was never deployed (no migration) and is
tagged `v1-full-contract`.

- **Still on-chain:** keyless custody and owner-only `upgrade` (refused while a payout's callback is
  outstanding); payments only to allowlisted suppliers at the revision the intent was made for,
  never to the contract, the token or a role; approval threshold, autonomous daily budget and
  daily cap; one payment per invoice (a rejected invoice stays blocked, D-07); the address-change
  cooldown, during which every payment waits for the owner and even the owner can approve at most
  `cooldown_max`; the executor-trust daily budget, tied to an executor epoch so rotation voids the
  old key's unsigned attempts (D-19); the cross-chain fee bound `value − fee% ≤ amount_in ≤ max_in`
  (D-02, with the fixed fee now in the policy); quote deadlines (≤ 1 day, funding margin); pause;
  proposals per day; a hard cap of 50 stored intents.
- **Budgets only go up.** Counters are charged when a payment is approved (autonomous budget, as
  `max_in`) or sent (daily cap and trust, as the amount sent) and never decrease, not even after a
  failed transfer. Refunds simply land in the token balance. This replaces D-01, D-08 and the
  owner-only crediting of returned funds.
- **Owner approvals name the terms instead of signing hashes.** Intents are immutable, so
  `decide(intent_id, action, amount_out, supplier_id)` binds the approval to the id and repeats
  the terms the wallet shows; attempts can be re-quoted, so `authorize(intent_id, deposit,
  amount_in)` names the exact 1Click deposit and fails if the executor has swapped it. Replaces
  D-18 and the hash checks of D-21.
- **Every payout goes through `start_payout`**, which checks pause, supplier, revision, expiry,
  the obligation mapping, gas, the daily cap and, for cross-chain, the attempt's deadline, fee
  bound and authorization or trust; then writes the intent as `PAYING` and sends. Native payouts
  are one `ft_transfer` in the call that approves them (the agent's `propose` within limits, or the
  owner's `decide`), so the executor never touches them and native suppliers must use the token's
  decimals. Cross-chain payouts are one receipt `[storage_deposit, ft_transfer]` to the token, so a
  failed transfer also undoes the deposit account's registration.
- **The callback is `on_paid(intent_id, since)`**: a no-op unless that payout is still the one in
  flight, never panics, and only changes a fixed-width status, so it can never fail for storage.
  A lost callback is settled by the owner (`MARK_PAID` / `MARK_FAILED`) after `callback_grace_ns`
  (≥ 1 h); only `FAILED` intents, or cross-chain `PAID` ones the swap refunded, can be retried.
- **Off-chain now:** the ledger and reservations (a payout beyond the balance fails cleanly in the
  token), monthly and per-supplier caps, the unverified-supplier budget and `verify_supplier`,
  test-payment ceilings (now `cooldown_max`), the asset registry, `amend_intent`, delivery reports
  and reconciliation (1Click status is read by the executor and the dashboard), the open-work
  listing (`get_intents` scans), the rejection log (refusals are returned and logged as events),
  the quote-ref burn set, sweep and hosted mode (a trust budget of 0 is the same thing).
- **Size measures:** agent, executor and callback arguments, results and views are Borsh; owner
  methods keep JSON so the wallet shows what is signed, but it is read by a strict flat-object
  parser (`contract/src/json.rs`) instead of serde_json (≈70 KB): duplicate keys (a wallet could
  show one value and the contract read another), unknown or missing keys, escapes, floats, nesting
  and trailing bytes are refused; it is fuzzed against serde_json. Events and the token calls'
  arguments are written by hand; records use raw storage with one-byte prefixes; no embedded ABI;
  the Tron checksum is checked off-chain (seed script, dashboard), the contract checks the shape.
- **Storage:** an intent with its invoice entry is ≈0.003 NEAR; at most 50 are stored, closed ones
  are forgotten after `retention_ns` (7 days) and never-funded expired or stale ones at once (which
  frees their invoice). Paid and rejected invoices keep ≈0.0008 NEAR each to block duplicates.
- **Role accounts:** NEAR checks a signer's balance against the attached gas at a worst-case price
  (≈0.001 NEAR per TGas), so the services attach only what a call needs (propose 70, fund 80 TGas;
  the contract requires 60 for a payout, proven on a real node) and the role accounts get 0.15 and
  0.2 NEAR.

Also superseded or amended by D-28: D-03 and D-04 (the limits and budgets listed above), D-06 (no
caps or verification; `update_supplier` bumps the revision and restarts the cooldown), D-09 and
D-16 (no reconciliation on-chain), D-12 (registration happens inside the cross-chain payout), D-13
(`withdraw_near` keeps a 0.05 NEAR reserve), D-14 (re-quoting replaces an unfunded attempt), D-15
(the owner approves the test payment and signs its deposit), D-17 (hashes are gone; Borsh as
above), D-20 (refusals are not stored), D-22 (no sweep; the executor re-quotes), D-26 (the intent
page replaces the approve, attempt and reconcile pages).

**D-29 · Suppliers are added from Telegram, and the bot keeps their names.**
Adding a supplier took a JSON file, `pnpm seed` on the owner's machine, and the directory pasted into
both hosts as `GETLEASH_DIRECTORY_BASE64`. Now it takes one message and one signature:
- **Two ways in.** The owner sends `/addsupplier <name> <address>`, or `/invite [name]` for a one-time
  link the supplier opens in Telegram and answers with its own address. An invite works for the first
  Telegram user who opens it, for 7 days and 5 unusable answers, and is stored as the SHA-256 of its
  token. A supplier who opened one gets answers about that invite only; every other message from outside
  the allowlist stays unanswered.
- **Checked, then signed by the owner.** Details are read by deterministic code, not a model. The bot
  checks the address: Tron checksum; that a named NEAR account exists; not the contract, the token, a
  role account or the USDT contract; not already on the list. It keeps the request and gives the owner a
  button to `/suppliers/new?to=<address>`. That page checks again in the browser, and the owner's wallet
  signs `storage_deposit` on USDC (when the account is not registered) and `add_supplier` with exactly
  those terms. The bot signs nothing; the contract is unchanged.
- **The name stays with the bot.** It never travels in the page's link, so it is not in Telegram's button
  or the dashboard host's logs. The bot watches the chain for the request's address: every 10 s for 15
  minutes, then every minute, for 7 days. When the supplier appears, the bot saves the name to the
  directory file on its disk and tells the owner, and the supplier if it came through an invite. A name
  another supplier already goes by, as the agent compares names, gets `#<id>`: two suppliers with one name
  would make every invoice in that name ambiguous.
- **Where names are read from.** The services read `GETLEASH_DIRECTORY_BASE64` (the suppliers `pnpm seed`
  added, which win for an id both have) plus the directory file. On a host without a disk, names added in
  Telegram are lost at a restart. Payments still find the supplier: an on-chain supplier with no directory
  entry is matched by its exact address, when the invoice prints it and the model read it. Only that
  address can be paid, so this is as safe as matching payment details on file. `/addsupplier` names it
  again without a signature.
- **Not offered.** The bot does not offer to add the address that an invoice from an unknown supplier asks
  to be paid at. That is the classic invoice fraud (fixture 05). The reply tells the owner to get the
  address from the supplier directly, or to send an invite.

Amends D-26 (the bot also writes the directory file) and PLAN §4.3 step 4 (an unnamed on-chain supplier
is matched by its exact address).

**D-30 · Other businesses set up their own GetLeash from the operator's bot (hosted mode).**
A business that wanted GetLeash had to run all of `docs/deployment.md`: a terminal, near-cli, its own bot
token, a NEAR AI key, its own hosting. Now it opens the operator's bot and taps a button; its own wallet
does the rest. One service serves many businesses; each keeps everything that matters:
- **Their own contract, signed by their own wallet.** `/start` from someone the bot does not serve offers a
  "Set up GetLeash" keyboard button (a keyboard button, because only a Mini App opened from one can send
  data back to the bot). It opens the dashboard's `/setup` page in Telegram with the public halves of two
  keys the bot just generated for this person, one for the agent and one for the executor, and an expiry a
  day away (asking /start again renews it with the same keys). The page builds
  the setup CLI's own transactions (`setupTransactions`, `shared/src/setup.ts`; one builder for both) and
  the owner's wallet signs them: `agent-1.<owner>` and `executor-1.<owner>` with only those keys,
  `getleash.<owner>` created, funded, deployed and initialised in one transaction with no access key, and its
  USDC registration. The code is the published release (`RELEASE_WASM_SHA256`), installed by the installer
  from the operator's release store (D-31; the page first copied it from the operator's own contract, which
  no wallet request could carry). Since D-32 the wallet makes one call to GetLeash's factory instead, which
  creates these accounts under its own name. Steps already on the chain are
  skipped, so the page carries on where it stopped. It costs the owner about 1.43 NEAR; the limits are
  `DEFAULT_POLICY` (the mainnet values, trust budget 0), which only the owner's wallet can change.
- **A setup is someone's only when three things meet, each from where it can't be faked**
  (`shared/src/hosted.ts`, `channels/telegram/src/signup.ts`):
  1. *The link, signed by the bot.* The bot signs each setup link (NEP-413, recipient `getleash-setup-link`)
     with the operator's agent key: the setup's two public keys, its expiry, the Telegram account it is for
     as the bot saw it at /start (user id and "@username" or name; Telegram gives a Mini App opened from a
     keyboard button no user data) and the bot's username. The page reads that agent's keys from the chain
     (the operator's contract names its agent) and refuses a link they didn't sign. So a fake bot can't
     hand out links with keys of its own (its owner would hold a business's role keys), can't make a link
     show another name, and can't send the last step anywhere but the real bot.
  2. *The owner's claim.* Before any transaction, the owner's wallet signs a claim (NEP-413, recipient
     `getleash-setup`): the contract, the link's agent key and that Telegram account. Its nonce is the
     SHA-256 of a finish code the page makes and keeps to itself. The page shows whose setup it is ("This
     setup is for the Telegram account @acme. Continue only if that account is yours"), checks the claim
     exactly as the bot will (a wallet whose signature the bot would refuse stops before anything is paid),
     and sends it at the end as `web_app_data` to the bot that opened the page.
  3. *The finish code, from the right account.* Finish also opens the real bot's chat
     (`t.me/<bot>?start=finish_<code>`, the bot from the signed link), where the user taps START (Android
     sends it by itself, the chat being the one under the page): Telegram delivers the code as a message
     from the account holding the app the page runs in. (Telegram keeps a Mini App open while it opens a
     chat since Bot API 7.0; the page asks older apps to update.) The chat opens from a tap of its own:
     Telegram on Android opens a link from a Mini App only within 10 seconds of a tap, once per tap, and the
     wallet's window uses the tap that asked it to sign (verified-facts.md, "Telegram Bot API"). So a page
     opened again, which has no signed claim, takes two taps: Finish signs, "Open the GetLeash chat" sends
     (found live on 2026-11-04: the claim reached the bot, the code never did). The bot serves the business
     only when a claim and its code both came from the account the setup is for, in either order; a code
     without its claim is let go after a minute.

  This closes the lookalike bot. Mallory's bot sends Victor to the real page with her own, signed link; the
  page says the setup is for @mallory; if Victor signs anyway, his claim goes to Mallory's bot and she can
  relay it here, but the code goes from Victor's own Telegram straight to the real bot, which sees Victor,
  not Mallory, refuses, and tells Victor whose setup it was. Mallory never sees the code. A forwarded link
  fails the same way, and a link edited to show another name no longer verifies. (Earlier drafts took the
  account the page named, `/ready <account>`, the user in Telegram's launch data, which a keyboard button
  doesn't send, and then the claim alone, which a lookalike bot could relay; three rounds of review found
  the gaps.)
- **The owner's wallet can always move its GetLeash to another Telegram account.** The same page, opened
  by a wallet whose `getleash.<owner>` runs the release and is registered on USDC while its role accounts
  hold other keys than the link's, offers to connect it instead: a claim of kind `connect` naming the new
  account, finished the same way. If the service serves that contract, it moves it there: only the registry
  entry changes (keys, secrets and files stay), the account it leaves is told, the business's supplier
  invites and requests report to the new chat (a hosted channel answers one chat only), and the executor
  notifies it from its next pass. This covers a new phone and a lost account, and it undoes the one attack
  no code here can prevent: a copy of the page on another website that gets the owner's wallet to sign a
  claim naming someone else's Telegram account (the wallet shows that account in the message it signs).
  Whoever gets the bot that way reads what the bot says about that business and can have it pay only
  suppliers the owner added, within the owner's limits, until the owner's wallet connects it back.
  Connecting never takes a setup that is still open: a draft also served a setup whose keys the owner's
  accounts held, to rescue someone whose wallet paid with another person's link, but anyone can put a
  setup's public keys (on-chain from its first transaction) on accounts of their own, so it let a stranger
  take over someone else's half-finished setup (found in review). Someone whose wallet paid with another
  person's link has lost that NEAR, and the page warned them first; nobody can use what it created.
  Display names in links and claims are `@username` when there is one, else the name in quotes, cleaned so
  it can't pass for a username or a user id.
- **The bot believes nothing it is told.** Any client can send anything as `web_app_data`. So the bot checks
  the claim's signature, made by a full-access key of that account (`checkSetupClaim`), over the message
  rebuilt from its own record of the setup's agent key and Telegram account, and counts it only from that
  account's chat and only with a finish code from that same account. Then it checks from
  chain state alone (`checkHostedSetup`): the contract has no keys, runs the release, and names that account
  as owner and the two role accounts; each role account holds only the key generated for this person; the
  token is the operator's; the contract is registered on it. It keeps checking for 3 minutes (blocks take a
  moment to reach every RPC), then says which check failed, and checks at most every 10 s whoever asks. Only
  then is the business served, once: its two off-chain secrets were made with the setup, and the registry
  never replaces a business's secrets (its invoices and obligation ids depend on them).
- **What the business trusts the operator with.** The service holds the two function-call keys and two
  secrets it generated (the obligation-id key and the invoice store key), in `<data dir>/hosted/<contract>/`,
  mode 0600. So it reads the business's invoices, and it can propose payments to suppliers the owner added
  and fund cross-chain payments the owner authorised. The contract bounds the rest: without the owner, at
  most `approval_threshold` a payment and `autonomous_daily_budget` a day (2.50 and 5 USDC by default),
  and only to the owner's own suppliers. It can never add a supplier, change a limit, withdraw or upgrade.
  The setup page and the bot's first message say so before anything is signed. A business that wants
  none of this runs its own copy (`docs/deployment.md`), as before.
- **Isolated in the service.** Each business gets its own channel (answering only its owner's Telegram
  account and private chat), agent, executor, supplier directory, invoice store, journal and notices;
  businesses share only the bot and the model's limit of 3 invoices at once. Each chat's messages are
  handled in order on their own queue, so one business's slow invoice never holds up another's, and a
  hosted business has at most 50 invoices read a day. Because grammY confirms updates to Telegram before
  the queues have run them, each update is kept, encrypted with INVOICE_STORE_KEY, in
  `telegram-pending.jsonl` until it is handled; after a restart the unfinished ones are replayed (the
  update log drops any already acted on). The hub routes each message: an invite link to the
  business that sent it, whoever opens it (businesses supply each other); a text answer to the invite the
  sender opened last (someone who uses a GetLeash here answers only by replying to that invite's question);
  else to the business whose owner sent it; else to the signup; else nowhere (strangers' other messages
  stay unanswered). One business per Telegram user; the operator's own users cannot sign up. The executor
  takes this GetLeash and one hosted one per pass (every 10 s), in turn, to stay within the public RPCs'
  limits: at the 50-business cap each is looked at about every 8 minutes, so a trust-budget quote (20
  minutes) still lasts the two looks a cross-chain payment needs. Dashboard links name a hosted business's
  contract as `?c=<contract>`. A link can name any contract, so the wallet signs nothing for one until the
  chain shows it runs the release, and every page says so meanwhile. The private view (names, invoices)
  stays the operator's alone, and its names are not shown against another contract's suppliers.
- **Bounds and failure.** Signup opens only when `GETLEASH_DATA_DIR` names a disk and `DASHBOARD_URL` is an
  https address (Telegram opens Mini Apps from https only); `GETLEASH_SIGNUP=off` closes it, and
  `GETLEASH_MAX_BUSINESSES` (default 50) caps it. An open setup keeps its keys until a day after its link
  expired (a wallet may have signed just before), then they go and the bot removes the button; 1000 can be
  open at once. A registry that can't be read closes signup and serves no hosted business, while the
  operator's own GetLeash runs as usual. If the service loses its disk, the businesses' keys are gone with it, but not their money:
  it stays in each business's contract, which answers only to its owner's wallet (`set_roles` points it
  at new keys, `withdraw` takes the USDC out; both owner-signed, from any wallet or near-cli).

Amends D-11 (the setup can be signed by a browser wallet, with the same transactions), D-26 (each hosted
business has its own directory file) and PLAN §4.4 (the bot answers `/start` from people outside the
allowlist, to offer a setup).

**D-31 · A setup from a browser wallet deploys a small installer, which copies the release from a store on NEAR.**
- **Why.** The first setup from Telegram (HOT Wallet, 4 Nov) never showed the wallet's prompt. HOT's
  connector (near-connect's sandboxed `hotwallet.js`) base58-encodes the JSON of every request before it
  shows anything; a `Uint8Array` becomes an object with one key per byte, so the batch deploying the
  83,900-byte release was 960,190 characters, and base58 (base-x) takes time that grows with the square of
  the length: about 40 minutes on a laptop, hours on a phone. The request also expires 60 seconds after it
  is made (docs/verified-facts.md). Nothing was signed or spent; the small claim before it went through.
  So no wallet request may carry the release.
- **What.** The page's batch for the contract deploys the installer instead (`contract/bootstrap/installer`,
  1,932 bytes, raw host functions, no near-sdk), still keyless: `CreateAccount getleash.<owner>`, `Transfer`,
  `DeployContract(installer)`, `install(<new's arguments>)`. `install` (only from the account it is a
  sub-account of: its owner) keeps the arguments and calls the release store's `get`; its callback `on_code`
  (only from the account itself) deploys what came back only if its SHA-256 is the release's, after
  removing what `install` kept, and calls `new` with the owner's arguments, both in one batch on itself:
  both happen or neither. The release's `new` already accepts its own account as the caller. The store's
  account and the release's hash are built into the installer (`pnpm build:installer`, toolchain pinned,
  `--check` rebuilds and compares), so it installs that release from that store and nothing else; the
  owner's arguments can't point it anywhere else. The whole wallet request is now 20,688 characters and
  encodes in about 1 s on the same laptop. The installer's path burns about 30 Tgas and needs 28 attached;
  `install` gets 60.
- **The store** (`contract/bootstrap/store`, `release-8eaccbf1.onanikes.near`) is published once by the
  operator (`pnpm publish:release`, 0.86 NEAR locked for its storage): created keyless in one batch with the
  release as `set`'s raw input. `set` works once, only for its parent account; `get` returns the code to
  anyone. With no keys and no other method, it never changes.
- **What it changes for the owner.** What they sign and pay stays the same: four transactions, about 1.43
  NEAR, and the wallet shows `new`'s arguments, now as `install`'s. The account never has a key. The page
  checks the store holds the release before anything is signed, and the bot checks the result exactly as
  before (`checkHostedSetup`: the release's code hash, no keys, the roles). If the code doesn't come (no
  store, other code), the contract keeps the installer, keyless, and only its owner can act: the page offers
  to cancel (`abandon` deletes the account and sends its NEAR to the owner); `install` again also works.
  `abandon`'s batch first calls `still_installer`, a no-op the release doesn't have, so a cancel whose batch
  lands after the release was installed fails whole instead of deleting it. A page built after a new
  installer still recognises the old ones it lists (`RETIRED_INSTALLER_SHA256S`), so their owners can cancel.
- **Known and accepted (review, 4 Nov).** An `install` sent again while another is between `on_code` and the
  deploy (about a block) keeps its arguments after `on_code` removed the first's, and the release starts
  with them still stored under `i`: owner-only, harmless (the release's keys are longer and nothing reads
  `i`; about 0.007 NEAR stays locked), removable only by an upgrade. The installer can't prevent it without
  leaving a key of its own, since once the release runs nothing of the installer's can delete anything.
  The page never sends `install` twice; only call it again when the installer is stuck. An independent
  review rebuilt both wasm files to the same hashes, swept interleavings and gas on a local node, and found
  nothing else on-chain.
- **What a wallet must hold while it signs.** NEAR takes each transaction's attached gas at about 10× the
  gas price when it is sent and refunds the unburned part a block or two later, after the wallet has sent
  the next one. Measured on a local node with the page's four transactions back to back: the cost plus 0.05
  NEAR ran out at the contract, plus 0.06 completed. So `install` attaches 60 Tgas and the USDC registration
  10 (it burns 2.04), and the page requires the cost plus all the gas still to attach at that price
  (`signingReserve`: 0.07 NEAR, 1.50 in all), which it says comes back. From a wallet holding exactly what
  the first live wallet held (1.50 NEAR, 182 bytes of its own), the installer's setup completed, and the
  direct deploy before (100 Tgas attached to `new`) was refused at the contract: 1.135 NEAR left, 1.164
  needed. The page had said 1.43 was enough.
- **Rejected.** NEAR global contracts (publish once, `UseGlobalContract` by hash): the natural fit and about
  0.6 NEAR per setup, but publishing burns 10 NEAR per 100 KB (about 8.4 NEAR, not refundable), more than the
  operator could spend. A key on the new contract, or a throwaway account whose key the page holds, to
  deploy from the browser: breaks D-11, or puts a key in a browser. The service uploading the code: needs a
  funded service account and puts the service on the setup's path. A factory contract: it can't create
  `getleash.<owner>` (a contract creates only its own sub-accounts). An installer that takes the store and
  the hash as arguments: twice the size (1.9 KB → 2.8 KB), for no one but tests.
- Tests: `devkit/test/installer.sandbox.test.ts` (12, on a local node with the real wasm: keyless before the
  store exists, owner-only, abandon and its guard, the store set once, install, too little gas then install
  again, a whole setup in one transaction, the signing reserve, a store holding other code); `shared/test/installer.test.ts` (bytes pinned, built for this
  release and store, the request's size).

Amends D-11 (the code is installed by the installer a few receipts after the batch, still with no key),
D-30 (the page no longer copies the release from the operator's contract) and AGENTS.md ("code changes only
through the owner-signed `upgrade`", and once, at creation, through the installer).

**D-32 · A business's wallet makes one call to GetLeash's factory, which creates everything.**
- **Why.** With the installer (D-31) the setup reached HOT Wallet, which then showed it as a "Dangerous
  request": a red "Deploying a contract replaces your account code. A malicious contract can take over the
  account", a yellow "The app gets a key to call … without asking you", and a box to type CONFIRM. HOT's
  own code says why (`app.hot-labs.org`, read 4 Nov, docs/verified-facts.md): it rates every
  `DeployContract` and `UseGlobalContract` "danger", whichever account it targets, and asks for CONFIRM
  whenever any action is rated so; a function-call key on another account is a warning; a function call
  that sends NEAR gets no warning at all. Nothing here is unsafe, but a business owner reading that stops.
  So the wallet must not deploy anything or add keys.
- **What.** The factory (`contract/bootstrap/factory`, 7.9 KB, raw host functions) is published once, keyless,
  at `getleash.near` (`pnpm publish:factory`). The wallet signs one call: `create({"agent":"<hex>",
  "executor":"<hex>"})` with exactly the setup's cost attached (1.40325 NEAR: 0.15 + 0.2 + 1.05 for the
  three accounts, 0.00125 for the USDC registration, 0.002 the factory keeps for its record). The factory,
  for the caller as owner, creates `<name>-agent.getleash.near` and `<name>-executor.getleash.near`, each
  with its NEAR and exactly one function-call key (the link's), limited to the contract and the role's
  methods; `<name>.getleash.near`, the contract, with the installer and `install`, whose `new` arguments
  the factory writes (the caller as owner, those two accounts, USDC, `DEFAULT_POLICY`); and the contract's
  USDC registration. `<name>` is the owner's account id with dots made dashes (onasachi.tg →
  onasachi-tg). Everything it sets up (amounts, allowances, methods, the token, the limits, the installer)
  is built in from `shared/` (`factory/src/config.rs`, written by `pnpm build:installer`), so the factory's
  code hash says all of it, and the bot checks the result exactly as before (`checkHostedSetup`).
- **Why it can't go wrong in pieces.** Only the factory can create accounts under its own name, and it keeps
  a record per name and refuses a name it set up before (`TAKEN`), an owner whose id ends in `.agent`,
  `-agent`, `.executor` or `-executor` (`BAD_NAME`: otherwise one owner's contract could carry another
  setup's role name, and that contract's owner could act as the other business's agent), a deposit other
  than the exact cost (`WRONG_DEPOSIT`) and keys not given exactly as `{"agent":"<64 hex>","executor":"<64
  hex>"}` (`BAD_ARGS`), all before anything is spent: the call fails whole and the wallet gets its NEAR
  back. So none of the accounts it then creates can exist already. If the release is ever missing when
  the installer asks, the contract keeps the installer, keyless; `retry_install`, for the recorded owner
  only, asks again with all the gas the owner attaches (so a future rise in gas costs can be met). The
  factory has no other method and no key: it can't touch a contract once created.
- **What it changes.** HOT shows one smart contract call sending 1.404 NEAR, with no warning (to be confirmed
  live). Names change from `getleash.<owner>`, `agent-1.<owner>`, `executor-1.<owner>` to the three above:
  the contract is still the owner's alone (its owner, its limits), but it lives under GetLeash's name, not
  the owner's. An account id of up to 41 characters can have one, implicit accounts included if short
  enough. The claim names the new contract. The CLI's own setup (`pnpm setup:owner`) keeps the old names.
- **What a wallet must hold.** The call attaches 85 Tgas: `create` needs 74 (measured; `install` inside gets
  35 and needs 28, the registration 10), and NEAR holds attached gas at 10.06 times the gas price while it
  runs (measured). So the page asks for the deposit plus the gas at 10.2 times the current gas price
  (`setupNeeds`: 1.491 NEAR at the lowest price, more if gas costs more), and about 1.43 leaves the wallet
  in the end (50.5 Tgas burnt, 0.0237 NEAR: each new account's receipt costs about 0.007). A wallet holding
  exactly the first live wallet's balance (1.498 NEAR available) completed the setup on a local node.
- **Limits accepted.** The factory is immutable, so a new release, token or default policy needs a new factory
  at a new account, and new setups get names under it; contracts already set up keep their names (the bot
  stores each business's contract). Two owners whose ids differ only where one has a dash and the other a
  dot (a-b.near, a.b.near) get the same name; the second is refused (`TAKEN`). So someone could take the
  name of an owner whose id has two dots or more (x.y.near) by creating its twin (x-y.near) and setting it
  up first, for about 1.4 NEAR; for one dot (x.near, x.tg) the twin would be a top-level account, which
  only NEAR's registrar creates. Only a name built from a hash would rule this out, and these names are
  for reading. Anyone can register any name on USDC, even one that doesn't exist yet: the page doesn't let
  that hold up a setup, and the factory's registration then refunds its 0.00125 NEAR to the factory, where
  it stays, as would the NEAR of any creation receipt that failed (none can, given the checks above).
- **Rejected.** Explaining the warning on the page and keeping the wallet's deploy (users would still type
  CONFIRM under "A malicious contract can take over the account"). `UseGlobalContract` (rated "danger" too,
  and about 8.4 NEAR to publish). The role accounts in the wallet's own request (a yellow warning per key).
- **Reviewed (4 Nov).** A separate review by an AI reviewer agent (a Claude Code subagent) on a local node found the role-name overlap, a page that a
  stranger could keep at "being created" by registering a name on USDC first, too little headroom in the
  wallet check, `retry_install` capped at 35 Tgas, and a publish script that could leave a key added by a
  wallet; all fixed as above, and it confirmed the rest (keys added only to new accounts, nothing
  injectable into `new`'s arguments, refusals before anything is spent, the gas figures).
- Tests: `devkit/test/factory.sandbox.test.ts` (9, on a local node with the real wasm, the factory made
  keyless as `pnpm publish:factory` makes it); `devkit/test/hosted.sandbox.test.ts` (the page's one call
  makes a contract the bot serves); `shared/test/installer.test.ts` (the factory's bytes pinned, with the
  installer, USDC and the limits inside; the request is one call under 1,000 characters).

Amends D-30 (the wallet calls the factory; the accounts are named under it) and D-31 (the factory deploys the
installer, and a stuck install is retried through the factory rather than cancelled; `abandon` stays in the
installer for contracts their owner created themselves).

**D-33 · The bot reads a PDF's text in a process of its own, one PDF at a time.**
- **Why.** On 6 Nov the first PDF sent to the hosted bot was never answered: the Render instance (512 MB for
  the bot, the executor and their supervisor together) restarted within the minute, and the update log then
  skipped the interrupted update. Measured locally, pdf.js loaded in the bot's process, which runs through
  tsx, raised that process from 124 MB to 518 MB and kept it there; under plain Node it needs about 90 MB.
- **What.** `pdfText` (`ingestion/src/pdf.ts`) runs `ingestion/src/pdf-worker.mjs` with plain Node: no tsx,
  no environment (so no secrets), a 128 MB heap. It sends the PDF on stdin and reads one JSON answer,
  checked with zod. One reader runs at a time, and the 30 s limit (PLAN §4.4) now kills the reader instead
  of only giving up on it. The page limit and the extracted text are unchanged. After a PDF the bot's
  process stays at 124 MB; the reader peaks at 93 MB for about 0.3 s.
- Tests: `ingestion/test/pdf.test.ts`, the first to read a real PDF: the text layer, the page limit, a broken
  PDF, the time limit, several PDFs at once.

**D-34 · An MCP server: read-only at getleash.xyz/mcp, and on the owner's machine it takes invoices into the bot's pipeline.**
- **Why.** PLAN §4.6 (a stretch) asked for `submit_invoice`, `list_intents` and `get_policy` "behind the same
  ingestion and contract rules", so that AI assistants other than the bot (Claude Code, Cursor, Codex) can
  hand GetLeash invoices. An assistant is one more untrusted caller. The design already assumes the agent can
  be fooled, so the server adds no new authority: it is a channel into the same pipeline as the bot.
- **What.** `channels/mcp` is a stdio MCP server built with the MCP TypeScript SDK (`@modelcontextprotocol/sdk`
  1.32.2) that serves one contract.
  - **Read-only tools.** `get_policy`, `list_intents` and `list_suppliers` read views and need no key. A fourth
    tool beyond the plan, `list_suppliers`, lets an assistant see who can be paid.
  - **`submit_invoice`.** It exists only when the server holds the agent's function-call key, and builds an
    `InvoiceInput` (source `mcp`) for `InvoiceAgent`, so the extraction, the deterministic match, the
    obligation id and `propose` are the bot's.
    - Its input schema is strict and has two fields, the invoice's `text` or an absolute `file_path`. There is
      no supplier, address or amount field, and the schema refuses extra fields.
    - A file is checked by path, size (10 MB) and first bytes (PDF, PNG, JPEG, WebP) before anything reads it
      fully. A file that is not an invoice, a private key for instance, never reaches a model.
  - **Replies.** They are deterministic text in the bot's words (`shared/src/words.ts`), plus the same facts as
    JSON, and never model output.
  - **Shared secret and names.** `TENANT_SECRET` must be the bot's, so that an invoice is the same obligation
    whichever way it came in: `pnpm devnet` shares one with its MCP line, and the duplicate is refused across
    channels. Supplier names come from the directory on that machine.
  - **Logs and tooling.** Logs go to stderr, since stdout carries the protocol. `pnpm --silent mcp` runs the
    server; `pnpm --silent mcp:ask <tool>` starts it as a client would and prints one answer.
- **Hosted, read-only.** https://www.getleash.xyz/mcp serves the three views to clients that take a URL
  (Claude's custom connectors, `claude mcp add --transport http`).
  - **Where it runs.** `channels/mcp/src/http.ts` is mounted by `web/app/mcp/route.ts` on the dashboard's host,
    not on the bot's server. It holds no key and no secret.
  - **Contracts.** Each tool takes an optional `contract` and reads the dashboard's own GetLeash without it, so
    a business the bot hosts can read its own contract too.
  - **Supplier names.** It shows none: they are private (Privacy), so a supplier shows as its id and address.
  - **Per request.** Each request gets its own server and transport (stateless, JSON responses), which a
    serverless function needs. A GET or DELETE answers 405 with how to add the URL.
  - **Limits.** A client address may send 60 requests a minute to each running instance, and a body over
    64 KB is refused (413).
  - **Code.** The views live in `views.ts`, which imports only `@getleash/shared` and the SDK; the local
    server registers the same tools for its one contract.
- **Not done.** Taking invoices remotely, for the businesses the bot hosts. Their agent keys stay with the bot,
  and serving them remotely needs MCP's OAuth flow, with a token bound to one business, which waits for after
  the hackathon.
- Tests:
  - `channels/mcp/test/server.test.ts`: which tools exist with and without the key; the strict schema; files
    refused by path, size and type before the pipeline; replies for paid, waiting, refused and not-proposed
    invoices; errors as tool errors.
  - `channels/mcp/test/http.test.ts`: the hosted endpoint through the SDK's HTTP client. It offers only the three
    views, each taking a contract, and reads the default or a named contract, with links to that site. It shows
    no names. It refuses a malformed account and explains one that is not GetLeash. A single tool call works
    without a handshake. GET answers 405, a busy client 429 and an oversized body 413.
  - `devkit/test/mcp.sandbox.test.ts`: an MCP client submits fixture invoices to the real contract. One is paid,
    the reformatted duplicate and the unknown supplier are refused with the balance unchanged, and a large one
    waits for the owner with its page. The views read the same contract, and so does the hosted endpoint over
    HTTP, for a contract the call names.

**D-35 · A reply whose TEE evidence fails its checks waits for the owner.**
- **Why.** The verification badge (D-24) was shown to the owner but gated nothing. An invoice read by a reply
  whose evidence failed its checks was proposed like any other, and within the limits it was paid. A screen of
  this repository (14 Nov) named this as the weakest point of the private-AI claims.
- **What.** `decide` (`agent/src/rules.ts`) adds the review flag `AMBIGUOUS_EXTRACTION` when the badge is
  "Verification failed", with a note saying why, so the contract holds the payment for the owner (route
  `REVIEW_FLAG`). The other badges are unchanged:
  - "Model response verified" and "Gateway evidence verified" keep the agent's limits.
  - "Verification unavailable" (no evidence to check, as with the offline reader of the demo and the tests) keeps
    them too.

  A failed check includes Intel's or NVIDIA's service being unreachable, so during such an outage every invoice
  waits for the owner: the safe side. No contract change: the flag is one of the existing four.
- Tests: `agent/test/rules.test.ts`, "private inference (D-35)": each of the three other badges leaves the
  decision unflagged, and a failed one flags it with its note. The offline demo is unchanged.
