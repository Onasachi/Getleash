"use client";

/**
 * Adds a supplier (docs/decisions.md D-29): the page the bot's "Add …" button opens, for an address the
 * owner sent the bot (/addsupplier) or a supplier answered an invite with (/invite). It also works on its
 * own, with the address typed here. Everything is checked in this browser against the chain: the format
 * (Tron checksum), that a NEAR account exists and is not one of GetLeash's own, and that it is not on the
 * list yet. The owner's wallet then signs `add_supplier` with exactly these terms, after registering a
 * NEAR account on USDC when it is not (the contract pays registered accounts only). The supplier's name
 * stays with the bot, which saves it once the supplier is on-chain; it never travels in this page's link.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { decodeU32, durationText, FT_STORAGE_DEPOSIT, money, paidAt, type Payee, payeeOf, supplierTerms, USDT_TRON_CONTRACT } from "@getleash/shared";

import { Check, Loading, StatusChip, TerminalOption } from "@/components/ui";
import { policy, rpc } from "@/lib/chain";
import { nearCliCommand } from "@/lib/cli";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { plainError } from "@/lib/owner-action";
import { closeMiniApp, inTelegram } from "@/lib/telegram";
import { useChain } from "@/lib/use-chain";
import { type Call, useWallet } from "@/lib/wallet";

async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc.viewAccount({ accountId });
    return true;
  } catch (e) {
    if (/does not exist/i.test((e as Error).message)) return false;
    throw e;
  }
}

async function load(payee: Payee | null) {
  const [state, suppliers] = await Promise.all([policy.state(), policy.suppliers()]);
  if (!payee) return { state, payee, check: null };
  const terms = supplierTerms(payee, state);
  const listed = suppliers.find((s) => s.chain === terms.chain && s.asset_id === terms.asset_id && s.recipient === terms.recipient) ?? null;
  const own = [POLICY_ID, state.token_id, state.owner_id, state.agent_id, state.executor_id, USDT_TRON_CONTRACT].includes(payee.recipient);
  let exists = true;
  let registered = true;
  if (payee.chain === "NEAR" && !own) {
    // An implicit account (64 hex) is valid before it exists: whoever holds its key controls it.
    exists = /^[0-9a-f]{64}$/.test(payee.recipient) || (await accountExists(payee.recipient));
    registered = exists && (await rpc.callFunction({ contractId: state.token_id, method: "storage_balance_of", args: { account_id: payee.recipient } })) != null;
  }
  return { state, payee, check: { terms, listed, own, exists, registered } };
}

export default function NewSupplierPage() {
  return (
    <Suspense fallback={<Loading error={null} />}>
      <NewSupplier />
    </Suspense>
  );
}

function NewSupplier() {
  const given = useSearchParams().get("to") ?? "";
  const [typed, setTyped] = useState(given);
  const [address, setAddress] = useState(given.trim());
  const wanted = address ? payeeOf(address) : null;
  const { data, error: loadError, reload } = useChain(() => load(wanted), [wanted?.recipient ?? ""]);
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: number | null; txHash: string } | null>(null);
  // Until the checks for the address just typed are in, show nothing to sign: the terms, the checks and
  // the address on the page always belong together.
  if (!data || (data.payee?.recipient ?? null) !== (wanted?.recipient ?? null)) return <Loading error={loadError} />;
  const { state, check, payee } = data;
  const telegram = inTelegram();
  const cooldown = BigInt(state.policy.cooldown_ns) > 0n;

  if (added) {
    return (
      <section className="hero">
        <StatusChip label="Added" tone="good" />
        <h1>{added.id !== null ? `Supplier #${added.id} is on your list` : "The supplier is on your list"}</h1>
        <p className="lead">
          {payee ? `Paid in ${paidAt(payee)}. ` : ""}
          {telegram ? "The bot confirms it in the chat in a few seconds, with the name you gave it." : "The bot confirms it in Telegram in a few seconds, with the name you gave it."}
        </p>
        <div className="actions">
          {telegram ? (
            <button className="primary" onClick={() => closeMiniApp()}>
              Back to the chat
            </button>
          ) : (
            <Link href="/">See payments</Link>
          )}
          <a href={EXPLORER.explorerTx(added.txHash)} target="_blank" rel="noreferrer">
            View the transaction ↗
          </a>
        </div>
      </section>
    );
  }

  const form = (
    <form
      className="actions"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setAddress(typed.trim());
      }}
    >
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="acme.near or T…"
        aria-label="Their NEAR account or Tron address"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        style={{ flex: "1 1 260px", minWidth: 0 }}
      />
      <button type="submit">Check</button>
    </form>
  );

  if (!payee || !check) {
    return (
      <section className="hero">
        <StatusChip label="New supplier" tone="plain" />
        <h1>Add a supplier</h1>
        <p className="lead">
          Their NEAR account (paid in USDC) or their Tron address (paid in USDT). Use the address they gave you themselves, not one copied from an invoice:
          invoices can be faked.
        </p>
        {form}
        {address && <p className="error">That&apos;s not a NEAR account (like acme.near) or a Tron address (T…, 34 characters, with a valid checksum).</p>}
        <p className="hint">In Telegram, /addsupplier and /invite bring you here with the address filled in, and the bot keeps the supplier&apos;s name.</p>
      </section>
    );
  }

  const { terms, listed, own, exists, registered } = check;
  const recipient = payee.recipient;
  const blocked = own || !exists || !!listed;
  const calls: Call[] = [
    ...(payee.chain === "NEAR" && !registered
      ? [{ receiverId: state.token_id, method: "storage_deposit", args: { account_id: recipient, registration_only: true }, tgas: 30, deposit: FT_STORAGE_DEPOSIT.toString() }]
      : []),
    { receiverId: POLICY_ID, method: "add_supplier", args: terms, tgas: 30, deposit: "1" },
  ];
  const commands = calls
    .map((c) =>
      nearCliCommand(state.owner_id, c.method, c.args, c.tgas, c.method === "storage_deposit" ? { receiver: c.receiverId, deposit: "0.00125 NEAR" } : {}),
    )
    .join(" && \\\n");

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const account = wallet.accountId ?? (await wallet.connect());
      if (!account) return;
      if (account !== state.owner_id) throw new Error(`You're connected as ${account}. Only the owner, ${state.owner_id}, can add suppliers.`);
      const outcomes = await wallet.sendCalls(calls);
      const last = outcomes.at(-1)!;
      if (!last.ok) {
        throw new Error(`The transaction failed, so nothing was added: ${last.failures.map((f) => f.panic ?? f.message).join("; ")}`);
      }
      let id: number | null = null;
      try {
        id = last.bytes ? decodeU32(last.bytes) : null;
      } catch {
        // Some wallets return the outcome without the result; the bot reads the id from the chain anyway.
      }
      setAdded({ id, txHash: last.txHash });
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
      await reload();
    }
  }

  return (
    <section className="hero">
      <StatusChip label={blocked ? "Can't add" : "New supplier"} tone={blocked ? "bad" : "plain"} />
      <h1>Add a supplier</h1>
      <p className="lead">
        Paid in {payee.chain === "NEAR" ? "USDC" : "USDT on Tron"} at <span className="mono">{recipient}</span>.
      </p>
      <Check ok label={payee.chain === "NEAR" ? "A NEAR account" : "A Tron address, with a valid checksum"} />
      {payee.chain === "NEAR" && !own && (
        <Check ok={exists} label={exists ? "The account exists" : `There is no NEAR account called ${recipient}: check the spelling with them`} />
      )}
      <Check
        ok={!own}
        label={
          own
            ? recipient === USDT_TRON_CONTRACT
              ? "That's the USDT token's own address on Tron, not a wallet"
              : `${recipient} is one of this GetLeash's own accounts, so it can't be a supplier`
            : "Not one of GetLeash's own accounts"
        }
      />
      <Check ok={!listed} label={listed ? `Already on your list as supplier #${listed.id}` : "Not on your list yet"} />
      {payee.chain === "NEAR" && exists && !own && !listed && (
        <Check ok label={registered ? "Can already receive USDC" : "Gets registered on USDC first, so it can receive it (0.00125 NEAR, paid by you)"} />
      )}
      {!blocked && (
        <p className="lead small">
          {cooldown
            ? `For the first ${durationText(state.policy.cooldown_ns)}, every payment to them waits for your OK and can be at most ${money(state.policy.cooldown_max, state.token_decimals)} USDC: send a small test payment and check with them that it arrived. `
            : ""}
          {payee.chain === "TRON" ? "Payments to Tron go through NEAR Intents, which charges a network fee on each one. " : ""}
          Adding them costs a network fee of well under 0.01 NEAR.
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || blocked} onClick={() => void add()}>
          {busy ? "Waiting for your wallet…" : "Add supplier"}
        </button>
      </div>
      {!wallet.accountId && !blocked && <p className="hint">You&apos;ll sign in your wallet, as {state.owner_id}.</p>}
      {error && <p className="error">{error}</p>}
      {!blocked && <TerminalOption command={commands} owner={state.owner_id} open={wallet.walletId === "near-cli"} onCopied={() => void setTimeout(() => void reload(), 15_000)} />}
      <details className="fold">
        <summary className="small">A different address?</summary>
        <div className="fold-body">{form}</div>
      </details>
    </section>
  );
}
