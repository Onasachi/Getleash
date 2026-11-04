/**
 * The factory on a real local node (docs/decisions.md D-32), with the exact wasm the operator publishes
 * (shared/src/installer-wasm.ts): a business's wallet makes one call, with exactly the setup's cost, and gets
 * a contract the bot accepts with its own check (checkHostedSetup), named after its account under the factory.
 *
 * The factory has the operator's store (release-8eaccbf1.onanikes.near, through the installer) and Circle's
 * USDC built in, so these devnets have both account names: the operator, and a mock token at USDC's id. The
 * factory account is made keyless as the publish script makes it: deploy, then delete its only key.
 */
import { type Account, actions, KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  accountExists,
  checkHostedSetup,
  codeSha256,
  FACTORY_BUILD,
  FACTORY_ID,
  FACTORY_WASM_SHA256,
  factoryDeposit,
  hostedIds,
  hostedSetupPlan,
  hostedSetupTransaction,
  INSTALLER_WASM_SHA256,
  near,
  nearApiActions,
  parseOutcome,
  PolicyView,
  RELEASE_STORE_ID,
  RELEASE_WASM_SHA256,
  retryInstallTransaction,
  type SetupPlan,
  type SetupTarget,
  type SetupTransaction,
  setupNeeds,
  tgas,
  type TxOutcome,
} from "@getleash/shared";

import { type Devnet, publishFactory, publishStore, startDevnet } from "../src/sandbox.ts";

const OPERATOR = RELEASE_STORE_ID.slice(RELEASE_STORE_ID.indexOf(".") + 1);

async function send(signer: Account, tx: SetupTransaction): Promise<TxOutcome> {
  return parseOutcome(await signer.signAndSendTransaction({ receiverId: tx.receiverId, actions: nearApiActions(tx.actions), throwOnFailure: false }));
}

const panics = (outcome: TxOutcome) => outcome.failures.map((f) => f.panic ?? f.message);

function planFor(ownerId: string): SetupPlan {
  return hostedSetupPlan({
    ownerId,
    agentPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    executorPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    token: { token_id: FACTORY_BUILD.token, token_decimals: 6 },
  });
}

const targetOf = (plan: SetupPlan): SetupTarget => ({
  ownerId: plan.ownerId,
  policyId: plan.policyId,
  agent: { accountId: plan.agent.accountId, publicKey: plan.agent.publicKey },
  executor: { accountId: plan.executor.accountId, publicKey: plan.executor.publicKey },
});

async function balance(net: Devnet, accountId: string): Promise<bigint> {
  return BigInt(((await net.rpc.viewAccount({ accountId })) as unknown as { amount: string }).amount);
}

async function keyCount(net: Devnet, accountId: string): Promise<number> {
  return ((await net.rpc.viewAccessKeyList({ accountId })) as unknown as { keys: unknown[] }).keys.length;
}

