/**
 * The executor against the real contract on a local node, with mock-1click settling real (mock)
 * tokens. Covers PLAN §4.2 and the §9 rows that need the executor: native funding, trust budget
 * vs owner-signed attempts, exact-output change, refunds, an unreachable provider, and a worker
 * restart after broadcast.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attemptHash, type Attempt, type Intent } from "@getleash/shared";
import type { Executor, TickReport } from "@getleash/executor";

import { startWorld, TRON_RECIPIENT, USDC, type World } from "../src/world.ts";

let world: World;
let counter = 0;

/** A fresh 64-hex obligation id per test payment. */
function obligation(): string {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
}

async function tickUntil(
  executor: Executor,
  done: () => Promise<boolean>,
  { timeoutMs = 60_000, pauseMs = 400 } = {},
): Promise<TickReport[]> {
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

async function liveAttempt(id: number): Promise<Attempt | null> {
  const i = await intent(id);
  return i.live_attempt === null ? null : world.view.attempt(i.live_attempt);
}

async function propose(supplierId: number, amountOut: bigint) {
  const result = (await world.agent.propose({ obligationId: obligation(), supplierId, amountOut, reviewFlag: null })).value;
  expect(result.accepted, JSON.stringify(result)).toBe(true);
  return result.intent_id!;
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

  it("native: an approved intent is paid in one tick, exactly amount_out to the supplier", async () => {
    const { executor, notifier } = world.makeExecutor();
    const before = await world.net.ftBalance("acme.near");
    const id = await propose(acme, 7n * USDC);
    await tickUntil(executor, async () => (await intent(id)).status === "DONE");
    expect((await world.net.ftBalance("acme.near")) - before).toBe(7n * USDC);
    expect(notifier.kinds()).toContain("paid");
  });

  it("cross-chain within the trust budget: quote → attempt → register deposit → fund → delivered", async () => {
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 2n * USDC);
    await tickUntil(executor, async () => (await intent(id)).status === "DONE");

    const done = await intent(id);
    const attempt = (await world.view.attempt(done.attempt_ids.at(-1)!))!;
    expect(attempt.authorization).toBe("TRUST_BUDGET");
    expect(attempt.status).toBe("DELIVERED");
    expect(attempt.terms.refund_to).toBe(world.policyId);
    expect(attempt.terms.final_recipient).toBe(TRON_RECIPIENT);
    expect(BigInt(attempt.terms.amount_in)).toBeLessThanOrEqual(BigInt(done.terms.max_in));
    expect(attempt.delivered_amount).toBe((2n * USDC).toString());
    // The quote signature is the committed quote_ref, and 1Click's status echoes it.
    const status = await world.oneclick.status(attempt.terms.pay_to);
    expect(status.quoteResponse?.signature).toBe(attempt.terms.quote_ref);
    expect(notifier.kinds()).toContain("delivered");
  });

  it("exact-output change comes back as unreconciled inflow; only the owner attributes it (§9 row)", async () => {
    world.mock.setScenario("change");
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 1n * USDC);
    await tickUntil(executor, async () => (await intent(id)).status === "DONE");
    const attemptId = (await intent(id)).attempt_ids.at(-1)!;

    // Wait for the change transfer to land, then check nothing was credited automatically.
    let stray = 0n;
    for (let i = 0; i < 50 && stray === 0n; i++) {
      stray = await world.unreconciled();
      if (stray === 0n) await new Promise((r) => setTimeout(r, 200));
    }
    expect(stray).toBeGreaterThan(0n);
    expect(notifier.kinds()).toContain("returned_funds");
    const before = await world.view.ledger();

    await world.owner.reconcileInflows([{ amount: stray.toString(), attribution: { ATTEMPT_RETURN: { attempt_id: attemptId } } }]);
    const after = await world.view.ledger();
    expect(BigInt(after.cash) - BigInt(before.cash)).toBe(stray);
    expect(after.total_returned).toBe((BigInt(before.total_returned) + stray).toString());
    // Charges stay: returned change never restores budgets.
    expect(after.spent_day).toEqual(before.spent_day);
    expect((await world.view.attempt(attemptId))!.returned_amount).toBe(stray.toString());
    expect(await world.unreconciled()).toBe(0n);
  });

  it("above the trust budget the attempt waits for the owner's signature on its hash (§9 row)", async () => {
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 8n * USDC); // more than the 5 USDC trust budget
    await tickUntil(executor, async () => (await liveAttempt(id))?.status === "AWAITING_OWNER");
    const attempt = (await liveAttempt(id))!;
    expect(attempt.authorization).toBe("OWNER_REQUIRED");
    // The executor registers the committed deposit account while it waits, and asks the owner.
    expect(await world.isRegistered(attempt.terms.pay_to)).toBe(true);
    expect(notifier.notices.find((n) => n.kind === "attempt_needs_signature")?.link).toBe(
      `http://dashboard.test/attempt/${attempt.terms.id}`,
    );
    // Without the signature, more ticks change nothing.
    await executor.tick();
    expect((await liveAttempt(id))!.status).toBe("AWAITING_OWNER");

    // The owner's page recomputes the hash from the terms it shows before signing.
    expect(attemptHash(world.policyId, attempt.terms)).toBe(attempt.attempt_hash);
    await world.owner.authorizeAttempt(attempt.terms.id, attempt.attempt_hash);
    await tickUntil(executor, async () => (await intent(id)).status === "DONE");
    expect((await world.view.attempt(attempt.terms.id))!.authorization).toBe("OWNER_SIGNED");
  });

  it("a failed swap is flagged, the owner resolves it, and the refund is attributed by the owner only", async () => {
    world.mock.setScenario("refund");
    const { executor, notifier } = world.makeExecutor();
    const id = await propose(tron, 1n * USDC);
    await tickUntil(executor, async () => (await liveAttempt(id))?.status === "NEEDS_RECONCILIATION");
    expect(notifier.kinds()).toEqual(expect.arrayContaining(["swap_failed", "needs_reconciliation", "returned_funds"]));
    const attempt = (await liveAttempt(id))!;
    const refunded = await world.unreconciled();
    expect(refunded).toBe(BigInt(attempt.terms.amount_in));

    await world.owner.resolveReconciliation(attempt.terms.id, "SWAP_FAILED");
    expect((await world.view.attempt(attempt.terms.id))!.status).toBe("SWAP_FAILED");
    await world.owner.reconcileInflows([
      { amount: refunded.toString(), attribution: { ATTEMPT_RETURN: { attempt_id: attempt.terms.id } } },
    ]);
    expect(await world.unreconciled()).toBe(0n);
    // The intent was re-reserved for a retry; the next tick quotes a new attempt.
    expect((await intent(id)).status).toBe("APPROVED");
    await tickUntil(executor, async () => (await intent(id)).status === "DONE" || (await liveAttempt(id))?.status === "AWAITING_OWNER");
  });

  it("1Click unreachable past the timeout: the funded attempt is flagged, never re-funded", async () => {
    world.mock.setScenario("outage");
    let clock = Date.now();
    const { executor } = world.makeExecutor({ statusTimeoutMs: 60_000 }, { nowMs: () => clock });
    const id = await propose(tron, 1n * USDC);
    // Today's trust budget is used up by now, so this attempt needs the owner's signature first.
    await tickUntil(executor, async () => (await liveAttempt(id))?.status === "AWAITING_OWNER");
    const pending = (await liveAttempt(id))!;
    await world.owner.authorizeAttempt(pending.terms.id, pending.attempt_hash);
    await tickUntil(executor, async () => (await liveAttempt(id))?.status === "FUNDED");
    const attempt = (await liveAttempt(id))!;
    const debitsBefore = await world.net.ftBalance(attempt.terms.pay_to);

    clock = Date.now();
    await executor.tick(); // status 503, not overdue yet
    expect((await liveAttempt(id))!.status).toBe("FUNDED");
    clock = Date.now() + 61_000; // past funded_at + statusTimeoutMs
    await executor.tick();
    expect((await world.view.attempt(attempt.terms.id))!.status).toBe("NEEDS_RECONCILIATION");
    // Nothing was sent twice.
    expect(await world.net.ftBalance(attempt.terms.pay_to)).toBeLessThanOrEqual(debitsBefore);
    await world.owner.resolveReconciliation(attempt.terms.id, {
      DELIVERED: { delivered_amount: (1n * USDC).toString(), dest_tx: "checked-on-tronscan" },
    });
    expect((await intent(id)).status).toBe("DONE");
  });

  it("worker restart after broadcast: a new executor recovers from open work without a second transfer (§9 row)", async () => {
    // The first worker creates and funds an attempt, then "crashes" (its journal is lost).
    const first = world.makeExecutor().executor;
    const id = await propose(acme, 3n * USDC);
    const before = await world.net.ftBalance("acme.near");
    const attemptId = (await world.executorCalls.createAttemptNative(id)).value;
    await world.executorCalls.fundNative(attemptId);
    void first;

    // A fresh executor with an empty journal sees the paid intent and does nothing more.
    const { executor } = world.makeExecutor();
    const report = await executor.tick();
    expect(report.errors).toEqual([]);
    expect((await intent(id)).status).toBe("DONE");
    expect((await world.net.ftBalance("acme.near")) - before).toBe(3n * USDC);

    // And a replayed funding call is refused by the contract.
    await expect(world.executorCalls.fundNative(attemptId)).rejects.toMatchObject({ code: "ATTEMPT_NOT_AUTHORIZED" });
  });

  it("pending intents are announced to the owner once, with the approval link", async () => {
    const { executor, notifier } = world.makeExecutor();
    const big = (await world.agent.propose({ obligationId: obligation(), supplierId: acme, amountOut: 30n * USDC, reviewFlag: null })).value;
    expect(big).toMatchObject({ accepted: true, status: "PENDING", route: { NEEDS_APPROVAL: "ABOVE_THRESHOLD" } });
    await executor.tick();
    await executor.tick();
    const approvals = notifier.notices.filter((n) => n.kind === "approval_needed" && n.intentId === big.intent_id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.link).toBe(`http://dashboard.test/approve/${big.intent_id}`);
  });
});
