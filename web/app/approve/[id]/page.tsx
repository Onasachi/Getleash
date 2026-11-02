"use client";

/**
 * Approval page (PLAN §4.5): loads the intent from the chain, recomputes its hash from the terms
 * shown here, and only then offers `approve(id, intent_hash)`. If the recomputed hash differs from
 * the on-chain one, signing is disabled: the owner never signs a hash they were not shown.
 */
import Link from "next/link";
import { use, useState } from "react";

import { intentHash, routeReason, type TxOutcome } from "@getleash/shared";

import { Check, Loading, Pill, Row, TxNote } from "@/components/ui";
import { policy } from "@/lib/chain";
import { POLICY_ID } from "@/lib/config";
import { nsToDate, usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

export default function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const intentId = Number(id);
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, reload } = useChain(async () => {
    const intent = await policy.intent(intentId);
    if (!intent) throw new Error(`intent ${intentId} not found`);
    const [supplier, config, budgets] = await Promise.all([policy.supplier(intent.terms.supplier_id), policy.config(), policy.budgetsToday()]);
    return { intent, supplier, config, budgets };
  }, [intentId]);

  if (!data) return <Loading error={loadError} />;
  const { intent, supplier, config } = data;
  const t = intent.terms;
  const d = config.treasury_decimals;
  const recomputed = intentHash(POLICY_ID, t);
  const hashOk = recomputed === intent.intent_hash;
  const supplierOk = !!supplier && supplier.active && supplier.revision === t.supplier_revision;
  const isOwner = wallet.accountId === config.owner_id;

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
        Intent #{t.id} <Pill value={intent.status} />
      </h1>
      <p className="muted">
        {routeReason(t.route) ? `Needs approval: ${routeReason(t.route)}` : "Auto-approved within the autonomous budget"}
        {t.review_flag && (
          <>
            {" "}
            · agent flag <Pill value={t.review_flag} />
          </>
        )}
        {t.test_payment && <> · test payment during the supplier's cooldown</>}
      </p>

      <h2>What approving pays</h2>
      <table>
        <tbody>
          <Row k="Supplier" v={`#${t.supplier_id} (revision ${t.supplier_revision})`} />
          <Row k="Destination" v={<span className="mono">{t.chain} · {t.recipient}</span>} />
          <Row k="Asset" v={<span className="mono small">{t.asset_id}</span>} />
          <Row k="Supplier receives" v={`${usdc(t.amount_out)} (${t.kind === "NATIVE" ? "direct transfer" : "via NEAR Intents"})`} />
          <Row k="Most the treasury can spend" v={`${usdc(t.max_in, d)} (fees included)`} />
          <Row k="Expires" v={nsToDate(t.expires_at)} />
          <Row k="Obligation id (keyed HMAC)" v={<span className="mono small">{t.obligation_id}</span>} />
          <Row k="Attempts" v={intent.attempt_ids.length ? intent.attempt_ids.map((a) => <Link key={a} href={`/attempt/${a}`}>#{a} </Link>) : "none"} />
        </tbody>
      </table>

      <h2>Checks done in your browser</h2>
      <Check ok={hashOk} label="The hash you sign matches the terms shown above" detail={recomputed} />
      <Check
        ok={supplierOk}
        label="The supplier still has this destination and is active"
        detail={supplier ? `revision ${supplier.revision}, ${supplier.active ? "active" : "inactive"}, ${supplier.verified ? "verified" : "unverified"}` : "supplier not found"}
      />
      <Check ok={!config.paused} label="The contract is not paused" />

      <div className="actions">
        {intent.status === "PENDING" && (
          <>
            <button disabled={!isOwner || !hashOk || !supplierOk || busy} onClick={() => void act("approve", { intent_id: t.id, expected_intent_hash: recomputed })}>
              Approve (sign intent hash)
            </button>
            <button className="danger" disabled={!isOwner || busy} onClick={() => void act("reject", { intent_id: t.id })}>
              Reject
            </button>
          </>
        )}
        {(intent.status === "APPROVED" || intent.status === "PENDING") && (
          <button className="ghost" disabled={!isOwner || busy} onClick={() => void act("cancel", { intent_id: t.id })}>
            Cancel intent
          </button>
        )}
      </div>
      {!isOwner && <p className="muted small">Connect the owner wallet ({config.owner_id}) to act.</p>}
      <TxNote result={result} error={error} />
    </>
  );
}
