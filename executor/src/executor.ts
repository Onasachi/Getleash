/**
 * The executor (PLAN §4.2; v2, docs/decisions.md D-28): deterministic, no LLM, and only for
 * cross-chain payouts. Native payouts never reach it: the contract pays them in the call that
 * approves them. Each `tick()` reads the contract state and every stored intent from a low-water
 * mark (the oldest id still stored, kept in the journal), so a restart or an owner RETRY never
 * loses an intent:
 *
 *   PENDING                       → tell the owner (approval link), once. With `delivered`, this and
 *                                   the PAID/FAILED notices of native payouts wait `intakeGraceMs`
 *                                   and are skipped if the bot already said it in the owner's chat.
 *   APPROVED, no usable attempt   → non-dry EXACT_OUTPUT 1Click quote, sanity-checked against the
 *                                   intent and supplier, then create_attempt.
 *   APPROVED with an attempt      → fund (intent id only) if the owner authorized it, or if it fits
 *                                   today's trust budget at the current executor epoch outside the
 *                                   cooldown; otherwise ask the owner to authorize it, once.
 *   PAYING past the grace time    → tell the owner the callback never came back, once.
 *   PAID cross-chain              → poll 1Click until terminal; tell the owner how it ended (a
 *                                   refund lands back in the treasury; the owner may RETRY).
 *   FAILED                        → tell the owner, once (only the owner retries).
 *   Hourly                        → forget closed intents past retention and never-funded expired
 *                                   or stale ones (frees storage and their invoices).
 *
 * The executor never chooses an amount or an address at funding time; the contract enforces both.
 */
import {
  checkExecutionQuote,
  ContractCallError,
  fromUnits,
  isExpired,
  isNative,
  isoToNanos,
  OneClickError,
  TERMINAL_STATUSES,
  type ExecutorClient,
  type Intent,
  type OneClickClient,
  type PolicyView,
  type StateView,
  type StatusResponse,
  type Supplier,
} from "@getleash/shared";
import { type DeliveredNotices, noticeKey } from "@getleash/shared/node";

import type { Journal } from "./journal.ts";
import type { Notice, Notifier } from "./notify.ts";

export type ExecutorConfig = {
  policyId: string;
  /** 1Click asset id of the treasury token, e.g. nep141:<usdc contract>. */
  originAsset: string;
  slippageBps: number;
  /** Quote deadline when the attempt can be funded from the trust budget at once. */
  trustQuoteTtlMs: number;
  /** Quote deadline when the owner must authorize the attempt first (contract maximum: 1 day). */
  ownerQuoteTtlMs: number;
  /** Tell the owner if a funded swap has no terminal 1Click status after this long. */
  statusTimeoutMs: number;
  /** Stop re-quoting an intent after this many failed quotes or fundings until the owner looks. */
  maxFundingFailures: number;
  forgetEveryMs: number;
  /**
   * With `delivered`: how long after an intent's status changed to hold back a notice the bot may
   * already have sent in the owner's chat (its approval request or payment result).
   */
  intakeGraceMs: number;
  dashboardUrl: string | null;
};

export const DEFAULT_CONFIG: Omit<ExecutorConfig, "policyId" | "originAsset" | "dashboardUrl"> = {
  slippageBps: 50,
  trustQuoteTtlMs: 20 * 60_000,
  ownerQuoteTtlMs: 4 * 3_600_000,
  statusTimeoutMs: 2 * 3_600_000,
  maxFundingFailures: 3,
  forgetEveryMs: 3_600_000,
  intakeGraceMs: 20_000,
};

export type ExecutorDeps = {
  view: PolicyView;
  calls: ExecutorClient;
  /** null: cross-chain intents are left alone (native-only deployments). */
  oneclick: OneClickClient | null;
  notifier: Notifier;
  journal: Journal;
  /** Notices another service already gave the owner (the bot, replying in the owner's chat). */
  delivered?: Pick<DeliveredNotices, "has"> | null;
  nowMs?: () => number;
  log?: (line: string) => void;
};

export type TickReport = { items: number; actions: string[]; errors: string[] };

const NS_PER_MS = 1_000_000n;
const MAX_FORGET = 20;

export class Executor {
  private readonly cfg: ExecutorConfig;
  private lastForget = 0;
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

  private nowNs(): bigint {
    return BigInt(this.now()) * NS_PER_MS;
  }

  private log(line: string) {
    this.deps.log?.(`[executor] ${line}`);
  }

  private link(path: string): string | undefined {
    return this.cfg.dashboardUrl ? `${this.cfg.dashboardUrl.replace(/\/$/, "")}${path}` : undefined;
  }

