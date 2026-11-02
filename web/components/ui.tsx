"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { TxOutcome } from "@getleash/shared";

import { EXPLORER, NETWORK, POLICY_ID } from "@/lib/config";
import { useWallet } from "@/lib/wallet";

export function Shell({ children }: { children: ReactNode }) {
  const { accountId, connect, disconnect } = useWallet();
  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          GetLeash
        </Link>
        <nav>
          <Link href="/">Overview</Link>
          <Link href="/pause">Pause</Link>
          <Link href="/private">Private</Link>
        </nav>
        <span className="spacer" />
        <span className="muted mono small">
          {POLICY_ID || "no contract configured"} · {NETWORK}
        </span>
        {accountId ? (
          <button className="ghost" onClick={() => void disconnect()}>
            {accountId} ✕
          </button>
        ) : (
          <button onClick={() => void connect()}>Connect wallet</button>
        )}
      </header>
      <main>{children}</main>
      <footer className="muted small">
        Data is read from the chain in your browser. Every owner action is signed in your wallet with 1 yoctoNEAR.
      </footer>
    </>
  );
}

export function Pill({ value }: { value: string }) {
  const tone = /PAID|SUCCESS|APPROVED|OK/.test(value)
    ? "good"
    : /FAILED|REJECTED|REFUNDED|INCOMPLETE|PAUSED/.test(value)
      ? "bad"
      : /PENDING|PAYING|PROCESSING|KNOWN_DEPOSIT/.test(value)
        ? "warn"
        : "plain";
  return <span className={`pill ${tone}`}>{value}</span>;
}

export function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: ReactNode }) {
  return (
    <div className={`check ${ok ? "ok" : "fail"}`}>
      <span className="mark">{ok ? "✓" : "✗"}</span>
      <span>{label}</span>
      {detail !== undefined && <span className="muted mono small detail">{detail}</span>}
    </div>
  );
}

export function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <tr>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  );
}

export function TxNote({ result, error }: { result: TxOutcome | null; error: string | null }) {
  if (error) return <p className="error">{error}</p>;
  if (!result) return null;
  const failed = !result.ok;
  return (
    <p className={failed ? "error" : "success"}>
      {failed ? `Transaction failed: ${result.failures.map((f) => f.panic ?? f.message).join("; ")}` : "Done."}{" "}
      <a href={EXPLORER.explorerTx(result.txHash)} target="_blank" rel="noreferrer" className="mono small">
        {result.txHash}
      </a>
    </p>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error ? <p className="error">{error}</p> : <p className="muted">Loading from the chain…</p>;
}
