/**
 * The installer and the release store on a real local node (docs/decisions.md D-31), with the exact wasm
 * the setup page deploys (shared/src/installer-wasm.ts) and the release (contract/target/near).
 *
 * The installer is built for one store under one operator (release-8eaccbf1.onanikes.near), so these
 * devnets have that operator as a genesis account. Before the store exists, a business's contract is
 * created and keeps the installer, keyless, and nobody but its owner can do anything with it. The operator
 * then publishes the store once; it can't be set again, and gives the release to anyone. The owner's
 * install then turns the contract into the release, initialised with the owner's arguments, with nothing of
 * the installer left. Abandon gives the owner their NEAR back. A store holding other code installs nothing.
 */
import { type Account, actions } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  abandonTransaction,
  accountExists,
  codeSha256,
  hostedSetupPlan,
  hostedSetupTransactions,
  initArgs,
  INSTALL_GAS,
  INSTALLER_WASM,
  INSTALLER_WASM_SHA256,
  installerPolicyTransaction,
  near,
  nearApiActions,
  parseOutcome,
  PolicyView,
  RELEASE_STORE_ID,
  RELEASE_WASM_BYTES,
  RELEASE_WASM_SHA256,
  releaseStoreTransaction,
  setupCost,
  type SetupPlan,
  type SetupTransaction,
  signingReserve,
  STORE_WASM_SHA256,
  storeHoldsRelease,
  storeTransaction,
  tgas,
  type TxOutcome,
} from "@getleash/shared";
import { KeyPair } from "near-api-js";

import { type Devnet, ensureWasm, startDevnet } from "../src/sandbox.ts";

const OPERATOR = RELEASE_STORE_ID.slice(RELEASE_STORE_ID.indexOf(".") + 1);
const EXTRA = ["acme.near", "shop.near", "mallory.near", "oneclick.near", OPERATOR];

async function send(signer: Account, tx: SetupTransaction): Promise<TxOutcome> {
  return parseOutcome(await signer.signAndSendTransaction({ receiverId: tx.receiverId, actions: nearApiActions(tx.actions), throwOnFailure: false }));
}

function call(receiverId: string, method: string, args: Record<string, unknown> = {}, gas = tgas(30)): SetupTransaction {
  return { receiverId, actions: [{ type: "FunctionCall", method, args, gas, deposit: 0n }] };
}

const panics = (outcome: TxOutcome) => outcome.failures.map((f) => f.panic ?? f.message);

function planFor(net: Devnet, ownerId: string): SetupPlan {
  return hostedSetupPlan({
    ownerId,
    agentPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    executorPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    token: { token_id: net.token.id, token_decimals: 6 },
  });
}

async function keyCount(net: Devnet, accountId: string): Promise<number> {
  const { keys } = (await net.rpc.viewAccessKeyList({ accountId })) as unknown as { keys: unknown[] };
  return keys.length;
}

async function balance(net: Devnet, accountId: string): Promise<bigint> {
  const { amount } = (await net.rpc.viewAccount({ accountId })) as unknown as { amount: string };
  return BigInt(amount);
}

