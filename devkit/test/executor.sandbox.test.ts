/**
 * The v2 executor (cross-chain only) against the real contract on a local node, with mock-1click
 * settling real (mock) tokens. Covers PLAN §4.2 and the §9 rows that need the executor: trust
 * budget vs owner-signed attempts, exact-output change, refunds and retries, an unreachable
 * provider, a worker restart after broadcast, and re-quoting an expired quote.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Executor, TickReport } from "@getleash/executor";
import type { Intent } from "@getleash/shared";

import { startWorld, TRON_RECIPIENT, USDC, type World } from "../src/world.ts";

let world: World;
let counter = 0;

/** A fresh 64-hex obligation id per test payment. */
function obligation(): string {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
}

async function tickUntil(executor: Executor, done: () => Promise<boolean>, { timeoutMs = 60_000, pauseMs = 400 } = {}): Promise<TickReport[]> {
  const reports: TickReport[] = [];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    reports.push(await executor.tick());
    if (await done()) return reports;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  throw new Error(`condition not reached; last reports: ${JSON.stringify(reports.slice(-3))}`);
}

async function intent(id: number): Promise<Intent> {
  return (await world.view.intent(id))!;
}

async function propose(supplierId: number, amountOut: bigint) {
  const result = (await world.agent.propose({ obligationId: obligation(), supplierId, amountOut, reviewFlag: null })).value;
  expect(result.accepted, JSON.stringify(result)).toBe(true);
  return result.intent_id!;
}

/** Ticks until the intent is funded. The executor funds it itself when it fits today's trust
 *  budget; otherwise it asks the owner, who here signs the exact deposit and amount shown. */
async function fundedWithOwnerIfNeeded(executor: Executor, id: number) {
  await tickUntil(executor, async () => {
    const i = await intent(id);
    return i.status === "PAID" || i.attempt !== null;
  });
  // Attempts are funded on the tick after they are created, if the trust budget allows.
  await executor.tick();
  const i = await intent(id);
  if (i.status !== "PAID" && i.attempt && !i.attempt.authorized) {
    await world.owner.authorize(id, i.attempt.deposit, i.attempt.amount_in);
  }
  await tickUntil(executor, async () => (await intent(id)).status === "PAID");
}

