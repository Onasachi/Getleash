/** Network presets and providers. Browser-safe. */
import { JsonRpcProvider } from "near-api-js";

export type NetworkId = "mainnet" | "testnet" | "sandbox";

export type NetworkPreset = {
  id: NetworkId;
  rpcUrl: string;
  /** Other public RPCs the services move to while `rpcUrl` rate-limits them (each answered on 2026-11-03). */
  backupRpcUrls: readonly string[];
  explorerTx: (hash: string) => string;
  explorerAccount: (id: string) => string;
  /** Circle USDC on NEAR (docs/verified-facts.md). Sandbox deployments use a mock token. */
  usdc: string | null;
};

export const NETWORKS: Record<NetworkId, NetworkPreset> = {
  mainnet: {
    id: "mainnet",
    rpcUrl: "https://rpc.mainnet.fastnear.com",
    backupRpcUrls: ["https://rpc.mainnet.near.org", "https://near.drpc.org"],
    explorerTx: (h) => `https://nearblocks.io/txns/${h}`,
    explorerAccount: (a) => `https://nearblocks.io/address/${a}`,
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  testnet: {
    id: "testnet",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    backupRpcUrls: ["https://rpc.testnet.near.org"],
    explorerTx: (h) => `https://testnet.nearblocks.io/txns/${h}`,
    explorerAccount: (a) => `https://testnet.nearblocks.io/address/${a}`,
    usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  },
  sandbox: {
    id: "sandbox",
    rpcUrl: "http://127.0.0.1:3030",
    backupRpcUrls: [],
    explorerTx: (h) => `sandbox:tx/${h}`,
    explorerAccount: (a) => `sandbox:account/${a}`,
    usdc: null,
  },
};

export function networkId(value: string | undefined): NetworkId {
  const id = value ?? "mainnet";
  if (id !== "mainnet" && id !== "testnet" && id !== "sandbox") throw new Error(`unknown network ${id}`);
  return id;
}

/**
 * Whether an RPC turned a request away for its rate limit. FastNEAR answers HTTP 429 with a JSON-RPC
 * error (code -429, "Rate limits exceeded"), which near-api-js 7.4 does not retry: it retries HTTP 500,
 * 503 and 408 only.
 */
export function isRateLimited(error: unknown): boolean {
  const { cause, message } = (error ?? {}) as { cause?: unknown; message?: unknown };
  return cause === 429 || /rate limit|too many requests|"code":\s*-429/i.test(String(message ?? ""));
}

export type RetryPolicy = { attempts: number; firstWaitMs: number };

/**
 * A provider that waits and tries again when an RPC rate-limits it, moving to the next address each time
 * and staying on the one that answered. Any other error passes through unchanged. A rate-limited request
 * never reached a node, and a signed transaction sent again keeps its hash and nonce, so trying again
 * cannot make anything happen twice.
 */
export class SteadyRpcProvider extends JsonRpcProvider {
  readonly urls: readonly string[];
  private readonly endpoints: JsonRpcProvider[];
  private current = 0;

  constructor(
    urls: readonly string[],
    private readonly retry: RetryPolicy = { attempts: 6, firstWaitMs: 500 },
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    super({ url: urls[0] ?? "" });
    if (urls.length === 0) throw new Error("no RPC address given");
    this.urls = urls;
    this.endpoints = urls.map((url) => new JsonRpcProvider({ url }));
  }

  // The base signature is generic over near-api-js's internal method table; this forwards it unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async sendJsonRpc(method: any, params: any): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const index = (this.current + attempt) % this.endpoints.length;
      const endpoint = this.endpoints[index]!;
      try {
        const result = await (endpoint.sendJsonRpc as (m: unknown, p: unknown) => Promise<unknown>).call(endpoint, method, params);
        this.current = index;
        return result;
      } catch (error) {
        if (!isRateLimited(error) || attempt + 1 >= this.retry.attempts) throw error;
        await this.wait(this.retry.firstWaitMs * 2 ** attempt);
      }
    }
  }
}

/** A provider for one RPC address, or several: a list, or addresses separated by commas (NEAR_RPC_URL). */
export function provider(rpcUrls: string | readonly string[]): JsonRpcProvider {
  const urls = (typeof rpcUrls === "string" ? rpcUrls.split(",") : rpcUrls).map((u) => u.trim()).filter(Boolean);
  return new SteadyRpcProvider(urls);
}

/** The RPC addresses for a service: NEAR_RPC_URL when set, else the network's own and its backups. */
export function serviceRpcUrls(network: NetworkId, configured: string | undefined): readonly string[] | string {
  return configured?.trim() ? configured : [NETWORKS[network].rpcUrl, ...NETWORKS[network].backupRpcUrls];
}
