/**
 * The executor (PLAN §4.2): deterministic, no LLM. Each `tick()` reads `get_open_work()` (never a
 * forward-only cursor, so a restart loses nothing) and moves every item one or more steps:
 *
 *   Pending intent              → tell the owner (approval link), once.
 *   Approved, no live attempt   → native: create_attempt_native.
 *                                 cross-chain: non-dry EXACT_OUTPUT 1Click quote, sanity-checked
 *                                 against the intent, then create_attempt_crosschain.
 *   Attempt AwaitingOwner       → register the payee, tell the owner (attempt link), once.
 *   Attempt Authorized          → register the payee if needed, fund_native / fund_crosschain
 *                                 (attempt id only), then submit the deposit tx to 1Click.
 *   FundingPending past grace   → flag_reconciliation (a lost callback is never a reason to re-fund).
 *   Cross-chain Funded          → poll /v0/status: SUCCESS → report_delivery (and tell the owner about
 *                                 returned change); REFUNDED/FAILED/INCOMPLETE or no answer past the
 *                                 timeout → flag_reconciliation and tell the owner.
 *
 * The executor never credits funds and never chooses an amount or a destination at funding time;
 * the contract enforces both. Housekeeping (`sweep`, `prune`) runs when needed.
 */
import {
  checkExecutionQuote,
  ContractCallError,
  fromUnits,
  isoToNanos,
  OneClickError,
  routeReason,
  TERMINAL_STATUSES,
  type Attempt,
  type ConfigView,
  type ExecutorClient,
  type Intent,
  type OneClickClient,
  type OpenWorkItem,
  type PolicyView,
  type StatusResponse,
} from "@getleash/shared";

import type { Journal } from "./journal.ts";
import type { Notice, Notifier } from "./notify.ts";

export type ExecutorConfig = {
  policyId: string;
  /** 1Click asset id of the treasury token, e.g. nep141:<usdc contract>. */
  originAsset: string;
  slippageBps: number;
  /** Quote deadline when the attempt will fit the executor-trust budget (funded at once). */
  trustQuoteTtlMs: number;
  /** Quote deadline when the owner must sign the attempt first (contract maximum: 1 day). */
  ownerQuoteTtlMs: number;
  /** Flag a funded cross-chain attempt if 1Click has no terminal status after this long. */
  statusTimeoutMs: number;
  /** Stop retrying an intent after this many failed fundings until the owner looks at it. */
  maxFundingFailures: number;
  pruneEveryMs: number;
  dashboardUrl: string | null;
};

export const DEFAULT_CONFIG: Omit<ExecutorConfig, "policyId" | "originAsset" | "dashboardUrl"> = {
  slippageBps: 50,
  trustQuoteTtlMs: 20 * 60_000,
  ownerQuoteTtlMs: 4 * 3_600_000,
  statusTimeoutMs: 2 * 3_600_000,
  maxFundingFailures: 3,
  pruneEveryMs: 3_600_000,
};

export type ExecutorDeps = {
  view: PolicyView;
  calls: ExecutorClient;
  /** null: cross-chain intents are left alone (native-only deployments). */
  oneclick: OneClickClient | null;
  notifier: Notifier;
  journal: Journal;
  /** Whether an account is storage-registered on the treasury token. */
  isRegistered: (accountId: string) => Promise<boolean>;
  nowMs?: () => number;
  log?: (line: string) => void;
};

export type TickReport = { items: number; actions: string[]; errors: string[] };

const NS_PER_MS = 1_000_000n;

export class Executor {
  private readonly cfg: ExecutorConfig;
  private lastPrune = 0;
  private stopped = false;

