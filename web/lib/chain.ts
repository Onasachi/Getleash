/** Chain reads from the browser, straight to the RPC: the pages never trust a GetLeash server. */
import { baseDecode } from "near-api-js";

import { bytesToHex, OneClickClient, PolicyView, provider, RELEASE_WASM_SHA256 } from "@getleash/shared";

import { HOME_POLICY_ID, ONECLICK_URL, POLICY_ID, RPC_URL } from "./config";

export const rpc = provider(RPC_URL);
/** The GetLeash these pages show (lib/config.ts: the dashboard's own, or the one a link names). */
export const policy = new PolicyView(rpc, POLICY_ID);
/** The dashboard's own GetLeash, whatever a link names: the setup page copies its token from it. */
export const homePolicy = new PolicyView(rpc, HOME_POLICY_ID);

/** Whether an account runs the published GetLeash release (its code's SHA-256, as the chain reports it). */
export async function runsRelease(accountId: string): Promise<boolean> {
  const account = (await rpc.viewAccount({ accountId })) as unknown as { code_hash: string };
  return bytesToHex(baseDecode(account.code_hash)) === RELEASE_WASM_SHA256;
}
export const oneclick = new OneClickClient({ baseUrl: ONECLICK_URL });

export async function accessKeyCount(accountId: string): Promise<number> {
  const list = (await rpc.viewAccessKeyList({ accountId })) as unknown as { keys: unknown[] };
  return list.keys.length;
}
