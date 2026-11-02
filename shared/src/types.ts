/**
 * The policy contract's JSON interface, mirrored from `contract/src/types.rs` and `ledger.rs`.
 *
 * Conventions (docs/decisions.md D-17): ids are JSON numbers; amounts and nanosecond timestamps are
 * decimal strings; hashes and obligation ids are 64-char lowercase hex; enum codes are
 * SCREAMING_SNAKE_CASE. Amounts stay strings here (they are serialisable as-is); use `big()` for
 * arithmetic.
 *
 * Every view result is parsed with these schemas, so a contract change that drifts from them fails
 * loudly instead of being misread. The sandbox tests parse real contract output with them.
 */
import { z } from "zod";

// ── Scalars ──────────────────────────────────────────────────────────────────────────────────

/** A non-negative integer as a decimal string (u64/u128 on the contract side). */
export const Amount = z.string().regex(/^(0|[1-9][0-9]*)$/, "expected a decimal integer string");
export type Amount = z.infer<typeof Amount>;

/** Nanosecond timestamp as a decimal string. */
export const Nanos = Amount;

/** 32 bytes as 64 lowercase hex characters. */
export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");
export type Hex32 = z.infer<typeof Hex32>;

export const SupplierId = z.number().int().nonnegative();
export const IntentId = z.number().int().nonnegative();
export const AttemptId = z.number().int().nonnegative();

export const AccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id");

// ── Enums ────────────────────────────────────────────────────────────────────────────────────

export const Chain = z.enum(["NEAR", "TRON"]);
export type Chain = z.infer<typeof Chain>;

export const PayoutKind = z.enum(["NATIVE", "CROSS_CHAIN"]);
export type PayoutKind = z.infer<typeof PayoutKind>;

export const ReviewFlag = z.enum([
  "ADDRESS_MISMATCH",
  "UNCERTAIN_MATCH",
  "AMBIGUOUS_EXTRACTION",
  "UNUSUAL_AMOUNT",
]);
export type ReviewFlag = z.infer<typeof ReviewFlag>;

export const ApprovalReason = z.enum([
  "ABOVE_THRESHOLD",
  "AUTONOMOUS_BUDGET_USED",
  "UNVERIFIED_SUPPLIER",
  "REVIEW_FLAG",
  "TEST_PAYMENT",
  "OWNER_AMENDED",
]);
export type ApprovalReason = z.infer<typeof ApprovalReason>;

/** `"AUTONOMOUS"` or `{ "NEEDS_APPROVAL": <reason> }` (serde externally tagged). */
export const Route = z.union([
  z.literal("AUTONOMOUS"),
  z.object({ NEEDS_APPROVAL: ApprovalReason }).strict(),
]);
export type Route = z.infer<typeof Route>;

export const IntentStatus = z.enum([
  "PENDING",
  "APPROVED",
  "FUNDING",
  "DONE",
  "REJECTED",
  "CANCELLED",
  "INVALIDATED",
  "EXPIRED",
]);
export type IntentStatus = z.infer<typeof IntentStatus>;

export const AttemptAuth = z.enum(["NATIVE_AUTO", "TRUST_BUDGET", "OWNER_REQUIRED", "OWNER_SIGNED"]);
export type AttemptAuth = z.infer<typeof AttemptAuth>;

export const AttemptStatus = z.enum([
  "AWAITING_OWNER",
  "AUTHORIZED",
  "FUNDING_PENDING",
  "FUNDED",
  "DELIVERED",
  "FAILED",
  "VOID",
  "NEEDS_RECONCILIATION",
  "SWAP_FAILED",
]);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const RejectReason = z.enum([
  "PAUSED",
  "UNKNOWN_SUPPLIER",
  "INACTIVE_SUPPLIER",
  "ASSET_DISABLED",
  "OBLIGATION_OPEN_OR_PAID",
  "OBLIGATION_REJECTED",
  "SUPPLIER_COOLDOWN",
  "OVER_UNVERIFIED_BUDGET",
  "OVER_PER_PAYMENT_CAP",
  "OVER_MONTHLY_SUPPLIER_CAP",
  "OVER_DAILY_CAP",
  "OVER_MONTHLY_CAP",
  "INSUFFICIENT_FUNDS",
]);
export type RejectReason = z.infer<typeof RejectReason>;

