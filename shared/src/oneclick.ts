/**
 * NEAR Intents 1Click API client and schemas (docs/verified-facts.md, checked 2026-11-01/02).
 *
 * Browser-safe (fetch only): the executor uses it to quote and track payouts, and the dashboard's
 * attempt page uses it to fetch the quote status independently of the executor.
 *
 * Execution quotes are always non-dry with explicit deposit/recipient/refund types and
 * refundTo = the policy contract (AGENTS.md hard rule). `dry: true` is for previews only.
 */
import { z } from "zod";

export const DEFAULT_ONECLICK_URL = "https://1click.chaindefuser.com";

export const SwapType = z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]);

export const QuoteRequest = z.looseObject({
  dry: z.boolean(),
  swapType: SwapType,
  slippageTolerance: z.number().int().nonnegative(),
  originAsset: z.string(),
  depositType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
  destinationAsset: z.string(),
  amount: z.string().regex(/^\d+$/),
  refundTo: z.string(),
  refundType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
  recipient: z.string(),
  recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
  deadline: z.string(),
  depositMode: z.enum(["SIMPLE", "MEMO"]).optional(),
  referral: z.string().optional(),
  quoteWaitingTimeMs: z.number().int().optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

const Digits = z.string().regex(/^\d+$/);

export const Quote = z.looseObject({
  amountIn: Digits,
  amountInFormatted: z.string(),
  minAmountIn: Digits,
  amountOut: Digits,
  amountOutFormatted: z.string(),
  minAmountOut: Digits,
  timeEstimate: z.number(),
  depositAddress: z.string().optional(),
  depositMemo: z.string().optional(),
  deadline: z.string().optional(),
  timeWhenInactive: z.string().optional(),
  refundFee: Digits.optional(),
  withdrawFee: Digits.optional(),
});
export type Quote = z.infer<typeof Quote>;

export const QuoteResponse = z.looseObject({
  correlationId: z.string().optional(),
  timestamp: z.string(),
  signature: z.string(),
  quoteRequest: QuoteRequest,
  quote: Quote,
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

export const ExecutionStatus = z.enum([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "SUCCESS",
  "REFUNDED",
  "FAILED",
  "INCOMPLETE_DEPOSIT",
]);

const TxRef = z.looseObject({ hash: z.string(), explorerUrl: z.string().optional() });
const NullableDigits = Digits.nullable().optional();

export const SwapDetails = z.looseObject({
  intentHashes: z.array(z.string()).default([]),
  nearTxHashes: z.array(z.string()).default([]),
  amountIn: NullableDigits,
  amountOut: NullableDigits,
  depositedAmount: NullableDigits,
  refundedAmount: NullableDigits,
  refundReason: z.string().nullable().optional(),
  refundFee: NullableDigits,
  withdrawFee: NullableDigits,
  originChainTxHashes: z.array(TxRef).default([]),
  destinationChainTxHashes: z.array(TxRef).default([]),
});
export type SwapDetails = z.infer<typeof SwapDetails>;

export const StatusResponse = z.looseObject({
  correlationId: z.string().optional(),
  status: ExecutionStatus,
  updatedAt: z.string(),
  swapDetails: SwapDetails,
  quoteResponse: z
    .looseObject({ timestamp: z.string(), signature: z.string(), quoteRequest: QuoteRequest, quote: Quote })
    .optional(),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const TokenInfo = z.looseObject({
  assetId: z.string(),
  decimals: z.number().int(),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number().optional(),
  contractAddress: z.string().optional(),
});
export type TokenInfo = z.infer<typeof TokenInfo>;

export class OneClickError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`1Click ${path} → HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "OneClickError";
  }
}

export type OneClickOptions = {
  baseUrl?: string;
  /** Partner JWT, sent as X-API-Key. Without it 1Click adds its unauthenticated fee. */
  jwt?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class OneClickClient {
  readonly baseUrl: string;
  private readonly jwt: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OneClickOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_ONECLICK_URL).replace(/\/$/, "");
    this.jwt = opts.jwt || undefined;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    // Browsers require fetch to be called unbound (or on window), never as a method of this class.
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init?.body) headers["Content-Type"] = "application/json";
    if (this.jwt) headers["X-API-Key"] = this.jwt;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new OneClickError(response.status, text, path);
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`1Click ${path} returned an unexpected shape: ${parsed.error.message}`);
    return parsed.data;
  }

  tokens() {
    return this.request("/v0/tokens", z.array(TokenInfo));
  }

  quote(body: QuoteRequest) {
    return this.request("/v0/quote", QuoteResponse, { method: "POST", body: JSON.stringify(body) });
  }

  status(depositAddress: string, depositMemo?: string) {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    return this.request(`/v0/status?${query}`, StatusResponse);
  }

  submitDeposit(body: { txHash: string; depositAddress: string; nearSenderAccount?: string; memo?: string }) {
    return this.request("/v0/deposit/submit", z.unknown(), { method: "POST", body: JSON.stringify(body) });
  }
}

/** Nanoseconds since the epoch for an ISO timestamp (the contract's time unit). */
export function isoToNanos(iso: string): bigint {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp ${iso}`);
  return BigInt(ms) * 1_000_000n;
}

/** What GetLeash requires of an execution quote before committing it on-chain (a sanity check;
 *  the contract and, above the trust budget, the owner are the real protection). */
export type QuoteExpectation = {
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  refundTo: string;
  amountOut: bigint;
  maxIn: bigint;
};

export function checkExecutionQuote(q: QuoteResponse, expect: QuoteExpectation): string[] {
  const problems: string[] = [];
  const r = q.quoteRequest;
  const want: Array<[string, unknown, unknown]> = [
    ["dry", r.dry, false],
    ["swapType", r.swapType, "EXACT_OUTPUT"],
    ["depositType", r.depositType, "ORIGIN_CHAIN"],
    ["recipientType", r.recipientType, "DESTINATION_CHAIN"],
    ["refundType", r.refundType, "ORIGIN_CHAIN"],
    ["originAsset", r.originAsset, expect.originAsset],
    ["destinationAsset", r.destinationAsset, expect.destinationAsset],
    ["recipient", r.recipient, expect.recipient],
    ["refundTo", r.refundTo, expect.refundTo],
    ["amount", r.amount, expect.amountOut.toString()],
  ];
  for (const [field, actual, expected] of want) {
    if (actual !== expected) problems.push(`${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  if (!q.quote.depositAddress) problems.push("no depositAddress (dry quote?)");
  else if (!/^[0-9a-f]{64}$/.test(q.quote.depositAddress)) {
    problems.push(`depositAddress ${q.quote.depositAddress} is not a NEAR implicit account`);
  }
  if (q.quote.depositMemo) problems.push("memo deposits are not supported");
  if (BigInt(q.quote.amountOut) < expect.amountOut) problems.push(`amountOut ${q.quote.amountOut} < ${expect.amountOut}`);
  if (BigInt(q.quote.amountIn) > expect.maxIn) problems.push(`amountIn ${q.quote.amountIn} > max_in ${expect.maxIn}`);
  if (BigInt(q.quote.amountIn) <= 0n) problems.push("amountIn is zero");
  return problems;
}
