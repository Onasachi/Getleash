/**
 * Obligation ids (PLAN §4.4, F-06): `HMAC-SHA256(tenant_secret, domain ‖ supplier_id ‖ normalised
 * invoice number)`, computed by this deterministic code after supplier matching, never by the model.
 *
 * The same invoice as a PDF, a photo or pasted text yields the same id, so the contract's
 * one-open-or-paid-intent-per-obligation rule stops it being paid twice. Without `tenant_secret`
 * the id cannot be guessed from public data, so the chain does not reveal invoice numbers.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, hexToBytes } from "@getleash/shared";

const DOMAIN = new TextEncoder().encode("getleash:obligation:v1\0");

const SEPARATORS = /[\s\-_/.#:,;()[\]{}'"]+/gu;
const LABEL = /^(INVOICE|INV|NUMBER|NUM|NO|NR)(?=[A-Z0-9])/u;

/** Upper case, separators removed, leading zeros dropped from every run of digits. */
export function compactForm(text: string): string {
  return text
    .normalize("NFKC")
    .toUpperCase()
    .replace(SEPARATORS, "")
    .replace(/\d+/gu, (digits) => digits.replace(/^0+(?=\d)/u, ""));
}

/**
 * Deterministic normal form of an invoice number: `compactForm`, then leading labels such as
 * "INVOICE", "INV", "NO", "NUMBER" stripped. "INV-00042", "Invoice No. 42" and "inv 0042" all
 * become "42"; "SP-2207" becomes "SP2207". Returns null when no digit is left: a number without
 * digits is not a reliable invoice number.
 */
export function normaliseInvoiceNumber(raw: string): string | null {
  let text = compactForm(raw);
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(LABEL, "");
  }
  if (!/^[\p{L}\p{N}]{1,64}$/u.test(text) || !/\d/u.test(text)) return null;
  return text;
}

export function parseTenantSecret(hex: string | undefined): Uint8Array {
  if (!hex || !/^[0-9a-f]{64,}$/i.test(hex)) {
    throw new Error("TENANT_SECRET must be at least 32 random bytes as hex (openssl rand -hex 32)");
  }
  return hexToBytes(hex.toLowerCase());
}

export function obligationId(tenantSecret: Uint8Array, supplierId: number, normalisedInvoiceNumber: string): string {
  if (!Number.isInteger(supplierId) || supplierId < 0 || supplierId > 0xffff_ffff) throw new Error("bad supplier id");
  const supplier = new Uint8Array(4);
  new DataView(supplier.buffer).setUint32(0, supplierId, false);
  const number = new TextEncoder().encode(normalisedInvoiceNumber);
  const message = new Uint8Array(DOMAIN.length + 4 + number.length);
  message.set(DOMAIN, 0);
  message.set(supplier, DOMAIN.length);
  message.set(number, DOMAIN.length + 4);
  return bytesToHex(hmac(sha256, tenantSecret, message));
}
