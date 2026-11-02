/**
 * Exact decimal ↔ base-unit conversion with bigint. No floating point anywhere money is handled.
 */

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** "12.34" with 6 decimals → 12340000n. Rejects more fractional digits than `decimals`. */
export function toUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  if (!DECIMAL.test(text)) throw new Error(`not a plain decimal amount: ${JSON.stringify(amount)}`);
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${amount} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 12340000n with 6 decimals → "12.34". */
export function fromUnits(units: bigint | string, decimals: number): string {
  const value = BigInt(units);
  if (value < 0n) return `-${fromUnits(-value, decimals)}`;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Converts between assets with different decimals, rounding up (as the contract does). */
export function rescaleUp(units: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals >= fromDecimals) return units * 10n ** BigInt(toDecimals - fromDecimals);
  const div = 10n ** BigInt(fromDecimals - toDecimals);
  return (units + div - 1n) / div;
}

export const YOCTO_PER_NEAR = 10n ** 24n;
export const ONE_YOCTO = 1n;
export const TGAS = 10n ** 12n;

export function near(amount: string): bigint {
  return toUnits(amount, 24);
}

export function tgas(n: number): bigint {
  return BigInt(n) * TGAS;
}
