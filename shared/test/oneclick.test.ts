import { describe, expect, it } from "vitest";

import { checkExecutionQuote, isoToNanos, type QuoteResponse } from "../src/oneclick.ts";

const POLICY = "getleash.biz.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

/** Shaped like the live non-dry quote recorded in docs/verified-facts.md (2026-11-02). */
function liveLikeQuote(): QuoteResponse {
  return {
    correlationId: "f488e615-0f7d-46e6-aae5-61c2ac135239",
    timestamp: "2026-11-02T08:28:54.684Z",
    signature: "ed25519:t8i9Vt4dZwANFf8ztnmmnCPaeFjn6smqNwCvu54ZET3vVPSnijZcTaRv2ABjCqCaTqhcAuUMwas8LUjPJVxTLzs",
    quoteRequest: {
      dry: false,
      depositMode: "SIMPLE",
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 50,
      originAsset: USDC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDT_TRON,
      amount: "2000000",
      refundTo: POLICY,
      refundType: "ORIGIN_CHAIN",
      recipient: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-02T08:58:51.000Z",
    },
    quote: {
      amountIn: "2215009",
      amountInFormatted: "2.215009",
      minAmountIn: "2203933",
      amountOut: "2000000",
      amountOutFormatted: "2.0",
      minAmountOut: "2000000",
      timeEstimate: 75,
      refundFee: "0",
      withdrawFee: "205893",
      deadline: "2026-11-05T08:58:51.000Z",
      timeWhenInactive: "2026-11-05T08:58:51.000Z",
      depositAddress: "74374f462e4688206375358099432df2670f3c2dd6fbd26e37468757458e262a",
    },
  };
}

const expectation = {
  originAsset: USDC,
  destinationAsset: USDT_TRON,
  recipient: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  refundTo: POLICY,
  amountOut: 2_000_000n,
  maxIn: 3_520_000n,
};

describe("checkExecutionQuote", () => {
  it("accepts a quote that pays the intent's snapshot destination, refunds to the contract and fits max_in", () => {
    expect(checkExecutionQuote(liveLikeQuote(), expectation)).toEqual([]);
  });

  it("rejects a quote whose recipient, refund address, type or amount differs, or that exceeds max_in", () => {
    const cases: Array<[string, (q: QuoteResponse) => void]> = [
      ["recipient", (q) => (q.quoteRequest.recipient = "TAttackerAddress0000000000000000000")],
      ["refundTo", (q) => (q.quoteRequest.refundTo = "mallory.near")],
      ["refundType", (q) => (q.quoteRequest.refundType = "INTENTS")],
      ["recipientType", (q) => (q.quoteRequest.recipientType = "INTENTS")],
      ["dry", (q) => (q.quoteRequest.dry = true)],
      ["swapType", (q) => (q.quoteRequest.swapType = "EXACT_INPUT")],
      ["amount", (q) => (q.quoteRequest.amount = "1999999")],
      ["amountIn", (q) => (q.quote.amountIn = "3520001")],
      ["depositAddress", (q) => (q.quote.depositAddress = "0xdeadbeef")],
      ["depositAddress", (q) => delete q.quote.depositAddress],
      ["memo", (q) => (q.quote.depositMemo = "123")],
    ];
    for (const [field, mutate] of cases) {
      const q = liveLikeQuote();
      mutate(q);
      const problems = checkExecutionQuote(q, expectation);
      expect(problems.length, field).toBeGreaterThan(0);
    }
  });

  it("converts ISO deadlines to contract nanoseconds", () => {
    expect(isoToNanos("2026-11-02T08:58:51.000Z")).toBe(1_793_609_931_000_000_000n);
  });
});
