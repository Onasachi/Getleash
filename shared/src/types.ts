/**
 * The v2 contract's data (contract/src/types.rs, docs/decisions.md D-28), decoded from Borsh views
 * and encoded into Borsh arguments. Amounts and nanosecond timestamps are decimal strings and ids
 * are numbers, as everywhere else in GetLeash (D-17). Decoding is strict (`bytes.ts`), and a
 * golden-vector test checks this layout against the Rust one.
 *
 * The policy is also accepted as flat JSON (deploy/*.json, the owner's `new` and `set_policy`
 * arguments) and validated with zod.
 */
import { z } from "zod";

import { BorshReader, BorshWriter, bytesToHex, hex32 } from "./bytes.ts";

// ── Enums (order = Borsh index; only ever appended) ─────────────────────────────────────────────

export const CHAINS = ["NEAR", "TRON"] as const;
export type Chain = (typeof CHAINS)[number];

export const STATUSES = ["PENDING", "APPROVED", "PAYING", "PAID", "FAILED", "REJECTED"] as const;
export type IntentStatus = (typeof STATUSES)[number];

export const ROUTES = [
  "AUTONOMOUS",
  "ABOVE_THRESHOLD",
  "AUTONOMOUS_BUDGET_USED",
  "DAILY_CAP",
  "REVIEW_FLAG",
  "SUPPLIER_COOLDOWN",
] as const;
export type Route = (typeof ROUTES)[number];

export const REASONS = [
  "NONE",
  "PAUSED",
  "UNKNOWN_SUPPLIER",
  "INACTIVE_SUPPLIER",
  "OBLIGATION_OPEN_OR_PAID",
  "OBLIGATION_REJECTED",
  "STORAGE_FULL",
  "BAD_AMOUNT",
] as const;
export type RejectReason = Exclude<(typeof REASONS)[number], "NONE">;

/** The only model-influenced byte on-chain (index = the u8 sent; 0 = no flag). */
export const REVIEW_FLAGS = ["NONE", "ADDRESS_MISMATCH", "UNCERTAIN_MATCH", "AMBIGUOUS_EXTRACTION", "UNUSUAL_AMOUNT"] as const;
export type ReviewFlag = Exclude<(typeof REVIEW_FLAGS)[number], "NONE">;

export const OWNER_ACTIONS = ["APPROVE", "REJECT", "RETRY", "MARK_PAID", "MARK_FAILED"] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

// ── Policy (JSON in, Borsh out) ──────────────────────────────────────────────────────────────────

const Amount = z.string().regex(/^\d+$/, "decimal string");
const Nanos = z.string().regex(/^\d+$/, "nanoseconds as a decimal string");

