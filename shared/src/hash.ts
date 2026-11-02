/**
 * Off-chain recomputation of the term hashes the owner signs (docs/decisions.md D-18):
 *
 *   hash = sha256(domain ‖ borsh(contract_account_id) ‖ borsh(terms))
 *
 * The approval and attempt pages recompute the hash from the terms they display and refuse to
 * offer a signature if it differs from the on-chain hash, so the owner never signs a hash that
 * does not match what they were shown. The borsh layout below follows the field and variant order
 * of `contract/src/types.rs`; the sandbox tests check it against hashes computed by the contract.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import type { AttemptTerms, IntentTerms } from "./types.ts";

const INTENT_DOMAIN = new TextEncoder().encode("getleash:intent:v1\0");
const ATTEMPT_DOMAIN = new TextEncoder().encode("getleash:attempt:v1\0");

const CHAIN = { NEAR: 0, TRON: 1 } as const;
const PAYOUT_KIND = { NATIVE: 0, CROSS_CHAIN: 1 } as const;
const APPROVAL_REASON = {
  ABOVE_THRESHOLD: 0,
  AUTONOMOUS_BUDGET_USED: 1,
  UNVERIFIED_SUPPLIER: 2,
  REVIEW_FLAG: 3,
  TEST_PAYMENT: 4,
  OWNER_AMENDED: 5,
} as const;
const REVIEW_FLAG = {
  ADDRESS_MISMATCH: 0,
  UNCERTAIN_MATCH: 1,
  AMBIGUOUS_EXTRACTION: 2,
  UNUSUAL_AMOUNT: 3,
} as const;

class BorshWriter {
  private chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.chunks.push(value);
    return this;
  }

  u8(value: number): this {
    return this.bytes(Uint8Array.of(value));
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return this.bytes(out);
  }

  u64(value: string | number | bigint): this {
    return this.uint(BigInt(value), 8);
  }

  u128(value: string | number | bigint): this {
    return this.uint(BigInt(value), 16);
  }

  string(value: string): this {
    const utf8 = new TextEncoder().encode(value);
    return this.u32(utf8.length).bytes(utf8);
  }

  option<T>(value: T | null, write: (w: this, v: T) => void): this {
    if (value === null) return this.u8(0);
    this.u8(1);
    write(this, value);
    return this;
  }

  finish(): Uint8Array {
    const length = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private uint(value: bigint, bytes: number): this {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) {
      throw new RangeError(`value ${value} does not fit in ${bytes} bytes`);
    }
    const out = new Uint8Array(bytes);
    let v = value;
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return this.bytes(out);
  }
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hex32(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  return bytes;
}

export function borshIntentTerms(t: IntentTerms): Uint8Array {
  const w = new BorshWriter()
    .u64(t.id)
    .bytes(hex32(t.obligation_id))
    .u32(t.supplier_id)
    .u32(t.supplier_revision)
    .u8(CHAIN[t.chain])
    .string(t.asset_id)
    .string(t.recipient)
    .u8(PAYOUT_KIND[t.kind])
    .u128(t.amount_out)
    .u128(t.value)
    .u128(t.max_in)
    .u64(t.created_at)
    .u64(t.expires_at);
  if (t.route === "AUTONOMOUS") w.u8(0);
  else w.u8(1).u8(APPROVAL_REASON[t.route.NEEDS_APPROVAL]);
  w.option(t.review_flag, (w, flag) => w.u8(REVIEW_FLAG[flag]));
  w.bool(t.test_payment);
  return w.finish();
}

export function borshAttemptTerms(t: AttemptTerms): Uint8Array {
  return new BorshWriter()
    .u64(t.id)
    .u64(t.intent_id)
    .bytes(hex32(t.intent_hash))
    .u8(PAYOUT_KIND[t.kind])
    .string(t.pay_to)
    .u128(t.amount_in)
    .option(t.quote_deadline, (w, v) => w.u64(v))
    // DepositType, RecipientType and RefundType each have a single variant (index 0).
    .option(t.deposit_type, (w) => w.u8(0))
    .option(t.recipient_type, (w) => w.u8(0))
    .option(t.refund_type, (w) => w.u8(0))
    .option(t.refund_to, (w, v) => w.string(v))
    .string(t.destination_asset)
    .string(t.final_recipient)
    .u128(t.expected_out)
    .option(t.quote_ref, (w, v) => w.string(v))
    .u64(t.created_at)
    .finish();
}

function domainHash(domain: Uint8Array, contractId: string, terms: Uint8Array): string {
  const preimage = new BorshWriter().bytes(domain).string(contractId).bytes(terms).finish();
  return bytesToHex(sha256(preimage));
}

export function intentHash(contractId: string, terms: IntentTerms): string {
  return domainHash(INTENT_DOMAIN, contractId, borshIntentTerms(terms));
}

export function attemptHash(contractId: string, terms: AttemptTerms): string {
  return domainHash(ATTEMPT_DOMAIN, contractId, borshAttemptTerms(terms));
}
