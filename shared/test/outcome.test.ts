import { describe, expect, it } from "vitest";

import { contractEvents, panicCode, parseOutcome } from "../src/outcome.ts";

const b64 = (s: string) => btoa(s);

function tx(status: unknown, receipts: Array<{ status: unknown; logs?: string[]; executor_id?: string }>) {
  return {
    status,
    transaction_outcome: { id: "TX", outcome: { status: { SuccessReceiptId: "R0" }, logs: [] } },
    receipts_outcome: receipts.map((r, i) => ({ id: `R${i}`, outcome: { logs: [], executor_id: "c.near", ...r } })),
  };
}

const panic = (msg: string) => ({
  Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } },
});

describe("parseOutcome", () => {
  it("decodes the return value and events", () => {
    const event = `EVENT_JSON:${JSON.stringify({ standard: "getleash", version: "1.0.0", event: "attempt_created", data: [{ attempt_id: 7 }] })}`;
    const out = parseOutcome(tx({ SuccessValue: b64("42") }, [{ status: { SuccessValue: b64("42") }, logs: [event] }]));
    expect(out).toMatchObject({ txHash: "TX", finalOk: true, ok: true, value: 42 });
    expect(contractEvents(out, "attempt_created")).toEqual([{ attempt_id: 7 }]);
  });

  it("reports the contract's panic code when the call fails", () => {
    const out = parseOutcome(tx(panic("ONLY_EXECUTOR"), [{ status: panic("ONLY_EXECUTOR") }]));
    expect(out.finalOk).toBe(false);
    expect(out.failures[0]!.panic).toBe("ONLY_EXECUTOR");
  });

  it("sees a failed inner receipt even when the final status succeeded (fund_* with a failed ft_transfer)", () => {
    const out = parseOutcome(
      tx({ SuccessValue: "" }, [
        { status: { SuccessReceiptId: "R1" } },
        { status: panic("The account doesn't have enough balance"), executor_id: "usdc.near" },
        { status: { SuccessValue: "" } },
      ]),
    );
    expect(out.finalOk).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.executorId).toBe("usdc.near");
  });

  it("panicCode only strips the contract-panic prefix", () => {
    expect(panicCode("Smart contract panicked: PAUSED")).toBe("PAUSED");
    expect(panicCode("Exceeded the prepaid gas.")).toBeNull();
  });
});
