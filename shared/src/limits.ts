/**
 * The owner's limits as the dashboard's Limits page edits them: the policy's amounts and waiting period as
 * text, checked by the contract's own rules (contract/src/lib.rs `validate_policy`) and written back into
 * the whole policy, which `set_policy` takes in one piece. A field left as it was keeps the policy's exact
 * value, so saving one limit never changes another.
 */
import type { Policy } from "./types.ts";
import { fromUnits, toUnits } from "./units.ts";
import { money } from "./words.ts";

/** contract/src/types.rs MAX_AMOUNT: the largest amount any policy field may hold (base units). */
export const MAX_POLICY_AMOUNT = 1_000_000_000_000_000n;
const HOUR = 3_600_000_000_000n;
const DAY = 24n * HOUR;
/** The waiting period is edited in days, to four decimals (0.5 is 12 hours). */
const WAIT_DECIMALS = 4;
const WAIT_STEP = DAY / 10n ** BigInt(WAIT_DECIMALS);

export type LimitsForm = {
  perPayment: string;
  perDay: string;
  dailyCap: string;
  waitDays: string;
  waitMax: string;
  crossChainPerDay: string;
};

type AmountKey = Exclude<keyof LimitsForm, "waitDays">;
const AMOUNTS: Record<AmountKey, keyof Policy> = {
  perPayment: "approval_threshold",
  perDay: "autonomous_daily_budget",
  dailyCap: "daily_cap",
  waitMax: "cooldown_max",
  crossChainPerDay: "executor_trust_daily_budget",
};

/** The fields, in the page's order, with what each one means. */
export const LIMIT_FIELDS: ReadonlyArray<{ key: keyof LimitsForm; label: string; help: string; unit: string }> = [
  { key: "perPayment", label: "Agent pays alone, per payment", help: "Above this, a payment waits for your OK.", unit: "USDC" },
  { key: "perDay", label: "Agent pays alone, per day", help: "After that, every payment waits for you until the next day (UTC).", unit: "USDC" },
  { key: "dailyCap", label: "Daily cap", help: "The most that can leave in a day, whoever approves it.", unit: "USDC" },
  { key: "waitDays", label: "Wait after an address changes", help: "Payments to that supplier need your OK until then.", unit: "days" },
  { key: "waitMax", label: "Most you approve while it waits", help: "Per payment to that supplier, until the wait ends.", unit: "USDC" },
  {
    key: "crossChainPerDay",
    label: "Cross-chain without your confirmation, per day",
    help: "What the executor may send on its own. 0: you confirm every cross-chain payment.",
    unit: "USDC",
  },
];

const labelOf = (key: keyof LimitsForm) => LIMIT_FIELDS.find((f) => f.key === key)!.label;

/** The policy's limits as the form's text: amounts in USDC with two decimals or more, the wait in days. */
export function limitsForm(p: Policy, decimals: number): LimitsForm {
  const amount = (field: keyof Policy) => money(String(p[field]), decimals);
  const wait = BigInt(p.cooldown_ns);
  return {
    perPayment: amount("approval_threshold"),
    perDay: amount("autonomous_daily_budget"),
    dailyCap: amount("daily_cap"),
    waitDays: fromUnits(wait / WAIT_STEP, WAIT_DECIMALS),
    waitMax: amount("cooldown_max"),
    crossChainPerDay: amount("executor_trust_daily_budget"),
  };
}

const plain = (text: string) => text.replace(/[\s,]/g, "");
/** The value a field's text stands for, or the text itself when it isn't a number ("2.5" and "2.50" are the same). */
function valueOf(key: keyof LimitsForm, text: string, decimals: number): string {
  try {
    return toUnits(plain(text), key === "waitDays" ? WAIT_DECIMALS : decimals).toString();
  } catch {
    return plain(text);
  }
}

/** Which fields differ between two forms in value. */
export function changedLimits(before: LimitsForm, after: LimitsForm, decimals: number): Array<keyof LimitsForm> {
  return LIMIT_FIELDS.map((f) => f.key).filter((key) => valueOf(key, before[key], decimals) !== valueOf(key, after[key], decimals));
}

