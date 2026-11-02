import { describe, expect, it } from "vitest";

import { assetName, flagText, money, moneyRounded, paymentState, REASONS, REFUSALS, shortAddress, waitReason } from "../src/index.ts";

const usdc = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const attempt = { deposit: "ab".repeat(32), amount_in: "1206121", deadline: "1", authorized: false, epoch: 0 };

describe("plain words for owners", () => {
  it("writes money with at least two decimals", () => {
    expect(money("3000000")).toBe("3.00");
    expect(money("2500000")).toBe("2.50");
    expect(money("1206121")).toBe("1.206121");
    expect(money("0")).toBe("0.00");
    expect(moneyRounded("13993879")).toBe("13.99");
    expect(moneyRounded("6006121")).toBe("6.01");
    expect(moneyRounded("20000000")).toBe("20.00");
  });

  it("names what a supplier receives", () => {
    expect(assetName({ chain: "NEAR", asset_id: `nep141:${usdc}` })).toBe("USDC");
    expect(assetName({ chain: "NEAR", asset_id: "nep141:usdc.test.near" }, "usdc.test.near")).toBe("USDC");
    expect(assetName({ chain: "TRON", asset_id: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near" })).toBe("USDT on Tron");
    expect(assetName({ chain: "TRON", asset_id: "nep141:other.omft.near" })).toBe("nep141:other.omft.near (TRON)");
  });

  it("shortens only addresses nobody reads in full", () => {
    expect(shortAddress("getleash-supplier.testnet")).toBe("getleash-supplier.testnet");
    expect(shortAddress("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).toBe("T9yD14…HxuWwb");
    expect(shortAddress("62e303410c1f7cd3890bc642d80fd7bc6f353ca6afd4750a1a0a11c5b5529e99")).toBe("62e303…529e99");
  });

  it("says why a payment waits, with the owner's own limits", () => {
    const limits = { approval_threshold: "2500000", autonomous_daily_budget: "5000000", daily_cap: "20000000" };
    expect(waitReason("ABOVE_THRESHOLD", limits)).toBe("it is above the 2.50 USDC the agent may pay on its own");
    expect(waitReason("AUTONOMOUS_BUDGET_USED", limits)).toBe("the agent has used today's 5.00 USDC auto-pay budget");
    expect(waitReason("ABOVE_THRESHOLD")).toBe("it is above what the agent may pay on its own");
  });

  it("has words for every refusal and flag", () => {
    for (const reason of REASONS.filter((r) => r !== "NONE")) expect(REFUSALS[reason]).toBeTruthy();
    expect(flagText(0)).toBeNull();
    expect(flagText(1)).toMatch(/not on file/);
  });

  it("tells where a payment stands", () => {
    expect(paymentState({ status: "PENDING", attempt: null }, true).label).toBe("Needs your OK");
    expect(paymentState({ status: "PAID", attempt: null }, true).label).toBe("Paid");
    expect(paymentState({ status: "APPROVED", attempt: null }, false).label).toBe("Getting a quote");
    expect(paymentState({ status: "APPROVED", attempt }, false).label).toBe("Confirm transfer");
    expect(paymentState({ status: "APPROVED", attempt: { ...attempt, authorized: true } }, false).label).toBe("Sending");
    expect(paymentState({ status: "PAID", attempt }, false, "PROCESSING").label).toBe("On its way");
    expect(paymentState({ status: "PAID", attempt }, false, "SUCCESS").label).toBe("Delivered");
    expect(paymentState({ status: "PAID", attempt }, false, "REFUNDED")).toEqual({ label: "Refunded", tone: "bad" });
  });
});