  constructor(
    cfg: Partial<ExecutorConfig> & Pick<ExecutorConfig, "policyId" | "originAsset">,
    private readonly deps: ExecutorDeps,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, dashboardUrl: null, ...cfg };
  }

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private log(line: string) {
    this.deps.log?.(`[executor] ${line}`);
  }

  private link(path: string): string | undefined {
    return this.cfg.dashboardUrl ? `${this.cfg.dashboardUrl.replace(/\/$/, "")}${path}` : undefined;
  }

  private async notifyOnce(notice: Notice) {
    if (this.deps.journal.wasNotified(notice.key)) return;
    await this.deps.notifier.notify(notice);
    this.deps.journal.record("notified", { key: notice.key, kind: notice.kind });
  }

  /** Runs ticks until `stop()`. */
  async run(intervalMs = 5_000) {
    this.stopped = false;
    while (!this.stopped) {
      const report = await this.tick();
      for (const error of report.errors) this.log(`error: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop() {
    this.stopped = true;
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { items: 0, actions: [], errors: [] };
    let config: ConfigView;
    let work: OpenWorkItem[];
    try {
      [config, work] = await Promise.all([this.deps.view.config(), this.deps.view.openWork()]);
    } catch (error) {
      report.errors.push(`reading open work: ${(error as Error).message}`);
      return report;
    }
    report.items = work.length;
    if (config.paused) {
      await this.notifyOnce({ key: `paused:${config.next_intent_id}`, kind: "paused", text: "The policy contract is paused: no new attempts or funding." });
    }
    for (const item of work) {
      try {
        await this.handle(item, config, report);
      } catch (error) {
        const code = error instanceof ContractCallError ? error.code : (error as Error).message;
        report.errors.push(`intent ${item.intent.terms.id}: ${code}`);
      }
    }
    await this.housekeeping(work, config, report);
    return report;
  }

  // ── One work item ────────────────────────────────────────────────────────────────────────

  private async handle(item: OpenWorkItem, config: ConfigView, report: TickReport) {
    const { intent } = item;
    let attempt = item.attempt;
    const id = intent.terms.id;
    const nowNs = BigInt(this.now()) * NS_PER_MS;

    if (intent.status === "PENDING") {
      const reason = routeReason(intent.terms.route) ?? "REVIEW";
      await this.notifyOnce({
        key: `approval:${id}`,
        kind: "approval_needed",
        text: `Intent ${id} needs your approval (${reason}): ${intent.terms.amount_out} to supplier ${intent.terms.supplier_id}, max ${fromUnits(intent.terms.max_in, config.treasury_decimals)} from the treasury.`,
        link: this.link(`/approve/${id}`),
        intentId: id,
      });
      return;
    }

    if (intent.status === "APPROVED" && attempt === null) {
      if (config.paused || nowNs >= BigInt(intent.terms.expires_at)) return;
      if (this.deps.journal.failuresFor(id) >= this.cfg.maxFundingFailures) {
        await this.notifyOnce({
          key: `stuck:${id}:${intent.attempt_ids.length}`,
          kind: "funding_failed",
          text: `Intent ${id}: funding failed ${this.deps.journal.failuresFor(id)} times; the executor stopped retrying it. Check the supplier's registration and the attempts.`,
          link: this.link(`/approve/${id}`),
          intentId: id,
        });
        return;
      }
      const created = await this.createAttempt(intent, config, report);
      if (created === null) return;
      attempt = await this.deps.view.attempt(created);
      if (attempt === null) return;
    }
    if (attempt === null) return;

    switch (attempt.status) {
      case "AWAITING_OWNER":
        await this.ensureRegistered(attempt, report);
        await this.notifyOnce({
          key: `sign:${attempt.terms.id}`,
          kind: "attempt_needs_signature",
          text: `Attempt ${attempt.terms.id} (intent ${id}) needs your signature: ${fromUnits(attempt.terms.amount_in, config.treasury_decimals)} to ${attempt.terms.pay_to}${attempt.terms.kind === "CROSS_CHAIN" ? ` for ${attempt.terms.expected_out} ${attempt.terms.destination_asset} to ${attempt.terms.final_recipient}` : ""}.`,
          link: this.link(`/attempt/${attempt.terms.id}`),
          intentId: id,
          attemptId: attempt.terms.id,
        });
        return;
      case "AUTHORIZED":
        if (config.paused) return;
        await this.fund(intent, attempt, config, report);
        return;
      case "FUNDING_PENDING": {
        const fundedAt = BigInt(attempt.funded_at ?? "0");
        if (nowNs >= fundedAt + BigInt(config.policy.reconcile_grace_ns)) {
          await this.deps.calls.flagReconciliation(attempt.terms.id);
          this.deps.journal.record("flagged", { attemptId: attempt.terms.id, why: "callback_lost" });
          report.actions.push(`flag ${attempt.terms.id} (callback lost)`);
          await this.reconciliationNotice(attempt, "the funding callback never completed");
        }
        return;
      }
      case "FUNDED":
        if (attempt.terms.kind === "CROSS_CHAIN") await this.trackDelivery(attempt, config, report);
        return;
      case "NEEDS_RECONCILIATION":
        await this.reconciliationNotice(attempt, "its outcome is unknown");
        return;
      default:
        return;
    }
  }

  private async reconciliationNotice(attempt: Attempt, why: string) {
    await this.notifyOnce({
      key: `reconcile:${attempt.terms.id}`,
      kind: "needs_reconciliation",
      text: `Attempt ${attempt.terms.id} needs reconciliation: ${why}. Check the transfer and resolve it.`,
      link: this.link(`/attempt/${attempt.terms.id}`),
      intentId: attempt.terms.intent_id,
      attemptId: attempt.terms.id,
    });
  }

  private async createAttempt(intent: Intent, config: ConfigView, report: TickReport): Promise<number | null> {
    const id = intent.terms.id;
    if (intent.terms.kind === "NATIVE") {
      const out = await this.deps.calls.createAttemptNative(id);
      this.deps.journal.record("attempt_created", { intentId: id, attemptId: out.value, kind: "NATIVE", tx: out.txHash });
      report.actions.push(`attempt ${out.value} for intent ${id} (native)`);
      return out.value;
    }
    if (!this.deps.oneclick) return null;

    // Owner-signed attempts get a longer quote window so the owner has time to sign.
    const budgets = await this.deps.view.budgetsToday();
    const ownerPath =
      config.hosted_mode || intent.terms.test_payment || BigInt(intent.terms.max_in) > BigInt(budgets.executor_trust.remaining);
    const ttl = ownerPath ? this.cfg.ownerQuoteTtlMs : this.cfg.trustQuoteTtlMs;
    const deadline = new Date(this.now() + ttl).toISOString();
    const quote = await this.deps.oneclick.quote({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.cfg.slippageBps,
      originAsset: this.cfg.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: intent.terms.asset_id,
      amount: intent.terms.amount_out,
      refundTo: this.cfg.policyId,
      refundType: "ORIGIN_CHAIN",
      recipient: intent.terms.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    });
    const problems = checkExecutionQuote(quote, {
      originAsset: this.cfg.originAsset,
      destinationAsset: intent.terms.asset_id,
      recipient: intent.terms.recipient,
      refundTo: this.cfg.policyId,
      amountOut: BigInt(intent.terms.amount_out),
      maxIn: BigInt(intent.terms.max_in),
    });
    if (problems.length > 0) {
      this.deps.journal.record("quote_rejected", { intentId: id, problems });
      await this.notifyOnce({
        key: `quote:${id}:${problems.join("|")}`,
        kind: "quote_rejected",
        text: `Intent ${id}: the 1Click quote was not used (${problems.join("; ")}).`,
        link: this.link(`/approve/${id}`),
        intentId: id,
      });
      return null;
    }
    const out = await this.deps.calls.createAttemptCrosschain({
      intentId: id,
      depositAddress: quote.quote.depositAddress!,
      amountIn: quote.quote.amountIn,
      quoteDeadlineNs: isoToNanos(quote.quoteRequest.deadline),
      // The signature identifies the quote and is echoed by /v0/status (docs/verified-facts.md).
      quoteRef: quote.signature,
    });
    this.deps.journal.record("attempt_created", {
      intentId: id,
      attemptId: out.value,
      kind: "CROSS_CHAIN",
      depositAddress: quote.quote.depositAddress,
      amountIn: quote.quote.amountIn,
      deadline: quote.quoteRequest.deadline,
      tx: out.txHash,
    });
    report.actions.push(`attempt ${out.value} for intent ${id} (cross-chain, ${quote.quote.amountIn} in)`);
    return out.value;
  }

  private async ensureRegistered(attempt: Attempt, report: TickReport) {
    if (await this.deps.isRegistered(attempt.terms.pay_to)) return;
    const out = await this.deps.calls.registerRecipient(attempt.terms.id);
    this.deps.journal.record("registered", { attemptId: attempt.terms.id, payTo: attempt.terms.pay_to, tx: out.txHash });
    report.actions.push(`register ${attempt.terms.pay_to}`);
  }

  private async fund(intent: Intent, attempt: Attempt, config: ConfigView, report: TickReport) {
    const id = attempt.terms.id;
    if (attempt.terms.quote_deadline !== null) {
      const latest = BigInt(attempt.terms.quote_deadline) - BigInt(config.policy.funding_margin_ns);
      if (BigInt(this.now()) * NS_PER_MS > latest) return; // too late; sweep voids it, then we re-quote
    }
    await this.ensureRegistered(attempt, report);
    const out =
      attempt.terms.kind === "NATIVE" ? await this.deps.calls.fundNative(id) : await this.deps.calls.fundCrosschain(id);
    const after = await this.deps.view.attempt(id);
    this.deps.journal.record("funded", { attemptId: id, intentId: intent.terms.id, tx: out.txHash, ok: out.ok, status: after?.status });
    report.actions.push(`fund ${id} → ${after?.status}`);

    if (after?.status === "FAILED") {
      this.deps.journal.record("funding_failed", { intentId: intent.terms.id, attemptId: id, failures: out.failures.map((f) => f.message) });
      return;
    }
    if (after?.status === "DELIVERED") {
      await this.notifyOnce({
        key: `paid:${id}`,
        kind: "paid",
        text: `Paid ${fromUnits(after.terms.amount_in, config.treasury_decimals)} to ${after.terms.pay_to} (intent ${intent.terms.id}).`,
        intentId: intent.terms.id,
        attemptId: id,
      });
    }
    if (attempt.terms.kind === "CROSS_CHAIN" && after?.status === "FUNDED" && this.deps.oneclick) {
      try {
        await this.deps.oneclick.submitDeposit({
          txHash: out.txHash,
          depositAddress: attempt.terms.pay_to,
          nearSenderAccount: this.cfg.policyId,
        });
      } catch (error) {
        this.log(`deposit/submit for attempt ${id} failed (optional): ${(error as Error).message}`);
      }
    }
  }

  private async trackDelivery(attempt: Attempt, config: ConfigView, report: TickReport) {
    if (!this.deps.oneclick) return;
    const id = attempt.terms.id;
    const fundedMs = Number(BigInt(attempt.funded_at ?? "0") / NS_PER_MS);
    const overdue = this.now() - fundedMs > this.cfg.statusTimeoutMs;
    let status: StatusResponse | null = null;
    try {
      status = await this.deps.oneclick.status(attempt.terms.pay_to);
    } catch (error) {
      const what = error instanceof OneClickError ? `HTTP ${error.status}` : (error as Error).message;
      this.deps.journal.record("status_error", { attemptId: id, error: what });
    }

    if (status && status.quoteResponse && status.quoteResponse.signature !== attempt.terms.quote_ref) {
      await this.flag(attempt, report, "1Click reports a different quote for this deposit address");
      return;
    }
    if (status && TERMINAL_STATUSES.has(status.status)) {
      const details = status.swapDetails;
      const returned = BigInt(details.refundedAmount ?? "0");
      if (status.status === "SUCCESS") {
        const delivered = details.amountOut ?? attempt.terms.expected_out;
        const destTx = details.destinationChainTxHashes[0]?.hash ?? "unknown";
        await this.deps.calls.reportDelivery(id, delivered, destTx);
        this.deps.journal.record("delivered", { attemptId: id, delivered, destTx, returned });
        report.actions.push(`delivered ${id}`);
        await this.notifyOnce({
          key: `delivered:${id}`,
          kind: "delivered",
          text: `Delivered ${delivered} ${attempt.terms.destination_asset} to ${attempt.terms.final_recipient} (attempt ${id}, tx ${destTx}).`,
          intentId: attempt.terms.intent_id,
          attemptId: id,
        });
      } else {
        await this.flag(attempt, report, `1Click status ${status.status}${details.refundReason ? ` (${details.refundReason})` : ""}`);
        await this.notifyOnce({
          key: `swap_failed:${id}`,
          kind: "swap_failed",
          text: `Attempt ${id}: the swap ended ${status.status}. Resolve it as SWAP_FAILED, then attribute the returned ${fromUnits(returned, config.treasury_decimals)} to attempt ${id}.`,
          link: this.link(`/attempt/${id}`),
          intentId: attempt.terms.intent_id,
          attemptId: id,
        });
      }
      if (returned > 0n) {
        await this.notifyOnce({
          key: `returned:${id}`,
          kind: "returned_funds",
          text: `1Click returned ${fromUnits(returned, config.treasury_decimals)} to the treasury for attempt ${id}. It stays unreconciled until you attribute it (reconcile page).`,
          link: this.link("/reconcile"),
          intentId: attempt.terms.intent_id,
          attemptId: id,
        });
      }
      return;
    }
    if (overdue) await this.flag(attempt, report, status ? `no result after the timeout (last status ${status.status})` : "1Click unreachable past the timeout");
  }

  private async flag(attempt: Attempt, report: TickReport, why: string) {
    await this.deps.calls.flagReconciliation(attempt.terms.id);
    this.deps.journal.record("flagged", { attemptId: attempt.terms.id, why });
    report.actions.push(`flag ${attempt.terms.id} (${why})`);
    await this.reconciliationNotice(attempt, why);
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────────────────────

  private async housekeeping(work: OpenWorkItem[], config: ConfigView, report: TickReport) {
    const nowNs = BigInt(this.now()) * NS_PER_MS;
    const margin = BigInt(config.policy.funding_margin_ns);
    const needsSweep = work.some(
      ({ intent, attempt }) =>
        ((intent.status === "PENDING" || intent.status === "APPROVED") && nowNs >= BigInt(intent.terms.expires_at)) ||
        (attempt !== null &&
          (attempt.status === "AWAITING_OWNER" || attempt.status === "AUTHORIZED") &&
          attempt.terms.quote_deadline !== null &&
          nowNs + margin > BigInt(attempt.terms.quote_deadline)),
    );
    try {
      if (needsSweep) {
        const out = await this.deps.calls.sweep(20);
        this.deps.journal.record("sweep", { ...out.value });
        report.actions.push(`sweep ${JSON.stringify(out.value)}`);
      }
      if (this.now() - this.lastPrune >= this.cfg.pruneEveryMs) {
        this.lastPrune = this.now();
        const out = await this.deps.calls.prune(20);
        if (out.value > 0) report.actions.push(`prune ${out.value}`);
      }
    } catch (error) {
      report.errors.push(`housekeeping: ${error instanceof ContractCallError ? error.code : (error as Error).message}`);
    }
  }
}
