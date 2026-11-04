/**
 * A hosted setup on a real local node (docs/decisions.md D-30): the exact transactions the dashboard's
 * /setup page asks a business's wallet to sign (setupTransactions, the same list the page converts with
 * walletActions), signed here with the owner's key, produce a contract the bot accepts with its own
 * check (checkHostedSetup against the published release). Before that, and for anyone else's keys, the
 * check fails without throwing. The setup page's check of a setup link reads the signing agent's keys
 * from the chain the same way, and accepts only what that agent's key signed.
 */
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkHostedSetup,
  hostedSetupPlan,
  nearApiActions,
  parseOutcome,
  PolicyView,
  RELEASE_WASM_SHA256,
  setupLinkSigned,
  type SetupPlan,
  type SetupTarget,
  setupTransactions,
  sha256Hex,
  signSetupLink,
} from "@getleash/shared";

import { type Devnet, ensureWasm, startDevnet } from "../src/sandbox.ts";

describe("a hosted setup on a local node", () => {
  let net: Devnet;
  let plan: SetupPlan;
  let target: SetupTarget;
  const agentKey = KeyPair.fromRandom("ed25519");
  const executorKey = KeyPair.fromRandom("ed25519");

  beforeAll(async () => {
    net = await startDevnet();
    const { policy: wasm } = ensureWasm();
    plan = hostedSetupPlan({
      ownerId: net.owner.id,
      agentPublicKey: agentKey.getPublicKey().toString(),
      executorPublicKey: executorKey.getPublicKey().toString(),
      wasm,
      token: { token_id: net.token.id, token_decimals: 6 },
    });
    target = {
      ownerId: plan.ownerId,
      policyId: plan.policyId,
      agent: { accountId: plan.agent.accountId, publicKey: plan.agent.publicKey },
      executor: { accountId: plan.executor.accountId, publicKey: plan.executor.publicKey },
    };
  });

  afterAll(async () => {
    await net?.stop();
  });

  it("builds the release the bot checks for", () => {
    // contract/target/near holds the reproducible release build; a dev build would differ, and the bot would refuse it.
    expect(sha256Hex(plan.wasm)).toBe(RELEASE_WASM_SHA256);
  });

  it("fails the bot's check before the owner has signed anything, without throwing", async () => {
    const checks = await checkHostedSetup(net.rpc, target, net.token.id);
    expect(checks.some((c) => !c.ok)).toBe(true);
  });

  it("the page's transactions, signed by the owner, make a contract the bot serves", async () => {
    for (const tx of setupTransactions(plan)) {
      const outcome = parseOutcome(await net.owner.account.signAndSendTransaction({ receiverId: tx.receiverId, actions: nearApiActions(tx.actions), throwOnFailure: false }));
      expect(outcome.ok, `${tx.receiverId}: ${outcome.failures.map((f) => f.panic ?? f.message).join("; ")}`).toBe(true);
    }
    const checks = await checkHostedSetup(net.rpc, target, net.token.id);
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([`${plan.policyId} has no access keys`, "deployed code matches the wasm", `${plan.policyId} can receive USDC`]),
    );
    const state = await new PolicyView(net.rpc, plan.policyId).state();
    expect(state).toMatchObject({ owner_id: plan.ownerId, agent_id: plan.agent.accountId, executor_id: plan.executor.accountId, token_id: net.token.id });
    expect(state.policy.executor_trust_daily_budget).toBe("0");
  });

  it("a setup link that agent's key signed checks out against the keys the chain lists for it, as the page reads them", async () => {
    const link = { agent: plan.agent.publicKey, executor: plan.executor.publicKey, until: Date.now() + 86_400_000, user: "4004", name: "@acme_owner", bot: "GetLeashBot" };
    const sig = await signSetupLink(KeyPairSigner.fromSecretKey(agentKey.toString() as KeyPairString), plan.agent.accountId, link);
    // What the page does: the contract names its agent, and the chain lists that agent's keys.
    const state = await new PolicyView(net.rpc, plan.policyId).state();
    const { keys } = (await net.rpc.viewAccessKeyList({ accountId: state.agent_id })) as unknown as { keys: Array<{ public_key: string }> };
    const onChain = keys.map((k) => k.public_key);
    expect(onChain).toEqual([agentKey.getPublicKey().toString()]);
    expect(await setupLinkSigned(link, sig, onChain)).toBe(true);
    // A key the agent doesn't hold (here, the executor's) signs nothing the page accepts.
    const forged = await signSetupLink(KeyPairSigner.fromSecretKey(executorKey.toString() as KeyPairString), plan.executor.accountId, link);
    expect(await setupLinkSigned(link, forged, onChain)).toBe(false);
  });

  it("someone else's keys do not pass: the role accounts must hold the keys generated for this business", async () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const checks = await checkHostedSetup(net.rpc, { ...target, agent: { ...target.agent, publicKey: other } }, net.token.id);
    expect(checks.find((c) => c.name === `${plan.agent.accountId} holds only its function-call key`)?.ok).toBe(false);
  });
});
