/**
 * Offline end-to-end demo (`pnpm demo:mock`): a local NEAR node, the real contract wasm, the
 * executor, mock-1click and the agent pipeline with the offline invoice reader. Every invoice in
 * fixtures/invoices goes through ingestion → agent → contract → executor, and the script checks
 * each outcome against what the README promises. Exit code 1 if any check fails.
 *
 * Nothing here touches mainnet, NEAR AI Cloud or the real 1Click API.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvoiceAgent, InvoiceStore, OfflineExtractor, type AgentOutcome } from "@getleash/agent";
import { startWorld, TRON_RECIPIENT, TRON_USDT, USDC, type World } from "@getleash/devkit/world";
import { UpdateLog } from "@getleash/ingestion";
import { type Directory, fromUnits, type IntentStatus, routeReason } from "@getleash/shared";

import { REPO_ROOT } from "@getleash/devkit/paths";

const NEW_TRON_WALLET = "TF1Abk71gzu7f9ADmY4iiRYe6fZVuonFTv";
const verbose = process.argv.includes("--verbose");
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

type Expect = {
  status: AgentOutcome["status"];
  intent?: IntentStatus;
  reason?: string;
  settles?: IntentStatus;
};

const failures: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? dim(`  (${detail})`) : ""}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

async function settle(world: World, tick: () => Promise<unknown>, intentId: number, until: IntentStatus[], timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await tick();
    const intent = await world.view.intent(intentId);
    if (intent && until.includes(intent.status)) return intent;
    await new Promise((r) => setTimeout(r, 300));
  }
  return world.view.intent(intentId);
}

console.log(bold("GetLeash offline demo: local NEAR node + real contract + executor + mock 1Click + agent\n"));
console.log(dim("Starting a local NEAR node and deploying the contract with the self-custodial setup…"));
const world = await startWorld({ log: verbose ? (l) => console.log(dim(l)) : undefined });

try {
  // ── Suppliers and the private directory ───────────────────────────────────────────────────
  const acme = await world.addSupplier({ chain: "NEAR", recipient: "acme.near", register: true });
  const shenzhen = await world.addSupplier({ chain: "TRON", recipient: TRON_RECIPIENT, assetId: TRON_USDT });
  const directory: Directory = {
    suppliers: [
      { supplier_id: acme, name: "Acme Packaging Ltd", aliases: ["Acme Packaging"], payment_details: ["acme.near"], typical_amount: "18", currency: "USD" },
      { supplier_id: shenzhen, name: "Shenzhen Parts Co.", aliases: [], payment_details: [TRON_RECIPIENT], typical_amount: "2", currency: "USDT" },
    ],
  };
  const policy = await world.view.policy();
  console.log(
    `Policy ${world.policyId}: autonomous budget ${fromUnits(policy.autonomous_daily_budget, 6)}/day, approval above ${fromUnits(policy.approval_threshold, 6)}, ` +
      `executor-trust budget ${fromUnits(policy.executor_trust_daily_budget, 6)}/day. Treasury: ${fromUnits((await world.view.ledger()).cash, 6)} USDC.\n` +
      `Suppliers: #${acme} Acme Packaging (NEAR, acme.near), #${shenzhen} Shenzhen Parts (USDT on Tron, ${TRON_RECIPIENT}).\n`,
  );

  const work = mkdtempSync(join(tmpdir(), "getleash-demo-"));
  const updates = new UpdateLog(join(work, "updates.log"));
  const agent = new InvoiceAgent({
    extractor: new OfflineExtractor(),
    view: world.view,
    agent: world.agent,
    tenantSecret: randomBytes(32),
    directory: () => directory,
    store: new InvoiceStore(join(work, "invoices"), randomBytes(32)),
    dashboardUrl: "http://localhost:3000",
  });
  const { executor, notifier } = world.makeExecutor({ dashboardUrl: "http://localhost:3000" });
  const tick = () => executor.tick();

  let n = 0;
  async function invoice(file: string, says: string, expect: Expect, updateKey?: string) {
    n += 1;
    const key = updateKey ?? `demo-${n}`;
    console.log(`${bold(`${String(n).padStart(2)}. ${file}`)}  ${dim(says)}`);
    if (!updates.claim(key)) {
      console.log(`  → update ${key} was already processed: ignored before any processing`);
      check("replayed update produces nothing", expect.status === "ignored", "");
      return null;
    }
    const text = readFileSync(join(REPO_ROOT, "fixtures/invoices", file), "utf8");
    const outcome = await agent.process({ key, source: "demo", receivedAt: new Date().toISOString(), text, files: [] });
    console.log(`  → agent: ${outcome.summary}${outcome.decision && "flags" in outcome.decision && outcome.decision.flags.length ? `; flags ${outcome.decision.flags.join(", ")}` : ""}`);
    console.log(dim(`    badge: ${outcome.badge} · model: ${outcome.model}`));
    let detail = outcome.status;
    let ok = outcome.status === expect.status;
    if (expect.reason) {
      const reason =
        outcome.result?.reason ??
        (outcome.result?.route ? routeReason(outcome.result.route) : null) ??
        (outcome.decision && "reason" in outcome.decision ? outcome.decision.reason : null);
      detail += ` ${reason}`;
      ok &&= reason === expect.reason;
    }
    if (expect.intent) {
      detail += ` → intent ${outcome.result?.status}`;
      ok &&= outcome.result?.status === expect.intent;
    }
    check(`expected ${expect.status}${expect.reason ? ` ${expect.reason}` : ""}${expect.intent ? ` (${expect.intent})` : ""}`, ok, detail);
    if (expect.settles && outcome.result?.intent_id != null) {
      const intent = await settle(world, tick, outcome.result.intent_id, [expect.settles]);
      const attempt = intent?.attempt_ids.length ? await world.view.attempt(intent.attempt_ids.at(-1)!) : null;
      const how = attempt
        ? attempt.terms.kind === "NATIVE"
          ? `paid ${fromUnits(attempt.terms.amount_in, 6)} USDC to ${attempt.terms.pay_to}`
          : `${fromUnits(attempt.terms.amount_in, 6)} USDC → 1Click → ${fromUnits(attempt.delivered_amount ?? "0", 6)} USDT to ${attempt.terms.final_recipient} (${attempt.authorization}, Tron tx ${attempt.dest_tx?.slice(0, 12)}…)`
        : "";
      console.log(`  → executor: ${how}`);
      check(`settles ${expect.settles}`, intent?.status === expect.settles, `${intent?.status}`);
    }
    return outcome;
  }

  console.log(bold("Act 1: normal operation"));
  await invoice("01-acme-clean.txt", "normal invoice, NEAR supplier", { status: "proposed", intent: "APPROVED", settles: "DONE" });
  await invoice("02-shenzhen-clean.txt", "normal invoice, paid in USDT on Tron", { status: "proposed", intent: "APPROVED", settles: "DONE" });
  await invoice("01-acme-clean.txt", "the same Telegram update delivered twice", { status: "ignored" }, "demo-1");

  console.log(bold("\nAct 2: duplicates and attacks"));
  await invoice("03-acme-duplicate-reformatted.txt", "same invoice, different layout and number format", { status: "rejected_onchain", reason: "OBLIGATION_OPEN_OR_PAID" });
  await invoice("04-acme-edited-duplicate.txt", "same invoice number, edited total", { status: "rejected_onchain", reason: "OBLIGATION_OPEN_OR_PAID" });
  await invoice("05-poisoned-unknown-supplier.txt", "prompt injection: pay an unknown address", { status: "rejected_onchain", reason: "UNKNOWN_SUPPLIER" });
  const swap = await invoice("06-shenzhen-address-swap.txt", "known supplier, new wallet on the invoice", { status: "proposed", intent: "PENDING", reason: "REVIEW_FLAG" });
  await invoice("08-ngn-invoice.txt", "invoice in naira", { status: "ignored", reason: "UNSUPPORTED_CURRENCY" });
  await invoice("11-no-invoice-number.txt", "no invoice number to deduplicate on", { status: "needs_owner", reason: "NO_RELIABLE_INVOICE_NUMBER" });

  console.log(bold("\nAct 3: the honest one: a fabricated small invoice to a real supplier"));
  await invoice("07-acme-small-fabricated.txt", "fabricated, small, real supplier: within the rules, so it is paid", { status: "proposed", intent: "APPROVED", settles: "DONE" });
  await invoice("10-acme-fabricated-burst.txt", "another one, past today's autonomous budget", { status: "proposed", intent: "PENDING", reason: "AUTONOMOUS_BUDGET_USED" });
  await invoice("09-acme-above-threshold.txt", "large and unusual for this supplier", { status: "proposed", intent: "PENDING", reason: "REVIEW_FLAG" });
  const budgets = await world.view.budgetsToday();
  console.log(`  autonomous budget today: ${fromUnits(budgets.autonomous.used, 6)} of ${fromUnits(budgets.autonomous.limit, 6)} used; that is the most fabricated invoices can cost per day.`);

  console.log(bold("\nAct 4: address change → cooldown → owner-signed test payment only"));
  if (swap?.result?.intent_id != null) {
    await world.owner.reject(swap.result.intent_id);
    console.log(`  owner rejects intent ${swap.result.intent_id} and confirms the new wallet with Shenzhen by phone`);
  }
  await world.owner.setPolicy({ ...policy, new_supplier_cooldown_ns: (2n * 86_400n * 1_000_000_000n).toString() });
  await world.owner.updateSupplier(shenzhen, "TRON", TRON_USDT, NEW_TRON_WALLET);
  directory.suppliers[1]!.payment_details = [NEW_TRON_WALLET];
  console.log(`  owner updates supplier #${shenzhen} to ${NEW_TRON_WALLET}: revision bumped, 2-day cooldown starts`);
  await invoice("12-shenzhen-after-swap.txt", "a normal-size invoice to the new wallet", { status: "rejected_onchain", reason: "SUPPLIER_COOLDOWN" });
  const test = await invoice("13-shenzhen-test-payment.txt", "a 0.50 test payment", { status: "proposed", intent: "PENDING", reason: "TEST_PAYMENT" });
  if (test?.result?.intent_id != null) {
    const id = test.result.intent_id;
    const intent = (await world.view.intent(id))!;
    await world.owner.approve(id, intent.intent_hash);
    console.log(`  owner approves intent ${id} (bound to its hash ${intent.intent_hash.slice(0, 12)}…)`);
    let attempt = null;
    for (let i = 0; i < 40 && attempt?.status !== "AWAITING_OWNER"; i++) {
      await tick();
      const live = (await world.view.intent(id))!.live_attempt;
      attempt = live === null ? null : await world.view.attempt(live);
    }
    check("the test payment's attempt waits for the owner's signature", attempt?.status === "AWAITING_OWNER", `${attempt?.status}`);
    if (attempt) {
      await world.owner.authorizeAttempt(attempt.terms.id, attempt.attempt_hash);
      console.log(`  owner signs attempt ${attempt.terms.id} (${attempt.attempt_hash.slice(0, 12)}…)`);
      const done = await settle(world, tick, id, ["DONE"]);
      check("test payment delivered", done?.status === "DONE", `${done?.status}`);
    }
  }

  // ── Summary from chain state ─────────────────────────────────────────────────────────────
  const ledger = await world.view.ledger();
  const rejections = await world.view.recentRejections();
  const keys = (await world.net.rpc.viewAccessKeyList({ accountId: world.policyId })) as unknown as { keys: unknown[] };
  console.log(bold("\nChain state"));
  console.log(`  ledger: cash ${fromUnits(ledger.cash, 6)}, reserved ${fromUnits(ledger.reserved, 6)}, in flight ${fromUnits(ledger.in_flight, 6)}, charged ${fromUnits(ledger.total_charged, 6)}`);
  console.log(`  unreconciled inflow: ${fromUnits(await world.unreconciled(), 6)}`);
  console.log(`  rejections on-chain (enum codes only): ${rejections.map((r) => r.reason).join(", ")}`);
  check(`${world.policyId} has no access keys`, keys.keys.length === 0, `${keys.keys.length} keys`);
  console.log(`  owner notices: ${notifier.notices.length} (${[...new Set(notifier.kinds())].join(", ")})`);
  void USDC;
} finally {
  await world.stop();
}

console.log(failures.length === 0 ? bold("\nAll checks passed.") : bold(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`));
process.exit(failures.length === 0 ? 0 : 1);
