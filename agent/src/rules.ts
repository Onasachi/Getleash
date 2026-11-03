/**
 * Deterministic checks between the model's extraction and a proposal (PLAN §4.3 steps 2–6).
 * Everything here is plain code over the extraction, the raw text, the private supplier directory
 * and the on-chain supplier records. The model never picks a supplier id, an address or an id.
 */
import { compactForm, normaliseInvoiceNumber } from "@getleash/ingestion";
import { type DirectoryEntry, InvoiceCurrency, nameTokens, type ReviewFlag, type Supplier, toUnits } from "@getleash/shared";

import type { ExtractResult } from "./extract.ts";

/** Supplier id 0 never exists on-chain (ids start at 1): proposing it records UNKNOWN_SUPPLIER. */
export const UNMATCHED_SUPPLIER_ID = 0;

const ACCEPTED_CURRENCIES = new Map<string, string>([
  ["USD", "USD"],
  ["US$", "USD"],
  ["$", "USD"],
  ["USDT", "USDT"],
  ["USD₮", "USDT"],
  ["USDC", "USDC"],
]);

export type Decision =
  | {
      action: "propose";
      supplierId: number;
      supplierName: string | null;
      amountOut: bigint;
      invoiceNumber: string;
      reviewFlag: ReviewFlag | null;
      /** Every flag raised, strongest first; only the first goes on-chain. */
      flags: ReviewFlag[];
      notes: string[];
    }
  | { action: "needs_owner"; reason: "NO_RELIABLE_INVOICE_NUMBER" | "AMBIGUOUS_SUPPLIER" | "NO_TOTAL"; notes: string[] }
  | { action: "ignore"; reason: "NOT_AN_INVOICE" | "UNSUPPORTED_CURRENCY"; notes: string[] };

const FLAG_ORDER: ReviewFlag[] = ["ADDRESS_MISMATCH", "UNCERTAIN_MATCH", "AMBIGUOUS_EXTRACTION", "UNUSUAL_AMOUNT"];

function similarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

