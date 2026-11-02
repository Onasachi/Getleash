"use client";

/**
 * One intent (PLAN §4.5; v2, docs/decisions.md D-28). Loads the intent and its supplier from the
 * chain in this browser and offers the owner's actions. Every action names the terms the wallet
 * will show: `decide` repeats amount_out and supplier_id; `authorize` names the exact 1Click
 * deposit and amount. For a cross-chain attempt, this browser fetches 1Click's own record of the
 * deposit address and compares it, field by field, with what the contract committed; any
 * mismatch disables signing.
 */
import { use, useState } from "react";

import { isExpired, isNative, isoToNanos, type OwnerAction, type StatusResponse, TERMINAL_STATUSES, type TxOutcome } from "@getleash/shared";

import { Check, Loading, Pill, Row, TxNote } from "@/components/ui";
import { oneclick, policy } from "@/lib/chain";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { nsToDate, usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

type Comparison = { label: string; committed: string; quoted: string };

export default function IntentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const intentId = Number(id);
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, reload } = useChain(async () => {
    const intent = await policy.intent(intentId);
    if (!intent) throw new Error(`intent ${intentId} not found (or forgotten after retention)`);
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
  }, [intentId]);

  if (!data) return <Loading error={loadError} />;
  const { intent, state, supplier, status, statusError, reused } = data;
  const d = state.token_decimals;
  const p = state.policy;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const native = !!supplier && isNative(supplier, state.token_id);
  const isOwner = wallet.accountId === state.owner_id;
  const supplierOk = !!supplier && supplier.active && supplier.revision === intent.revision;
  const inCooldown = !!supplier && nowNs < BigInt(supplier.changed_at) + BigInt(p.cooldown_ns);
  const cooldownOk = !inCooldown || BigInt(intent.value) <= BigInt(p.cooldown_max);
  const expired = isExpired(intent, p, nowNs);
  const pastGrace = intent.status === "PAYING" && nowNs >= BigInt(intent.since) + BigInt(p.callback_grace_ns);
  const a = intent.attempt;

  const comparisons: Comparison[] = [];
  if (a && supplier && status?.quoteResponse) {
    const q = status.quoteResponse;
    const r = q.quoteRequest;
    comparisons.push(
      { label: "Deposit address", committed: a.deposit, quoted: q.quote.depositAddress ?? "(none)" },
      { label: "Final recipient (the supplier on file)", committed: supplier.recipient, quoted: r.recipient },
      { label: "Destination asset", committed: supplier.asset_id, quoted: r.destinationAsset },
      { label: "Amount the supplier gets", committed: intent.amount_out, quoted: r.amount },
      { label: "Amount in", committed: a.amount_in, quoted: q.quote.amountIn },
      { label: "Refunds go to the treasury", committed: POLICY_ID, quoted: r.refundTo },
      { label: "Refund type", committed: "ORIGIN_CHAIN", quoted: r.refundType },
      { label: "Recipient type", committed: "DESTINATION_CHAIN", quoted: r.recipientType },
      { label: "Deposit type", committed: "ORIGIN_CHAIN", quoted: r.depositType },
      { label: "Swap type", committed: "EXACT_OUTPUT", quoted: r.swapType },
      { label: "Execution quote (not dry)", committed: "false", quoted: String(r.dry) },
      { label: "Quote deadline (ns)", committed: a.deadline, quoted: isoToNanos(r.deadline).toString() },
    );
  }
  const quoteOk = comparisons.length > 0 && comparisons.every((c) => c.committed === c.quoted) && reused.length === 0;
  const quoteLive = !!a && nowNs + BigInt(p.funding_margin_ns) <= BigInt(a.deadline);
  const refunded = !!status && TERMINAL_STATUSES.has(status.status) && status.status !== "SUCCESS";

  async function call(method: string, args: Record<string, unknown>, tgas = 30) {
    setBusy(true);
    setError(null);
    try {
      setResult(await wallet.ownerCall(method, args, tgas));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const decide = (action: OwnerAction) =>
    call("decide", { intent_id: intent.id, action, amount_out: intent.amount_out, supplier_id: intent.supplier_id }, action === "APPROVE" || action === "RETRY" ? 80 : 30);

  return (
    <>
      <h1>
        Intent #{intent.id} <Pill value={intent.status} />
      </h1>
      <p className="muted">
        {intent.route === "AUTONOMOUS" ? "Approved by the agent within its limits" : `Waits for the owner: ${intent.route}`}
        {intent.flag > 0 && <> · agent flag #{intent.flag}</>} · {native ? "direct USDC transfer" : "cross-chain via NEAR Intents 1Click"}
      </p>

      <h2>What this pays</h2>
      <table>
        <tbody>
          <Row k="Supplier" v={`#${intent.supplier_id} (revision ${intent.revision})`} />
          <Row k="Destination" v={supplier ? <span className="mono">{supplier.chain} · {supplier.recipient}</span> : "supplier not found"} />
          <Row k="Asset" v={<span className="mono small">{supplier?.asset_id}</span>} />
          <Row
            k="Supplier receives"
            v={native ? `${usdc(intent.amount_out, d)} USDC` : `${usdc(intent.amount_out, supplier?.decimals ?? d)} of the asset above (${intent.amount_out} base units)`}
          />
          <Row k="Most the treasury can spend" v={`${usdc(intent.max_in, d)} USDC${native ? "" : " (fees included)"}`} />
          <Row k="Status since" v={nsToDate(intent.since)} />
          <Row k="Invoice id (keyed HMAC)" v={<span className="mono small">{intent.obligation}</span>} />
          {a && (
            <>
              <Row k="1Click deposit" v={<span className="mono small">{a.deposit}</span>} />
              <Row k="Amount in" v={`${usdc(a.amount_in, d)} USDC`} />
              <Row k="Quote deadline" v={nsToDate(a.deadline)} />
              <Row k="Signed by the owner" v={a.authorized ? "yes" : `no (trust-fundable only at executor epoch ${state.executor_epoch}; this attempt: ${a.epoch})`} />
            </>
          )}
        </tbody>
      </table>

      <h2>Checks done in your browser</h2>
      <Check ok={supplierOk} label="The supplier is active and still has the destination this intent was made for" detail={supplier ? `revision ${supplier.revision}` : "not found"} />
      <Check ok={!state.paused} label="The contract is not paused" />
      <Check ok={!expired} label="The intent has not expired" />
      <Check ok={cooldownOk} label={inCooldown ? `Cooldown: at most ${usdc(p.cooldown_max, d)} can be approved to this supplier until it ends` : "The supplier is past its cooldown"} />
      {a && (
        <>
          {statusError && <Check ok={false} label="1Click's record of this deposit address" detail={statusError} />}
          {status && (
            <p className="muted small">
              1Click status: <Pill value={status.status} /> · fetched from {oneclick.baseUrl} by this browser
            </p>
          )}
          {comparisons.map((c) => (
            <Check key={c.label} ok={c.committed === c.quoted} label={c.label} detail={c.committed === c.quoted ? c.committed : `committed ${c.committed} ≠ 1Click ${c.quoted}`} />
          ))}
          <Check ok={reused.length === 0} label="This deposit address is not used by another intent" detail={reused.length ? `also on intent ${reused.join(", ")}` : undefined} />
        </>
      )}

      <div className="actions">
        {intent.status === "PENDING" && (
          <>
            <button disabled={!isOwner || busy || !supplierOk || state.paused || expired || !cooldownOk} onClick={() => void decide("APPROVE")}>
              Approve {native ? `and pay ${usdc(intent.value, d)}` : ""}
            </button>
            <button className="danger" disabled={!isOwner || busy} onClick={() => void decide("REJECT")}>
              Reject
            </button>
          </>
        )}
        {intent.status === "APPROVED" && (
          <>
            {a && !a.authorized && (
              <button
                disabled={!isOwner || busy || !quoteOk || !quoteLive || state.paused}
                onClick={() => void call("authorize", { intent_id: intent.id, deposit: a.deposit, amount_in: a.amount_in })}
              >
                Sign for {usdc(a.amount_in, d)} USDC to this deposit
              </button>
            )}
            <button className="danger" disabled={!isOwner || busy} onClick={() => void decide("REJECT")}>
              Reject
            </button>
          </>
        )}
        {(intent.status === "FAILED" || (intent.status === "PAID" && !native && refunded)) && (
          <button disabled={!isOwner || busy || !supplierOk || state.paused || !cooldownOk} onClick={() => void decide("RETRY")}>
            Retry (counted against today&apos;s budgets again)
          </button>
        )}
        {pastGrace && (
          <>
            <button className="ghost" disabled={!isOwner || busy} onClick={() => void decide("MARK_PAID")}>
              Mark paid
            </button>
            <button className="ghost" disabled={!isOwner || busy} onClick={() => void decide("MARK_FAILED")}>
              Mark failed
            </button>
          </>
        )}
      </div>
      {pastGrace && (
        <p className="muted small">
          The transfer&apos;s callback never came back. Check the token transfer from{" "}
          <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer">
            {POLICY_ID}
          </a>{" "}
          first: mark it paid only if the tokens arrived, failed only if they did not.
        </p>
      )}
      {intent.status === "PAID" && !native && status && !refunded && (
        <p className="muted small">The swap has not been refunded, so retrying is not offered (it could pay twice).</p>
      )}
      {!isOwner && <p className="muted small">Connect the owner wallet ({state.owner_id}) to act.</p>}
      <TxNote result={result} error={error} />
    </>
  );
}
