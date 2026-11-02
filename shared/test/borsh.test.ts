/**
 * The TypeScript Borsh layer against golden vectors written by the Rust contract's own types
 * (`contract/src/tests/golden.rs` → `fixtures/borsh-golden.json`): the same values must give the
 * same bytes on both sides, and the decoders must refuse anything else.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bytesToHex,
  decodeIntents,
  decodeProposeResult,
  decodeState,
  decodeSuppliers,
  encodeCreateAttempt,
  encodeId,
  encodeIds,
  encodePropose,
  encodeRange,
  hexToBytes,
} from "../src/index.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/borsh-golden.json", import.meta.url), "utf8")) as Record<string, string>;
const bytes = (name: string) => hexToBytes(golden[name]!);

const NOV_1 = "1793491200000000000";
const NOV_1_PLUS_HOUR = "1793494800000000000";

describe("Borsh layout matches the contract", () => {
  it("encodes agent and executor arguments", () => {
    const propose = encodePropose({ obligationId: "11".repeat(32), supplierId: 7, amountOut: 18_000_000n, reviewFlag: "UNUSUAL_AMOUNT" });
    expect(bytesToHex(propose)).toBe(golden.propose_args);
    const attempt = encodeCreateAttempt({ intentId: 42, deposit: "5a".repeat(32), amountIn: 2_300_000n, deadlineNs: BigInt(NOV_1_PLUS_HOUR) });
    expect(bytesToHex(attempt)).toBe(golden.create_attempt_args);
    expect(bytesToHex(encodeId(42))).toBe(golden.id_arg);
    expect(bytesToHex(encodeIds([1, 2, 300]))).toBe(golden.ids_arg);
    expect(bytesToHex(encodeRange(1, 50, true))).toBe(golden.range_u64_args);
    expect(bytesToHex(encodeRange(1, 50, false))).toBe(golden.range_u32_args);
  });

  it("decodes propose results", () => {
    expect(decodeProposeResult(bytes("propose_result_accepted"))).toEqual({
      accepted: true,
      intent_id: 9,
      status: "PAYING",
      route: "AUTONOMOUS",
      reason: null,
    });
    expect(decodeProposeResult(bytes("propose_result_refused"))).toEqual({
      accepted: false,
      intent_id: null,
      status: null,
      route: null,
      reason: "UNKNOWN_SUPPLIER",
    });
  });

  it("decodes intents, suppliers and state", () => {
    const [approved, pending] = decodeIntents(bytes("intents"));
    expect(approved).toEqual({
      id: 3,
      supplier_id: 2,
      revision: 1,
      obligation: "ab".repeat(32),
      amount_out: "2000000",
      value: "2000000",
      max_in: "3520000",
      status: "APPROVED",
      route: "AUTONOMOUS",
      flag: 0,
      since: NOV_1,
      created_at: NOV_1,
      attempt: { deposit: "07".repeat(32), amount_in: "2300000", deadline: NOV_1_PLUS_HOUR, authorized: true, epoch: 1 },
    });
    expect(pending).toMatchObject({ id: 4, status: "PENDING", route: "REVIEW_FLAG", flag: 1, attempt: null });

    const suppliers = decodeSuppliers(bytes("suppliers"));
    expect(suppliers.map((s) => [s.id, s.chain, s.recipient, s.active, s.revision])).toEqual([
      [1, "NEAR", "acme.near", true, 1],
      [2, "TRON", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", false, 3],
    ]);

    const state = decodeState(bytes("state"));
    expect(state).toMatchObject({
      owner_id: "biz.near",
      token_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      token_decimals: 6,
      paused: false,
      executor_epoch: 2,
      budgets: { day: 20758, autonomous: "18000000", outflow: "20300000", trust: "2300000", proposals: 3 },
      next_supplier_id: 3,
      next_intent_id: 5,
      stored_intents: 2,
      paying: 0,
    });
    expect(state.policy).toMatchObject({ approval_threshold: "25000000", max_fee_bps: 100, callback_grace_ns: "3600000000000", max_proposals_per_day: 100 });
  });

  it("refuses bytes that do not match the layout", () => {
    const state = bytes("state");
    expect(() => decodeState(state.subarray(0, state.length - 1))).toThrow(/end of data/);
    expect(() => decodeState(Uint8Array.from([...state, 0]))).toThrow(/trailing/);
    const result = bytes("propose_result_accepted");
    const badBool = Uint8Array.from(result);
    badBool[0] = 2;
    expect(() => decodeProposeResult(badBool)).toThrow(/bool/);
    const badEnum = Uint8Array.from(result);
    badEnum[9] = 9;
    expect(() => decodeProposeResult(badEnum)).toThrow(/enum/);
  });
});
