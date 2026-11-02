/**
 * The off-chain supplier directory (PLAN §4.3 step 4): names, aliases and payment details on file,
 * keyed by on-chain supplier id. It is private data (shown only in the authenticated view) and is
 * what the agent matches invoices against. The chain holds only ids, destinations and caps.
 */
import { z } from "zod";

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
