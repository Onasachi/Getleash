# Audit response

Each finding from the v2 design audit, what the code does about it, and the tests that show it.
Test paths are relative to `contract/src/`. Run them with `cd contract && cargo test`.

Status (2026-11-02): **contract-side fixes are implemented and tested** in unit and property tests and on a
local NEAR node (`cargo test --test sandbox -- --ignored`). The TypeScript services and dashboard are implemented;
their rows point to `pnpm test` (unit), `pnpm test:sandbox` (real wasm on a local node, `devkit/test/`) and
`pnpm demo:mock` (every fixture through the whole pipeline). Rows still marked *pending* need the public demo
deployment.

| Finding | Fix in the contract | Tests |
|---|---|---|
| **F-01** Executor can redirect cross-chain payments | An attempt commits its deposit account, `amount_in ≤ max_in`, quote deadline, deposit/recipient/refund types and `refund_to = this contract`; its hash binds them. Funding takes only an attempt id. Cross-chain attempts need `authorize_attempt(id, attempt_hash)` from the owner unless they fit today's `executor_trust_daily_budget`, which is forced to 0 in hosted mode. A quote ref and a deposit account can back one attempt ever. Rotating the executor or entering hosted mode voids its unfunded trust-budget attempts (D-19). | `tests/unit.rs`: `executor_supplies_its_own_deposit_address_above_the_trust_budget`, `rotating_the_executor_or_going_hosted_voids_its_trust_budget_attempts`, `executor_funds_its_own_address_within_the_trust_budget_is_bounded`, `hosted_mode_cross_chain_always_needs_the_owner`, `quote_reused_for_another_intent_or_attempt_rejected`, `crosschain_attempt_terms_are_checked`, `set_policy_with_trust_budget_while_hosted_rejected` |
| **F-02** Refund declarations restore capacity | Charges are never removed by refunds, only by a proven transfer failure of that exact attempt. Returned funds are credited only by the owner (`reconcile_inflows`), per attempt, never more than its `amount_in`. Delivery reports credit nothing. | `executor_claims_a_refund_no_credit_no_budget_restoration`, `exact_output_swap_returns_change_recorded_separately`, `refund_for_an_october_attempt_arriving_in_november_leaves_november_charges`, `unrelated_top_up_during_refund_processing_stays_unreconciled_until_attributed` |
| **F-03** Approvals can change meaning | Intents are immutable and snapshot the supplier revision; `approve(id, intent_hash)` binds to them; the hash includes a domain tag and the contract id. Changing a supplier's destination invalidates its open intents. Funding re-checks pause, supplier status and revision. `verify_supplier` is bound to a revision. | `approval_is_bound_to_the_intent_hash`, `intent_hash_binds_the_contract_and_terms`, `supplier_changed_after_approval_invalidates_open_intents`, `approve_then_pause_or_deactivate_supplier_blocks_funding`, `verify_supplier_is_bound_to_the_revision` |
| **F-04** Inconsistent accounting | `ledger.rs` is a pure module (no `env`): `cash`, `reserved`, `in_flight`, per-period charges, checked arithmetic, copy-then-commit, invariant `reserved ≤ cash` checked on every mutation. `available = cash − reserved`. Fee slack stays reserved until the transfer is confirmed (D-01). | `ledger.rs` unit tests; `tests/props.rs`: `ledger_invariants_hold` (512 sequences), `contract_invariants_hold` (whole-contract random walks), `random_walks_reach_deep_states`; `sixty_of_hundred_in_flight_no_double_subtraction`, `concurrent_approvals_with_fee_headroom_never_exceed_cash`, `caps_hold_across_midnight_after_a_failed_transfer` |
| **F-05** Native amount mismatch | `fund_native(attempt_id)` has no amount or receiver parameter: it sends the intent's `amount_out` to the intent's recipient. | `native_funding_debit_equals_amount_out`; every random walk checks each debit equals its attempt's committed `amount_in` and `pay_to`, once |
| **F-06** Agent controls the dedupe id | One open-or-paid intent per obligation id; owner rejection or cancellation is final (`OBLIGATION_REJECTED`); only `amend_intent` revives it. The id is `HMAC-SHA256(TENANT_SECRET, domain ‖ supplier_id ‖ normalised invoice number)`, computed by ingestion code after the deterministic supplier match (D-23); the number must appear in the document text. | `same_invoice_with_edited_fields_keeps_its_obligation_id`, `rejected_and_amended_obligations`; random walks; `ingestion/test/obligation.test.ts`; `pnpm demo:mock` fixtures 03 and 04 (`OBLIGATION_OPEN_OR_PAID`) |
| **F-07** Async lifecycle underspecified | Full attempt state machine incl. `NeedsReconciliation`; callbacks are `#[private]`, attempt-bound, no-ops unless still `FundingPending`, and never panic; only an explicit promise failure counts as a failed transfer (D-10). Unfunded intents expire; `get_open_work` is the worker's queue. Flagging a stuck transfer waits `reconcile_grace_ns`; only the owner resolves. | `transfer_failure_restores_the_ledger_once_and_allows_a_retry`, `transfer_succeeds_callback_fails_needs_reconciliation_and_no_refund`, `stale_callback_after_a_new_attempt_has_no_effect`, `worker_restart_after_broadcast_recovers_from_open_work`, `unexecutable_approved_intent_expires_releasing_only_the_unfunded_reservation` |
| **F-08** Storage exhaustion | Role checks panic before any write. Rejections are events plus a 100-entry ring buffer with enum codes only. Quotas per day (proposals, attempts, registrations), `max_open_intents`, 10 attempts per intent, input length limits, FIFO pruning of closed intents. | `unauthorized_callers_spam_proposals_panic_before_writing`, `every_role_is_enforced`, `authorized_agent_spam_hits_quotas_and_the_ring_stays_bounded`, `open_intents_are_capped`, `prune_removes_old_closed_intents_but_keeps_obligations_blocked` |
| **F-09** TEE badge unsupported | `agent/src/verify.ts` implements NEAR AI's flow: signature over our exact request/response bytes, fresh attestation binding signer and nonce in TDX report_data, debug TDs refused, Intel PCS quote verification, NVIDIA NRAS with our nonce. Badge states computed only there; evidence stored with the invoice (D-24). Not yet run against the live service (needs an API key). | `agent/test/verify.test.ts` (verified, gateway-only, tampered bytes, stale nonce, debug TD, unknown signer, failed quote/GPU, unavailable evidence) |
| **F-10** Privacy overclaimed | On-chain data carries no model text: rejection reasons and review flags are enums; obligation ids are keyed HMACs. Invoices are stored AES-256-GCM encrypted; names and documents are shown only in the private view after a NEP-413 signature by the owner's full-access key (D-26). Only NEAR-hosted models are used for inference (D-24). | `prompt_injection_to_an_unknown_supplier_is_rejected_and_recorded`; `NearAiExtractor` tests (non-NEAR models refused, schema-violating output rejected); `/api/private/*` returns 401 without a session |
| **§3** Agent fraud within the numbers | `autonomous_daily_budget` (never returned the same day), per-supplier `unverified_cumulative_budget`, cooldown with owner-signed test payments only, review flags that can only force review. | `autonomous_budget_caps_a_fabricated_small_invoice_stream`, `cooldown_allows_only_an_owner_signed_test_payment_and_verification_does_not_end_it`, `a_review_flag_can_only_force_review`, `routing_reasons`, `every_rejection_reason_code` |
| **§4** Integration details | Owner methods need exactly 1 yoctoNEAR. Registration happens after the attempt commits its payee (`register_recipient`). Rotation by account swap. Cooldown semantics as specified. Fixed-fee bound for Tron withdrawals (D-02). | `non_owner_calls_upgrade_or_withdraw_rejected_and_owner_needs_one_yocto`, `register_recipient_registers_only_the_committed_payee`, `rotation_moves_authority_to_the_new_account`, `supplier_destinations_are_validated` |