describe("executor on a local node with mock 1Click", () => {
  let acme: number;
  let tron: number;

  beforeAll(async () => {
    world = await startWorld({ log: process.env.WORLD_LOG ? (l) => console.log(l) : undefined });
    acme = await world.addSupplier({ chain: "NEAR", recipient: "acme.near", register: true });
    tron = await world.addSupplier({ chain: "TRON", recipient: TRON_RECIPIENT });
  });

  afterAll(async () => {
    await world?.stop();
  });

  it("native: the contract pays in the agent's own call; the executor only reports it", async () => {
    const { executor, notifier } = world.makeExecutor();
    const before = await world.net.ftBalance("acme.near");
    const id = await propose(acme, 7n * USDC);
    expect((await intent(id)).status).toBe("PAID");
    expect((await world.net.ftBalance("acme.near")) - before).toBe(7n * USDC);
    const report = await executor.tick();
    expect(report.actions).toEqual([]);
    expect(notifier.kinds()).toContain("paid");
  });

  it("cross-chain within the trust budget: quote → attempt → fund (registers the deposit) → delivered", async () => {
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 2n * USDC);
    expect((await intent(id)).status).toBe("APPROVED");
    await tickUntil(executor, async () => (await intent(id)).status === "PAID");
    const paid = await intent(id);
    expect(paid.attempt).not.toBeNull();
    expect(paid.attempt!.authorized).toBe(false);
    expect(BigInt(paid.attempt!.amount_in)).toBeLessThanOrEqual(BigInt(paid.max_in));
    // The contract registered the fresh deposit account in the funding batch.
    expect(await world.isRegistered(paid.attempt!.deposit)).toBe(true);
    // 1Click's record for that deposit is for this supplier, with refunds to the treasury.
    const status = await world.oneclick.status(paid.attempt!.deposit);
    expect(status.quoteResponse?.quoteRequest).toMatchObject({ recipient: TRON_RECIPIENT, refundTo: world.policyId, amount: (2n * USDC).toString() });
    await tickUntil(executor, async () => notifier.notices.some((n) => n.kind === "delivered" && n.intentId === id));
    expect((await world.view.state()).budgets.trust).toBe(paid.attempt!.amount_in);
  });

  it("exact-output change lands back in the treasury and never restores budgets (§9 row)", async () => {
    world.mock.setScenario("change");
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 1n * USDC);
    await tickUntil(executor, async () => (await intent(id)).status === "PAID");
    const sent = BigInt((await intent(id)).attempt!.amount_in);
    const budgetsAfterFunding = (await world.view.state()).budgets;
    const balanceAfterFunding = await world.balance();
    // (A fresh executor also reports earlier tests' swaps: wait for this intent's own notice.)
    await tickUntil(executor, async () => notifier.notices.some((n) => n.kind === "delivered" && n.intentId === id));
    let back = 0n;
    for (let i = 0; i < 50 && back === 0n; i++) {
      back = (await world.balance()) - balanceAfterFunding;
      if (back === 0n) await new Promise((r) => setTimeout(r, 200));
    }
    expect(back).toBeGreaterThan(0n);
    expect(back).toBeLessThan(sent);
    expect((await world.view.state()).budgets).toEqual(budgetsAfterFunding);
    expect(notifier.notices.find((n) => n.kind === "delivered" && n.intentId === id)?.text).toMatch(/change came back/);
  });

  it("above the trust budget the attempt waits for the owner, who signs its exact deposit and amount (§9 row)", async () => {
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 8n * USDC); // more than the 5 USDC trust budget
    await tickUntil(executor, async () => (await intent(id)).attempt !== null);
    const attempt = (await intent(id)).attempt!;
    expect(attempt.authorized).toBe(false);
    await executor.tick();
    expect(notifier.notices.find((n) => n.kind === "authorization_needed")?.link).toBe(`http://dashboard.test/intent/${id}`);
    // Without the signature, more ticks change nothing.
    await executor.tick();
    expect((await intent(id)).status).toBe("APPROVED");
    // A signature for other terms is refused.
    await expect(world.owner.authorize(id, attempt.deposit, (BigInt(attempt.amount_in) + 1n).toString())).rejects.toMatchObject({ code: "TERMS_MISMATCH" });
    await world.owner.authorize(id, attempt.deposit, attempt.amount_in);
    await tickUntil(executor, async () => (await intent(id)).status === "PAID");
  });

  it("a refunded swap: the owner is told, the money is back, budgets are not, and RETRY pays again", async () => {
    world.mock.setScenario("refund");
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 1n * USDC);
    await fundedWithOwnerIfNeeded(executor, id);
    const first = (await intent(id)).attempt!;
    const outflow = (await world.view.state()).budgets.outflow;
    await tickUntil(executor, async () => notifier.notices.some((n) => n.kind === "swap_failed" && n.intentId === id));
    expect(await world.isRegistered(first.deposit)).toBe(true);
    expect((await world.view.state()).budgets.outflow).toBe(outflow);

    world.mock.setScenario("success");
    await world.owner.decide(await intent(id), "RETRY");
    expect(await intent(id)).toMatchObject({ status: "APPROVED", attempt: null });
    await fundedWithOwnerIfNeeded(executor, id);
    const second = (await intent(id)).attempt!;
    expect(second.deposit).not.toBe(first.deposit);
    expect(BigInt((await world.view.state()).budgets.outflow)).toBe(BigInt(outflow) + BigInt(second.amount_in));
  });

  it("1Click unreachable past the timeout: the owner is told, nothing is sent twice", async () => {
    world.mock.setScenario("outage");
    let clock = Date.now();
    const { executor, notifier } = world.makeExecutor({ statusTimeoutMs: 60_000 }, { nowMs: () => clock });
    const id = await propose(tron, 1n * USDC);
    await fundedWithOwnerIfNeeded(executor, id);
    const deposit = (await intent(id)).attempt!.deposit;
    const received = await world.net.ftBalance(deposit);
    await executor.tick(); // status 503, not overdue yet
    expect(notifier.notices.some((n) => n.intentId === id && n.kind === "swap_failed")).toBe(false);
    clock = Date.now() + 61_000;
    await executor.tick();
    expect(notifier.notices.find((n) => n.intentId === id && n.kind === "swap_failed")?.text).toMatch(/no result from 1Click/);
    expect((await intent(id)).status).toBe("PAID");
    expect(await world.net.ftBalance(deposit)).toBeLessThanOrEqual(received);
    world.mock.setScenario("success");
  });

  it("worker restart after broadcast: a fresh executor sends nothing twice, and the contract refuses a replay (§9 row)", async () => {
    const first = world.makeExecutor().executor;
    const id = await propose(tron, 1n * USDC);
    await fundedWithOwnerIfNeeded(first, id);
    const deposit = (await intent(id)).attempt!.deposit;
    const received = await world.net.ftBalance(deposit);

    // A fresh executor with an empty journal sees the paid intent and only tracks it.
    const { executor } = world.makeExecutor();
    const report = await executor.tick();
    expect(report.errors).toEqual([]);
    expect(report.actions.some((a) => a.startsWith("fund"))).toBe(false);
    expect(await world.net.ftBalance(deposit)).toBe(received);
    await expect(world.executorCalls.fund(id)).rejects.toMatchObject({ code: "INTENT_NOT_APPROVED" });
  });

  it("an expired quote is re-quoted, and the owner's signature never carries over to the new deposit", async () => {
    let clock = Date.now();
    const { executor } = world.makeExecutor({}, { nowMs: () => clock });
    const id = await propose(tron, 4n * USDC);
    await tickUntil(executor, async () => (await intent(id)).attempt !== null);
    const old = (await intent(id)).attempt!;
    // Five hours later (executor clock) the 4-hour owner quote is past its deadline.
    clock = Date.now() + 5 * 3_600_000;
    await tickUntil(executor, async () => (await intent(id)).attempt?.deposit !== old.deposit);
    const fresh = (await intent(id)).attempt!;
    expect(fresh.authorized).toBe(false);
    await expect(world.owner.authorize(id, old.deposit, old.amount_in)).rejects.toMatchObject({ code: "TERMS_MISMATCH" });
  });

  it("pending intents are announced to the owner once, with the intent link", async () => {
    const { executor, notifier } = world.makeExecutor();
    const big = (await world.agent.propose({ obligationId: obligation(), supplierId: acme, amountOut: 30n * USDC, reviewFlag: null })).value;
    expect(big).toMatchObject({ accepted: true, status: "PENDING", route: "ABOVE_THRESHOLD" });
    await executor.tick();
    await executor.tick();
    const approvals = notifier.notices.filter((n) => n.kind === "approval_needed" && n.intentId === big.intent_id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.link).toBe(`http://dashboard.test/intent/${big.intent_id}`);
  });
});
