/**
 * Offline stand-in for the model: a deterministic, regex-based reader for plain-text invoices. It
 * lets the offline demo and the tests run the whole pipeline without NEAR AI Cloud. It never runs
 * in production, and its verification badge is always "Verification unavailable".
 */
import type { Extraction, ExtractInput, Extractor, ExtractResult, PaymentDetail } from "./extract.ts";

const LINE = (label: string) => new RegExp(`^\\s*(?:${label})\\s*[:#]?\\s*(.+?)\\s*$`, "im");

function firstMatch(text: string, label: string): string | null {
  return text.match(LINE(label))?.[1]?.trim() ?? null;
}

export function readTextInvoice(text: string): Extraction {
  const supplier = firstMatch(text, "from|supplier|seller|billed by");
  const number = firstMatch(text, "invoice\\s*(?:no\\.?|number|#)|invoice id|inv\\s*(?:no\\.?|#)");
  const totalLine = text.match(/^\s*(?:total(?:\s+due)?|amount\s+due|balance\s+due)\s*[:\s]\s*(.+)$/im)?.[1] ?? null;
  let currency: string | null = null;
  let total: string | null = null;
  if (totalLine) {
    const m = totalLine.match(/(USD₮|USDT|USDC|USD|US\$|NGN|EUR|GBP|\$|₦|€|£)?\s*([\d][\d,\s]*(?:\.\d+)?)\s*(USD₮|USDT|USDC|USD|NGN|EUR|GBP)?/i);
    if (m) {
      currency = (m[1] ?? m[3] ?? null)?.toUpperCase() ?? null;
      total = m[2]!.replace(/[,\s]/g, "");
    }
  }
  const details: PaymentDetail[] = [];
  for (const v of text.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g) ?? []) details.push({ kind: "tron_address", value: v });
  for (const v of text.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? []) details.push({ kind: "evm_address", value: v });
  for (const v of text.match(/\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b/g) ?? []) {
    details.push({ kind: "near_account", value: v });
  }
  const isInvoice = /\binvoice\b/i.test(text) && total !== null;
  return {
    is_invoice: isInvoice,
    supplier_name: supplier,
    invoice_number: number,
    currency,
    total_amount: total && /^\d{1,12}(\.\d{1,6})?$/.test(total) ? total : null,
    due_date: firstMatch(text, "due(?:\\s+date)?"),
    payment_details: [...new Map(details.map((d) => [d.value, d])).values()].slice(0, 10),
  };
}

export class OfflineExtractor implements Extractor {
  readonly name = "offline-text-reader";

  async extract(input: ExtractInput): Promise<ExtractResult> {
    if (!input.text) throw new Error("the offline reader only handles text and PDF text layers, not photos");
    return {
      extraction: readTextInvoice(input.text),
      sourceText: input.text,
      sourceIsModelTranscript: false,
      model: this.name,
      verification: {
        badge: "VERIFICATION_UNAVAILABLE",
        checks: [{ name: "inference in a TEE", ok: false, detail: "offline reader, no model, no TEE" }],
        evidence: null,
      },
    };
  }
}
