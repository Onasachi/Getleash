import { fromUnits } from "@getleash/shared";

export const usdc = (units: string | bigint, decimals = 6) => fromUnits(units, decimals);

export function shortHash(hex: string, n = 10): string {
  return hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex;
}

export function nsToDate(ns: string | null | undefined): string {
  if (!ns) return "—";
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
