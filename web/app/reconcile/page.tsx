"use client";

/**
 * Reconcile page (PLAN §4.5, D-16): tokens that reached the contract without `ft_transfer_call`
 * (refunds, exact-output change, stray transfers) are not credited until the owner attributes
 * them. The page shows the unreconciled amount, what 1Click says it returned per attempt (fetched
 * by this browser), and builds a `reconcile_inflows` batch. Returns never restore budgets.
 */
import { useState } from "react";

import type { Attempt, InflowEntry, TxOutcome } from "@getleash/shared";

import { Loading, Pill, TxNote } from "@/components/ui";
import { oneclick, policy, tokenBalance } from "@/lib/chain";
import { POLICY_ID } from "@/lib/config";
import { usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

type Candidate = { attempt: Attempt; reported: bigint; outstanding: bigint };

export default function ReconcilePage() {
  const wallet = useWallet();
  const [entries, setEntries] = useState<Array<{ amount: string; kind: "TOP_UP" | "ATTEMPT_RETURN" | "UNATTRIBUTED"; attemptId: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, reload } = useChain(async () => {
    const [config, ledger] = await Promise.all([policy.config(), policy.ledger()]);
    const balance = await tokenBalance(config.treasury_token, POLICY_ID);
    // Recent cross-chain attempts whose transfer left the treasury may have returns.
    const ids = Array.from({ length: Math.min(40, config.next_attempt_id - 1) }, (_, i) => config.next_attempt_id - 1 - i);
    const attempts = (await Promise.all(ids.map((id) => policy.attempt(id)))).filter(
      (a): a is Attempt => !!a && a.terms.kind === "CROSS_CHAIN" && a.transfer_confirmed,
    );
    const candidates: Candidate[] = [];
    for (const attempt of attempts) {
      try {
        const status = await oneclick.status(attempt.terms.pay_to);
        const reported = BigInt(status.swapDetails.refundedAmount ?? "0");
        const outstanding = reported - BigInt(attempt.returned_amount);
        if (reported > 0n) candidates.push({ attempt, reported, outstanding });
      } catch {
        // 1Click unreachable for this one: the owner can still attribute manually.
      }
    }
    return { config, ledger, unreconciled: balance - BigInt(ledger.cash), candidates };
  });

  if (!data) return <Loading error={loadError} />;
  const { config, unreconciled, candidates } = data;
  const d = config.treasury_decimals;
  const isOwner = wallet.accountId === config.owner_id;
  const total = entries.reduce((sum, e) => sum + (/^\d+$/.test(e.amount) ? BigInt(e.amount) : 0n), 0n);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const batch: InflowEntry[] = entries.map((e) => ({
        amount: e.amount,
        attribution: e.kind === "ATTEMPT_RETURN" ? { ATTEMPT_RETURN: { attempt_id: Number(e.attemptId) } } : e.kind,
      }));
      setResult(await wallet.ownerCall("reconcile_inflows", { entries: batch }, 100));
      setEntries([]);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Reconcile inflows</h1>
      <p className="muted">
        Unreconciled: <strong>{usdc(unreconciled, d)}</strong> (token balance minus recognised cash). Nothing here is credited until you sign.
      </p>

      <h2>Returns reported by 1Click</h2>
      {candidates.length === 0 ? (
        <p className="muted">No refunds or change reported for recent attempts.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Status</th>
              <th>Reported returned</th>
              <th>Already attributed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map(({ attempt, reported, outstanding }) => (
              <tr key={attempt.terms.id}>
                <td>#{attempt.terms.id}</td>
                <td>
                  <Pill value={attempt.status} />
                </td>
                <td>{usdc(reported, d)}</td>
                <td>{usdc(attempt.returned_amount, d)}</td>
                <td>
                  {outstanding > 0n && (
                    <button
                      className="ghost"
                      onClick={() => setEntries([...entries, { amount: outstanding.toString(), kind: "ATTEMPT_RETURN", attemptId: String(attempt.terms.id) }])}
                    >
                      Add {usdc(outstanding, d)}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Batch (up to 20 entries)</h2>
      {entries.map((e, i) => (
        <div className="actions" key={i}>
          <input value={e.amount} onChange={(ev) => setEntries(entries.map((x, j) => (j === i ? { ...x, amount: ev.target.value.trim() } : x)))} placeholder="amount (base units)" />
          <select value={e.kind} onChange={(ev) => setEntries(entries.map((x, j) => (j === i ? { ...x, kind: ev.target.value as typeof e.kind } : x)))}>
            <option value="ATTEMPT_RETURN">return for attempt</option>
            <option value="TOP_UP">top-up</option>
            <option value="UNATTRIBUTED">unattributed</option>
          </select>
          {e.kind === "ATTEMPT_RETURN" && (
            <input value={e.attemptId} onChange={(ev) => setEntries(entries.map((x, j) => (j === i ? { ...x, attemptId: ev.target.value.trim() } : x)))} placeholder="attempt id" />
          )}
          <button className="ghost" onClick={() => setEntries(entries.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div className="actions">
        <button className="ghost" disabled={entries.length >= 20} onClick={() => setEntries([...entries, { amount: "", kind: "TOP_UP", attemptId: "" }])}>
          Add entry
        </button>
        <button disabled={!isOwner || busy || entries.length === 0 || total > unreconciled} onClick={() => void submit()}>
          Sign reconcile_inflows ({usdc(total, d)})
        </button>
      </div>
      {total > unreconciled && <p className="error">The batch is larger than the unreconciled amount.</p>}
      {!isOwner && <p className="muted small">Connect the owner wallet ({config.owner_id}) to sign.</p>}
      <TxNote result={result} error={error} />
    </>
  );
}
