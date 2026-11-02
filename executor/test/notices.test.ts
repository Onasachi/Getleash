/**
 * Owner notices shared with the bot. When the bot already gave the news in the owner's chat, the
 * executor stays quiet. When it did not (another chat, or its reply failed), the executor's notice
 * still comes once the grace period is over. The contract views are faked; nothing is called.
 */
import { describe, expect, it } from "vitest";

import type { ExecutorClient, Intent, PolicyView, StateView, Supplier } from "@getleash/shared";

import { Executor } from "../src/executor.ts";
import { Journal } from "../src/journal.ts";
import { MemoryNotifier } from "../src/notify.ts";

const TOKEN = "usdc.testnet";
const NOW_MS = 1_793_600_000_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function intent(id: number, status: Intent["status"], sinceMs: number): Intent {
  return {
    id,
    supplier_id: 1,
    revision: 1,
    obligation: "00".repeat(32),
    amount_out: "3000000",
    value: "3000000",
    max_in: "3000000",
    status,
    route: "ABOVE_THRESHOLD",
    flag: 0,
    since: ns(sinceMs),
    created_at: ns(sinceMs),
    attempt: null,
  };
}

function setup(intents: Intent[], delivered: ReadonlySet<string> | null, names?: Record<number, string>, quietStart = false) {
  let now = NOW_MS;
  const state = {
    token_id: TOKEN,
    token_decimals: 6,
    paused: false,
    executor_epoch: 0,
    next_intent_id: 100,
    policy: {
      approval_threshold: "2500000",
      autonomous_daily_budget: "5000000",
      daily_cap: "20000000",
      callback_grace_ns: ns(3_600_000),
      retention_ns: ns(7 * 86_400_000),
      intent_ttl_ns: ns(3 * 86_400_000),
    },
    budgets: { trust: "0" },
  } as unknown as StateView;
  const supplier: Supplier = { id: 1, chain: "NEAR", asset_id: `nep141:${TOKEN}`, recipient: "bob.testnet", decimals: 6, active: true, revision: 1, changed_at: "0" };
  const view = { state: async () => state, intentsSince: async () => intents, suppliers: async () => [supplier] } as unknown as PolicyView;
  const notifier = new MemoryNotifier();
  const journal = new Journal(null);
  const executor = new Executor(
    { policyId: "policy.testnet", originAsset: `nep141:${TOKEN}`, forgetEveryMs: Number.MAX_SAFE_INTEGER, quietStart },
    {
      view,
      calls: {} as ExecutorClient,
      oneclick: null,
      notifier,
      journal,
      delivered: delivered && { has: (key: string) => delivered.has(key) },
      names: names ? (id: number) => names[id] ?? null : null,
      nowMs: () => now,
    },
  );
  return { executor, notifier, journal, advance: (ms: number) => void (now += ms) };
}

describe("owner notices shared with the bot", () => {
  it("stays quiet about news the bot already gave in the owner's chat", async () => {
    const pending = intent(2, "PENDING", NOW_MS - 60_000);
    const paid = intent(1, "PAID", NOW_MS - 60_000);
    const { executor, notifier, journal } = setup([paid, pending], new Set(["approval:2", `paid:1:${paid.since}`]));
    const report = await executor.tick();
    expect(report.errors).toEqual([]);
    expect(notifier.notices).toEqual([]);
    expect(journal.entries.filter((e) => e.type === "notified").map((e) => [e.key, e.by])).toEqual([
      [`paid:1:${paid.since}`, "intake"],
      ["approval:2", "intake"],
    ]);
    await executor.tick();
    expect(notifier.notices).toEqual([]);
  });

  it("waits out the grace period, then sends what the bot did not", async () => {
    const { executor, notifier, advance } = setup([intent(3, "PENDING", NOW_MS - 1_000), intent(4, "FAILED", NOW_MS - 1_000)], new Set());
    await executor.tick();
    expect(notifier.notices).toEqual([]);
    advance(20_000);
    await executor.tick();
    expect(notifier.kinds()).toEqual(["approval_needed", "payout_failed"]);
    // Plain words, with the owner's own limit; without a directory the supplier is named by its address.
    expect(notifier.notices[0]!.text).toBe(
      "👋 bob.testnet asks for 3.00 USDC. It needs your OK because it is above the 2.50 USDC the agent may pay on its own (payment #3). Review and approve:",
    );
    await executor.tick();
    expect(notifier.notices).toHaveLength(2);
  });

  it("without a shared record, notices go out at once, naming the supplier from the directory", async () => {
    const { executor, notifier } = setup([intent(5, "PENDING", NOW_MS)], null, { 1: "Acme Packaging Ltd" });
    await executor.tick();
    expect(notifier.kinds()).toEqual(["approval_needed"]);
    expect(notifier.notices[0]!.text).toMatch(/^👋 Acme Packaging Ltd asks for 3\.00 USDC\./);
  });

  it("a fresh journal starts quietly: what is already true is recorded, later changes are sent", async () => {
    const paid = intent(1, "PAID", NOW_MS - 3_600_000);
    const intents = [paid, intent(2, "PENDING", NOW_MS - 3_600_000)];
    const { executor, notifier, journal } = setup(intents, null, undefined, true);
    await executor.tick();
    expect(notifier.notices).toEqual([]);
    expect(journal.entries.filter((e) => e.by === "quiet_start").map((e) => e.key)).toEqual([`paid:1:${paid.since}`, "approval:2"]);
    intents.push(intent(3, "PENDING", NOW_MS));
    await executor.tick();
    expect(notifier.notices.map((n) => n.key)).toEqual(["approval:3"]);
  });
});
