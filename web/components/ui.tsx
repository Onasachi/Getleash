"use client";

/**
 * The dashboard's shared pieces, in GetLeash's design system (Claude Design, stage 2, 5 Nov 2026): the
 * header and footer around every page, status chips, notices, folds, checks, the progress list, the
 * identifier block and the loading skeleton. Styles are in app/globals.css under the same class names.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

import type { Tone, TxOutcome } from "@getleash/shared";

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronIcon,
  CopyIcon,
  CrossIcon,
  ExternalIcon,
  InfoIcon,
  RefreshIcon,
  WalletIcon,
  WarningIcon,
} from "@/components/icons";
import { LeashMark, Wordmark } from "@/components/logo";
import { runsRelease } from "@/lib/chain";
import { EXPLORER, HOME_POLICY_ID, HOSTED, NETWORK, POLICY_ID } from "@/lib/config";
import { startTelegramMiniApp } from "@/lib/telegram";
import { useWallet } from "@/lib/wallet";

/** The header's pages. "Suppliers & invoices" reads the bot's private data, which only GetLeash's own instance has. */
const PAGES = [
  { href: "/payments", label: "Payments", here: (path: string) => path.startsWith("/payments") || path.startsWith("/intent"), own: false },
  { href: "/private", label: "Suppliers & invoices", here: (path: string) => path.startsWith("/private") || path.startsWith("/suppliers"), own: true },
  { href: "/pause", label: "Pause", here: (path: string) => path.startsWith("/pause"), own: false },
  { href: "/wallet", label: "Wallet", here: (path: string) => path.startsWith("/wallet"), own: false },
];

