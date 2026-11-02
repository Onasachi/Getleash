import { describe, expect, it } from "vitest";

import { durationText, fromUnits, near, rescaleUp, toUnits } from "../src/units.ts";

describe("units", () => {
  it("converts decimals exactly, without floating point", () => {
    expect(toUnits("12.34", 6)).toBe(12_340_000n);
    expect(toUnits("0.000001", 6)).toBe(1n);
    expect(toUnits("1000000000", 6)).toBe(1_000_000_000_000_000n);
    expect(fromUnits(12_340_000n, 6)).toBe("12.34");
    expect(fromUnits("1", 6)).toBe("0.000001");
    expect(fromUnits(5_000_000n, 6)).toBe("5");
    expect(near("0.00125")).toBe(1_250_000_000_000_000_000_000n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["1e6", "-1", "1.0000001", "0x10", "", " ", "1,5", "NaN", "01.5"]) {
      expect(() => toUnits(bad, 6), bad).toThrow();
    }
  });

  it("rescales up like the contract (rounding up)", () => {
    expect(rescaleUp(1n, 18, 6)).toBe(1n);
    expect(rescaleUp(1_000_000_000_000n, 18, 6)).toBe(1n);
    expect(rescaleUp(1_000_000_000_001n, 18, 6)).toBe(2n);
    expect(rescaleUp(5n, 6, 8)).toBe(500n);
  });

  it("writes durations in the largest exact unit", () => {
    expect(durationText("600000000000")).toBe("10 min");
    expect(durationText("3600000000000")).toBe("1 h");
    expect(durationText(5_400_000_000_000n)).toBe("90 min");
    expect(durationText("86400000000000")).toBe("1 day");
    expect(durationText("172800000000000")).toBe("2 days");
    expect(durationText("259200000000000")).toBe("3 days");
    expect(durationText("90000000000")).toBe("90 s");
    expect(durationText("0")).toBe("0 s");
  });
});
