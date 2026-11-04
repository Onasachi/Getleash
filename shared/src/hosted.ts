/**
 * Hosted GetLeash (docs/decisions.md D-30): one service, the operator's, runs the agent and the executor
 * for many businesses. Each business still gets its own contract, created by its own wallet with the
 * same transactions as the setup CLI (setup.ts), owned by that wallet, holding its own treasury and
 * limits. The service holds only the two function-call keys it generated for that business: it can
 * propose payments to suppliers the owner added and fund cross-chain payments the owner approved, within
 * the contract's limits. It can never add a supplier, change a limit or withdraw.
 */
import { base64Decode, type Provider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { z } from "zod";

import { sha256 } from "@noble/hashes/sha2.js";

import { fromBase64Url, hexToBytes, toBase64Url } from "./bytes.ts";
import { type Check, DEFAULT_POLICY, defaultRoleIds, FT_STORAGE_DEPOSIT, RELEASE_WASM_SHA256, type SetupPlan, sha256Hex, suggestedPolicyBalance, verifySetup } from "./setup.ts";
import { near } from "./units.ts";

/** NEAR each role account starts with (for gas) and its key's gas allowance: the setup CLI's defaults. */
export const HOSTED_ROLES = {
  agent: { balance: near("0.15"), allowance: near("0.5") },
  executor: { balance: near("0.2"), allowance: near("1") },
} as const;

/** Network fees for the four setup transactions: about 0.023 NEAR on mainnet (docs/deployment.md, Costs). */
export const SETUP_GAS = near("0.025");

export const ED25519_PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const NAMED_ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)+$/;

/**
 * Whether GetLeash can be set up under this account: a named account with a dot (acme.near, acme.tg),
 * short enough for `executor-1.<account>` to stay within NEAR's 64 characters. An implicit account
 * (64 hex characters) cannot create sub-accounts.
 */
export function canHostUnder(accountId: string): boolean {
  return accountId.length <= 64 - "executor-1.".length && NAMED_ACCOUNT.test(accountId);
}

/** The setup a hosted business's wallet signs: the CLI's defaults, the service's two public keys, the operator's token. */
export function hostedSetupPlan(input: {
  ownerId: string;
  agentPublicKey: string;
  executorPublicKey: string;
  wasm: Uint8Array;
  token: { token_id: string; token_decimals: number };
}): SetupPlan {
  const ids = defaultRoleIds(input.ownerId);
  return {
    ownerId: input.ownerId,
    policyId: ids.policyId,
    agent: { accountId: ids.agentId, publicKey: input.agentPublicKey, ...HOSTED_ROLES.agent },
    executor: { accountId: ids.executorId, publicKey: input.executorPublicKey, ...HOSTED_ROLES.executor },
    treasuryToken: input.token.token_id,
    treasuryDecimals: input.token.token_decimals,
    policy: DEFAULT_POLICY,
    wasm: input.wasm,
    policyBalance: suggestedPolicyBalance(input.wasm.length),
  };
}

/** NEAR leaving the owner's account for the whole setup, network fees included (for a code of `wasmBytes`). */
export function setupCost(wasmBytes: number): bigint {
  return HOSTED_ROLES.agent.balance + HOSTED_ROLES.executor.balance + suggestedPolicyBalance(wasmBytes) + FT_STORAGE_DEPOSIT + SETUP_GAS;
}

