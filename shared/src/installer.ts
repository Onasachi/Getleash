/**
 * Setting up GetLeash from a browser wallet (docs/decisions.md D-31). HOT Wallet's connector can't carry
 * the 84 KB release in a request: it encodes each request in a time that grows with the square of its
 * size (about 40 minutes for the release on a laptop) and gives a request 60 seconds. So the setup page's
 * batch for the contract deploys the installer instead (contract/bootstrap/installer, under 2 KB), keyless
 * like the CLI's:
 *
 *   CreateAccount getleash.<owner>, Transfer, DeployContract(installer), install(<new's arguments>)
 *
 * The installer copies the release from the release store (contract/bootstrap/store), which the operator
 * publishes once (pnpm publish:release), deploys it only if its SHA-256 is the release's, and calls `new`
 * with the owner's arguments: what the CLI's batch does, a few receipts later. The store and the hash are
 * built into the installer, so it can install nothing else. The bot then checks the result exactly as it
 * checks a contract set up with the CLI (checkHostedSetup).
 *
 * The business's wallet doesn't deploy the installer itself, though: HOT Wallet calls any deployment a
 * dangerous request. It calls the factory (contract/bootstrap/factory, D-32), which creates the contract with
 * the installer, and the two role accounts, under its own account (hostedIds).
 */
import { baseDecode, type Provider } from "near-api-js";

import { bytesToHex, fromBase64Url } from "./bytes.ts";
import { FACTORY_BUILD, INSTALLER_BUILD, STORE_BUILD } from "./installer-wasm.ts";
import { initArgs, type SetupPlan, type SetupTransaction, sha256Hex } from "./setup.ts";
import { near, tgas } from "./units.ts";

export { FACTORY_BUILD, INSTALLER_BUILD, STORE_BUILD };

function decode(base64url: string): Uint8Array {
  const bytes = fromBase64Url(base64url);
  if (!bytes) throw new Error("shared/src/installer-wasm.ts is corrupt: run pnpm build:installer");
  return bytes;
}

export const INSTALLER_WASM = decode(INSTALLER_BUILD.wasm);
export const INSTALLER_WASM_SHA256: string = INSTALLER_BUILD.sha256;
export const STORE_WASM = decode(STORE_BUILD.wasm);
export const STORE_WASM_SHA256: string = STORE_BUILD.sha256;
export const FACTORY_WASM = decode(FACTORY_BUILD.wasm);
export const FACTORY_WASM_SHA256: string = FACTORY_BUILD.sha256;
/** The store the installer copies the release from (built into it). */
export const RELEASE_STORE_ID: string = INSTALLER_BUILD.store;

/** The factory's account (the operator's, keyless): every hosted business's accounts are named under it. */
export const FACTORY_ID = "getleash.near";

/** What the factory keeps of each setup's cost, for its record of the name (about 125 bytes of storage). */
export const FACTORY_RECORD = near("0.002");

/**
 * Installers built before this one that went live on mainnet (none yet). When `pnpm build:installer` makes a
 * new one for a new release, add the old hash here: a business whose install got stuck with it can then
 * still cancel from the page (its `abandon` works the same).
 */
export const RETIRED_INSTALLER_SHA256S: readonly string[] = [];

/** Whether a code hash is a GetLeash installer's: this one or a retired one. */
export function isInstallerCode(sha256: string | null): boolean {
  return sha256 === INSTALLER_WASM_SHA256 || (sha256 !== null && RETIRED_INSTALLER_SHA256S.includes(sha256));
}

/**
 * Gas for `install`: its own run, the store's `get` (15 Tgas), the callback and the deploy; `new` gets what is
 * left. The whole path burns about 30 Tgas and needs 28 attached (near-sandbox 2.13.4, docs/verified-facts.md).
 * Kept low on purpose: a wallet must hold attached gas at a worst-case price while it signs (signingReserve),
 * and a business's wallet often has little more than the setup costs. Built into the factory.
 */
export const INSTALL_GAS = tgas(35);

/** Gas for the factory's `create`: the three accounts, the installer's path and the USDC registration (measured, D-32). */
export const FACTORY_CREATE_GAS = tgas(85);

/** NEAR's lowest gas price, in yoctoNEAR per gas (mainnet has stayed at it, docs/verified-facts.md). */
export const MIN_GAS_PRICE = 100_000_000n;

