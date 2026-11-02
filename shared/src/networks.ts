/** Network presets and providers. Browser-safe. */
import { JsonRpcProvider } from "near-api-js";

export type NetworkId = "mainnet" | "testnet" | "sandbox";

export type NetworkPreset = {
  id: NetworkId;
  rpcUrl: string;
  explorerTx: (hash: string) => string;
  explorerAccount: (id: string) => string;
  /** Circle USDC on NEAR (docs/verified-facts.md). Sandbox deployments use a mock token. */
  usdc: string | null;
};

export const NETWORKS: Record<NetworkId, NetworkPreset> = {
  mainnet: {
    id: "mainnet",
    rpcUrl: "https://rpc.mainnet.fastnear.com",
    explorerTx: (h) => `https://nearblocks.io/txns/${h}`,
    explorerAccount: (a) => `https://nearblocks.io/address/${a}`,
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  testnet: {
    id: "testnet",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    explorerTx: (h) => `https://testnet.nearblocks.io/txns/${h}`,
    explorerAccount: (a) => `https://testnet.nearblocks.io/address/${a}`,
    usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  },
  sandbox: {
    id: "sandbox",
    rpcUrl: "http://127.0.0.1:3030",
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

export function provider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider({ url: rpcUrl });
}