  private async notifyOnce(notice: Notice) {
    if (this.deps.journal.wasNotified(notice.key)) return;
    if (this.deps.delivered?.has(notice.key)) {
      this.deps.journal.record("notified", { key: notice.key, kind: notice.kind, by: "intake" });
      return;
    }
    await this.deps.notifier.notify(notice);
    this.deps.journal.record("notified", { key: notice.key, kind: notice.kind });
  }

  /** False while the bot may still be replying in the owner's chat about this intent's new status. */
  private intakeSettled(intent: Intent): boolean {
    if (!this.deps.delivered) return true;
    return this.nowNs() >= BigInt(intent.since) + BigInt(this.cfg.intakeGraceMs) * NS_PER_MS;
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
    let state: StateView;
    let intents: Intent[];
    let suppliers: Map<number, Supplier>;
    try {
      state = await this.deps.view.state();
      const from = Math.min(this.deps.journal.scanFrom(), state.next_intent_id);
      [intents, suppliers] = await Promise.all([
        this.deps.view.intentsSince(from, state.next_intent_id),
        this.deps.view.suppliers().then((list) => new Map(list.map((s) => [s.id, s]))),
      ]);
    } catch (error) {
      report.errors.push(`reading the contract: ${(error as Error).message}`);
      return report;
    }
    // Everything below the oldest stored id is gone for good; start there next time.
    const oldest = intents[0]?.id ?? state.next_intent_id;
    if (oldest !== this.deps.journal.scanFrom()) this.deps.journal.record("scan_from", { id: oldest });
    report.items = intents.length;
    if (state.paused) {
      await this.notifyOnce({ key: `paused:${state.next_intent_id}`, kind: "paused", text: "The policy contract is paused: no payouts until you unpause it." });
    }
    for (const intent of intents) {
      const supplier = suppliers.get(intent.supplier_id);
      if (!supplier) continue;
      try {
        await this.handle(intent, supplier, state, report);
      } catch (error) {
        const code = error instanceof ContractCallError ? error.code : (error as Error).message;
        report.errors.push(`intent ${intent.id}: ${code}`);
      }
    }
    await this.housekeeping(intents, suppliers, state, report);
    return report;
  }

  // ── One intent ───────────────────────────────────────────────────────────────────────────

  private async handle(intent: Intent, supplier: Supplier, state: StateView, report: TickReport) {
    const id = intent.id;
    const native = isNative(supplier, state.token_id);
    const d = state.token_decimals;
    switch (intent.status) {
      case "PENDING":
        if (!this.intakeSettled(intent)) return;
        await this.notifyOnce({
          key: noticeKey.approval(id),
          kind: "approval_needed",
          text: `Intent ${id} needs your approval (${intent.route}): ${fromUnits(intent.value, d)} to supplier ${intent.supplier_id}${native ? "" : `, up to ${fromUnits(intent.max_in, d)} from the treasury`}.`,
          link: this.link(`/intent/${id}`),
          intentId: id,
        });
        return;
      case "APPROVED":
        if (!native) await this.crossChain(intent, supplier, state, report);
        return;
      case "PAYING":
        if (this.nowNs() >= BigInt(intent.since) + BigInt(state.policy.callback_grace_ns)) {
          await this.notifyOnce({
            key: `overdue:${id}:${intent.since}`,
            kind: "callback_overdue",
            text: `Intent ${id}: the transfer's callback has not come back. Check the transfer on the explorer, then mark the payment paid or failed.`,
            link: this.link(`/intent/${id}`),
            intentId: id,
          });
        }
        return;
      case "PAID":
        if (native || intent.attempt === null) {
          if (!this.intakeSettled(intent)) return;
          await this.notifyOnce({
            key: noticeKey.paid(id, intent.since),
            kind: "paid",
            text: `Paid ${fromUnits(intent.value, d)} to ${supplier.recipient} (intent ${id}).`,
            intentId: id,
          });
        } else {
          await this.trackSwap(intent, supplier, state, report);
        }
        return;
      case "FAILED":
        if (!this.intakeSettled(intent)) return;
        await this.notifyOnce({
          key: noticeKey.failed(id, intent.since),
          kind: "payout_failed",
          text: `Intent ${id}: the treasury token refused the transfer, so nothing left the treasury. Fix the cause (e.g. register the payee on USDC), then retry.`,
          link: this.link(`/intent/${id}`),
          intentId: id,
        });
        return;
      default:
        return;
    }
  }

