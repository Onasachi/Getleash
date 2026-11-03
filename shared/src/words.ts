/**
 * Plain words for what an owner reads in the dashboard and in Telegram: what a payment pays, why it
 * waits, why one was refused, and where it stands. Deterministic text only (never model output). The
 * enum codes stay in the technical details, in the contract's events and next to refusals.
 */
import { type ExecutionStatus, TERMINAL_STATUSES } from "./oneclick.ts";
import type { Intent, Policy, RejectReason, ReviewFlag, Route, Supplier } from "./types.ts";
import { REVIEW_FLAGS } from "./types.ts";
import { fromUnits } from "./units.ts";

/** An amount for reading: at least two decimals ("2.50"), more only when they are not zero ("1.206121"). */
export function money(units: string | bigint, decimals = 6): string {
  const text = fromUnits(units, decimals);
  const [whole, fraction = ""] = text.split(".");
  return fraction.length >= 2 ? text : `${whole}.${fraction.padEnd(2, "0")}`;
}

/** An amount rounded to cents, for totals and balances ("13.99"); single payments use `money` (exact). */
export function moneyRounded(units: string | bigint, decimals = 6): string {
  const value = BigInt(units);
  if (decimals <= 2) return money(value, decimals);
  const step = 10n ** BigInt(decimals - 2);
  return money((value + step / 2n) / step, 2);
}

/** 1Click asset ids GetLeash pays in, by the name an owner knows them by. */
export const ASSET_NAMES: Record<string, string> = {
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
  "nep141:3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af": "USDC",
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "USDT on Tron",
};

/** What the supplier receives: "USDC", "USDT on Tron", or the raw asset id for anything else. */
export function assetName(supplier: Pick<Supplier, "chain" | "asset_id">, tokenId?: string): string {
  if (tokenId && supplier.chain === "NEAR" && supplier.asset_id === `nep141:${tokenId}`) return "USDC";
  return ASSET_NAMES[supplier.asset_id] ?? `${supplier.asset_id} (${supplier.chain})`;
}

/** A time in UTC for reading: "Thu 5 Nov, 18:50 UTC" (nanoseconds, as the contract keeps time). */
export function utcTime(ns: bigint | string): string {
  const date = new Date(Number(BigInt(ns) / 1_000_000n));
  const text = date.toLocaleString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${text} UTC`;
}

/** Where a supplier is paid, for reading: "USDC at acme.near", "USDT on Tron at T…". */
export function paidAt(payee: { chain: string; recipient: string }): string {
  return payee.chain === "TRON" ? `USDT on Tron at ${payee.recipient}` : `USDC at ${payee.recipient}`;
}

/** Long addresses (Tron, 64-hex implicit accounts) shortened for reading; named NEAR accounts in full. */
export function shortAddress(address: string): string {
  const long = /^[0-9a-f]{64}$/.test(address) || (!address.includes(".") && address.length > 24);
  return long ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

type Limits = Pick<Policy, "approval_threshold" | "autonomous_daily_budget" | "daily_cap">;

/** Why a payment waits for the owner, as the end of "needs your OK because …". */
export function waitReason(route: Route, limits?: Limits, decimals = 6): string {
  const n = (units: string) => `${money(units, decimals)} USDC`;
  switch (route) {
    case "AUTONOMOUS":
      return "it is within the limits you gave the agent";
    case "ABOVE_THRESHOLD":
      return limits ? `it is above the ${n(limits.approval_threshold)} the agent may pay on its own` : "it is above what the agent may pay on its own";
    case "AUTONOMOUS_BUDGET_USED":
      return limits ? `the agent has used today's ${n(limits.autonomous_daily_budget)} auto-pay budget` : "the agent has used today's auto-pay budget";
    case "DAILY_CAP":
      return limits ? `it would go over today's ${n(limits.daily_cap)} spending cap` : "it would go over today's spending cap";
    case "REVIEW_FLAG":
      return "the agent flagged it for a closer look";
    case "SUPPLIER_COOLDOWN":
      return "this supplier's payment details changed recently";
  }
}

/** Why the contract refused a proposal (the enum code is shown next to it). */
export const REFUSALS: Record<RejectReason, string> = {
  PAUSED: "payments are paused",
  UNKNOWN_SUPPLIER: "the supplier is not on your approved list",
  INACTIVE_SUPPLIER: "this supplier is switched off",
  OBLIGATION_OPEN_OR_PAID: "this invoice was already paid, or is already waiting for you",
  OBLIGATION_REJECTED: "you rejected this invoice before",
  STORAGE_FULL: "too many payments are open; finish or clear some first",
  BAD_AMOUNT: "the amount is not valid",
};

/** What the agent's review flag means. */
export const FLAGS: Record<ReviewFlag, string> = {
  ADDRESS_MISMATCH: "the invoice shows payment details that are not on file (only the address on file can be paid)",
  UNCERTAIN_MATCH: "the supplier's name only roughly matches your list",
  AMBIGUOUS_EXTRACTION: "parts of the invoice were hard to read",
  UNUSUAL_AMOUNT: "the amount is much higher than usual for this supplier",
};

/** The flag byte stored on an intent (0 = none), in words. */
export function flagText(flag: number): string | null {
  const name = REVIEW_FLAGS[flag];
  return name && name !== "NONE" ? FLAGS[name] : null;
}

export type Tone = "good" | "warn" | "bad" | "plain";

/**
 * Where a payment stands, in a word or two. `swap` is 1Click's status of a cross-chain payout's
 * deposit, when known.
 */
export function paymentState(intent: Pick<Intent, "status" | "attempt">, native: boolean, swap?: string | null): { label: string; tone: Tone } {
  switch (intent.status) {
    case "PENDING":
      return { label: "Needs your OK", tone: "warn" };
    case "APPROVED":
      if (native) return { label: "Approved", tone: "warn" };
      if (!intent.attempt) return { label: "Getting a quote", tone: "plain" };
      return intent.attempt.authorized ? { label: "Sending", tone: "warn" } : { label: "Confirm transfer", tone: "warn" };
    case "PAYING":
      return { label: "Sending", tone: "warn" };
    case "PAID":
      if (native) return { label: "Paid", tone: "good" };
      if (swap === "SUCCESS") return { label: "Delivered", tone: "good" };
      if (swap && TERMINAL_STATUSES.has(swap as ExecutionStatus)) return { label: "Refunded", tone: "bad" };
      return { label: "On its way", tone: "warn" };
    case "FAILED":
      return { label: "Didn't go through", tone: "bad" };
    case "REJECTED":
      return { label: "Rejected", tone: "plain" };
  }
}
