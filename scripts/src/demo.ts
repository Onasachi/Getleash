/**
 * Offline end-to-end demo (`pnpm demo:mock`): a local NEAR node, the real v2 contract wasm, the
 * executor, mock-1click and the agent pipeline with the offline invoice reader. Every invoice in
 * fixtures/invoices goes through ingestion → agent → contract (→ executor for cross-chain), and
 * the script checks each outcome against what the README promises. Exit code 1 if any check fails.
 *
 * Nothing here touches mainnet, NEAR AI Cloud or the real 1Click API.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvoiceAgent, InvoiceStore, OfflineExtractor, type AgentOutcome } from "@getleash/agent";
import { startWorld, TRON_RECIPIENT, TRON_USDT, type World } from "@getleash/devkit/world";
import { UpdateLog } from "@getleash/ingestion";
import { ContractCallError, type Directory, fromUnits, type IntentStatus } from "@getleash/shared";

import { REPO_ROOT } from "@getleash/devkit/paths";

const NEW_TRON_WALLET = "TF1Abk71gzu7f9ADmY4iiRYe6fZVuonFTv";
const DAY_NS = 86_400_000_000_000n;
const verbose = process.argv.includes("--verbose");
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

type Expect = {
  status: AgentOutcome["status"];
  /** The intent's status right after the agent's call (native payments within limits are PAID). */
  intent?: IntentStatus;
  reason?: string;
  /** Run the executor until the intent is paid (cross-chain). */
  settles?: boolean;
};

const failures: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? dim(`  (${detail})`) : ""}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

