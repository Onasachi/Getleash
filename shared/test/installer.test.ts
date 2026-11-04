/**
 * The installer and the release store as the setup page and the scripts use them (docs/decisions.md D-31):
 * the bytes are the build's (pinned by SHA-256), the installer is built for this release and its store, and
 * a browser wallet's request for a whole setup stays small enough for HOT Wallet's connector, which the
 * release itself never was. The installer's behaviour on a node: devkit/test/installer.sandbox.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  abandonTransaction,
  hostedSetupPlan,
  hostedSetupTransactions,
  INSTALL_GAS,
  INSTALLER_BUILD,
  INSTALLER_WASM,
  INSTALLER_WASM_SHA256,
  isInstallerCode,
  near,
  nearRoundedUp,
  REGISTRATION_GAS,
  RELEASE_STORE_ID,
  RELEASE_WASM_BYTES,
  RELEASE_WASM_SHA256,
  releaseStoreId,
  releaseStoreTransaction,
  RETIRED_INSTALLER_SHA256S,
  setupCost,
  setupTransactions,
  sha256Hex,
  signingReserve,
  STORE_WASM,
  STORE_WASM_SHA256,
  storeBalance,
  storeTransaction,
  tgas,
  walletActions,
} from "../src/index.ts";

const plan = () =>
  hostedSetupPlan({
    ownerId: "acme.tg",
    agentPublicKey: "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB",
    executorPublicKey: "ed25519:9ZRMNuXdfDzoPMGcLj2ZTzEXzuRkTNM5uVrCAwKcYmS4",
    token: { token_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", token_decimals: 6 },
  });

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** What HOT Wallet's connector encodes before it shows anything: JSON.stringify of the request (a Uint8Array becomes an object with a key per byte). */
function hotRequest(transactions: ReturnType<typeof hostedSetupTransactions>): string {
  return JSON.stringify({
    method: "near:signAndSendTransactions",
    request: { transactions: transactions.map((t) => ({ receiverId: t.receiverId, actions: walletActions(t.actions) })) },
    deadline: 1_793_600_000_000,
    id: "00000000-0000-0000-0000-000000000000",
    $hot: true,
    origin: "https://www.getleash.xyz",
  });
}

describe("the installer and the store", () => {
  it("are the bytes pnpm build:installer built, pinned by their SHA-256", () => {
    expect(sha256Hex(INSTALLER_WASM)).toBe(INSTALLER_WASM_SHA256);
    expect(INSTALLER_WASM.length).toBe(INSTALLER_BUILD.bytes);
    expect(sha256Hex(STORE_WASM)).toBe(STORE_WASM_SHA256);
    // wasm modules, version 1
    expect([...INSTALLER_WASM.slice(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
    expect([...STORE_WASM.slice(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
  });

  it("the installer is built for this release, from the store named after it, and has both inside", () => {
    expect(INSTALLER_BUILD.release).toBe(RELEASE_WASM_SHA256);
    expect(RELEASE_STORE_ID).toBe(releaseStoreId("onanikes.near"));
    expect(RELEASE_STORE_ID).toBe("release-8eaccbf1.onanikes.near");
    expect(contains(INSTALLER_WASM, new TextEncoder().encode(RELEASE_STORE_ID))).toBe(true);
    expect(contains(INSTALLER_WASM, Uint8Array.from(Buffer.from(RELEASE_WASM_SHA256, "hex")))).toBe(true);
  });

  it("the installer is small: under 2 KB, against the release's 83,900 bytes", () => {
    expect(INSTALLER_WASM.length).toBeLessThan(2_000);
    expect(RELEASE_WASM_BYTES).toBe(83_900);
  });

  it("the page recognises this installer, and retired ones, by their code hash", () => {
    expect(isInstallerCode(INSTALLER_WASM_SHA256)).toBe(true);
    expect(RETIRED_INSTALLER_SHA256S).toEqual([]);
    expect(isInstallerCode(RELEASE_WASM_SHA256)).toBe(false);
    expect(isInstallerCode(STORE_WASM_SHA256)).toBe(false);
    expect(isInstallerCode(null)).toBe(false);
  });
});

describe("a browser wallet's request for a whole setup", () => {
  it("stays small enough for HOT Wallet's connector: under 25,000 characters, where deploying the release itself took 960,000", () => {
    const viaInstaller = hotRequest(hostedSetupTransactions(plan()));
    const direct = hotRequest(setupTransactions({ ...plan(), wasm: new Uint8Array(RELEASE_WASM_BYTES).fill(255) }));
    expect(viaInstaller.length).toBeLessThan(25_000);
    expect(direct.length).toBeGreaterThan(900_000);
  });
});

describe("the release store's batch", () => {
  it("creates the store keyless, funded for its storage, holding the release as raw bytes", () => {
    const release = new Uint8Array(RELEASE_WASM_BYTES);
    const tx = storeTransaction(RELEASE_STORE_ID, release);
    expect(tx.receiverId).toBe("release-8eaccbf1.onanikes.near");
    expect(tx.actions).toEqual([
      { type: "CreateAccount" },
      { type: "Transfer", deposit: near("0.86") },
      { type: "DeployContract", code: STORE_WASM },
      { type: "FunctionCall", method: "set", args: release, gas: tgas(50), deposit: 0n },
    ]);
    expect(storeBalance(RELEASE_WASM_BYTES)).toBe(near("0.86"));
  });

  it("is refused for anything but the release the installer installs", () => {
    expect(() => releaseStoreTransaction(new Uint8Array(RELEASE_WASM_BYTES))).toThrow(/isn't the release the installer installs/);
  });
});

describe("what a wallet must hold while it signs a setup", () => {
  it("is the setup's cost plus all the gas still to attach, at NEAR's worst-case price (it comes back)", () => {
    expect(INSTALL_GAS).toBe(tgas(60));
    expect(REGISTRATION_GAS).toBe(tgas(10));
    expect(signingReserve({ contract: true, registered: true })).toBe(near("0.07"));
    expect(signingReserve({ contract: false, registered: true })).toBe(near("0.01"));
    expect(signingReserve({ contract: false, registered: false })).toBe(0n);
    expect(nearRoundedUp(setupCost(RELEASE_WASM_BYTES) + signingReserve({ contract: true, registered: true }))).toBe("1.50");
  });
});

describe("abandon", () => {
  it("is one call to the installer, with no deposit", () => {
    expect(abandonTransaction("getleash.acme.tg")).toEqual({ receiverId: "getleash.acme.tg", actions: [{ type: "FunctionCall", method: "abandon", args: {}, gas: tgas(30), deposit: 0n }] });
  });
});
