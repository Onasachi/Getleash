"use client";

/**
 * Private view (PLAN §4.5, F-10): supplier names and invoice records, only after the owner signs a
 * NEP-413 message with a full-access key of the contract's owner account. The chain shows only
 * pseudonymous supplier ids and keyed obligation ids; this page joins them with the private data.
 */
import { useCallback, useEffect, useState } from "react";

import type { DirectoryEntry } from "@getleash/shared";

import { Pill } from "@/components/ui";
import { useWallet } from "@/lib/wallet";

type InvoiceRecord = {
  key: string;
  receivedAt: string;
  source: string;
  model: string;
  badge: string;
  extraction: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  outcome: { status: string; summary: string; obligationId: string | null; result: { intent_id: number | null; reason: string | null } | null };
  verification: { checks: Array<{ name: string; ok: boolean; detail: string }> } | null;
  files: Array<{ kind: string; name?: string; bytes: number }>;
};

type PrivateData = { accountId: string; directory: DirectoryEntry[]; invoices: InvoiceRecord[] };

export default function PrivatePage() {
  const wallet = useWallet();
  const [data, setData] = useState<PrivateData | null>(null);
  const [status, setStatus] = useState<"loading" | "signed_out" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/private/invoices", { cache: "no-store" });
    if (response.status === 401) return setStatus("signed_out");
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? `HTTP ${response.status}`);
      return setStatus("error");
    }
    setData(body as PrivateData);
    setStatus("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signIn() {
    setError(null);
    try {
      if (!wallet.accountId) await wallet.connect();
      const challenge = (await (await fetch("/api/auth/challenge", { method: "POST" })).json()) as { message: string; recipient: string; nonce: string };
      const nonce = new Uint8Array(challenge.nonce.match(/../g)!.map((h) => Number.parseInt(h, 16)));
      const signed = await wallet.signMessage(challenge.message, challenge.recipient, nonce);
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setData(null);
    setStatus("signed_out");
  }

  if (status === "loading") return <p className="muted">Loading…</p>;
  if (status === "signed_out") {
    return (
      <>
        <h1>Private view</h1>
        <p className="muted">Supplier names and invoices are shown only to the contract's owner, after signing a message in the owner wallet (NEP-413). Nothing is sent on-chain.</p>
        <div className="actions">
          <button onClick={() => void signIn()}>Sign in with the owner wallet</button>
        </div>
        {error && <p className="error">{error}</p>}
      </>
    );
  }
  if (status === "error" || !data) return <p className="error">{error}</p>;
  const names = new Map(data.directory.map((s) => [s.supplier_id, s.name]));

  return (
    <>
      <h1>Private view</h1>
      <p className="muted small">
        Signed in as {data.accountId}.{" "}
        <a href="#" onClick={() => void signOut()}>
          Sign out
        </a>
      </p>

      <h2>Suppliers (off-chain directory)</h2>
      <table className="list">
        <thead>
          <tr>
            <th>Id</th>
            <th>Name</th>
            <th>Payment details on file</th>
            <th>Usual amount</th>
          </tr>
        </thead>
        <tbody>
          {data.directory.map((s) => (
            <tr key={s.supplier_id}>
              <td>#{s.supplier_id}</td>
              <td>{s.name}</td>
              <td className="mono small">{s.payment_details.join(", ")}</td>
              <td>
                {s.typical_amount ?? "—"} {s.currency}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Invoices ({data.invoices.length})</h2>
      {data.invoices.map((inv) => (
        <details key={inv.key} className="card" style={{ marginBottom: 10 }}>
          <summary>
            <strong>{(inv.extraction?.supplier_name as string) ?? "?"}</strong> · {String(inv.extraction?.invoice_number ?? "no number")} ·{" "}
            {String(inv.extraction?.total_amount ?? "?")} {String(inv.extraction?.currency ?? "")} · <Pill value={inv.outcome.status.toUpperCase()} />{" "}
            <span className="muted small">{inv.badge}</span>
          </summary>
          <p className="small">{inv.outcome.summary}</p>
          <p className="muted small">
            {inv.receivedAt} · {inv.source} · model {inv.model}
            {inv.outcome.result?.intent_id != null && (
              <>
                {" "}
                · <a href={`/intent/${inv.outcome.result.intent_id}`}>intent #{inv.outcome.result.intent_id}</a>
                {names.size > 0 && null}
              </>
            )}
          </p>
          {inv.verification && (
            <ul className="small">
              {inv.verification.checks.map((c) => (
                <li key={c.name} className={c.ok ? "success" : "error"}>
                  {c.ok ? "✓" : "✗"} {c.name} <span className="muted mono">{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify({ extraction: inv.extraction, decision: inv.decision, files: inv.files }, null, 2)}
          </pre>
        </details>
      ))}
    </>
  );
}
