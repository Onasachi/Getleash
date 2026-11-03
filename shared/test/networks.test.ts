/**
 * RPC rate limits. FastNEAR answers HTTP 429 with a JSON-RPC error, which near-api-js 7.4 does not retry;
 * the services' provider waits, moves to the next address and stays there. Other errors pass straight
 * through, so a contract's refusal is never sent twice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isRateLimited, provider, serviceRpcUrls, SteadyRpcProvider } from "../src/networks.ts";

// FastNEAR's answer on 2026-11-03, as the bot received it on Render.
const LIMITED = '{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"}, "id": "1"}';
const STATUS = { jsonrpc: "2.0", id: "1", result: { chain_id: "mainnet" } };

function fakeRpcs(answer: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return answer(String(url));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RPC provider", () => {
  it("waits and moves to the next RPC when one rate-limits, then stays on the one that answered", async () => {
    const calls = fakeRpcs((url) => (url.includes("busy") ? new Response(LIMITED, { status: 429 }) : Response.json(STATUS)));
    const waits: number[] = [];
    const rpc = new SteadyRpcProvider(["https://busy.example", "https://spare.example"], { attempts: 6, firstWaitMs: 500 }, async (ms) => void waits.push(ms));
    expect(await rpc.viewNodeStatus()).toEqual({ chain_id: "mainnet" });
    expect(await rpc.viewNodeStatus()).toEqual({ chain_id: "mainnet" });
    expect(calls).toEqual(["https://busy.example", "https://spare.example", "https://spare.example"]);
    expect(waits).toEqual([500]);
  });

  it("gives up after its attempts with the RPC's own error, waiting longer each time", async () => {
    const calls = fakeRpcs(() => new Response(LIMITED, { status: 429 }));
    const waits: number[] = [];
    const rpc = new SteadyRpcProvider(["https://a.example", "https://b.example"], { attempts: 3, firstWaitMs: 500 }, async (ms) => void waits.push(ms));
    const error = await rpc.viewNodeStatus().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isRateLimited(error)).toBe(true);
    expect(calls).toEqual(["https://a.example", "https://b.example", "https://a.example"]);
    expect(waits).toEqual([500, 1000]);
  });

  it("passes any other error through at once", async () => {
    const unknownAccount = { code: -32000, message: "Server error", data: "account nobody.near does not exist while viewing", name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "nobody.near" } } };
    const calls = fakeRpcs(() => Response.json({ jsonrpc: "2.0", id: "1", error: unknownAccount }));
    const rpc = new SteadyRpcProvider(["https://a.example", "https://b.example"], { attempts: 6, firstWaitMs: 500 }, async () => undefined);
    await expect(rpc.viewAccount({ accountId: "nobody.near" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("reads several addresses from NEAR_RPC_URL, else uses the network's own and its backups", () => {
    expect((provider(" https://a.example , https://b.example ") as SteadyRpcProvider).urls).toEqual(["https://a.example", "https://b.example"]);
    expect(serviceRpcUrls("mainnet", undefined)).toEqual(["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"]);
    expect(serviceRpcUrls("mainnet", "https://mine.example")).toBe("https://mine.example");
  });
});
