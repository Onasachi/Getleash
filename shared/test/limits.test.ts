import { describe, expect, it } from "vitest";

import { applyLimits, changedLimits, DEFAULT_POLICY, limitsForm, loosens, type Policy, policyProblem } from "../src/index.ts";

const p: Policy = { ...DEFAULT_POLICY };
const form = limitsForm(p, 6);

describe("the owner's limits, as the Limits page edits them", () => {
  it("reads the policy as text", () => {
    expect(form).toEqual({ perPayment: "2.50", perDay: "5.00", dailyCap: "20.00", waitDays: "2", waitMax: "0.50", crossChainPerDay: "0.00" });
  });

  it("gives back the same policy when nothing changed, and counts 2.5 and 2.50 as the same", () => {
    expect(applyLimits(p, form, 6)).toEqual({ policy: p, problem: null });
    expect(changedLimits(form, { ...form, perPayment: "2.5", dailyCap: "20" }, 6)).toEqual([]);
  });

  it("raises limits, and leaves every other field of the policy as it was", () => {
    const result = applyLimits(p, { ...form, perPayment: "10", perDay: "50", dailyCap: "1,000", waitDays: "1.5" }, 6);
    expect(result.problem).toBeNull();
    expect(result.policy).toEqual({
      ...p,
      approval_threshold: "10000000",
      autonomous_daily_budget: "50000000",
      daily_cap: "1000000000",
      cooldown_ns: String(36n * 3_600_000_000_000n),
    });
    expect(changedLimits(form, { ...form, perPayment: "10", waitDays: "1.5" }, 6)).toEqual(["perPayment", "waitDays"]);
    expect(loosens(p, result.policy!)).toBe(true);
    expect(loosens(result.policy!, p)).toBe(false);
  });

  it("refuses what the contract would refuse, in words", () => {
    expect(applyLimits(p, { ...form, perDay: "21" }, 6).problem).toBe("The agent's daily amount can't be more than the daily cap.");
    expect(applyLimits(p, { ...form, crossChainPerDay: "25" }, 6).problem).toBe("The cross-chain amount can't be more than the daily cap.");
    expect(applyLimits(p, { ...form, waitMax: "30" }, 6).problem).toBe("The most you approve while an address waits can't be more than the daily cap.");
    expect(applyLimits(p, { ...form, dailyCap: "1", perDay: "1", waitMax: "0.5" }, 6).problem).toMatch(/^The daily cap must be at least 1\.50 USDC/);
    expect(applyLimits(p, { ...form, waitDays: "91" }, 6).problem).toBe("The wait after an address changes can be at most 90 days.");
    expect(applyLimits(p, { ...form, dailyCap: "1000000001" }, 6).problem).toBe("Each amount can be at most 1000000000.00 USDC.");
  });

  it("refuses text that isn't a plain amount", () => {
    for (const bad of ["ten", "-1", "1.0000001", "1e3", ""]) {
      expect(applyLimits(p, { ...form, perPayment: bad }, 6).problem).toMatch(/^Agent pays alone, per payment: ".*" isn't an amount in USDC/);
    }
    expect(applyLimits(p, { ...form, waitDays: "two" }, 6).problem).toMatch(/isn't a number of days/);
  });

  it("agrees with the contract on the shipped policy", () => {
    expect(policyProblem(DEFAULT_POLICY)).toBeNull();
  });
});