describe("the installer and the release store on a local node", () => {
  let net: Devnet;
  let release: Uint8Array;
  let acme: SetupPlan;
  let shop: SetupPlan;
  const as = (id: string) => net.accounts[id]!.account;

  beforeAll(async () => {
    net = await startDevnet({ extra: EXTRA });
    release = ensureWasm().policy;
    acme = planFor(net, "acme.near");
    shop = planFor(net, "shop.near");
  });

  afterAll(async () => {
    await net?.stop();
  });

  it("is built for the release the bot checks for, and that release is the local build", () => {
    expect(RELEASE_STORE_ID).toBe(`release-${RELEASE_WASM_SHA256.slice(0, 8)}.${OPERATOR}`);
    expect(Buffer.from(release).length).toBe(83_900);
  });

  it("before the store exists, the contract is created keyless and keeps the installer; nothing was deployed", async () => {
    expect(await storeHoldsRelease(net.rpc)).toBe(false);
    for (const plan of [acme, shop]) {
      const outcome = await send(as(plan.ownerId), installerPolicyTransaction(plan));
      expect(panics(outcome)).toContain("NO_CODE");
      expect(await codeSha256(net.rpc, plan.policyId)).toBe(INSTALLER_WASM_SHA256);
      expect(await keyCount(net, plan.policyId)).toBe(0);
    }
  });

  it("nobody but the owner can install, call the callback or abandon it", async () => {
    const mallory = as("mallory.near");
    expect(panics(await send(mallory, call(acme.policyId, "install", initArgs(acme), INSTALL_GAS)))).toEqual(["NOT_OWNER"]);
    expect(panics(await send(mallory, call(acme.policyId, "on_code")))).toEqual(["NOT_SELF"]);
    expect(panics(await send(mallory, call(acme.policyId, "abandon")))).toEqual(["NOT_OWNER"]);
    // Not even another business's owner.
    expect(panics(await send(as("shop.near"), call(acme.policyId, "abandon")))).toEqual(["NOT_OWNER"]);
    // The one method anyone may call does nothing (abandon's batch uses it to check the installer is still there).
    expect((await send(mallory, call(acme.policyId, "still_installer"))).ok).toBe(true);
    expect(await codeSha256(net.rpc, acme.policyId)).toBe(INSTALLER_WASM_SHA256);
    expect(await accountExists(net.rpc, acme.policyId)).toBe(true);
  });

  it("abandon's batch deletes an account only while the installer is its code, so a cancel that lands after the release can't delete it", async () => {
    // The batch abandon makes, sent here by accounts holding keys of their own: one running the release, one the installer.
    const batch = [actions.functionCall("still_installer", {}, tgas(10), 0n), actions.deleteAccount("acme.near")];
    const release = await wallet("x1.acme.near", near("2"));
    expect(parseOutcome(await release.signAndSendTransaction({ receiverId: "x1.acme.near", actions: [actions.deployContract(ensureWasm().policy)], throwOnFailure: false })).ok).toBe(true);
    const kept = parseOutcome(await release.signAndSendTransaction({ receiverId: "x1.acme.near", actions: batch, throwOnFailure: false }));
    expect(panics(kept).join()).toMatch(/MethodNotFound|MethodResolveError/);
    expect(await accountExists(net.rpc, "x1.acme.near")).toBe(true);
    const installer = await wallet("x2.acme.near", near("2"));
    expect(parseOutcome(await installer.signAndSendTransaction({ receiverId: "x2.acme.near", actions: [actions.deployContract(INSTALLER_WASM)], throwOnFailure: false })).ok).toBe(true);
    const deleted = parseOutcome(await installer.signAndSendTransaction({ receiverId: "x2.acme.near", actions: batch, throwOnFailure: false }));
    // It signed for itself here, so NEAR's gas refund to it finds no account; in abandon, the owner signs.
    expect(deleted.finalOk).toBe(true);
    expect(deleted.failures.map((f) => f.message).join()).toMatch(/^(|.*AccountDoesNotExist.*)$/);
    expect(await accountExists(net.rpc, "x2.acme.near")).toBe(false);
  });

  it("abandon deletes the contract and gives its owner the NEAR back", async () => {
    const before = await balance(net, "shop.near");
    const outcome = await send(as("shop.near"), abandonTransaction(shop.policyId));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    expect(await accountExists(net.rpc, shop.policyId)).toBe(false);
    // The contract's 1.05 NEAR, less a little gas.
    expect((await balance(net, "shop.near")) - before).toBeGreaterThan(shop.policyBalance - 10n ** 22n);
  });

  it("the operator publishes the store once: keyless, holding the release, and never set again", async () => {
    const outcome = await send(as(OPERATOR), releaseStoreTransaction(release));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    expect(await codeSha256(net.rpc, RELEASE_STORE_ID)).toBe(STORE_WASM_SHA256);
    expect(await keyCount(net, RELEASE_STORE_ID)).toBe(0);
    expect(await storeHoldsRelease(net.rpc)).toBe(true);
    const other = new Uint8Array([0, 97, 115, 109]);
    expect(panics(await send(as(OPERATOR), { receiverId: RELEASE_STORE_ID, actions: [{ type: "FunctionCall", method: "set", args: other, gas: tgas(30), deposit: 0n }] }))).toEqual([
      "ALREADY_SET",
    ]);
    expect(panics(await send(as("mallory.near"), { receiverId: RELEASE_STORE_ID, actions: [{ type: "FunctionCall", method: "set", args: other, gas: tgas(30), deposit: 0n }] }))).toEqual([
      "NOT_OWNER",
    ]);
    expect(await storeHoldsRelease(net.rpc)).toBe(true);
  });

  it("the owner installs again: the contract runs the release, initialised with the owner's arguments, and the installer is gone", async () => {
    const outcome = await send(as("acme.near"), call(acme.policyId, "install", initArgs(acme), INSTALL_GAS));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    expect(await codeSha256(net.rpc, acme.policyId)).toBe(RELEASE_WASM_SHA256);
    expect(await keyCount(net, acme.policyId)).toBe(0);
    const state = await new PolicyView(net.rpc, acme.policyId).state();
    expect(state).toMatchObject({ owner_id: "acme.near", agent_id: acme.agent.accountId, executor_id: acme.executor.accountId, token_id: net.token.id });
    // What the installer kept for its callback is gone (the key "i", base64 "aQ==").
    const { values } = await net.rpc.viewContractState({ contractId: acme.policyId, prefix: "i" });
    expect(values.map((v) => v.key)).not.toContain("aQ==");
    // And so is the installer: install and abandon don't exist any more.
    expect(panics(await send(as("acme.near"), call(acme.policyId, "install", initArgs(acme), INSTALL_GAS))).join()).toMatch(/MethodNotFound|MethodResolveError/);
    expect(panics(await send(as("acme.near"), call(acme.policyId, "abandon"))).join()).toMatch(/MethodNotFound|MethodResolveError/);
  });

  it("too little gas leaves the installer and the owner's arguments, and installing again with enough works", async () => {
    const plan = planFor(net, "g.acme.near");
    const owner = await wallet(plan.ownerId, near("3"));
    const starved = installerPolicyTransaction(plan);
    starved.actions[3] = { ...(starved.actions[3] as Extract<SetupTransaction["actions"][number], { type: "FunctionCall" }>), gas: tgas(20) };
    expect((await send(owner, starved)).ok).toBe(false);
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(INSTALLER_WASM_SHA256);
    const again = await send(owner, call(plan.policyId, "install", initArgs(plan), INSTALL_GAS));
    expect(again.ok, panics(again).join("; ")).toBe(true);
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(RELEASE_WASM_SHA256);
    const { values } = await net.rpc.viewContractState({ contractId: plan.policyId, prefix: "i" });
    expect(values.map((v) => v.key)).not.toContain("aQ==");
  });

  it("a new setup now installs the release in the same transaction that creates the contract", async () => {
    const fresh = planFor(net, "shop.near");
    const outcome = await send(as("shop.near"), installerPolicyTransaction(fresh));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    expect(await codeSha256(net.rpc, fresh.policyId)).toBe(RELEASE_WASM_SHA256);
    expect(await keyCount(net, fresh.policyId)).toBe(0);
    expect((await new PolicyView(net.rpc, fresh.policyId).state()).owner_id).toBe("shop.near");
  });

  /** A wallet account `id` holding `amount` spendable NEAR (plus its own storage), with a key of its own. */
  async function wallet(id: string, amount: bigint): Promise<Account> {
    const key = KeyPair.fromRandom("ed25519");
    const created = parseOutcome(
      await as("acme.near").signAndSendTransaction({
        receiverId: id,
        actions: [actions.createAccount(), actions.transfer(amount + near("0.002")), actions.addFullAccessKey(key.getPublicKey())],
        throwOnFailure: false,
      }),
    );
    expect(created.ok).toBe(true);
    return net.as(id, key.toString());
  }

  async function setUp(owner: Account, plan: SetupPlan): Promise<string[]> {
    const failed: string[] = [];
    for (const tx of hostedSetupTransactions(plan)) {
      try {
        const outcome = await send(owner, tx);
        if (!outcome.ok) failed.push(`${tx.receiverId}: ${panics(outcome).join("; ")}`);
      } catch (error) {
        failed.push(`${tx.receiverId}: ${(error as Error).message}`);
      }
      if (failed.length > 0) break;
    }
    return failed;
  }

  it("a wallet holding what the page asks for (the cost and the signing reserve) completes the whole setup", async () => {
    const plan = planFor(net, "w1.acme.near");
    const owner = await wallet(plan.ownerId, setupCost(RELEASE_WASM_BYTES) + signingReserve({ contract: true, registered: true }));
    expect(await setUp(owner, plan)).toEqual([]);
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(RELEASE_WASM_SHA256);
  });

  it("one holding only the cost runs out at the contract, which is why the page asks for the reserve too", async () => {
    const plan = planFor(net, "w2.acme.near");
    const owner = await wallet(plan.ownerId, setupCost(RELEASE_WASM_BYTES));
    const failed = await setUp(owner, plan);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^getleash\.w2\.acme\.near: .*(NotEnoughBalance|not enough|balance)/i);
    expect(await accountExists(net.rpc, plan.policyId)).toBe(false);
  });
});

describe("a release store holding other code", () => {
  let net: Devnet;

  beforeAll(async () => {
    net = await startDevnet({ extra: EXTRA });
  });

  afterAll(async () => {
    await net?.stop();
  });

  it("installs nothing: the installer checks the release's SHA-256, and the owner can still abandon", async () => {
    const { mockFt } = ensureWasm();
    expect((await send(net.accounts[OPERATOR]!.account, storeTransaction(RELEASE_STORE_ID, mockFt))).ok).toBe(true);
    expect(await storeHoldsRelease(net.rpc)).toBe(false);
    const plan = planFor(net, "acme.near");
    const acme = net.accounts["acme.near"]!.account;
    expect(panics(await send(acme, installerPolicyTransaction(plan)))).toContain("NOT_THE_RELEASE");
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(INSTALLER_WASM_SHA256);
    expect((await send(acme, abandonTransaction(plan.policyId))).ok).toBe(true);
    expect(await accountExists(net.rpc, plan.policyId)).toBe(false);
  });
});