/**
 * NEAR a wallet must hold on top of what the setup costs while it signs: NEAR takes the gas the factory call
 * attaches at a worst-case price when it is sent, and refunds what wasn't burned a block or two later. That
 * price was 10.06 times the gas price, measured (docs/verified-facts.md); 10.2 here.
 */
export function signingReserve(gasPrice: bigint = MIN_GAS_PRICE): bigint {
  const price = gasPrice > MIN_GAS_PRICE ? gasPrice : MIN_GAS_PRICE;
  return (FACTORY_CREATE_GAS * price * 102n) / 10n;
}

/** The owner only: asks the factory to have their contract's installer install the release again (D-32). */
export function retryInstallTransaction(): SetupTransaction {
  return { receiverId: FACTORY_ID, actions: [{ type: "FunctionCall", method: "retry_install", args: {}, gas: INSTALL_GAS + tgas(10), deposit: 0n }] };
}

/**
 * The policy account's batch for a browser wallet: the CLI's (policyTransaction), with the installer in
 * place of the release and `install` in place of `new`, with the same arguments. No access key, ever.
 */
export function installerPolicyTransaction(plan: SetupPlan): SetupTransaction {
  return {
    receiverId: plan.policyId,
    actions: [
      { type: "CreateAccount" },
      { type: "Transfer", deposit: plan.policyBalance },
      { type: "DeployContract", code: INSTALLER_WASM },
      { type: "FunctionCall", method: "install", args: initArgs(plan), gas: INSTALL_GAS, deposit: 0n },
    ],
  };
}

/** Before the release is installed only: deletes the policy account and sends its NEAR back to the owner. */
export function abandonTransaction(policyId: string): SetupTransaction {
  return { receiverId: policyId, actions: [{ type: "FunctionCall", method: "abandon", args: {}, gas: tgas(30), deposit: 0n }] };
}

/** NEAR the store keeps for its storage (its code, the release, the account), rounded up to 0.01 NEAR. */
export function storeBalance(releaseBytes: number): bigint {
  const bytes = BigInt(STORE_WASM.length + releaseBytes + 500);
  const step = near("0.01");
  return ((bytes * 10n ** 19n + step - 1n) / step) * step;
}

/** A store at `storeId` holding `code`: created, funded, deployed and set in one batch, so it never has a key. */
export function storeTransaction(storeId: string, code: Uint8Array): SetupTransaction {
  return {
    receiverId: storeId,
    actions: [
      { type: "CreateAccount" },
      { type: "Transfer", deposit: storeBalance(code.length) },
      { type: "DeployContract", code: STORE_WASM },
      { type: "FunctionCall", method: "set", args: code, gas: tgas(50), deposit: 0n },
    ],
  };
}

/** The operator's one-time batch (pnpm publish:release): the store the installer reads, holding the release it installs. */
export function releaseStoreTransaction(release: Uint8Array): SetupTransaction {
  if (sha256Hex(release) !== INSTALLER_BUILD.release) {
    throw new Error(`that wasm (sha256 ${sha256Hex(release)}) isn't the release the installer installs (${INSTALLER_BUILD.release})`);
  }
  return storeTransaction(RELEASE_STORE_ID, release);
}

/** What an account runs: the SHA-256 (hex) of its code, as the chain reports it; null for no code. */
export async function codeSha256(rpc: Provider, accountId: string): Promise<string | null> {
  const { code_hash } = (await rpc.viewAccount({ accountId })) as unknown as { code_hash: string };
  const hex = bytesToHex(baseDecode(code_hash));
  return /^0+$/.test(hex) ? null : hex;
}

/**
 * Whether the store holds the release the installer installs: what `get` returns, the installer's own
 * view, checked by its SHA-256. False when there is no store yet; network errors are thrown.
 */
export async function storeHoldsRelease(rpc: Provider, storeId: string = RELEASE_STORE_ID): Promise<boolean> {
  let result: number[];
  try {
    ({ result } = await rpc.callFunctionRaw({ contractId: storeId, method: "get", args: {} }));
  } catch (error) {
    if (/does not exist|UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound|EMPTY|NO_CONTRACT_CODE/i.test(String((error as Error).message ?? error))) return false;
    throw error;
  }
  return sha256Hex(Uint8Array.from(result)) === INSTALLER_BUILD.release;
}
