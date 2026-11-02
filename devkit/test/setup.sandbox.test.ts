/**
 * The self-custodial setup on a real local node (PLAN §3.1, §9 "Policy contract account after
 * setup", day-4 "function-call keys proven restricted"), followed by one native payout driven
 * entirely through the TypeScript clients.
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
  attemptHash,
  ContractCallError,
  createRoleAccount,
  defaultRoleIds,
  deployPolicy,
  EXECUTOR_METHODS,
  ExecutorClient,
  intentHash,
  near,
  OwnerClient,
  parseOutcome,
  type Policy,
  PolicyView,
  registerTreasury,
  type SetupPlan,
  sha256Hex,
  suggestedPolicyBalance,
  tgas,
  topUp,
  verifySetup,
} from "@getleash/shared";

import { type Devnet, ensureWasm, startDevnet, USDC } from "../src/sandbox.ts";

const DAY = 86_400_000_000_000n;

function testPolicy(): Policy {
  return {
    autonomous_daily_budget: (50n * USDC).toString(),
    approval_threshold: (25n * USDC).toString(),
    daily_cap: (200n * USDC).toString(),
    monthly_cap: (2000n * USDC).toString(),
    executor_trust_daily_budget: "0",
    unverified_cumulative_budget: (10n * USDC).toString(),
    test_payment_max: (USDC / 2n).toString(),
    max_fee_bps: 100,
    // No cooldown: sandbox time barely moves during a test.
    new_supplier_cooldown_ns: "0",
    intent_ttl_ns: (3n * DAY).toString(),
    quote_min_validity_ns: (300n * 1_000_000_000n).toString(),
    funding_margin_ns: (180n * 1_000_000_000n).toString(),
    reconcile_grace_ns: (600n * 1_000_000_000n).toString(),
    retention_ns: (30n * DAY).toString(),
    max_open_intents: 50,
    max_proposals_per_day: 100,
    max_attempts_per_day: 100,
    max_registrations_per_day: 20,
  };
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
      agent: { accountId: ids.agentId, publicKey: agentKey.getPublicKey().toString(), balance: near("1"), allowance: near("0.5") },
      executor: {
        accountId: ids.executorId,
        publicKey: executorKey.getPublicKey().toString(),
        balance: near("2"),
        allowance: near("1"),
      },
      treasuryToken: net.token.id,
      treasuryDecimals: 6,
      hostedMode: false,
      policy: testPolicy(),
      wasm,
      policyBalance: suggestedPolicyBalance(wasm.length),
    };
  });

  afterAll(async () => {
    await net?.stop();
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
        action: actions.functionCall("fund_native", { attempt_id: 1 }, tgas(100), 0n),
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
        action: actions.functionCall("propose_payment", {}, tgas(30), 1n),
        error: AccessKeyDepositWithFunctionCallActionError,
      },
      // … nor move NEAR out of its own account.
      { receiverId: "mallory.near", action: actions.transfer(near("0.1")), error: AccessKeyRequiresFullAccessActionError },
    ];
    for (const { receiverId, action, error } of cases) {
      await expect(agent.signAndSendTransaction({ receiverId, actions: [action] })).rejects.toBeInstanceOf(error);
    }
  });

  it("pays a native supplier through the TypeScript clients, and the off-chain hashes match the contract", async () => {
    const view = new PolicyView(net.rpc, plan.policyId);
    const owner = new OwnerClient(net.owner.account, plan.policyId);
    const agent = new AgentClient(net.as(plan.agent.accountId, agentKey.toString()), plan.policyId);
    const executor = new ExecutorClient(net.as(plan.executor.accountId, executorKey.toString()), plan.policyId);

    await topUp(net.owner.account, plan, 100n * USDC);
    expect((await view.ledger()).cash).toBe((100n * USDC).toString());

    // A supplier registered on the token, verified, with no cooldown.
    const acme = net.accounts["acme.near"]!;
    const registered = parseOutcome(
      await net.owner.account.signAndSendTransaction({
        receiverId: plan.treasuryToken,
        actions: [actions.functionCall("storage_deposit", { account_id: acme.id }, tgas(30), near("0.00125"))],
      }),
    );
    expect(registered.ok).toBe(true);
    const supplierId = (
      await owner.addSupplier({
        chain: "NEAR",
        assetId: `nep141:${plan.treasuryToken}`,
        recipient: acme.id,
        perPaymentCap: 100n * USDC,
        monthlyCap: 1000n * USDC,
      })
    ).value;
    const supplier = await view.supplier(supplierId);
    await owner.verifySupplier(supplierId, supplier!.revision);

    // Unauthorised: the owner's key is not the agent.
    const ownerAsAgent = new AgentClient(net.owner.account, plan.policyId);
    const denied = await ownerAsAgent
      .propose({ obligationId: "ab".repeat(32), supplierId, amountOut: 10n * USDC, reviewFlag: null })
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ContractCallError);
    expect((denied as ContractCallError).code).toBe("ONLY_AGENT");

    const proposal = await agent.propose({
      obligationId: "cd".repeat(32),
      supplierId,
      amountOut: 10n * USDC,
      reviewFlag: null,
    });
    expect(proposal.value).toMatchObject({ accepted: true, status: "APPROVED", route: "AUTONOMOUS" });
    const intent = (await view.intent(proposal.value.intent_id!))!;
    expect(intentHash(plan.policyId, intent.terms)).toBe(intent.intent_hash);

    const attemptId = (await executor.createAttemptNative(intent.terms.id)).value;
    const attempt = (await view.attempt(attemptId))!;
    expect(attemptHash(plan.policyId, attempt.terms)).toBe(attempt.attempt_hash);
    expect(attempt.status).toBe("AUTHORIZED");

    const funded = await executor.fundNative(attemptId);
    expect(funded.ok).toBe(true);
    expect((await view.attempt(attemptId))!.status).toBe("DELIVERED");
    expect((await view.intent(intent.terms.id))!.status).toBe("DONE");
    expect(await net.ftBalance(acme.id)).toBe(10n * USDC);

    const ledger = await view.ledger();
    expect(ledger.cash).toBe((90n * USDC).toString());
    expect(ledger.reserved).toBe("0");
    expect(ledger.in_flight).toBe("0");

    // The same obligation cannot be paid twice.
    const again = await agent.propose({ obligationId: "cd".repeat(32), supplierId, amountOut: 10n * USDC, reviewFlag: null });
    expect(again.value).toMatchObject({ accepted: false, reason: "OBLIGATION_OPEN_OR_PAID" });
  });
});