// ── Ledger and periods ───────────────────────────────────────────────────────────────────────

export const Period = z.object({ day: z.number().int(), month: z.number().int() }).strict();
export type Period = z.infer<typeof Period>;

export const PeriodCounter = z.object({ period: z.number().int(), total: Amount }).strict();
export type PeriodCounter = z.infer<typeof PeriodCounter>;

export const Ledger = z
  .object({
    cash: Amount,
    reserved: Amount,
    in_flight: Amount,
    spent_day: PeriodCounter,
    spent_month: PeriodCounter,
    autonomous_day: PeriodCounter,
    trust_day: PeriodCounter,
    total_topped_up: Amount,
    total_returned: Amount,
    total_unattributed: Amount,
    total_charged: Amount,
    total_withdrawn: Amount,
  })
  .strict();
export type Ledger = z.infer<typeof Ledger>;

// ── Policy, assets, suppliers ────────────────────────────────────────────────────────────────

export const Policy = z
  .object({
    autonomous_daily_budget: Amount,
    approval_threshold: Amount,
    daily_cap: Amount,
    monthly_cap: Amount,
    executor_trust_daily_budget: Amount,
    unverified_cumulative_budget: Amount,
    test_payment_max: Amount,
    max_fee_bps: z.number().int().min(0).max(65_535),
    new_supplier_cooldown_ns: Nanos,
    intent_ttl_ns: Nanos,
    quote_min_validity_ns: Nanos,
    funding_margin_ns: Nanos,
    reconcile_grace_ns: Nanos,
    retention_ns: Nanos,
    max_open_intents: z.number().int(),
    max_proposals_per_day: z.number().int(),
    max_attempts_per_day: z.number().int(),
    max_registrations_per_day: z.number().int(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

export const AssetInfo = z
  .object({ chain: Chain, decimals: z.number().int(), max_fixed_fee: Amount, enabled: z.boolean() })
  .strict();
export type AssetInfo = z.infer<typeof AssetInfo>;

export const AssetEntry = z.tuple([z.string(), AssetInfo]);

export const Supplier = z
  .object({
    id: SupplierId,
    revision: z.number().int(),
    chain: Chain,
    asset_id: z.string(),
    recipient: z.string(),
    per_payment_cap: Amount,
    monthly_cap: Amount,
    changed_at: Nanos,
    verified: z.boolean(),
    active: z.boolean(),
    reserved_out: Amount,
    month_out: PeriodCounter,
    unverified_committed: Amount,
  })
  .strict();
export type Supplier = z.infer<typeof Supplier>;

// ── Intents and attempts ─────────────────────────────────────────────────────────────────────

export const IntentTerms = z
  .object({
    id: IntentId,
    obligation_id: Hex32,
    supplier_id: SupplierId,
    supplier_revision: z.number().int(),
    chain: Chain,
    asset_id: z.string(),
    recipient: z.string(),
    kind: PayoutKind,
    amount_out: Amount,
    value: Amount,
    max_in: Amount,
    created_at: Nanos,
    expires_at: Nanos,
    route: Route,
    review_flag: ReviewFlag.nullable(),
    test_payment: z.boolean(),
  })
  .strict();
export type IntentTerms = z.infer<typeof IntentTerms>;

export const Intent = z
  .object({
    terms: IntentTerms,
    intent_hash: Hex32,
    status: IntentStatus,
    reserved: Amount,
    live_attempt: AttemptId.nullable(),
    attempt_ids: z.array(AttemptId),
    approved_at: Nanos.nullable(),
    updated_at: Nanos,
  })
  .strict();
export type Intent = z.infer<typeof Intent>;

export const AttemptTerms = z
  .object({
    id: AttemptId,
    intent_id: IntentId,
    intent_hash: Hex32,
    kind: PayoutKind,
    pay_to: z.string(),
    amount_in: Amount,
    quote_deadline: Nanos.nullable(),
    deposit_type: z.literal("ORIGIN_CHAIN").nullable(),
    recipient_type: z.literal("DESTINATION_CHAIN").nullable(),
    refund_type: z.literal("ORIGIN_CHAIN").nullable(),
    refund_to: z.string().nullable(),
    destination_asset: z.string(),
    final_recipient: z.string(),
    expected_out: Amount,
    quote_ref: z.string().nullable(),
    created_at: Nanos,
  })
  .strict();
export type AttemptTerms = z.infer<typeof AttemptTerms>;

export const Attempt = z
  .object({
    terms: AttemptTerms,
    attempt_hash: Hex32,
    authorization: AttemptAuth,
    status: AttemptStatus,
    trust_day: z.number().int().nullable(),
    funded_at: Nanos.nullable(),
    charged: Period.nullable(),
    transfer_confirmed: z.boolean(),
    delivered_amount: Amount.nullable(),
    dest_tx: z.string().nullable(),
    returned_amount: Amount,
    updated_at: Nanos,
  })
  .strict();
export type Attempt = z.infer<typeof Attempt>;

export const OpenWorkItem = z.object({ intent: Intent, attempt: Attempt.nullable() }).strict();
export type OpenWorkItem = z.infer<typeof OpenWorkItem>;

export const Rejection = z
  .object({
    at: Nanos,
    obligation_id: Hex32,
    supplier_id: SupplierId,
    amount_out: Amount,
    reason: RejectReason,
  })
  .strict();
export type Rejection = z.infer<typeof Rejection>;

// ── Views and call results ───────────────────────────────────────────────────────────────────

export const ConfigView = z
  .object({
    owner_id: z.string(),
    agent_id: z.string(),
    executor_id: z.string(),
    treasury_token: z.string(),
    treasury_asset_id: z.string(),
    treasury_decimals: z.number().int(),
    paused: z.boolean(),
    hosted_mode: z.boolean(),
    policy: Policy,
    open_intents: z.number().int(),
    supplier_count: z.number().int(),
    next_intent_id: IntentId,
    next_attempt_id: AttemptId,
  })
  .strict();
export type ConfigView = z.infer<typeof ConfigView>;

export const BudgetLine = z.object({ limit: Amount, used: Amount, remaining: Amount }).strict();
export type BudgetLine = z.infer<typeof BudgetLine>;

export const BudgetsView = z
  .object({
    period: Period,
    daily: BudgetLine,
    monthly: BudgetLine,
    autonomous: BudgetLine,
    executor_trust: BudgetLine,
    available: Amount,
    proposals_today: z.number().int(),
    attempts_today: z.number().int(),
    registrations_today: z.number().int(),
  })
  .strict();
export type BudgetsView = z.infer<typeof BudgetsView>;

export const ProposeResult = z
  .object({
    accepted: z.boolean(),
    intent_id: IntentId.nullable(),
    status: IntentStatus.nullable(),
    route: Route.nullable(),
    intent_hash: Hex32.nullable(),
    reason: RejectReason.nullable(),
  })
  .strict();
export type ProposeResult = z.infer<typeof ProposeResult>;

export const SweepResult = z
  .object({ expired: z.number().int(), invalidated: z.number().int(), voided_attempts: z.number().int() })
  .strict();
export type SweepResult = z.infer<typeof SweepResult>;

// ── Owner inputs ─────────────────────────────────────────────────────────────────────────────

export type InflowAttribution = "TOP_UP" | "UNATTRIBUTED" | { ATTEMPT_RETURN: { attempt_id: number } };
export type InflowEntry = { amount: Amount; attribution: InflowAttribution };

export type ReconcileOutcome =
  | "NOT_SENT"
  | "SENT"
  | "SWAP_FAILED"
  | { DELIVERED: { delivered_amount: Amount; dest_tx: string } };

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

export function big(value: string | number | bigint): bigint {
  return BigInt(value);
}

/** Attempt states that block a new attempt for the same intent (mirrors `AttemptStatus::is_live`). */
export function isLiveAttempt(status: AttemptStatus): boolean {
  return (
    status === "AWAITING_OWNER" ||
    status === "AUTHORIZED" ||
    status === "FUNDING_PENDING" ||
    status === "FUNDED" ||
    status === "NEEDS_RECONCILIATION"
  );
}

export function routeReason(route: Route): ApprovalReason | null {
  return route === "AUTONOMOUS" ? null : route.NEEDS_APPROVAL;
}
