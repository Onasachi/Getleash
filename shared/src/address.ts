/**
 * Payee address checks done off-chain. The v2 contract only checks a Tron address's shape (to
 * stay small, D-28); the full base58check checksum is verified here, before the owner signs
 * `add_supplier` / `update_supplier` (seed script, bot, dashboard). A bad checksum could only make
 * 1Click refuse the quote; it could never redirect a payment.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import type { Chain } from "./types.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  const leadingZeros = text.match(/^1*/)![0].length;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...bytes]);
}

/** `T…`, 34 characters, base58check of `0x41 ‖ 20-byte hash` with a valid checksum. */
export function isTronAddress(text: string): boolean {
  if (text.length !== 34 || !text.startsWith("T")) return false;
  const bytes = base58Decode(text);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const digest = sha256(sha256(bytes.subarray(0, 21)));
  return digest.subarray(0, 4).every((b, i) => b === bytes[21 + i]);
}

// ── Where a supplier is paid, from what an owner or a supplier types ─────────────────────────────

/** The 1Click asset Tron suppliers are paid in: USDT on Tron (docs/verified-facts.md). */
export const USDT_TRON_ASSET = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
/** The USDT token contract on Tron: an address explorers show everywhere, and never a supplier's wallet. */
export const USDT_TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/**
 * A NEAR account a supplier can be paid at: a named account with a dot (acme.near, pay.acme.near) or
 * an implicit one (64 hex). Top-level names without a dot are left out: they read like ordinary words.
 */
export function isNearPayee(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text) || (text.includes(".") && NEAR_ACCOUNT.test(text));
}

export type Payee = { chain: Chain; recipient: string };

/**
 * The payee one word names, if any: a Tron address (checksum checked) or a NEAR account. Punctuation
 * around the word is ignored. NEAR accounts are lowercase, but phones capitalise the first word of a
 * line, so "Acme.near" counts as acme.near for the usual top-level accounts (.near, .tg, .testnet).
 */
export function payeeOf(word: string): Payee | null {
  const text = word.replace(/^[("'<“‘[]+|[)"'>”’\].,;:!?]+$/g, "");
  if (isTronAddress(text)) return { chain: "TRON", recipient: text };
  if (isNearPayee(text)) return { chain: "NEAR", recipient: text };
  const lower = text.toLowerCase();
  if (/\.(near|tg|testnet)$/.test(lower) && isNearPayee(lower)) return { chain: "NEAR", recipient: lower };
  return null;
}

/** An Ethereum-style address (0x and 40 hex), which GetLeash does not pay; said so instead of "no address". */
export function looksLikeEvmAddress(text: string): boolean {
  return /(^|\s)0x[0-9a-fA-F]{40}(\s|$)/.test(text);
}

/**
 * The `add_supplier` terms for a payee: NEAR accounts get the treasury's own token (native, no
 * swap), Tron addresses USDT on Tron through NEAR Intents.
 */
export function supplierTerms(payee: Payee, token: { token_id: string; token_decimals: number }): { chain: Chain; asset_id: string; recipient: string; decimals: number } {
  return payee.chain === "NEAR"
    ? { chain: "NEAR", asset_id: `nep141:${token.token_id}`, recipient: payee.recipient, decimals: token.token_decimals }
    : { chain: "TRON", asset_id: USDT_TRON_ASSET, recipient: payee.recipient, decimals: 6 };
}
