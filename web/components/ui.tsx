"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";

import type { Tone, TxOutcome } from "@getleash/shared";

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
          <Link href="/">Payments</Link>
          <Link href="/private">Suppliers &amp; invoices</Link>
          <Link href="/pause">Pause</Link>
        </nav>
        <span className="spacer" />
        {NETWORK !== "mainnet" && <span className="net">{NETWORK}</span>}
        {accountId ? (
          <button className="ghost" title="Disconnect" onClick={() => void disconnect()}>
            {accountId} ✕
          </button>
        ) : (
          <button onClick={() => void connect()}>Connect wallet</button>
        )}
      </header>
      <main>{children}</main>
      <footer className="muted small">
        Everything here is read straight from the NEAR blockchain in your browser. Money moves only within the rules of the contract{" "}
        {POLICY_ID ? (
          <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer" className="mono">
            {POLICY_ID}
          </a>
        ) : (
          "(not configured)"
        )}
        , and anything you approve is signed in your own wallet.
      </footer>
    </>
  );
}

/** A status in plain words ("Needs your OK", "Paid"), coloured by how it is going. */
export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`chip ${tone}`}>{label}</span>;
}

/** Raw enum codes (1Click statuses, the private view's records). */
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

export type Step = { label: string; state: "done" | "current" | "todo" | "bad" };

/** Where a payment is on its way, left to right. */
export function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.label} className={s.state}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/** A section that starts folded ("Show"), for details most people never need. */
export function Fold({ summary, open, children }: { summary: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details className="fold" open={open}>
      <summary>{summary}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/**
 * The same action as a terminal command (near-cli), for owners whose key lives in near-cli: copy,
 * paste, Enter. `onCopied` lets the page watch for the result.
 */
export function TerminalOption({ command, owner, open, onCopied }: { command: string; owner: string; open?: boolean; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      onCopied?.();
    } catch {
      setCopied(false);
    }
  }
  return (
    <Fold open={open} summary={<span className="small">Or sign in a terminal (near-cli)</span>}>
      <p className="small muted">
        Paste it into your terminal and press Enter: it signs with the key near-cli keeps for {owner} and sends right away. This page updates by itself.
      </p>
      <pre className="cmd">{command}</pre>
      <button className="ghost" onClick={() => void copy()}>
        {copied ? "Copied ✓" : "Copy command"}
      </button>
    </Fold>
  );
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
  const link = (
    <a href={EXPLORER.explorerTx(result.txHash)} target="_blank" rel="noreferrer">
      View the transaction ↗
    </a>
  );
  return result.ok ? (
    <p className="success">✓ Done. {link}</p>
  ) : (
    <p className="error">
      The transaction failed, so nothing changed: {result.failures.map((f) => f.panic ?? f.message).join("; ")}. {link}
    </p>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error ? <p className="error">{error}</p> : <p className="muted">Loading from the chain…</p>;
}
