/**
 * Payee address checks done off-chain. The v2 contract only checks a Tron address's shape (to
 * stay small, D-28); the full base58check checksum is verified here, before the owner signs
 * `add_supplier` / `update_supplier` (seed script, dashboard). A bad checksum could only make
 * 1Click refuse the quote; it could never redirect a payment.
 */
import { sha256 } from "@noble/hashes/sha2.js";

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