export const Policy = z
  .object({
    autonomous_daily_budget: Amount,
    approval_threshold: Amount,
    daily_cap: Amount,
    executor_trust_daily_budget: Amount,
    cooldown_max: Amount,
    max_fixed_fee: Amount,
    max_fee_bps: z.number().int().min(0).max(5_000),
    cooldown_ns: Nanos,
    intent_ttl_ns: Nanos,
    quote_min_validity_ns: Nanos,
    funding_margin_ns: Nanos,
    callback_grace_ns: Nanos,
    retention_ns: Nanos,
    max_proposals_per_day: z.number().int().min(1).max(200),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

function readPolicy(r: BorshReader): Policy {
  return {
    autonomous_daily_budget: r.u128().toString(),
    approval_threshold: r.u128().toString(),
    daily_cap: r.u128().toString(),
    executor_trust_daily_budget: r.u128().toString(),
    cooldown_max: r.u128().toString(),
    max_fixed_fee: r.u128().toString(),
    max_fee_bps: r.u16(),
    cooldown_ns: r.u64().toString(),
    intent_ttl_ns: r.u64().toString(),
    quote_min_validity_ns: r.u64().toString(),
    funding_margin_ns: r.u64().toString(),
    callback_grace_ns: r.u64().toString(),
    retention_ns: r.u64().toString(),
    max_proposals_per_day: r.u32(),
  };
}

// ── Records and views ──────────────────────────────────────────────────────────────────────────

export type Supplier = {
  id: number;
  chain: Chain;
  /** 1Click asset id (`nep141:<treasury token>` for native NEAR suppliers). */
  asset_id: string;
  recipient: string;
  decimals: number;
  active: boolean;
  revision: number;
  changed_at: string;
};

export type Attempt = {
  /** The 1Click deposit account (64 hex). */
  deposit: string;
  amount_in: string;
  deadline: string;
  authorized: boolean;
  epoch: number;
};

export type Intent = {
  id: number;
  supplier_id: number;
  revision: number;
  /** Keyed obligation id (64 hex). */
  obligation: string;
  amount_out: string;
  value: string;
  max_in: string;
  status: IntentStatus;
  route: Route;
  flag: number;
  /** When the status last changed (ns). */
  since: string;
  created_at: string;
  attempt: Attempt | null;
};

export type Budgets = { day: number; autonomous: string; outflow: string; trust: string; proposals: number };

export type StateView = {
  owner_id: string;
  agent_id: string;
  executor_id: string;
  token_id: string;
  token_decimals: number;
  paused: boolean;
  executor_epoch: number;
  policy: Policy;
  budgets: Budgets;
  next_supplier_id: number;
  next_intent_id: number;
  stored_intents: number;
  paying: number;
};

export type ProposeResult = {
  accepted: boolean;
  intent_id: number | null;
  status: IntentStatus | null;
  route: Route | null;
  reason: RejectReason | null;
};

function readSupplier(r: BorshReader, id: number): Supplier {
  return {
    id,
    chain: r.enumOf(CHAINS),
    asset_id: r.string(),
    recipient: r.string(),
    decimals: r.u8(),
    active: r.bool(),
    revision: r.u32(),
    changed_at: r.u64().toString(),
  };
}

function readIntent(r: BorshReader, id: number): Intent {
  return {
    id,
    supplier_id: r.u32(),
    revision: r.u32(),
    obligation: bytesToHex(r.fixed(32)),
    amount_out: r.u128().toString(),
    value: r.u128().toString(),
    max_in: r.u128().toString(),
    status: r.enumOf(STATUSES),
    route: r.enumOf(ROUTES),
    flag: r.u8(),
    since: r.u64().toString(),
    created_at: r.u64().toString(),
    attempt: r.option((a) => ({
      deposit: bytesToHex(a.fixed(32)),
      amount_in: a.u128().toString(),
      deadline: a.u64().toString(),
      authorized: a.bool(),
      epoch: a.u32(),
    })),
  };
}

function strict<T>(bytes: Uint8Array, read: (r: BorshReader) => T): T {
  const r = new BorshReader(bytes);
  const value = read(r);
  r.done();
  return value;
}

export function decodeState(bytes: Uint8Array): StateView {
  return strict(bytes, (r) => ({
    owner_id: r.string(),
    agent_id: r.string(),
    executor_id: r.string(),
    token_id: r.string(),
    token_decimals: r.u8(),
    paused: r.bool(),
    executor_epoch: r.u32(),
    policy: readPolicy(r),
    budgets: { day: r.u32(), autonomous: r.u128().toString(), outflow: r.u128().toString(), trust: r.u128().toString(), proposals: r.u32() },
    next_supplier_id: r.u32(),
    next_intent_id: r.id(),
    stored_intents: r.u32(),
    paying: r.u32(),
  }));
}

export function decodeSuppliers(bytes: Uint8Array): Supplier[] {
  return strict(bytes, (r) => r.vec((x) => readSupplier(x, x.u32())));
}

export function decodeIntents(bytes: Uint8Array): Intent[] {
  return strict(bytes, (r) => r.vec((x) => readIntent(x, x.id())));
}

export function decodeProposeResult(bytes: Uint8Array): ProposeResult {
  return strict(bytes, (r) => {
    const accepted = r.bool();
    const intentId = r.id();
    const status = r.enumOf(STATUSES);
    const route = r.enumOf(ROUTES);
    const reason = r.enumOf(REASONS);
    return accepted
      ? { accepted, intent_id: intentId, status, route, reason: null }
      : { accepted, intent_id: null, status: null, route: null, reason: reason === "NONE" ? null : reason };
  });
}

export function decodeU32(bytes: Uint8Array): number {
  return strict(bytes, (r) => r.u32());
}

// ── Argument encoders (Borsh) ────────────────────────────────────────────────────────────────────

export function encodePropose(p: { obligationId: string; supplierId: number; amountOut: bigint; reviewFlag: ReviewFlag | null }): Uint8Array {
  const flag = p.reviewFlag === null ? 0 : REVIEW_FLAGS.indexOf(p.reviewFlag);
  if (flag < 0) throw new Error(`unknown review flag ${p.reviewFlag}`);
  return new BorshWriter().bytes(hex32(p.obligationId)).u32(p.supplierId).u128(p.amountOut).u8(flag).finish();
}

export function encodeCreateAttempt(p: { intentId: number; deposit: string; amountIn: bigint; deadlineNs: bigint }): Uint8Array {
  return new BorshWriter().u64(p.intentId).bytes(hex32(p.deposit)).u128(p.amountIn).u64(p.deadlineNs).finish();
}

export function encodeId(id: number): Uint8Array {
  return new BorshWriter().u64(id).finish();
}

export function encodeIds(ids: number[]): Uint8Array {
  const w = new BorshWriter().u32(ids.length);
  for (const id of ids) w.u64(id);
  return w.finish();
}

/** View range arguments: `(from: u32 | u64, limit: u32)`. */
export function encodeRange(from: number, limit: number, wide: boolean): Uint8Array {
  const w = new BorshWriter();
  (wide ? w.u64(from) : w.u32(from)).u32(limit);
  return w.finish();
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

/** Native = paid in the treasury token itself to a NEAR account (no 1Click). */
export function isNative(supplier: Pick<Supplier, "chain" | "asset_id">, tokenId: string): boolean {
  return supplier.chain === "NEAR" && supplier.asset_id === `nep141:${tokenId}`;
}

/** Intents that still need someone: the owner (PENDING, an unauthorized attempt), the executor
 *  (APPROVED cross-chain) or a callback (PAYING). */
export function isOpen(intent: Pick<Intent, "status">): boolean {
  return intent.status === "PENDING" || intent.status === "APPROVED" || intent.status === "PAYING";
}

/** Has this pending or approved intent outlived its TTL? */
export function isExpired(intent: Pick<Intent, "status" | "since">, policy: Pick<Policy, "intent_ttl_ns">, nowNs: bigint): boolean {
  return (intent.status === "PENDING" || intent.status === "APPROVED") && nowNs > BigInt(intent.since) + BigInt(policy.intent_ttl_ns);
}
