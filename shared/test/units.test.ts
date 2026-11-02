import { describe, expect, it } from "vitest";

import { fromUnits, near, rescaleUp, toUnits } from "../src/units.ts";

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
});