  private async crossChain(intent: Intent, supplier: Supplier, state: StateView, report: TickReport) {
    if (state.paused || !this.deps.oneclick) return;
    const nowNs = this.nowNs();
    if (isExpired(intent, state.policy, nowNs) || supplier.revision !== intent.revision || !supplier.active) return;
    const id = intent.id;
    const margin = BigInt(state.policy.funding_margin_ns);
    const attempt = intent.attempt;
    const usable = attempt !== null && nowNs + margin <= BigInt(attempt.deadline);
    if (!usable) {
      if (this.deps.journal.failuresFor(id) >= this.cfg.maxFundingFailures) {
        await this.notifyOnce({
          key: `stuck:${id}:${this.deps.journal.failuresFor(id)}`,
          kind: "funding_failed",
          text: `Intent ${id}: quoting or funding failed ${this.deps.journal.failuresFor(id)} times; the executor stopped retrying it.`,
          link: this.link(`/intent/${id}`),
          intentId: id,
        });
        return;
      }
      await this.createAttempt(intent, supplier, state, report);
      return;
    }
    const trustOk =
      attempt.epoch === state.executor_epoch &&
      nowNs >= BigInt(supplier.changed_at) + BigInt(state.policy.cooldown_ns) &&
      BigInt(state.budgets.trust) + BigInt(attempt.amount_in) <= BigInt(state.policy.executor_trust_daily_budget);
    if (attempt.authorized || trustOk) {
      await this.fund(intent, report);
      return;
    }
    await this.notifyOnce({
      key: `authorize:${id}:${attempt.deposit}`,
      kind: "authorization_needed",
      text: `Intent ${id} needs your signature: ${fromUnits(attempt.amount_in, state.token_decimals)} USDC to the 1Click deposit ${attempt.deposit} for ${intent.amount_out} of ${supplier.asset_id} to ${supplier.recipient}.`,
      link: this.link(`/intent/${id}`),
      intentId: id,
    });
  }

  private async createAttempt(intent: Intent, supplier: Supplier, state: StateView, report: TickReport) {
    const id = intent.id;
    // Owner-signed attempts get a longer quote window so the owner has time to sign.
    const trustLeft = BigInt(state.policy.executor_trust_daily_budget) - BigInt(state.budgets.trust);
    const inCooldown = this.nowNs() < BigInt(supplier.changed_at) + BigInt(state.policy.cooldown_ns);
    const ownerPath = inCooldown || BigInt(intent.max_in) > trustLeft;
    const deadline = new Date(this.now() + (ownerPath ? this.cfg.ownerQuoteTtlMs : this.cfg.trustQuoteTtlMs)).toISOString();
    const quote = await this.deps.oneclick!.quote({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.cfg.slippageBps,
      originAsset: this.cfg.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: supplier.asset_id,
      amount: intent.amount_out,
      refundTo: this.cfg.policyId,
      refundType: "ORIGIN_CHAIN",
      recipient: supplier.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    });
    const problems = checkExecutionQuote(quote, {
      originAsset: this.cfg.originAsset,
      destinationAsset: supplier.asset_id,
      recipient: supplier.recipient,
      refundTo: this.cfg.policyId,
      amountOut: BigInt(intent.amount_out),
      maxIn: BigInt(intent.max_in),
    });
    if (problems.length > 0) {
      this.deps.journal.record("funding_failed", { intentId: id, why: "quote_rejected", problems });
      await this.notifyOnce({
        key: `quote:${id}:${problems.join("|")}`,
        kind: "quote_rejected",
        text: `Intent ${id}: the 1Click quote was not used (${problems.join("; ")}).`,
        link: this.link(`/intent/${id}`),
        intentId: id,
      });
      return;
    }
    const out = await this.deps.calls.createAttempt({
      intentId: id,
      depositAddress: quote.quote.depositAddress!,
      amountIn: BigInt(quote.quote.amountIn),
      deadlineNs: isoToNanos(quote.quoteRequest.deadline),
    });
    this.deps.journal.record("attempt_created", {
      intentId: id,
      depositAddress: quote.quote.depositAddress,
      amountIn: quote.quote.amountIn,
      deadline: quote.quoteRequest.deadline,
      signature: quote.signature,
      tx: out.txHash,
    });
    report.actions.push(`attempt for intent ${id} (${quote.quote.amountIn} in)`);
  }

