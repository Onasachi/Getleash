/**
 * The off-chain supplier directory (PLAN §4.3 step 4): names, aliases and payment details on file,
 * keyed by on-chain supplier id. It is private data (shown only in the authenticated view) and is
 * what the agent matches invoices against. The chain holds only ids, destinations and caps.
 */
import { z } from "zod";

import { type Payee, payeeOf } from "./address.ts";

export const InvoiceCurrency = z.enum(["USD", "USDT", "USDC"]);
export type InvoiceCurrency = z.infer<typeof InvoiceCurrency>;

export const DirectoryEntry = z.object({
  supplier_id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).default([]),
  /** Payment details on file as they appear on invoices (addresses, account ids). */
  payment_details: z.array(z.string().min(1).max(200)).default([]),
  /** A previously established contact channel, used to confirm test payments (never one from an invoice). */
  contact: z.string().max(200).optional(),
  /** Typical invoice total in the supplier's currency (decimal string), for the unusual-amount check. */
  typical_amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  currency: InvoiceCurrency,
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

export const Directory = z.object({ suppliers: z.array(DirectoryEntry) });
export type Directory = z.infer<typeof Directory>;

/** Entries of `first`, then those of `second` for suppliers `first` has no entry for. */
export function mergeDirectories(first: Directory, second: Directory): Directory {
  const known = new Set(first.suppliers.map((s) => s.supplier_id));
  return { suppliers: [...first.suppliers, ...second.suppliers.filter((s) => !known.has(s.supplier_id))] };
}

// ── Supplier details as an owner or a supplier types them ────────────────────────────────────────

export const MAX_SUPPLIER_NAME = 100;

export type SupplierDetails = { name: string | null; payee: Payee };
export type DetailsProblem = "NO_ADDRESS" | "TWO_ADDRESSES" | "NAME_TOO_LONG";

/** A supplier name as typed, tidied: labels ("Name:"), separators and extra spaces removed; null if no letter or digit is left. */
export function cleanName(text: string): string | null {
  const name = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/^\s*(?:name|business|company|supplier)\s*[:\-–—]\s*/i, "")
    .replace(/^[\s\-–—:|,·•]+|[\s\-–—:|,·•]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/**
 * A name and one payee from a short message: "Acme Packaging acme.near", or the name on one line and
 * the address on another (that line may carry a label, "Pay to (NEAR): acme.near"). Deterministic: no
 * model reads it. The name is optional here (an invite may already have one); the caller decides.
 */
export function parseSupplierDetails(text: string): { details: SupplierDetails } | { problem: DetailsProblem } {
  const finish = (name: string | null, payee: Payee) =>
    name && name.length > MAX_SUPPLIER_NAME ? { problem: "NAME_TOO_LONG" as const } : { details: { name, payee } };
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Several lines: the one line that ends in an address is the address; the others are the name.
  if (lines.length >= 2) {
    const ending = lines.map((line) => payeeOf(line.split(/\s+/).at(-1) ?? "")).map((payee, i) => ({ payee, i })).filter((x) => x.payee);
    if (ending.length === 1) {
      const { payee, i } = ending[0]!;
      return finish(cleanName(lines.filter((_, j) => j !== i).join(" ")), payee!);
    }
  }
  const words = text.split(/\s+/).filter(Boolean);
  const found = new Map<string, Payee>();
  for (const word of words) {
    const payee = payeeOf(word);
    if (payee) found.set(`${payee.chain}:${payee.recipient}`, payee);
  }
  if (found.size === 0) return { problem: "NO_ADDRESS" };
  if (found.size > 1) return { problem: "TWO_ADDRESSES" };
  const payee = [...found.values()][0]!;
  return finish(cleanName(words.filter((word) => payeeOf(word)?.recipient !== payee.recipient).join(" ")), payee);
}

const SUFFIXES = new Set(["ltd", "limited", "inc", "llc", "plc", "co", "company", "corp", "corporation", "gmbh", "sa", "bv", "the"]);

/** A name as the agent compares names: lowercase words, punctuation and company suffixes removed. */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !SUFFIXES.has(t));
}

/**
 * `name`, or `name #id` when another supplier already goes by it as the agent compares names: two
 * suppliers with one name would make every invoice in that name ambiguous.
 */
export function distinctName(name: string, supplierId: number, directory: Directory): string {
  const key = (n: string) => nameTokens(n).join(" ");
  const taken = directory.suppliers.some((s) => s.supplier_id !== supplierId && [s.name, ...s.aliases].some((n) => key(n) === key(name)));
  return taken ? `${name} #${supplierId}` : name;
}