export function Shell({ children }: { children: ReactNode }) {
  const { accountId, connect, disconnect } = useWallet();
  const path = usePathname();
  useEffect(() => startTelegramMiniApp(), []);
  // A link can name a hosted business's contract (?c=, lib/config.ts), which only the browser knows: it is
  // shown after the first render, so that render matches the prerendered page.
  const [contract, setContract] = useState(HOME_POLICY_ID);
  const [release, setRelease] = useState<boolean | null>(null);
  useEffect(() => {
    setContract(POLICY_ID);
    if (HOSTED) void runsRelease(POLICY_ID).then(setRelease, () => undefined); // unchecked stays "checking"; signing re-checks (lib/wallet.tsx)
  }, []);
  const hosted = contract !== HOME_POLICY_ID;
  // The setup page connects the wallet itself, and its contract doesn't exist yet. "Try app" (/app) finds the
  // visitor's own GetLeash first, so until then no page names one: no tabs, and the logo leads home.
  const setup = path.startsWith("/setup");
  const entry = path === "/app";
  return (
    <>
      <header className={setup ? "top for-setup" : entry ? "top for-entry" : "top"}>
        <div className="top-in">
          <Link href={entry ? "/" : "/payments"} className="brand" aria-label="GetLeash">
            <LeashMark size={24} className="mark" />
            <Wordmark height={19} className="word" />
          </Link>
          {/* On a phone inside Telegram the bot's buttons open each page, so the row is hidden there (globals.css). */}
          <nav aria-label="Pages">
            {PAGES.filter((p) => !(p.own && hosted)).map((p) => (
              <Link key={p.href} href={p.href} aria-current={p.here(path) ? "page" : undefined}>
                {p.label}
              </Link>
            ))}
          </nav>
          <span className="spacer" />
          <div className="tools">
            {NETWORK !== "mainnet" && <span className="net">{NETWORK}</span>}
            {accountId ? (
              <span className="acct">
                <WalletIcon size={16} />
                <span className="name">{accountId}</span>
                <button title="Disconnect" aria-label={`Disconnect ${accountId}`} onClick={() => void disconnect()}>
                  <CrossIcon size={14} />
                </button>
              </span>
            ) : (
              <button className="connect" onClick={() => void connect()}>
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>
      <main>
        {hosted && release === false && (
          <Notice tone="bad" title="This isn't a GetLeash">
            <span className="mono">{contract}</span> doesn&apos;t run the GetLeash release. These pages sign nothing for it; don&apos;t send it anything.
          </Notice>
        )}
        {hosted && release === null && (
          <Notice tone="info">
            Checking that <span className="mono">{contract}</span> runs the GetLeash release. Nothing is signed for it until it does.
          </Notice>
        )}
        {children}
      </main>
      <footer>
        {setup || entry ? (
          <p>
            Everything here is read straight from the NEAR blockchain in your browser. Money moves only within the rules of your contract, and anything you approve is
            signed in your own wallet.
          </p>
        ) : (
          <p>
            Everything here is read straight from the NEAR blockchain in your browser. Money moves only within the rules of the contract{" "}
            {contract ? (
              <a href={EXPLORER.explorerAccount(contract)} target="_blank" rel="noreferrer">
                {contract}
              </a>
            ) : (
              "(not configured)"
            )}
            , and anything you approve is signed in your own wallet.
          </p>
        )}
      </footer>
    </>
  );
}

/** A warning band. The bad one (this isn't a GetLeash) can't be dismissed; info is for what is being checked. */
export function Notice({ tone = "warn", icon: Icon, title, children }: { tone?: "warn" | "bad" | "info"; icon?: typeof WarningIcon; title?: string; children: ReactNode }) {
  const Mark = Icon ?? (tone === "info" ? InfoIcon : WarningIcon);
  return (
    <div className={`notice iconed${tone === "warn" ? "" : ` ${tone}`}`} role={tone === "bad" ? "alert" : undefined}>
      <Mark size={tone === "bad" ? 20 : 18} />
      <div className="body">
        {title && <strong className="title">{title}</strong>}
        {children}
      </div>
    </div>
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

/** Where a payment is on its way, top to bottom, so six long steps fit on a phone. */
export function Progress({ steps }: { steps: Step[] }) {
  return (
    <section className="progress">
      <div className="label">Progress</div>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.label} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            <span className="dot">{s.state === "done" ? <CheckIcon size={13} /> : s.state === "bad" ? <CrossIcon size={13} /> : null}</span>
            <span className="text">{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A section that starts folded ("Show"), for details most people never need. */
export function Fold({ summary, open, className, children }: { summary: ReactNode; open?: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={className ? `fold ${className}` : "fold"} open={open}>
      <summary>
        <span className="sum">{summary}</span>
        <span className="toggle">
          <span className="when-closed">Show</span>
          <span className="when-open">Hide</span>
          <ChevronDownIcon size={16} className="when-closed" />
          <ChevronIcon size={16} className="when-open" />
        </span>
      </summary>
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
    <Fold className="term" open={open} summary="Or sign in a terminal (near-cli)">
      <p className="small muted">
        Paste it into your terminal and press Enter: it signs with the key near-cli keeps for {owner} and sends right away. This page updates by itself.
      </p>
      <pre className="cmd">{command}</pre>
      <button className="ghost" onClick={() => void copy()}>
        {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        {copied ? "Copied" : "Copy command"}
      </button>
    </Fold>
  );
}

/** Copies `text`; says "Copied" for two seconds. */
export function CopyButton({ text, label = "Copy the address" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? "icon-btn copied" : "icon-btn"}
      title="Copy"
      aria-label={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
    >
      {copied ? <CheckIcon size={16} /> : <CopyIcon size={18} />}
      {copied && "Copied"}
    </button>
  );
}

/**
 * An address to check against the wallet, always in full: in groups of four when it is hex or Tron (copying
 * gives the raw address), with a copy button and, on NEAR, a link to the explorer.
 */
export function Ident({ address, grouped, explorer, meta }: { address: string; grouped: boolean; explorer?: string; meta: ReactNode }) {
  const parts = grouped ? (address.match(/.{1,4}/g) ?? [address]) : [address];
  return (
    <div className="ident">
      <div className="meta">{meta}</div>
      <div className="row">
        <div className="addr">
          {parts.map((part, i) => (
            <span key={i}>{part}</span>
          ))}
        </div>
        <CopyButton text={address} />
        {explorer && (
          <a className="icon-btn" href={explorer} target="_blank" rel="noreferrer" title="Open in the explorer" aria-label="Open in the explorer">
            <ExternalIcon size={18} />
          </a>
        )}
      </div>
    </div>
  );
}

/** A button's label while the page waits (for the wallet, by default): the label changes and the icon turns slowly. */
export function Waiting({ label = "Waiting for your wallet…" }: { label?: string }) {
  return (
    <>
      <RefreshIcon size={18} className="spin" />
      {label}
    </>
  );
}

export function Check({ ok, label, detail, className }: { ok: boolean; label: string; detail?: ReactNode; className?: string }) {
  return (
    <div className={`check ${ok ? "ok" : "fail"}${className ? ` ${className}` : ""}`}>
      {ok ? <CheckIcon size={18} aria-label="Passed" aria-hidden={false} role="img" /> : <CrossIcon size={18} aria-label="Failed" aria-hidden={false} role="img" />}
      <span>
        {label}
        {detail !== undefined && <span className="detail">{detail}</span>}
      </span>
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
  if (error)
    return (
      <p className="note bad">
        <CrossIcon size={16} />
        <span>{error}</span>
      </p>
    );
  if (!result) return null;
  const link = (
    <a href={EXPLORER.explorerTx(result.txHash)} target="_blank" rel="noreferrer">
      View the transaction
      <ExternalIcon size={14} />
    </a>
  );
  return result.ok ? (
    <p className="note good">
      <CheckIcon size={18} />
      <span>Done. {link}</span>
    </p>
  ) : (
    <p className="note bad">
      <CrossIcon size={16} />
      <span>
        The transaction failed, so nothing changed: {result.failures.map((f) => f.panic ?? f.message).join("; ")}. {link}
      </span>
    </p>
  );
}

/** Until the chain answers: a skeleton of the hero, so the page doesn't jump when data lands. */
export function Loading({ error, text = "Loading from the chain…" }: { error: string | null; text?: string }) {
  if (error)
    return (
      <p className="note bad">
        <CrossIcon size={16} />
        <span>{error}</span>
      </p>
    );
  return (
    <section className="hero skeleton" aria-busy="true">
      <span className="sk sk-chip" />
      <span className="sk sk-title" />
      <span className="sk sk-amount" />
      <span className="sk sk-block" />
      <span className="sk-note">
        <RefreshIcon size={16} className="spin" />
        {text}
      </span>
    </section>
  );
}