async function until(tick: () => Promise<unknown>, done: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await tick();
    if (await done()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

console.log(bold("GetLeash offline demo: local NEAR node + real v2 contract + executor + mock 1Click + agent\n"));
console.log(dim("Starting a local NEAR node and deploying the contract with the self-custodial setup…"));
const world: World = await startWorld({ log: verbose ? (l) => console.log(dim(l)) : undefined });

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
  const state = await world.view.state();
  const p = state.policy;
  console.log(
    `Policy ${world.policyId}: autonomous budget ${fromUnits(p.autonomous_daily_budget, 6)}/day, approval above ${fromUnits(p.approval_threshold, 6)}, ` +
      `daily cap ${fromUnits(p.daily_cap, 6)}, executor-trust budget ${fromUnits(p.executor_trust_daily_budget, 6)}/day. Treasury: ${fromUnits(await world.balance(), 6)} USDC.\n` +
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
  const refusals: string[] = [];

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
    if (outcome.result?.reason) refusals.push(outcome.result.reason);
    let detail = outcome.status;
    let ok = outcome.status === expect.status;
    if (expect.reason) {
      const reason = outcome.result?.reason ?? outcome.result?.route ?? (outcome.decision && "reason" in outcome.decision ? outcome.decision.reason : null);
      detail += ` ${reason}`;
      ok &&= reason === expect.reason;
    }
    if (expect.intent) {
      detail += ` → intent ${outcome.intentStatus}`;
      ok &&= outcome.intentStatus === expect.intent;
    }
    check(`expected ${expect.status}${expect.reason ? ` ${expect.reason}` : ""}${expect.intent ? ` (${expect.intent})` : ""}`, ok, detail);
    if (expect.intent === "PAID" && outcome.result?.intent_id != null) {
      const i = (await world.view.intent(outcome.result.intent_id))!;
      console.log(`  → contract: paid ${fromUnits(i.value, 6)} USDC to acme.near inside the agent's call (no executor)`);
    }
    if (expect.settles && outcome.result?.intent_id != null) {
      const id = outcome.result.intent_id;
      await settled(id);
    }
    return outcome;
  }

  /** Runs the executor until a cross-chain intent is paid and 1Click reports delivery. */
  async function settled(id: number) {
    const paid = await until(tick, async () => (await world.view.intent(id))?.status === "PAID");
    await until(tick, async () => notifier.notices.some((x) => x.kind === "delivered" && x.intentId === id), 30_000);
    const i = (await world.view.intent(id))!;
    const a = i.attempt;
    if (a) {
      console.log(
        `  → executor: ${fromUnits(a.amount_in, 6)} USDC → 1Click deposit ${a.deposit.slice(0, 10)}… → ${fromUnits(i.amount_out, 6)} USDT to the supplier on Tron` +
          ` (${a.authorized ? "owner-signed" : "executor-trust budget"})`,
      );
    }
    check("paid", paid && i.status === "PAID", i.status);
    check("delivered (1Click SUCCESS)", notifier.notices.some((x) => x.kind === "delivered" && x.intentId === id), "");
  }

  console.log(bold("Act 1: normal operation"));
  await invoice("01-acme-clean.txt", "normal invoice, NEAR supplier", { status: "proposed", intent: "PAID" });
  await invoice("02-shenzhen-clean.txt", "normal invoice, paid in USDT on Tron", { status: "proposed", intent: "APPROVED", settles: true });
  await invoice("01-acme-clean.txt", "the same Telegram update delivered twice", { status: "ignored" }, "demo-1");

  console.log(bold("\nAct 2: duplicates and attacks"));
  await invoice("03-acme-duplicate-reformatted.txt", "same invoice, different layout and number format", { status: "rejected_onchain", reason: "OBLIGATION_OPEN_OR_PAID" });
  await invoice("04-acme-edited-duplicate.txt", "same invoice number, edited total", { status: "rejected_onchain", reason: "OBLIGATION_OPEN_OR_PAID" });
  await invoice("05-poisoned-unknown-supplier.txt", "prompt injection: pay an unknown address", { status: "rejected_onchain", reason: "UNKNOWN_SUPPLIER" });
  const swap = await invoice("06-shenzhen-address-swap.txt", "known supplier, new wallet on the invoice", { status: "proposed", intent: "PENDING", reason: "REVIEW_FLAG" });
  await invoice("08-ngn-invoice.txt", "invoice in naira", { status: "ignored", reason: "UNSUPPORTED_CURRENCY" });
  await invoice("11-no-invoice-number.txt", "no invoice number to deduplicate on", { status: "needs_owner", reason: "NO_RELIABLE_INVOICE_NUMBER" });

  console.log(bold("\nAct 3: the honest one: a fabricated small invoice to a real supplier"));
  await invoice("07-acme-small-fabricated.txt", "fabricated, small, real supplier: within the rules, so it is paid", { status: "proposed", intent: "PAID" });
  await invoice("10-acme-fabricated-burst.txt", "another one, past today's autonomous budget", { status: "proposed", intent: "PENDING", reason: "AUTONOMOUS_BUDGET_USED" });
  await invoice("09-acme-above-threshold.txt", "large and unusual for this supplier", { status: "proposed", intent: "PENDING", reason: "REVIEW_FLAG" });
  const today = (await world.view.state()).budgets;
  console.log(`  autonomous budget today: ${fromUnits(today.autonomous, 6)} of ${fromUnits(p.autonomous_daily_budget, 6)} used; that is the most fabricated invoices can cost per day.`);

  console.log(bold("\nAct 4: address change → cooldown → only an owner-signed test payment"));
  if (swap?.result?.intent_id != null) {
    await world.owner.decide((await world.view.intent(swap.result.intent_id))!, "REJECT");
    console.log(`  owner rejects intent ${swap.result.intent_id} and confirms the new wallet with Shenzhen by phone`);
  }
  await world.owner.setPolicy({ ...p, cooldown_ns: (2n * DAY_NS).toString() });
  await world.owner.updateSupplier({ supplier_id: shenzhen, chain: "TRON", asset_id: TRON_USDT, recipient: NEW_TRON_WALLET, decimals: 6 });
  directory.suppliers[1]!.payment_details = [NEW_TRON_WALLET];
  console.log(`  owner updates supplier #${shenzhen} to ${NEW_TRON_WALLET}: revision bumped, 2-day cooldown starts`);
  const normal = await invoice("12-shenzhen-after-swap.txt", "a normal-size invoice to the new wallet", { status: "proposed", intent: "PENDING", reason: "SUPPLIER_COOLDOWN" });
  if (normal?.result?.intent_id != null) {
    const refused = await world.owner
      .decide((await world.view.intent(normal.result.intent_id))!, "APPROVE")
      .then(() => "approved", (e: unknown) => (e instanceof ContractCallError ? e.code : String(e)));
    check("even the owner cannot approve more than 0.50 to the new wallet during the cooldown", refused === "OVER_COOLDOWN_MAX", refused);
  }
  const test = await invoice("13-shenzhen-test-payment.txt", "a 0.50 test payment", { status: "proposed", intent: "PENDING", reason: "SUPPLIER_COOLDOWN" });
  if (test?.result?.intent_id != null) {
    const id = test.result.intent_id;
    await world.owner.decide((await world.view.intent(id))!, "APPROVE");
    console.log(`  owner approves intent ${id} (the wallet shows amount_out and supplier_id)`);
    await until(tick, async () => (await world.view.intent(id))?.attempt != null);
    await tick();
    const waiting = (await world.view.intent(id))!;
    check("during the cooldown the executor cannot fund without the owner's signature", waiting.status === "APPROVED", waiting.status);
    const a = waiting.attempt!;
    await world.owner.authorize(id, a.deposit, a.amount_in);
    console.log(`  owner signs deposit ${a.deposit.slice(0, 10)}… for ${fromUnits(a.amount_in, 6)} USDC`);
    await settled(id);
  }

  // ── Summary from chain state ─────────────────────────────────────────────────────────────
  const end = await world.view.state();
  const keys = (await world.net.rpc.viewAccessKeyList({ accountId: world.policyId })) as unknown as { keys: unknown[] };
  console.log(bold("\nChain state"));
  console.log(`  treasury ${fromUnits(await world.balance(), 6)} USDC; sent today ${fromUnits(end.budgets.outflow, 6)}; approved by the agent alone ${fromUnits(end.budgets.autonomous, 6)}; stored intents ${end.stored_intents}`);
  console.log(`  refusals (returned to the agent and logged as events, enum codes only): ${refusals.join(", ")}`);
  check(`${world.policyId} has no access keys`, keys.keys.length === 0, `${keys.keys.length} keys`);
  console.log(`  owner notices: ${notifier.notices.length} (${[...new Set(notifier.kinds())].join(", ")})`);
} finally {
  await world.stop();
}

console.log(failures.length === 0 ? bold("\nAll checks passed.") : bold(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`));
process.exit(failures.length === 0 ? 0 : 1);