/** NEAR for reading, rounded up to the cent: "1.43". */
export function nearRoundedUp(yocto: bigint): string {
  const cent = 10n ** 22n;
  const cents = (yocto + cent - 1n) / cent;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/**
 * A dashboard page. `contract` names a hosted business's contract, which the page reads from `?c=`;
 * without it the page shows the dashboard's own GetLeash (NEXT_PUBLIC_POLICY_CONTRACT_ID).
 */
export function dashboardLink(base: string | null | undefined, path: string, contract?: string | null): string | null {
  if (!base) return null;
  const url = `${base.replace(/\/+$/, "")}${path}`;
  return contract ? `${url}${url.includes("?") ? "&" : "?"}c=${encodeURIComponent(contract)}` : url;
}

/** The accounts a hosted setup is checked against: its contract, and the role accounts with the service's keys. */
export type SetupTarget = {
  ownerId: string;
  policyId: string;
  agent: { accountId: string; publicKey: string };
  executor: { accountId: string; publicKey: string };
};

/**
 * What the bot checks before it serves a hosted business, from chain state alone: verifySetup against the
 * published release (no keys on the contract, the release's code, the owner, the role accounts holding
 * only the service's keys, the token), and the contract's registration on the token, without which it
 * cannot hold USDC. An account that does not exist yet fails a check instead of throwing.
 */
export async function checkHostedSetup(rpc: Provider, target: SetupTarget, tokenId: string, wasmSha256 = RELEASE_WASM_SHA256): Promise<Check[]> {
  let checks: Check[];
  try {
    checks = await verifySetup(rpc, { ...target, treasuryToken: tokenId, wasmSha256 });
  } catch (error) {
    // An account that isn't there (yet): the setup isn't finished, or this RPC hasn't seen it.
    return [{ name: `${target.policyId} and its accounts exist`, ok: false, detail: (error as Error).message }];
  }
  const balance = await rpc.callFunction({ contractId: tokenId, method: "storage_balance_of", args: { account_id: target.policyId } });
  const registered = balance != null;
  return [...checks, { name: `${target.policyId} can receive USDC`, ok: registered, detail: registered ? "registered on the token" : "not registered on the token" }];
}

// ── Setup links, the owner's claim and the finish code (D-30) ──────────────────────────────────
// A setup is someone's only when three things meet, each from where it can't be faked:
//   1. The link. The bot signs each setup link (NEP-413) with the operator's agent key, which the page
//      reads from the chain (the dashboard's own GetLeash names that agent): the setup's two public keys,
//      its expiry, the Telegram account it is for as the bot saw it at /start, and the bot's username.
//      The page refuses a link the bot didn't sign, so a fake bot can't make one with keys of its own, nor
//      one that shows someone else's name, nor one that sends the last step anywhere but the real bot.
//   2. The owner's claim. Their wallet signs (NEP-413) a message naming the contract, the link's key and
//      that Telegram account. Its nonce is the SHA-256 of a code the page made and keeps to itself.
//   3. The finish code. The page opens the real bot's chat (t.me/<bot>, from the signed link) with that
//      code, and the user taps START: the code reaches the bot from whoever holds the Telegram app the
//      page runs in, straight from Telegram. The claim goes to the bot the page was opened from (sendData).
// The bot serves the business only when the claim and the code both came from the account the setup is
// for. A fake bot that opens the real page with its own owner's setup link gets the claim, never the
// code: the victim's own Telegram sends the code to the real bot, which sees the wrong account and refuses.

/** NEP-413 recipient of the bot's signature on a setup link. */
export const SETUP_LINK_RECIPIENT = "getleash-setup-link";

/** What a setup link carries: the setup's two public keys, its expiry, whose it is (as Telegram showed them to the bot) and the bot's username. */
export type SetupLink = { agent: string; executor: string; until: number; user: string; name: string; bot: string };

export function setupLinkMessage(link: SetupLink): string {
  return [
    "GetLeash setup link",
    `agent: ${link.agent}`,
    `executor: ${link.executor}`,
    `until: ${link.until}`,
    `for: ${link.name} (user ${link.user})`,
    `bot: @${link.bot}`,
  ].join("\n");
}

type Nep413Payload = { message: string; recipient: string; nonce: Uint8Array };

/** What the bot signs for a link. Its nonce is the message's SHA-256, so the link needn't carry one. */
export function setupLinkPayload(link: SetupLink): Nep413Payload {
  const message = setupLinkMessage(link);
  return { message, recipient: SETUP_LINK_RECIPIENT, nonce: sha256(new TextEncoder().encode(message)) };
}

/** Anything that signs NEP-413 messages for an account: near-api-js's KeyPairSigner, an Account's signer. */
export type Nep413Signer = { signNep413Message(accountId: string, payload: Nep413Payload): Promise<{ signature: Uint8Array }> };

/** The bot's signature on a setup link (base64url), by `accountId`'s key: the operator's agent account. */
export async function signSetupLink(signer: Nep413Signer, accountId: string, link: SetupLink): Promise<string> {
  return toBase64Url((await signer.signNep413Message(accountId, setupLinkPayload(link))).signature);
}

/** Whether `signature` (base64url) is a signature on this link by one of `keys` (the operator's agent account's, from the chain). */
export async function setupLinkSigned(link: SetupLink, signature: string, keys: readonly string[]): Promise<boolean> {
  const bytes = fromBase64Url(signature);
  if (!bytes || bytes.length !== 64) return false;
  for (const key of keys) {
    if (await nep413Signed(key, bytes, setupLinkPayload(link))) return true;
  }
  return false;
}

/** A NEP-413 signature check alone: whose key it is, the caller established. */
async function nep413Signed(publicKey: string, signature: Uint8Array, payload: Nep413Payload): Promise<boolean> {
  try {
    await verifyMessage({
      signerAccountId: "-",
      signerPublicKey: publicKey,
      signature,
      payload,
      // verifyMessage looks the key up first; whose key this is was settled by the caller.
      provider: { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Provider,
    });
    return true;
  } catch {
    return false;
  }
}

/** The deep-link parameter that finishes a setup: `/start finish_<code>`, the code in base64url (32 bytes, 43 characters). */
export const FINISH_PREFIX = "finish_";

/** A fresh finish code (the page makes one and keeps it to itself until the last step). */
export function newFinishCode(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The finish code as it goes in the deep link, and back. */
export function finishCodeText(code: Uint8Array): string {
  return toBase64Url(code);
}
export function parseFinishCode(text: string): Uint8Array | null {
  const code = fromBase64Url(text);
  return code && code.length === 32 ? code : null;
}

/** The claim's NEP-413 nonce for a finish code: its SHA-256 (hex). The wallet's signature commits to a code only the page has. */
export function finishNonce(code: Uint8Array): string {
  return sha256Hex(code);
}

/** NEP-413 recipient of a setup claim. */
export const SETUP_CLAIM_RECIPIENT = "getleash-setup";

/** The Telegram account a setup is for: its user id and how Telegram showed it to the bot ("@acme" or a name). */
export type SetupAccount = { telegramUser: string; telegramName: string };

/** A new GetLeash ("setup"), or one that exists, which its owner's wallet moves to this Telegram account ("connect"). */
export type ClaimKind = "setup" | "connect";

/** What the owner's wallet signs to claim a setup, or to connect its existing GetLeash, for one Telegram account. */
export function setupClaimMessage(c: { kind?: ClaimKind; ownerId: string; agentPublicKey: string } & SetupAccount): string {
  if (c.kind === "connect") {
    return [
      `Connect GetLeash: getleash.${c.ownerId}, owned by ${c.ownerId}.`,
      `This request's key: ${c.agentPublicKey}.`,
      `GetLeash then serves it only to the Telegram account ${c.telegramName} (user ${c.telegramUser}), instead of any account it served before. Sign only if that account is yours.`,
    ].join("\n");
  }
  return [
    `Set up GetLeash: getleash.${c.ownerId}, owned by ${c.ownerId}.`,
    `Its agent key: ${c.agentPublicKey}.`,
    `GetLeash serves it only to the Telegram account ${c.telegramName} (user ${c.telegramUser}). Sign only if that account is yours.`,
  ].join("\n");
}

/** What the setup page sends the bot (Telegram's `web_app_data`, 4096 bytes at most). */
export const SetupClaim = z.object({
  kind: z.enum(["setup", "connect"]).default("setup"),
  owner: z.string().min(2).max(64),
  publicKey: z.string().startsWith("ed25519:").max(60),
  /** base64 (NEP-413) */
  signature: z.string().min(40).max(200),
  /** The finish code's SHA-256 (finishNonce). */
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SetupClaim = z.infer<typeof SetupClaim>;

/**
 * Whether the claim is signed by a full-access key of `claim.owner` over setupClaimMessage (of the claim's
 * kind) for this setup's key and this Telegram account. "bad" for a wrong signature or key; an RPC failure throws.
 */
export async function checkSetupClaim(rpc: Provider, claim: SetupClaim, expected: { agentPublicKey: string } & SetupAccount): Promise<"ok" | "bad"> {
  let accessKey: Awaited<ReturnType<Provider["viewAccessKey"]>>;
  try {
    accessKey = await rpc.viewAccessKey({ accountId: claim.owner, publicKey: claim.publicKey });
  } catch (error) {
    if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|invalid/i.test((error as Error).message)) return "bad";
    throw error;
  }
  if (accessKey.permission !== "FullAccess") return "bad";
  let signature: Uint8Array;
  try {
    signature = base64Decode(claim.signature);
  } catch {
    return "bad";
  }
  const payload = { message: setupClaimMessage({ kind: claim.kind, ownerId: claim.owner, ...expected }), recipient: SETUP_CLAIM_RECIPIENT, nonce: hexToBytes(claim.nonce) };
  return (await nep413Signed(claim.publicKey, signature, payload)) ? "ok" : "bad";
}
