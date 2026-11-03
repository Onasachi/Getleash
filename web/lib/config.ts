import { DEFAULT_ONECLICK_URL, NETWORKS } from "@getleash/shared";

// NEXT_PUBLIC_* values are inlined at build time, so each one is referenced literally.
export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "mainnet") as "mainnet" | "testnet";
export const POLICY_ID = process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID ?? "";
/** The RPC, with the network's backups for when it rate-limits (both allow browser requests). */
export const RPC_URL: string | readonly string[] = process.env.NEXT_PUBLIC_NEAR_RPC_URL || [NETWORKS[NETWORK].rpcUrl, ...NETWORKS[NETWORK].backupRpcUrls];
export const ONECLICK_URL = process.env.NEXT_PUBLIC_ONECLICK_URL || DEFAULT_ONECLICK_URL;
export const EXPLORER = NETWORKS[NETWORK];