/** Digits-only comparison form of an amount ("1,250.50" → "1250.5"). */
function amountForms(text: string): Set<string> {
  const forms = new Set<string>();
  for (const match of text.matchAll(/\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const plain = match[0].replace(/[ ,]/g, "");
    forms.add(canonicalAmount(plain));
  }
  return forms;
}

function canonicalAmount(decimal: string): string {
  const [whole = "0", frac = ""] = decimal.split(".");
  const f = frac.replace(/0+$/, "");
  return `${BigInt(whole)}${f ? `.${f}` : ""}`;
}

function compact(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export type MatchResult =
  | { kind: "matched"; entry: DirectoryEntry; certain: boolean; via: "name" | "alias" | "payment_details" | "fuzzy" }
  | { kind: "ambiguous"; candidates: DirectoryEntry[] }
  | { kind: "none" };

export function matchSupplier(
  extraction: ExtractResult["extraction"],
  directory: DirectoryEntry[],
): MatchResult {
  // 1. A payment detail on file that appears on the invoice identifies the supplier exactly.
  const onInvoice = new Set(extraction.payment_details.map((p) => compact(p.value)));
  const byDetails = directory.filter((d) => d.payment_details.some((v) => onInvoice.has(compact(v))));
  // 2. Exact name or alias (after removing company suffixes and punctuation).
  const name = extraction.supplier_name ? nameTokens(extraction.supplier_name).join(" ") : "";
  const byName = name
    ? directory.filter((d) => [d.name, ...d.aliases].some((n) => nameTokens(n).join(" ") === name))
    : [];
  const exact = [...new Map([...byName, ...byDetails].map((d) => [d.supplier_id, d])).values()];
  if (exact.length === 1) {
    const entry = exact[0]!;
    return { kind: "matched", entry, certain: true, via: byName.length ? "name" : "payment_details" };
  }
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  // 3. Fuzzy name similarity: a match, but an uncertain one.
  if (!name) return { kind: "none" };
  const scored = directory
    .map((d) => ({ d, score: Math.max(...[d.name, ...d.aliases].map((n) => similarity(nameTokens(n), name.split(" ")))) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: "none" };
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return { kind: "ambiguous", candidates: scored.map((x) => x.d) };
  return { kind: "matched", entry: scored[0]!.d, certain: false, via: "fuzzy" };
}

/**
 * The on-chain supplier with no directory entry (added from the dashboard, or its name never saved)
 * whose exact address the invoice shows, in the model's reading and in the document text itself. Only
 * that address can ever be paid, so this is as safe as a match on payment details on file.
 */
function unnamedSupplier(result: ExtractResult, ctx: RuleContext, currency: string): DirectoryEntry | null {
  const named = new Set(ctx.directory.map((d) => d.supplier_id));
  const shown = new Set(result.extraction.payment_details.map((p) => compact(p.value)));
  const text = compact(result.sourceText);
  const hits = ctx.suppliers.filter((s) => !named.has(s.id) && shown.has(compact(s.recipient)) && text.includes(compact(s.recipient)));
  if (hits.length !== 1) return null;
  const supplier = hits[0]!;
  return {
    supplier_id: supplier.id,
    name: `supplier #${supplier.id}`,
    aliases: [],
    payment_details: [supplier.recipient],
    currency: InvoiceCurrency.parse(currency),
  };
}

export type RuleContext = {
  directory: DirectoryEntry[];
  suppliers: Supplier[];
  /** Flag invoices above this multiple of the supplier's typical amount. */
  unusualMultiple?: number;
};

export function decide(result: ExtractResult, ctx: RuleContext): Decision {
  const x = result.extraction;
  const notes: string[] = [];
  if (!x.is_invoice) return { action: "ignore", reason: "NOT_AN_INVOICE", notes: ["the model did not read this as an invoice"] };

  const currency = x.currency ? ACCEPTED_CURRENCIES.get(x.currency.trim().toUpperCase()) : undefined;
  if (!currency) {
    return { action: "ignore", reason: "UNSUPPORTED_CURRENCY", notes: [`currency ${JSON.stringify(x.currency)} is not USD, USDT or USDC`] };
  }
  if (!x.total_amount) return { action: "needs_owner", reason: "NO_TOTAL", notes: ["no total amount found"] };

  // The invoice number must be reliable: present, normalisable, and printed in the source text.
  const invoiceNumber = x.invoice_number ? normaliseInvoiceNumber(x.invoice_number) : null;
  const numberSeen =
    invoiceNumber !== null && result.sourceText.split("\n").some((line) => compactForm(line).includes(invoiceNumber));
  if (!invoiceNumber || !numberSeen) {
    return {
      action: "needs_owner",
      reason: "NO_RELIABLE_INVOICE_NUMBER",
      notes: [invoiceNumber ? `invoice number ${x.invoice_number} not found in the document text` : "no invoice number"],
    };
  }

  const flags = new Set<ReviewFlag>();
  if (!amountForms(result.sourceText).has(canonicalAmount(x.total_amount))) {
    flags.add("AMBIGUOUS_EXTRACTION");
    notes.push(`total ${x.total_amount} does not appear in the document text`);
  }
  if (result.sourceIsModelTranscript) notes.push("photo: checks ran against the model's transcription");

  const match = matchSupplier(x, ctx.directory);
  if (match.kind === "ambiguous") {
    return {
      action: "needs_owner",
      reason: "AMBIGUOUS_SUPPLIER",
      notes: [`could be any of: ${match.candidates.map((c) => c.name).join(", ")}`],
    };
  }
  // A supplier on-chain without a name in the directory is still found by its exact address.
  const unnamed = match.kind === "none" ? unnamedSupplier(result, ctx, currency) : null;
  if (match.kind === "none" && !unnamed) {
    notes.push(`supplier ${JSON.stringify(x.supplier_name)} is not in the directory`);
    return {
      action: "propose",
      supplierId: UNMATCHED_SUPPLIER_ID,
      supplierName: x.supplier_name,
      amountOut: toUnits(x.total_amount, 6),
      invoiceNumber,
      reviewFlag: null,
      flags: [],
      notes,
    };
  }
  const entry = match.kind === "matched" ? match.entry : unnamed!;
  if (match.kind === "matched" && !match.certain) {
    flags.add("UNCERTAIN_MATCH");
    notes.push(`matched "${x.supplier_name}" to "${entry.name}" by name similarity only`);
  }
  if (unnamed) notes.push(`matched to supplier #${entry.supplier_id} by its address on file; it has no name in the directory yet`);

  const onChain = ctx.suppliers.find((s) => s.id === entry.supplier_id);
  const known = new Set([...entry.payment_details, ...(onChain ? [onChain.recipient] : [])].map(compact));
  const shown = x.payment_details.map((p) => p.value);
  const foreign = shown.filter((v) => !known.has(compact(v)));
  if (foreign.length > 0) {
    flags.add("ADDRESS_MISMATCH");
    notes.push(`invoice shows payment details not on file: ${foreign.join(", ")} (only the address on file can ever be paid)`);
  }

  const typical = entry.typical_amount ? Number(entry.typical_amount) : null;
  const multiple = ctx.unusualMultiple ?? 2;
  if (typical !== null && Number(x.total_amount) > typical * multiple) {
    flags.add("UNUSUAL_AMOUNT");
    notes.push(`total ${x.total_amount} is more than ${multiple}× the usual ${entry.typical_amount}`);
  }
  if (entry.currency !== currency && !(entry.currency !== "USD" && currency === "USD")) {
    notes.push(`invoice currency ${currency}, supplier usually bills in ${entry.currency}`);
  }

  // Amounts are in the supplier's destination asset units (USD-pegged assets only).
  const decimals = onChain?.decimals ?? 6;
  const ordered = FLAG_ORDER.filter((f) => flags.has(f));
  return {
    action: "propose",
    supplierId: entry.supplier_id,
    supplierName: unnamed ? null : entry.name,
    amountOut: toUnits(x.total_amount, decimals),
    invoiceNumber,
    reviewFlag: ordered[0] ?? null,
    flags: ordered,
    notes,
  };
}
