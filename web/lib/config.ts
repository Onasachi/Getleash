import { DEFAULT_ONECLICK_URL, NETWORKS } from "@getleash/shared";

// NEXT_PUBLIC_* values are inlined at build time, so each one is referenced literally.
export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "mainnet") as "mainnet" | "testnet";
/** The dashboard's own GetLeash (the operator's): what it shows unless a link names another contract. */
export const HOME_POLICY_ID = process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID ?? "";
/** The RPC, with the network's backups for when it rate-limits (both allow browser requests). */
export const RPC_URL: string | readonly string[] = process.env.NEXT_PUBLIC_NEAR_RPC_URL || [NETWORKS[NETWORK].rpcUrl, ...NETWORKS[NETWORK].backupRpcUrls];
export const ONECLICK_URL = process.env.NEXT_PUBLIC_ONECLICK_URL || DEFAULT_ONECLICK_URL;
export const EXPLORER = NETWORKS[NETWORK];

const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const CHOSEN = "getleash.contract";

/**
 * The contract these pages show. The bot's links for a business set up through it (docs/decisions.md
 * D-30) name its contract as `?c=<contract>`; the choice is kept for the rest of this tab's visit, so
 * links between pages need not repeat it. Anything else shows the dashboard's own GetLeash. A link can
 * name any contract, so the pages check that it runs a GetLeash release (Shell) before offering to sign
 * anything, and every signature is the owner's own, in their wallet. On the server (prerendering) this is
 * always the dashboard's own; the pages read the chain only in the browser.
 */
function chosenContract(): string {
  if (typeof window === "undefined") return HOME_POLICY_ID;
  try {
    const named = new URLSearchParams(window.location.search).get("c");
    if (named !== null) {
      const contract = named.trim().toLowerCase();
      if (!NEAR_ACCOUNT.test(contract) || contract === HOME_POLICY_ID) {
        sessionStorage.removeItem(CHOSEN);
        return HOME_POLICY_ID;
      }
      sessionStorage.setItem(CHOSEN, contract);
      return contract;
    }
    return sessionStorage.getItem(CHOSEN) ?? HOME_POLICY_ID;
  } catch {
    return HOME_POLICY_ID;
  }
}

export const POLICY_ID = chosenContract();
/** Whether these pages show a hosted business's GetLeash rather than the dashboard's own. */
export const HOSTED = POLICY_ID !== HOME_POLICY_ID;
