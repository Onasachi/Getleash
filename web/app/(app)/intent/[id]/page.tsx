"use client";

/**
 * One payment (an intent; PLAN §4.5, docs/decisions.md D-28), written for the owner: who gets what,
 * why it waits, and one button. Everything is read from the chain in this browser, and the safety
 * checks run before any button works. Every action repeats the exact terms the wallet shows:
 * `decide` repeats amount_out and supplier_id; `authorize` names the exact 1Click deposit and
 * amount. For a cross-chain payment this browser fetches 1Click's own record of the deposit address
 * and compares it, field by field, with what the contract committed; any mismatch disables signing.
 * The raw terms are under "Technical details". While someone else is working (the executor quoting
 * or sending, 1Click delivering), the page refreshes itself.
 *
 * Layout (Claude Design, stage 3): one decision in the hero; the recipient in its own block, in full, with
 * the network and payment number; progress as a vertical list; on desktop, progress and the checks in a
 * side column.
 */
import Link from "next/link";
import { type ReactNode, use, useEffect, useState } from "react";

import {
  assetName,
  flagText,
  type Intent,
  isExpired,
  isNative,
  isoToNanos,
  money,
  type OwnerAction,
  paymentState,
  REVIEW_FLAGS,
  shortAddress,
  type StatusResponse,
  TERMINAL_STATUSES,
  waitReason,
} from "@getleash/shared";

import { BackIcon, CheckIcon, ClockIcon, CrossIcon, ExternalIcon, RefreshIcon, WalletIcon, WarningIcon } from "@/components/icons";
import { Check, Fold, Ident, Loading, Notice, Progress, Row, StatusChip, type Step, TerminalOption, TxNote, Waiting } from "@/components/ui";
import { oneclick, policy } from "@/lib/chain";
import { nearCliCommand } from "@/lib/cli";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { nsToDate, untilText, whenText } from "@/lib/format";
import { useSupplierNames } from "@/lib/names";
import { useOwnerAction } from "@/lib/owner-action";
import { useChain } from "@/lib/use-chain";

