import { fromUnits } from "@getleash/shared";

export const usdc = (units: string | bigint, decimals = 6) => fromUnits(units, decimals);

export function shortHash(hex: string, n = 10): string {
  return hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex;
}

export function nsToDate(ns: string | null | undefined): string {
  if (!ns) return "—";
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** A moment for reading, in local time: "today 19:25", "yesterday 08:10", "2 Nov 19:25". */
export function whenText(ns: string | bigint): string {
  const date = new Date(Number(BigInt(ns) / 1_000_000n));
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** Time left until a moment: "in 3 h 50 min", "in 12 min", "now". */
export function untilText(ns: string | bigint): string {
  const minutes = Math.floor((Number(BigInt(ns) / 1_000_000n) - Date.now()) / 60_000);
  if (minutes <= 0) return "now";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `in ${hours} h ${minutes % 60} min` : `in ${minutes} min`;
}
