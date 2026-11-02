/** Chain reads from the browser, straight to the RPC: the pages never trust a GetLeash server. */
import { OneClickClient, PolicyView, provider } from "@getleash/shared";

import { ONECLICK_URL, POLICY_ID, RPC_URL } from "./config";

export const rpc = provider(RPC_URL);
export const policy = new PolicyView(rpc, POLICY_ID);
export const oneclick = new OneClickClient({ baseUrl: ONECLICK_URL });

export async function accessKeyCount(accountId: string): Promise<number> {
  const list = (await rpc.viewAccessKeyList({ accountId })) as unknown as { keys: unknown[] };
  return list.keys.length;
}