  private async fund(intent: Intent, report: TickReport) {
    const id = intent.id;
    const out = await this.deps.calls.fund(id);
    const after = await this.deps.view.intent(id);
    this.deps.journal.record("funded", { intentId: id, tx: out.txHash, ok: out.ok, status: after?.status });
    report.actions.push(`fund ${id} → ${after?.status}`);
    if (after?.status === "FAILED") {
      this.deps.journal.record("funding_failed", { intentId: id, why: "transfer_refused", failures: out.failures.map((f) => f.message) });
      return;
    }
    if (after?.status === "PAID" && intent.attempt && this.deps.oneclick) {
      try {
        await this.deps.oneclick.submitDeposit({ txHash: out.txHash, depositAddress: intent.attempt.deposit, nearSenderAccount: this.cfg.policyId });
      } catch (error) {
        this.log(`deposit/submit for intent ${id} failed (optional): ${(error as Error).message}`);
      }
    }
  }

  private async trackSwap(intent: Intent, supplier: Supplier, state: StateView, report: TickReport) {
    const attempt = intent.attempt!;
    const payout = `${intent.id}:${intent.since}`;
    if (!this.deps.oneclick || this.deps.journal.swapEnded(payout)) return;
    let status: StatusResponse | null = null;
    try {
      status = await this.deps.oneclick.status(attempt.deposit);
    } catch (error) {
      const what = error instanceof OneClickError ? `HTTP ${error.status}` : (error as Error).message;
      this.deps.journal.record("status_error", { intentId: intent.id, error: what });
    }
    const d = state.token_decimals;
    if (status && TERMINAL_STATUSES.has(status.status)) {
      const details = status.swapDetails;
      const returned = BigInt(details.refundedAmount ?? "0");
      this.deps.journal.record("swap_ended", { payout, status: status.status, returned: returned.toString() });
      if (status.status === "SUCCESS") {
        const delivered = details.amountOut ?? intent.amount_out;
        const destTx = details.destinationChainTxHashes[0]?.hash ?? "unknown";
        report.actions.push(`delivered ${intent.id}`);
        await this.notifyOnce({
          key: `delivered:${payout}`,
          kind: "delivered",
          text: `Delivered ${delivered} of ${supplier.asset_id} to ${supplier.recipient} (intent ${intent.id}, tx ${destTx})${returned > 0n ? `; ${fromUnits(returned, d)} USDC change came back to the treasury` : ""}.`,
          intentId: intent.id,
        });
      } else {
        report.actions.push(`swap ${intent.id} ended ${status.status}`);
        await this.notifyOnce({
          key: `swap:${payout}`,
          kind: "swap_failed",
          text: `Intent ${intent.id}: the swap ended ${status.status}${details.refundReason ? ` (${details.refundReason})` : ""}; ${fromUnits(returned, d)} USDC came back to the treasury. Budgets are not given back; retry the intent to pay it again.`,
          link: this.link(`/intent/${intent.id}`),
          intentId: intent.id,
        });
      }
      return;
    }
    const sinceMs = Number(BigInt(intent.since) / NS_PER_MS);
    if (this.now() - sinceMs > this.cfg.statusTimeoutMs) {
      await this.notifyOnce({
        key: `swap_timeout:${payout}`,
        kind: "swap_failed",
        text: `Intent ${intent.id}: no result from 1Click after the timeout (${status ? `last status ${status.status}` : "unreachable"}). Check the deposit ${attempt.deposit}.`,
        link: this.link(`/intent/${intent.id}`),
        intentId: intent.id,
      });
    }
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────────────────────

  private async housekeeping(intents: Intent[], suppliers: Map<number, Supplier>, state: StateView, report: TickReport) {
    if (this.now() - this.lastForget < this.cfg.forgetEveryMs) return;
    this.lastForget = this.now();
    const nowNs = this.nowNs();
    const retention = BigInt(state.policy.retention_ns);
    const ids = intents
      .filter((i) => {
        const stale = suppliers.get(i.supplier_id)?.revision !== i.revision;
        if (i.status === "PAID" || i.status === "REJECTED") return nowNs >= BigInt(i.since) + retention;
        if (i.status === "PENDING" || i.status === "APPROVED") return isExpired(i, state.policy, nowNs) || stale;
        if (i.status === "FAILED") return nowNs > BigInt(i.since) + BigInt(state.policy.intent_ttl_ns) || stale;
        return false;
      })
      .map((i) => i.id)
      .slice(0, MAX_FORGET);
    if (ids.length === 0) return;
    try {
      const out = await this.deps.calls.forget(ids);
      this.deps.journal.record("forgot", { ids, removed: out.value });
      report.actions.push(`forget ${out.value}`);
    } catch (error) {
      report.errors.push(`forget: ${error instanceof ContractCallError ? error.code : (error as Error).message}`);
    }
  }
}