async function load(intentId: number) {
  const intent = await policy.intent(intentId);
  if (!intent) throw new Error(`Payment #${intentId} was not found. It may have been cleared after the retention period.`);
  const [state, supplier, recent] = await Promise.all([policy.state(), policy.supplier(intent.supplier_id), policy.recentIntents(50)]);
  let status: StatusResponse | null = null;
  let statusError: string | null = null;
  if (intent.attempt) {
    try {
      status = await oneclick.status(intent.attempt.deposit);
    } catch (e) {
      statusError = (e as Error).message;
    }
  }
  const reused = intent.attempt ? recent.filter((i) => i.id !== intent.id && i.attempt?.deposit === intent.attempt!.deposit).map((i) => i.id) : [];
  return { intent, state, supplier, status, statusError, reused };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** True while the next step is someone else's: the executor quoting or sending, 1Click delivering. */
function othersAreWorking({ intent, supplier, state, status }: Loaded): boolean {
  const native = !!supplier && isNative(supplier, state.token_id);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const a = intent.attempt;
  switch (intent.status) {
    case "PAYING":
      return true;
    case "APPROVED":
      return !native && (!a || a.authorized || nowNs + BigInt(state.policy.funding_margin_ns) > BigInt(a.deadline));
    case "PAID":
      return !native && (!status || !TERMINAL_STATUSES.has(status.status));
    default:
      return false;
  }
}

function progress(intent: Intent, native: boolean, status: StatusResponse | null): Step[] {
  const s = intent.status;
  const a = intent.attempt;
  const first: Step = { label: "Invoice received", state: "done" };
  if (s === "REJECTED") return [first, { label: "Rejected", state: "bad" }];
  const steps: Step[] = [
    first,
    intent.route === "AUTONOMOUS" ? { label: "Within the agent's limits", state: "done" } : { label: "Your OK", state: s === "PENDING" ? "current" : "done" },
  ];
  if (native) {
    steps.push(s === "FAILED" ? { label: "Didn't go through", state: "bad" } : { label: "Paid", state: s === "PAID" ? "done" : s === "PAYING" ? "current" : "todo" });
    return steps;
  }
  const sent = s === "PAYING" || s === "PAID";
  const swap = status?.status;
  const ended = !!swap && TERMINAL_STATUSES.has(swap);
  steps.push(
    { label: "Quote", state: a || sent ? "done" : s === "APPROVED" ? "current" : "todo" },
    sent && a && !a.authorized
      ? { label: "Within the executor's allowance", state: "done" }
      : { label: "Your confirmation", state: a?.authorized || sent ? "done" : s === "APPROVED" && a ? "current" : "todo" },
    s === "FAILED" ? { label: "Didn't go through", state: "bad" } : { label: "Sent", state: s === "PAID" ? "done" : sent || a?.authorized ? "current" : "todo" },
    ended && swap !== "SUCCESS" ? { label: "Refunded", state: "bad" } : { label: "Delivered", state: swap === "SUCCESS" ? "done" : s === "PAID" ? "current" : "todo" },
  );
  return steps;
}

const SWAP_WORDS: Record<string, string> = {
  PENDING_DEPOSIT: "waiting for the deposit to arrive",
  KNOWN_DEPOSIT_TX: "the deposit has been seen",
  PROCESSING: "converting and sending",
  INCOMPLETE_DEPOSIT: "the deposit was incomplete",
};

const chainName = (chain: string) => (chain === "TRON" ? "Tron" : chain);

/** "USDT on Tron" → ["USDT", "on Tron"], "USDC" → ["USDC", null]: the hero shows the network apart. */
function splitAsset(asset: string): [string, string | null] {
  const at = asset.indexOf(" on ");
  return at < 0 ? [asset, null] : [asset.slice(0, at), asset.slice(at + 1)];
}

/** Hex (NEAR implicit accounts) and Tron addresses are shown in groups of four, to check against the wallet. */
const grouped = (chain: string, address: string) => chain === "TRON" || /^[0-9a-f]{64}$/.test(address);

type Comparison = { label: string; committed: string; quoted: string };

export default function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const intentId = Number(id);
  const { names } = useSupplierNames();
  const { data, error: loadError, reload } = useChain(() => load(intentId), [intentId]);
  const { busy, result, error, run, wallet } = useOwnerAction(data?.state.owner_id, reload);
  // After the terminal command is copied, watch for its result for a few minutes.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => setWatching(false), 180_000);
    return () => clearTimeout(timer);
  }, [watching]);

  const working = (!!data && othersAreWorking(data) && !busy) || watching;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 4_000);
    return () => clearInterval(timer);
  }, [working, reload]);

  if (!data) return <Loading error={loadError} />;
  const { intent, state, supplier, status, statusError, reused } = data;
  const d = state.token_decimals;
  const p = state.policy;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const native = !!supplier && isNative(supplier, state.token_id);
  const a = intent.attempt;

  // ── The checks, the same ones the contract applies ────────────────────────────────────────
  const supplierOk = !!supplier && supplier.active && supplier.revision === intent.revision;
  const cooldownEnds = supplier ? BigInt(supplier.changed_at) + BigInt(p.cooldown_ns) : 0n;
  const inCooldown = nowNs < cooldownEnds;
  const cooldownOk = !inCooldown || BigInt(intent.value) <= BigInt(p.cooldown_max);
  const expired = isExpired(intent, p, nowNs);
  const pastGrace = intent.status === "PAYING" && nowNs >= BigInt(intent.since) + BigInt(p.callback_grace_ns);

  const comparisons: Comparison[] = [];
  if (a && supplier && status?.quoteResponse) {
    const q = status.quoteResponse;
    const r = q.quoteRequest;
    comparisons.push(
      { label: "Deposit address", committed: a.deposit, quoted: q.quote.depositAddress ?? "(none)" },
      { label: "Goes to the supplier's address on file", committed: supplier.recipient, quoted: r.recipient },
      { label: "What the supplier gets", committed: supplier.asset_id, quoted: r.destinationAsset },
      { label: "How much the supplier gets", committed: intent.amount_out, quoted: r.amount },
      { label: "How much leaves your treasury", committed: a.amount_in, quoted: q.quote.amountIn },
      { label: "Refunds come back to your treasury", committed: POLICY_ID, quoted: r.refundTo },
      { label: "Refunds are made on NEAR", committed: "ORIGIN_CHAIN", quoted: r.refundType },
      { label: "Delivered on the supplier's chain", committed: "DESTINATION_CHAIN", quoted: r.recipientType },
      { label: "Deposit made on NEAR", committed: "ORIGIN_CHAIN", quoted: r.depositType },
      { label: "The supplier gets the exact amount", committed: "EXACT_OUTPUT", quoted: r.swapType },
      { label: "A real quote, not a preview", committed: "false", quoted: String(r.dry) },
      { label: "Quote deadline", committed: a.deadline, quoted: isoToNanos(r.deadline).toString() },
    );
  }
  const quoteMatches = comparisons.length > 0 && comparisons.every((c) => c.committed === c.quoted) && reused.length === 0;
  const quoteLive = !!a && nowNs + BigInt(p.funding_margin_ns) <= BigInt(a.deadline);
  const ended = !!status && TERMINAL_STATUSES.has(status.status);
  const refunded = ended && status!.status !== "SUCCESS";
  const fee = a ? BigInt(a.amount_in) - BigInt(intent.value) : 0n;
  const trustOk =
    !!a &&
    a.epoch === state.executor_epoch &&
    !inCooldown &&
    BigInt(state.budgets.trust) + BigInt(a.amount_in) <= BigInt(p.executor_trust_daily_budget);

  // Reasons the main button cannot be used, in words.
  const blockers = [
    !supplierOk && "the supplier changed since this invoice, or is switched off",
    state.paused && "payments are paused",
    expired && "this payment expired; send the invoice again",
    !cooldownOk && `the supplier's address changed recently: until ${whenText(cooldownEnds)}, at most ${money(p.cooldown_max, d)} USDC`,
  ].filter((b): b is string => typeof b === "string");
  const quoteBlockers = [
    statusError && "NEAR Intents couldn't be reached to check the quote",
    !statusError && !quoteMatches && "the quote doesn't match what the contract will pay (see the checks)",
    !quoteLive && "the quote is about to expire; a new one is coming",
  ].filter((b): b is string => typeof b === "string");

  // ── Words ─────────────────────────────────────────────────────────────────────────────────
  const who = names.get(intent.supplier_id) ?? (supplier ? shortAddress(supplier.recipient) : `supplier #${intent.supplier_id}`);
  const asset = supplier ? assetName(supplier, state.token_id) : "";
  const figure = money(intent.amount_out, supplier?.decimals ?? d);
  const amount = `${figure} ${asset}`.trim();
  const [unit, network] = splitAsset(asset);
  const stateWord = paymentState(intent, native, status?.status ?? null);
  const flag = flagText(intent.flag);
  const decideArgs = (action: OwnerAction) => ({ intent_id: intent.id, action, amount_out: intent.amount_out, supplier_id: intent.supplier_id });
  const decideGas = (action: OwnerAction) => (action === "APPROVE" || action === "RETRY" ? 80 : 30);
  const decide = (action: OwnerAction, label: string) => void run(label, "decide", decideArgs(action), decideGas(action));
  const waitingFor = (label: string, text: string): ReactNode => (busy === label ? <Waiting /> : text);
  const busyClass = (label: string, base: string) => (busy === label ? `${base} busy` : base);
  const reject = (
    <button className={busyClass("reject", "quiet")} disabled={!!busy} onClick={() => decide("REJECT", "reject")}>
      {waitingFor("reject", "Reject")}
    </button>
  );
  const retry = (
    <button className={busyClass("retry", "primary")} disabled={!!busy || blockers.length > 0} onClick={() => decide("RETRY", "retry")}>
      {waitingFor("retry", "Try again")}
    </button>
  );

  let title = "";
  let lead: ReactNode = null;
  let actions: ReactNode = null;
  let blocked: string[] = [];
  // A cross-chain transfer to confirm: what the supplier gets, the fees and what leaves the treasury, and the quote's own deadline.
  let cost: { label: string; value: string; total?: boolean }[] | null = null;
  let timer: string | null = null;
  let retrying = false;
  // The main action, also offered as a terminal command.
  let primary: { method: string; args: Record<string, unknown>; tgas: number } | null = null;
  switch (intent.status) {
    case "PENDING":
      title = `Pay ${who}?`;
      lead = (
        <>
          It needs your OK because {waitReason(intent.route, p, d)}.
          {!native && <> It costs at most {money(intent.max_in, d)} USDC with fees; you confirm the exact amount later.</>}
        </>
      );
      blocked = blockers;
      primary = { method: "decide", args: decideArgs("APPROVE"), tgas: decideGas("APPROVE") };
      actions = (
        <>
          <button className={busyClass("approve", "primary")} disabled={!!busy || blocked.length > 0} onClick={() => decide("APPROVE", "approve")}>
            {waitingFor("approve", native ? `Approve and pay ${amount}` : `Approve ${amount}`)}
          </button>
          {reject}
        </>
      );
      break;
    case "APPROVED":
      if (native) {
        title = `Paying ${who}`;
      } else if (a?.authorized) {
        title = `Sending to ${who}…`;
        lead = "Confirmed. It goes out in a moment.";
      } else if (a && quoteLive) {
        title = `Confirm the transfer to ${who}`;
        cost = [
          { label: `${who} gets`, value: amount },
          ...(fee > 0n ? [{ label: "Fees", value: `${money(fee, d)} USDC` }] : []),
          { label: "From your treasury", value: `${money(a.amount_in, d)} USDC`, total: true },
        ];
        timer = `The quote is valid until ${whenText(a.deadline)} (${untilText(a.deadline)}).`;
        if (trustOk) lead = "Or leave it: it fits the executor's daily allowance and goes out by itself.";
        blocked = [...blockers, ...quoteBlockers];
        primary = { method: "authorize", args: { intent_id: intent.id, deposit: a.deposit, amount_in: a.amount_in }, tgas: 30 };
        actions = (
          <>
            <button
              className={busyClass("confirm", "primary")}
              disabled={!!busy || blocked.length > 0}
              onClick={() => void run("confirm", "authorize", { intent_id: intent.id, deposit: a.deposit, amount_in: a.amount_in })}
            >
              {waitingFor("confirm", `Confirm and send ${money(a.amount_in, d)} USDC`)}
            </button>
            {reject}
          </>
        );
      } else {
        title = `Getting a quote to pay ${who}`;
        lead = "Getting the price from NEAR Intents; then you confirm the exact amount.";
        actions = reject;
      }
      break;
    case "PAYING":
      title = `Sending to ${who}…`;
      lead = pastGrace ? "No confirmation yet. Check the transfer, then mark it paid or failed (below)." : "The transfer is on its way.";
      break;
    case "PAID":
      if (native) {
        title = `Paid ${who}`;
        lead = <>{amount} left your treasury {whenText(intent.since)}.</>;
      } else if (status?.status === "SUCCESS") {
        const got = status.swapDetails.amountOut ?? intent.amount_out;
        const change = BigInt(status.swapDetails.refundedAmount ?? "0");
        title = `Delivered to ${who}`;
        lead = (
          <>
            {who} received {money(got, supplier?.decimals ?? d)} {asset}. It cost {money(a?.amount_in ?? intent.value, d)} USDC from your treasury
            {change > 0n && <>, and {money(change, d)} USDC of change came back</>}.
          </>
        );
      } else if (refunded) {
        const back = BigInt(status!.swapDetails.refundedAmount ?? "0");
        title = "Not delivered: refunded";
        lead = (
          <>
            It couldn&apos;t be delivered, so {money(back, d)} USDC came back to your treasury. Today&apos;s limits aren&apos;t given back.
          </>
        );
        blocked = blockers;
        primary = { method: "decide", args: decideArgs("RETRY"), tgas: decideGas("RETRY") };
        actions = retry;
        retrying = true;
      } else {
        title = `On its way to ${who}`;
        lead = (
          <>
            NEAR Intents is delivering {amount}
            {status ? <> ({SWAP_WORDS[status.status] ?? status.status.toLowerCase()})</> : statusError ? <> (NEAR Intents could not be reached: {statusError})</> : null}.
          </>
        );
      }
      break;
    case "FAILED":
      title = "Didn't go through";
      lead = "The USDC token refused it, so nothing left your treasury. Often the supplier isn't registered on USDC yet.";
      blocked = blockers;
      primary = { method: "decide", args: decideArgs("RETRY"), tgas: decideGas("RETRY") };
      actions = retry;
      retrying = true;
      break;
    case "REJECTED":
      title = "Rejected";
      lead = "You rejected it. To pay it after all, send a corrected invoice with a new number.";
      break;
  }
  const canAct = actions !== null;
  const openForChecks = intent.status === "PENDING" || intent.status === "APPROVED" || intent.status === "FAILED" || refunded;
  const basics = [
    { ok: supplierOk, label: "The supplier is still on your list, unchanged since this invoice" },
    { ok: !state.paused, label: "Payments are not paused" },
    { ok: !expired, label: "The payment has not expired" },
    {
      ok: cooldownOk,
      label: inCooldown
        ? `The address changed recently: until ${whenText(cooldownEnds)}, at most ${money(p.cooldown_max, d)} USDC`
        : "The address hasn't changed recently",
    },
  ];
  const failed = basics.filter((c) => !c.ok).length;
  // Where a delivered cross-chain payment landed, on the supplier's chain.
  const landed = status?.status === "SUCCESS" ? status.swapDetails.destinationChainTxHashes[0]?.explorerUrl : undefined;

  return (
    <div className="pay">
      <div className="pay-main">
        <Link href="/payments" className="back">
          <BackIcon size={16} />
          All payments
        </Link>

        <section className="hero">
          <StatusChip {...stateWord} />
          <h1>{title}</h1>
          <div className="amt-row">
            <span className="num">{figure}</span>
            {unit && <span className="unit">{unit}</span>}
            {network && <span className="on">{network}</span>}
          </div>
          {supplier && (
            <Ident
              address={supplier.recipient}
              grouped={grouped(supplier.chain, supplier.recipient)}
              explorer={native ? EXPLORER.explorerAccount(supplier.recipient) : undefined}
              meta={
                <>
                  <span>To</span>
                  <span>
                    {native ? "NEAR" : chainName(supplier.chain)} · Payment #{intent.id}
                  </span>
                </>
              }
            />
          )}
          {lead && <p className="lead">{lead}</p>}
          {cost && (
            <dl className="cost">
              {cost.map((row) => (
                <div key={row.label} className={row.total ? "total" : undefined}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {timer && (
            <p className="note">
              <ClockIcon size={16} />
              <span>{timer}</span>
            </p>
          )}
          {flag && intent.status === "PENDING" && <Notice>Check this one: {flag}.</Notice>}
          {canAct && <div className="actions">{actions}</div>}
          {canAct && retrying && <p className="retry-note">It counts against today&apos;s limits again.</p>}
          {canAct && blocked.length > 0 && (
            <p className="note bad">
              <WarningIcon size={16} />
              <span>Not possible yet: {blocked.join("; ")}.</span>
            </p>
          )}
          {canAct && !wallet.accountId && (
            <p className="note soft sign">
              <WalletIcon size={16} />
              <span>You&apos;ll sign in your wallet, as {state.owner_id}.</span>
            </p>
          )}
          {canAct && wallet.accountId && wallet.accountId !== state.owner_id && (
            <p className="note bad">
              <CrossIcon size={16} />
              <span>
                You&apos;re connected as {wallet.accountId}; only the owner, {state.owner_id}, can approve.{" "}
                {/* Inside Telegram the header has no Disconnect: the way to switch to the owner's account. */}
                <button className="link" onClick={() => void wallet.disconnect()}>
                  Use another account
                </button>
              </span>
            </p>
          )}
          {/* An error only matters while there is still something to do: a payment signed elsewhere
              (in a terminal) after the wallet window was closed has moved on. */}
          <TxNote result={result} error={canAct ? error : null} />
          {working && (
            <p className="note soft live">
              <RefreshIcon size={16} />
              <span>This page updates by itself.</span>
            </p>
          )}
          {landed && (
            <a className="tx-link" href={landed} target="_blank" rel="noreferrer">
              View the transaction
              <ExternalIcon size={16} />
            </a>
          )}
          {pastGrace && (
            <Notice icon={ClockIcon}>
              <p>
                No confirmation came back. Check the transfer from{" "}
                <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer">
                  {POLICY_ID}
                </a>
                : mark it paid only if the tokens arrived, failed if not.
              </p>
              <div className="actions">
                <button className={busyClass("mark_paid", "ghost")} disabled={!!busy} onClick={() => decide("MARK_PAID", "mark_paid")}>
                  {waitingFor("mark_paid", "Mark paid")}
                </button>
                <button className={busyClass("mark_failed", "ghost")} disabled={!!busy} onClick={() => decide("MARK_FAILED", "mark_failed")}>
                  {waitingFor("mark_failed", "Mark failed")}
                </button>
              </div>
            </Notice>
          )}
          {canAct && primary && blocked.length === 0 && (
            <TerminalOption
              command={nearCliCommand(state.owner_id, primary.method, primary.args, primary.tgas)}
              owner={state.owner_id}
              open={wallet.walletId === "near-cli"}
              onCopied={() => setWatching(true)}
            />
          )}
        </section>
      </div>

      <aside className="pay-side">
        <Progress steps={progress(intent, native, status)} />

        {openForChecks && (
          <>
            <div className="label">Safety checks</div>
            <Fold
              className={failed ? "group bad" : "group"}
              open={failed > 0}
              summary={
                failed ? (
                  <>
                    <WarningIcon size={18} className="tone-bad" />
                    <span className="tone-bad">
                      {failed} check{failed === 1 ? "" : "s"} failed
                    </span>
                  </>
                ) : (
                  <>
                    <CheckIcon size={18} className="tone-good" />
                    <span className="tone-good">All {basics.length} checks passed</span>
                  </>
                )
              }
            >
              {basics.map((c) => (
                <Check key={c.label} ok={c.ok} label={c.label} />
              ))}
            </Fold>
            {a && (
              <Fold
                className={quoteMatches ? "group" : "group bad"}
                open={intent.status === "APPROVED" && !quoteMatches}
                summary={
                  quoteMatches ? (
                    <>
                      <CheckIcon size={18} className="tone-good" />
                      <span className="tone-good">NEAR Intents&apos; quote matches what the contract will pay ({comparisons.length + 1} checks)</span>
                    </>
                  ) : (
                    <>
                      <WarningIcon size={18} className="tone-bad" />
                      <span className="tone-bad">The quote could not be confirmed</span>
                    </>
                  )
                }
              >
                <p className="fold-note">
                  This browser fetched NEAR Intents&apos; own record of the deposit address from {oneclick.baseUrl} and compared it with the contract.
                </p>
                {statusError && <Check ok={false} label="NEAR Intents' record of this deposit address" detail={statusError} />}
                {comparisons.map((c) => (
                  <Check key={c.label} ok={c.committed === c.quoted} label={c.label} detail={c.committed === c.quoted ? c.committed : `contract ${c.committed} ≠ quote ${c.quoted}`} />
                ))}
                <Check ok={reused.length === 0} label="No other payment uses this deposit address" detail={reused.length ? `also on payment ${reused.join(", ")}` : undefined} />
              </Fold>
            )}
          </>
        )}

        <Fold summary="Technical details">
          <table>
            <tbody>
              <Row k="Intent" v={`#${intent.id} · ${intent.status} · route ${intent.route}${intent.flag ? ` · flag ${REVIEW_FLAGS[intent.flag]}` : ""}`} />
              <Row k="Supplier" v={`#${intent.supplier_id} (revision ${intent.revision})`} />
              <Row k="Destination" v={supplier ? <span className="mono">{supplier.chain} · {supplier.recipient}</span> : "supplier not found"} />
              <Row k="Asset" v={<span className="mono small">{supplier?.asset_id}</span>} />
              <Row k="Supplier receives (base units)" v={<span className="mono">{intent.amount_out}</span>} />
              <Row k="Most the treasury can spend" v={`${money(intent.max_in, d)} USDC${native ? "" : " (fees included)"}`} />
              <Row k="Status since" v={nsToDate(intent.since)} />
              <Row k="Invoice id (keyed HMAC)" v={<span className="mono small">{intent.obligation}</span>} />
              {a && (
                <>
                  <Row k="1Click deposit" v={<span className="mono small">{a.deposit}</span>} />
                  <Row k="Amount in" v={`${money(a.amount_in, d)} USDC`} />
                  <Row k="Quote deadline" v={nsToDate(a.deadline)} />
                  <Row k="Confirmed by the owner" v={a.authorized ? "yes" : `no (fundable within the executor's allowance only at epoch ${state.executor_epoch}; this attempt: ${a.epoch})`} />
                </>
              )}
              {status && (
                <Row
                  k="1Click status"
                  v={
                    <>
                      <span className="mono">{status.status}</span>
                      {status.swapDetails.destinationChainTxHashes[0] && (
                        <span className="mono small"> · destination tx {status.swapDetails.destinationChainTxHashes[0].hash}</span>
                      )}
                    </>
                  }
                />
              )}
            </tbody>
          </table>
        </Fold>
      </aside>
    </div>
  );
}
