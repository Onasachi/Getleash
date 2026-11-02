"use client";

/**
 * Attempt page (PLAN §4.5): loads the attempt from the chain and, for cross-chain attempts,
 * fetches the 1Click status of its deposit address directly from this browser, independently of
 * the executor that created it. Every committed term is compared with the quote 1Click reports;
 * any mismatch is shown in red and disables signing.
 */
import Link from "next/link";
import { use, useState } from "react";

import { attemptHash, isoToNanos, type StatusResponse, type TxOutcome } from "@getleash/shared";

import { Check, Loading, Pill, Row, TxNote } from "@/components/ui";
import { oneclick, policy } from "@/lib/chain";
import { POLICY_ID } from "@/lib/config";
import { nsToDate, usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

type Comparison = { label: string; committed: string; quoted: string };

export default function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const attemptId = Number(id);
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState({ amount: "", tx: "" });

  const { data, error: loadError, reload } = useChain(async () => {
    const attempt = await policy.attempt(attemptId);
    if (!attempt) throw new Error(`attempt ${attemptId} not found`);
    const [intent, config] = await Promise.all([policy.intent(attempt.terms.intent_id), policy.config()]);
    let status: StatusResponse | null = null;
    let statusError: string | null = null;
    if (attempt.terms.kind === "CROSS_CHAIN") {
      try {
        status = await oneclick.status(attempt.terms.pay_to);
      } catch (e) {
        statusError = (e as Error).message;
      }
    }
    return { attempt, intent, config, status, statusError };
  }, [attemptId]);

  if (!data) return <Loading error={loadError} />;
  const { attempt, intent, config, status, statusError } = data;
  const t = attempt.terms;
  const d = config.treasury_decimals;
  const recomputed = attemptHash(POLICY_ID, t);
  const hashOk = recomputed === attempt.attempt_hash;
  const intentOk = !!intent && intent.intent_hash === t.intent_hash && intent.terms.recipient === t.final_recipient && intent.terms.amount_out === t.expected_out;
  const isOwner = wallet.accountId === config.owner_id;

  const comparisons: Comparison[] = [];
  if (t.kind === "CROSS_CHAIN" && status?.quoteResponse) {
    const q = status.quoteResponse;
    const r = q.quoteRequest;
    comparisons.push(
      { label: "Deposit address", committed: t.pay_to, quoted: q.quote.depositAddress ?? "(none)" },
      { label: "Final recipient", committed: t.final_recipient, quoted: r.recipient },
      { label: "Destination asset", committed: t.destination_asset, quoted: r.destinationAsset },
      { label: "Amount the supplier gets", committed: t.expected_out, quoted: r.amount },
      { label: "Quoted amount out", committed: t.expected_out, quoted: q.quote.amountOut },
      { label: "Amount in", committed: t.amount_in, quoted: q.quote.amountIn },
      { label: "Refunds go to", committed: t.refund_to ?? "", quoted: r.refundTo },
      { label: "Refund type", committed: t.refund_type ?? "", quoted: r.refundType },
      { label: "Recipient type", committed: t.recipient_type ?? "", quoted: r.recipientType },
      { label: "Deposit type", committed: t.deposit_type ?? "", quoted: r.depositType },
      { label: "Swap type", committed: "EXACT_OUTPUT", quoted: r.swapType },
      { label: "Execution quote (not dry)", committed: "false", quoted: String(r.dry) },
      { label: "Quote signature", committed: t.quote_ref ?? "", quoted: q.signature },
      { label: "Deadline (ns)", committed: t.quote_deadline ?? "", quoted: isoToNanos(r.deadline).toString() },
    );
  }
  const quoteOk = t.kind === "NATIVE" || (comparisons.length > 0 && comparisons.every((c) => c.committed === c.quoted));
  const canAuthorize = attempt.status === "AWAITING_OWNER" && isOwner && hashOk && intentOk && quoteOk && !busy;

  async function act(method: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      setResult(await wallet.ownerCall(method, args));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>
        Attempt #{t.id} <Pill value={attempt.status} /> <Pill value={attempt.authorization} />
      </h1>
      <p className="muted">
        For <Link href={`/approve/${t.intent_id}`}>intent #{t.intent_id}</Link> · {t.kind === "NATIVE" ? "direct USDC transfer" : "cross-chain via NEAR Intents 1Click"}
      </p>

      <h2>Committed on-chain</h2>
      <table>
        <tbody>
          <Row k="Treasury sends" v={`${usdc(t.amount_in, d)} to ${t.pay_to}`} />
          <Row k="Supplier gets" v={`${usdc(t.expected_out)} ${t.destination_asset} at ${t.final_recipient}`} />
          {t.quote_deadline && <Row k="Quote deadline" v={nsToDate(t.quote_deadline)} />}
          <Row k="Funded" v={attempt.funded_at ? nsToDate(attempt.funded_at) : "not yet"} />
          {attempt.delivered_amount && <Row k="Delivered" v={`${usdc(attempt.delivered_amount)} · ${attempt.dest_tx}`} />}
          <Row k="Returned (owner-reconciled)" v={usdc(attempt.returned_amount, d)} />
        </tbody>
      </table>

      <h2>Checks done in your browser</h2>
      <Check ok={hashOk} label="The hash you sign matches the terms shown" detail={recomputed} />
      <Check ok={intentOk} label="The attempt is for its intent's destination and amount" />
      {t.kind === "CROSS_CHAIN" && (
        <>
          {statusError && <Check ok={false} label="1Click status for this deposit address" detail={statusError} />}
          {status && (
            <p className="muted small">
              1Click status: <Pill value={status.status} /> · fetched from {oneclick.baseUrl} by this browser
            </p>
          )}
          {comparisons.map((c) => (
            <Check key={c.label} ok={c.committed === c.quoted} label={c.label} detail={c.committed === c.quoted ? c.committed : `committed ${c.committed} ≠ quote ${c.quoted}`} />
          ))}
        </>
      )}

      <div className="actions">
        {attempt.status === "AWAITING_OWNER" && (
          <button disabled={!canAuthorize} onClick={() => void act("authorize_attempt", { attempt_id: t.id, expected_attempt_hash: recomputed })}>
            Authorize (sign attempt hash)
          </button>
        )}
        {(attempt.status === "AWAITING_OWNER" || attempt.status === "AUTHORIZED") && (
          <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("cancel_attempt", { attempt_id: t.id })}>
            Cancel attempt
          </button>
        )}
        {(attempt.status === "FUNDED" || attempt.status === "FUNDING_PENDING") && (
          <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("flag_reconciliation", { attempt_id: t.id })}>
            Flag for reconciliation
          </button>
        )}
      </div>

      {attempt.status === "NEEDS_RECONCILIATION" && (
        <>
          <h2>Resolve</h2>
          <p className="muted small">Check the transfer on the explorers first. Returned funds are credited separately on the Reconcile page.</p>
          <div className="actions">
            <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("resolve_reconciliation", { attempt_id: t.id, outcome: "NOT_SENT" })}>
              Not sent (restore)
            </button>
            <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("resolve_reconciliation", { attempt_id: t.id, outcome: "SENT" })}>
              Sent
            </button>
            <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("resolve_reconciliation", { attempt_id: t.id, outcome: "SWAP_FAILED" })}>
              Swap failed
            </button>
          </div>
          <div className="actions">
            <input placeholder="delivered (base units)" value={delivered.amount} onChange={(e) => setDelivered({ ...delivered, amount: e.target.value.trim() })} />
            <input placeholder="destination tx" value={delivered.tx} onChange={(e) => setDelivered({ ...delivered, tx: e.target.value.trim() })} />
            <button
              disabled={!isOwner || busy || !/^\d+$/.test(delivered.amount) || !delivered.tx}
              onClick={() => void act("resolve_reconciliation", { attempt_id: t.id, outcome: { DELIVERED: { delivered_amount: delivered.amount, dest_tx: delivered.tx } } })}
            >
              Delivered
            </button>
          </div>
        </>
      )}
      {!isOwner && <p className="muted small">Connect the owner wallet ({config.owner_id}) to act.</p>}
      <TxNote result={result} error={error} />
    </>
  );
}