## PLAN §9 adversarial suite

| Row | Status | Test |
|---|---|---|
| Executor supplies its own deposit address above the trust budget | ✅ | `executor_supplies_its_own_deposit_address_above_the_trust_budget`; on a node: `executor.sandbox.test.ts` ("above the trust budget …"); the attempt page compares every committed term with 1Click's status |
| Executor funds its own address within the trust budget | ✅ bounded, accepted risk | `executor_funds_its_own_address_within_the_trust_budget_is_bounded` |
| Quote reused for another intent or attempt | ✅ | `quote_reused_for_another_intent_or_attempt_rejected` |
| Executor claims a refund | ✅ | `executor_claims_a_refund_no_credit_no_budget_restoration`; on a node: `executor.sandbox.test.ts` ("a failed swap is flagged …") |
| Unrelated top-up during refund processing | ✅ | `unrelated_top_up_during_refund_processing_stays_unreconciled_until_attributed` |
| Exact-output swap returns change | ✅ | `exact_output_swap_returns_change_recorded_separately`; on a node with mock-1click: `executor.sandbox.test.ts` ("exact-output change …") |
| Refund for an October attempt arrives in November | ✅ | `refund_for_an_october_attempt_arriving_in_november_leaves_november_charges` |
| Approve, then pause or deactivate the supplier | ✅ | `approve_then_pause_or_deactivate_supplier_blocks_funding` |
| Supplier changed after approval | ✅ | `supplier_changed_after_approval_invalidates_open_intents` |
| 60 of 100 in flight | ✅ | `sixty_of_hundred_in_flight_no_double_subtraction` |
| Concurrent approvals with fee headroom | ✅ | `concurrent_approvals_with_fee_headroom_never_exceed_cash` |
| Native funding | ✅ | `native_funding_debit_equals_amount_out` |
| Same invoice, different hash or edited fields | ✅ | `same_invoice_with_edited_fields_keeps_its_obligation_id`; `ingestion/test/obligation.test.ts`; `pnpm demo:mock` fixtures 03, 04 |
| Transfer succeeds, callback fails | ✅ | `transfer_succeeds_callback_fails_needs_reconciliation_and_no_refund` |
| Worker restart after broadcast | ✅ | `worker_restart_after_broadcast_recovers_from_open_work`; `devkit/test/executor.sandbox.test.ts` ("worker restart after broadcast") |
| Unauthorized callers spam proposals | ✅ | `unauthorized_callers_spam_proposals_panic_before_writing` |
| Authorized agent spams | ✅ | `authorized_agent_spam_hits_quotas_and_the_ring_stays_bounded` |
| Unexecutable approved intent | ✅ | `unexecutable_approved_intent_expires_releasing_only_the_unfunded_reservation` |
| Stale callback after a new attempt | ✅ | `stale_callback_after_a_new_attempt_has_no_effect` |
| Attestation stale, invalid or missing | ✅ against a fake NEAR AI Cloud | `agent/test/verify.test.ts` |
| Telegram update replayed | ✅ | `channels/telegram/test/bot.test.ts` ("a replayed update is processed once"); `pnpm demo:mock` step 3 |
| Demo panel requests production data | pending (`demo-getleash` deployment, day 12) | — |
| Policy contract account after setup has no access key | ✅ on a local node | `tests/sandbox.rs::native_payouts_end_to_end_on_a_real_node`; `devkit/test/setup.sandbox.test.ts` (the real setup CLI functions, then `verifySetup`; function-call keys refused for other methods, contracts, deposits and transfers) |
| `set_policy` with a non-zero trust budget while hosted | ✅ | `set_policy_with_trust_budget_while_hosted_rejected`, `init_refuses_a_trust_budget_in_hosted_mode` |
| Non-owner calls `upgrade` or `withdraw`; owner without 1 yocto | ✅ | `non_owner_calls_upgrade_or_withdraw_rejected_and_owner_needs_one_yocto` |

## What the random walks check after every step

`tests/props.rs::Sim::check`, over arbitrary interleavings of every role's calls, lost and
replayed callbacks, day and month boundaries, supplier changes and pauses:

- `reserved ≤ cash`; `ledger.reserved = Σ intent.reserved`; `ledger.in_flight = Σ` in-flight attempts.
- **Token conservation:** the token contract's balance = `cash` + transfers whose outcome the contract
  has not learned yet + pending withdrawals. Nothing appears or disappears.
- Committed outflow ≤ `daily_cap` and ≤ `monthly_cap`; autonomous and trust budgets never exceeded.
- Each intent's reservation matches its state; at most one live attempt per intent, correctly linked.
- At most one open-or-paid intent per obligation id; each supplier's `reserved_out` matches its intents.
- Every debit is an attempt's committed `amount_in` to its committed `pay_to`, at most once per
  attempt, or an owner withdrawal to the owner.
- Unauthorized calls always fail; callbacks never panic; a replayed callback changes nothing.