/** Why the contract would refuse this policy, in words; null when it would take it. Mirrors `validate_policy`. */
export function policyProblem(p: Policy, decimals = 6): string | null {
  const amount = (field: keyof Policy) => BigInt(String(p[field]));
  const usdc = (units: bigint) => `${money(units, decimals)} USDC`;
  const cap = amount("daily_cap");
  const fields: Array<keyof Policy> = ["autonomous_daily_budget", "approval_threshold", "daily_cap", "executor_trust_daily_budget", "cooldown_max", "max_fixed_fee"];
  if (fields.some((f) => amount(f) > MAX_POLICY_AMOUNT)) return `Each amount can be at most ${usdc(MAX_POLICY_AMOUNT)}.`;
  if (amount("autonomous_daily_budget") > cap) return "The agent's daily amount can't be more than the daily cap.";
  if (amount("executor_trust_daily_budget") > cap) return "The cross-chain amount can't be more than the daily cap.";
  if (amount("cooldown_max") > cap) return "The most you approve while an address waits can't be more than the daily cap.";
  if (amount("max_fixed_fee") > cap) return `The daily cap must be at least ${usdc(amount("max_fixed_fee"))}, the largest fixed fee a cross-chain payment may have.`;
  if (p.max_fee_bps > 5_000) return "The fee limit can be at most 50 %.";
  const ns = (field: keyof Policy) => BigInt(String(p[field]));
  if (ns("cooldown_ns") > 90n * DAY) return "The wait after an address changes can be at most 90 days.";
  if (ns("intent_ttl_ns") < HOUR || ns("intent_ttl_ns") > 30n * DAY) return "A payment's lifetime must be between 1 hour and 30 days.";
  if (ns("funding_margin_ns") > ns("quote_min_validity_ns")) return "The funding margin can't be longer than a quote's minimum validity.";
  if (ns("quote_min_validity_ns") > DAY) return "A quote's minimum validity can be at most 1 day.";
  if (ns("callback_grace_ns") < HOUR || ns("callback_grace_ns") > 30n * DAY) return "The confirmation grace period must be between 1 hour and 30 days.";
  if (ns("retention_ns") < DAY || ns("retention_ns") > 365n * DAY) return "Closed payments must be kept between 1 day and 365 days.";
  if (p.max_proposals_per_day < 1 || p.max_proposals_per_day > 200) return "Invoices per day must be between 1 and 200.";
  return null;
}

/**
 * The whole policy with the form's limits in it, or why not: a field that isn't a plain number, has more
 * decimals than the token, or breaks one of the contract's rules.
 */
export function applyLimits(p: Policy, form: LimitsForm, decimals: number): { policy: Policy; problem: null } | { policy: null; problem: string } {
  const before = limitsForm(p, decimals);
  const changed = new Set(changedLimits(before, form, decimals));
  const next: Policy = { ...p };
  for (const [key, field] of Object.entries(AMOUNTS) as Array<[AmountKey, keyof Policy]>) {
    if (!changed.has(key)) continue;
    let units: bigint;
    try {
      units = toUnits(plain(form[key]), decimals);
    } catch {
      return { policy: null, problem: `${labelOf(key)}: "${form[key]}" isn't an amount in USDC (at most ${decimals} decimals).` };
    }
    (next as Record<keyof Policy, unknown>)[field] = units.toString();
  }
  if (changed.has("waitDays")) {
    let steps: bigint;
    try {
      steps = toUnits(plain(form.waitDays), WAIT_DECIMALS);
    } catch {
      return { policy: null, problem: `${labelOf("waitDays")}: "${form.waitDays}" isn't a number of days.` };
    }
    next.cooldown_ns = (steps * WAIT_STEP).toString();
  }
  const problem = policyProblem(next, decimals);
  return problem ? { policy: null, problem } : { policy: next, problem: null };
}

/** Whether the new policy lets more go out without the owner's OK than the old one. */
export function loosens(before: Policy, after: Policy): boolean {
  const up = (field: keyof Policy) => BigInt(String(after[field])) > BigInt(String(before[field]));
  return (
    up("approval_threshold") || up("autonomous_daily_budget") || up("daily_cap") || up("executor_trust_daily_budget") || up("cooldown_max") || BigInt(after.cooldown_ns) < BigInt(before.cooldown_ns)
  );
}
