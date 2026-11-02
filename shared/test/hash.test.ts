import { describe, expect, it } from "vitest";

import { borshIntentTerms, intentHash } from "../src/hash.ts";
import type { IntentTerms } from "../src/types.ts";

const terms: IntentTerms = {
  id: 1,
  obligation_id: "ab".repeat(32),
  supplier_id: 2,
  supplier_revision: 1,
  chain: "NEAR",
  asset_id: "nep141:usdc.near",
  recipient: "acme.near",
  kind: "NATIVE",
  amount_out: "10000000",
  value: "10000000",
  max_in: "10000000",
  created_at: "1793608926933142000",
  expires_at: "1793868126933142000",
  route: "AUTONOMOUS",
  review_flag: null,
  test_payment: false,
};

describe("term hashes", () => {
  it("borsh-encodes fields in declaration order with little-endian integers", () => {
    const bytes = borshIntentTerms(terms);
    // id: u64 LE
    expect(Array.from(bytes.slice(0, 8))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    // obligation id: 32 raw bytes, no length prefix
    expect(bytes[8]).toBe(0xab);
    // supplier_id u32 = 2, supplier_revision u32 = 1, chain NEAR = 0
    expect(Array.from(bytes.slice(40, 49))).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 0]);
    // asset_id: u32 length then utf-8
    expect(Array.from(bytes.slice(49, 53))).toEqual([16, 0, 0, 0]);
  });

  it("binds every term: changing any field changes the hash", () => {
    const base = intentHash("getleash.biz.near", terms);
    expect(intentHash("demo-getleash.biz.near", terms)).not.toBe(base);
    const variants: Array<Partial<IntentTerms>> = [
      { recipient: "mallory.near" },
      { amount_out: "10000001" },
      { max_in: "10000001" },
      { supplier_revision: 2 },
      { route: { NEEDS_APPROVAL: "ABOVE_THRESHOLD" } },
      { review_flag: "ADDRESS_MISMATCH" },
      { test_payment: true },
    ];
    for (const v of variants) expect(intentHash("getleash.biz.near", { ...terms, ...v }), JSON.stringify(v)).not.toBe(base);
  });
});
