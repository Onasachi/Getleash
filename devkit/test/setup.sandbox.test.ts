/**
 * The self-custodial setup on a real local node (PLAN §3.1, §9 "Policy contract account after
 * setup", day-4 "function-call keys proven restricted"), then one native payout driven entirely
 * through the TypeScript clients, and the v2 size budget (docs/decisions.md D-28).
 */
import { actions, KeyPair } from "near-api-js";
import {
  AccessKeyDepositWithFunctionCallActionError,
  AccessKeyMethodNameMismatchActionError,
  AccessKeyReceiverMismatchActionError,
  AccessKeyRequiresFullAccessActionError,
} from "near-api-js/rpc-errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_METHODS,
  AgentClient,
  ContractCallError,
  createRoleAccount,
  defaultRoleIds,
  deployPolicy,
  encodeId,
  EXECUTOR_METHODS,
  near,
  OwnerClient,
  type Policy,
  PolicyView,
  registerOnToken,
  registerTreasury,
  type SetupPlan,
  sha256Hex,
  suggestedPolicyBalance,
  tgas,
  topUp,
  verifySetup,
} from "@getleash/shared";

import { type Devnet, ensureWasm, startDevnet, USDC } from "../src/sandbox.ts";
import { worldPolicy } from "../src/world.ts";

/** The contract is the mainnet budget's largest item: keep it small (D-28). */
const MAX_WASM_BYTES = 150_000;

function testPolicy(): Policy {
  return worldPolicy({ executor_trust_daily_budget: "0" });
}

describe("setup on a local node", () => {
  let net: Devnet;
  let plan: SetupPlan;
  const agentKey = KeyPair.fromRandom("ed25519");
  const executorKey = KeyPair.fromRandom("ed25519");

  beforeAll(async () => {
    net = await startDevnet();
    const ids = defaultRoleIds(net.owner.id);
    const { policy: wasm } = ensureWasm();
    plan = {
      ownerId: net.owner.id,
      policyId: ids.policyId,
      agent: { accountId: ids.agentId, publicKey: agentKey.getPublicKey().toString(), balance: near("0.15"), allowance: near("0.5") },
      executor: { accountId: ids.executorId, publicKey: executorKey.getPublicKey().toString(), balance: near("0.2"), allowance: near("1") },
      treasuryToken: net.token.id,
      treasuryDecimals: 6,
      policy: testPolicy(),
      wasm,
      policyBalance: suggestedPolicyBalance(wasm.length),
    };
  });

  afterAll(async () => {
    await net?.stop();
  });

  it("the contract stays within the mainnet size budget", () => {
    expect(plan.wasm.length).toBeLessThanOrEqual(MAX_WASM_BYTES);
    // Code + 0.2 NEAR for records, rounded up: about 1.1 NEAR for the policy account.
    expect(plan.policyBalance).toBeLessThanOrEqual(near("1.5"));
  });

  it("creates the role accounts and the keyless policy account, then verifies them from chain state", async () => {
    const owner = net.owner.account;
    await createRoleAccount(owner, plan.policyId, plan.agent, AGENT_METHODS);
    await createRoleAccount(owner, plan.policyId, plan.executor, EXECUTOR_METHODS);
    await deployPolicy(owner, plan);
    await registerTreasury(owner, plan);

    const checks = await verifySetup(net.rpc, { ...plan, wasmSha256: sha256Hex(plan.wasm) });
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    expect(checks.map((c) => c.name)).toContain(`${plan.policyId} has no access keys`);
  });

  it("function-call keys are restricted by the protocol: method, contract, deposit and transfers", async () => {
    const agent = net.as(plan.agent.accountId, agentKey.toString());
    const cases = [
      // The agent's key cannot call an executor method …
      {
        receiverId: plan.policyId,
        action: actions.functionCall("fund", encodeId(1), tgas(30), 0n),
        error: AccessKeyMethodNameMismatchActionError,
      },
      // … nor any other contract (here: the business's tokens) …
      {
        receiverId: plan.treasuryToken,
        action: actions.functionCall("ft_transfer", { receiver_id: "mallory.near", amount: "1" }, tgas(30), 0n),
        error: AccessKeyReceiverMismatchActionError,
      },
      // … nor attach a deposit, so it can never pass an owner method's 1-yocto check …
      {
        receiverId: plan.policyId,
        action: actions.functionCall("propose", new Uint8Array(), tgas(30), 1n),
        error: AccessKeyDepositWithFunctionCallActionError,
      },
      // … nor move NEAR out of its own account.
      { receiverId: "mallory.near", action: actions.transfer(near("0.01")), error: AccessKeyRequiresFullAccessActionError },
    ];
    for (const { receiverId, action, error } of cases) {
      await expect(agent.signAndSendTransaction({ receiverId, actions: [action] })).rejects.toBeInstanceOf(error);
    }
  });

  it("pays a native supplier inside the agent's own call, through the TypeScript clients", async () => {
    const view = new PolicyView(net.rpc, plan.policyId);
    const owner = new OwnerClient(net.owner.account, plan.policyId);
    const agent = new AgentClient(net.as(plan.agent.accountId, agentKey.toString()), plan.policyId);

    await topUp(net.owner.account, plan, 100n * USDC);
    expect(await net.ftBalance(plan.policyId)).toBe(100n * USDC);

    const acme = net.accounts["acme.near"]!;
    await registerOnToken(net.owner.account, plan.treasuryToken, acme.id);
    const supplierId = (await owner.addSupplier({ chain: "NEAR", asset_id: `nep141:${plan.treasuryToken}`, recipient: acme.id, decimals: 6 })).value;
    expect(supplierId).toBe(1);
    expect(await view.supplier(supplierId)).toMatchObject({ chain: "NEAR", recipient: acme.id, revision: 1, active: true });

    // Unauthorised: the owner's key is not the agent.
    const ownerAsAgent = new AgentClient(net.owner.account, plan.policyId);
    const denied = await ownerAsAgent.propose({ obligationId: "ab".repeat(32), supplierId, amountOut: 10n * USDC, reviewFlag: null }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ContractCallError);
    expect((denied as ContractCallError).code).toBe("ONLY_AGENT");

    const proposal = await agent.propose({ obligationId: "cd".repeat(32), supplierId, amountOut: 10n * USDC, reviewFlag: null });
    expect(proposal.ok).toBe(true);
    expect(proposal.value).toMatchObject({ accepted: true, status: "PAYING", route: "AUTONOMOUS" });
    const intent = (await view.intent(proposal.value.intent_id!))!;
    expect(intent).toMatchObject({ status: "PAID", amount_out: (10n * USDC).toString(), value: (10n * USDC).toString(), attempt: null });
    expect(await net.ftBalance(acme.id)).toBe(10n * USDC);
    expect(await net.ftBalance(plan.policyId)).toBe(90n * USDC);
    const state = await view.state();
    expect(state.budgets).toMatchObject({ autonomous: (10n * USDC).toString(), outflow: (10n * USDC).toString(), proposals: 1 });
    expect(state.paying).toBe(0);

    // The same invoice cannot be paid twice.
    const again = await agent.propose({ obligationId: "cd".repeat(32), supplierId, amountOut: 10n * USDC, reviewFlag: null });
    expect(again.value).toMatchObject({ accepted: false, reason: "OBLIGATION_OPEN_OR_PAID" });
  });
});
