import { DEFAULT_ONECLICK_URL, NETWORKS } from "@getleash/shared";

// NEXT_PUBLIC_* values are inlined at build time, so each one is referenced literally.
export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "mainnet") as "mainnet" | "testnet";
export const POLICY_ID = process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID ?? "";
export const RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC_URL || NETWORKS[NETWORK].rpcUrl;
export const ONECLICK_URL = process.env.NEXT_PUBLIC_ONECLICK_URL || DEFAULT_ONECLICK_URL;
export const EXPLORER = NETWORKS[NETWORK];