describe("the factory on a local node", () => {
  let net: Devnet;
  const as = (id: string) => net.accounts[id]!.account;

  beforeAll(async () => {
    net = await startDevnet({ owner: "acme.tg", token: FACTORY_BUILD.token, extra: ["shop.near", "mallory.near", "oneclick.near", "v.agent", OPERATOR, FACTORY_ID] });
    await publishFactory(net);
  });

  afterAll(async () => {
    await net?.stop();
  });

  it("is keyless, runs the published factory code, and names a business's accounts after its account", async () => {
    expect(await keyCount(net, FACTORY_ID)).toBe(0);
    expect(await codeSha256(net.rpc, FACTORY_ID)).toBe(FACTORY_WASM_SHA256);
    expect(hostedIds("acme.tg")).toEqual({ policyId: "acme-tg.getleash.near", agentId: "acme-tg-agent.getleash.near", executorId: "acme-tg-executor.getleash.near" });
  });

  it("one call sets everything up; before the store exists the contract keeps the installer, keyless, and the owner can ask again", async () => {
    const plan = planFor("shop.near");
    const outcome = await send(as("shop.near"), hostedSetupTransaction(plan));
    expect(panics(outcome)).toContain("NO_CODE");
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(INSTALLER_WASM_SHA256);
    expect(await keyCount(net, plan.policyId)).toBe(0);
    // Only the owner the factory recorded can ask again.
    expect(panics(await send(as("mallory.near"), retryInstallTransaction()))).toEqual(["NOT_YOURS"]);
    await publishStore(net);
    const again = await send(as("shop.near"), retryInstallTransaction());
    expect(again.ok, panics(again).join("; ")).toBe(true);
    expect(await codeSha256(net.rpc, plan.policyId)).toBe(RELEASE_WASM_SHA256);
    const checks = await checkHostedSetup(net.rpc, targetOf(plan), FACTORY_BUILD.token);
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
  });

  it("the page's one call makes a contract the bot serves: the release, no keys, the caller as owner, the roles with only their keys, USDC", async () => {
    const plan = planFor("acme.tg");
    const outcome = await send(as("acme.tg"), hostedSetupTransaction(plan));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    const checks = await checkHostedSetup(net.rpc, targetOf(plan), FACTORY_BUILD.token);
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["acme-tg.getleash.near has no access keys", "deployed code matches the wasm", "acme-tg.getleash.near can receive USDC"]),
    );
    const state = await new PolicyView(net.rpc, plan.policyId).state();
    expect(state).toMatchObject({ owner_id: "acme.tg", agent_id: "acme-tg-agent.getleash.near", executor_id: "acme-tg-executor.getleash.near", token_id: FACTORY_BUILD.token });
    expect(state.policy).toMatchObject({ executor_trust_daily_budget: "0", approval_threshold: "2500000", daily_cap: "20000000" });
    // The NEAR went where it should: 1.05 to the contract, 0.15 and 0.2 to the roles, 0.002 kept for the record.
    expect(await balance(net, plan.agent.accountId)).toBe(near("0.15"));
    expect(await balance(net, plan.executor.accountId)).toBe(near("0.2"));
  });

  it("refuses a second setup for the same name, wrong deposits and bad arguments, giving the NEAR straight back", async () => {
    const before = await balance(net, "acme.tg");
    expect(panics(await send(as("acme.tg"), hostedSetupTransaction(planFor("acme.tg"))))).toEqual(["TAKEN"]);
    expect(before - (await balance(net, "acme.tg"))).toBeLessThan(near("0.01"));
    const plan = planFor("mallory.near");
    const create = hostedSetupTransaction(plan);
    const fn = create.actions[0] as Extract<SetupTransaction["actions"][number], { type: "FunctionCall" }>;
    for (const deposit of [factoryDeposit() - 1n, factoryDeposit() + 1n]) {
      expect(panics(await send(as("mallory.near"), { ...create, actions: [{ ...fn, deposit }] }))).toEqual(["WRONG_DEPOSIT"]);
    }
    for (const args of [{ agent: "00", executor: "11" }, { executor: (fn.args as Record<string, string>).executor, agent: (fn.args as Record<string, string>).agent }]) {
      expect(panics(await send(as("mallory.near"), { ...create, actions: [{ ...fn, args }] }))).toEqual(["BAD_ARGS"]);
    }
    expect(await accountExists(net.rpc, plan.policyId)).toBe(false);
    expect(await accountExists(net.rpc, plan.agent.accountId)).toBe(false);
  });

  it("refuses a name that would end like a role account's, so no contract is ever another setup's agent or executor", async () => {
    const plan = planFor("v.agent");
    expect(panics(await send(as("v.agent"), hostedSetupTransaction(plan)))).toEqual(["BAD_NAME"]);
    expect(await accountExists(net.rpc, plan.policyId)).toBe(false);
  });

  it("sets up a name someone registered on USDC first: registration is open to anyone, and harmless", async () => {
    const plan = planFor("w3.shop.near");
    const early = await send(as("mallory.near"), {
      receiverId: FACTORY_BUILD.token,
      actions: [{ type: "FunctionCall", method: "storage_deposit", args: { account_id: plan.policyId, registration_only: true }, gas: tgas(10), deposit: near("0.00125") }],
    });
    expect(early.ok).toBe(true);
    const outcome = await send(await wallet("w3.shop.near", near("2")), hostedSetupTransaction(plan));
    expect(outcome.ok, panics(outcome).join("; ")).toBe(true);
    const checks = await checkHostedSetup(net.rpc, targetOf(plan), FACTORY_BUILD.token);
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
  });

  it("retry after the release is in does nothing: the release has no install", async () => {
    const outcome = await send(as("acme.tg"), retryInstallTransaction());
    expect(panics(outcome).join()).toMatch(/MethodNotFound|MethodResolveError/);
    expect(await codeSha256(net.rpc, hostedIds("acme.tg").policyId)).toBe(RELEASE_WASM_SHA256);
  });

  /** A wallet account `id` holding `amount` spendable NEAR (plus its own storage), with a key of its own. */
  async function wallet(id: string, amount: bigint): Promise<Account> {
    const key = KeyPair.fromRandom("ed25519");
    const created = parseOutcome(
      await as("shop.near").signAndSendTransaction({
        receiverId: id,
        actions: [actions.createAccount(), actions.transfer(amount + 182n * 10n ** 19n), actions.addFullAccessKey(key.getPublicKey())],
        throwOnFailure: false,
      }),
    );
    expect(created.ok).toBe(true);
    return net.as(id, key.toString());
  }

  it("a wallet holding what the page asks for completes the setup; the first live wallet's 1.498 NEAR does too", async () => {
    for (const [id, amount] of [
      ["w1.shop.near", setupNeeds()],
      ["w2.shop.near", 1_498_180_000_000_000_000_000_000n],
    ] as const) {
      const plan = planFor(id);
      const outcome = await send(await wallet(id, amount), hostedSetupTransaction(plan));
      expect(outcome.ok, `${id}: ${panics(outcome).join("; ")}`).toBe(true);
      expect(await codeSha256(net.rpc, plan.policyId)).toBe(RELEASE_WASM_SHA256);
    }
  });

  it("the create call attaches 85 Tgas, and the setup needs no more NEAR than the page asks for", () => {
    expect(hostedSetupTransaction(planFor("acme.tg")).actions[0]).toMatchObject({ gas: tgas(85) });
    expect(setupNeeds()).toBeLessThan(1_498_180_000_000_000_000_000_000n);
  });
});
