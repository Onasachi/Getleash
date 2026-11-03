"use client";

/**
 * The page the bot's /wallet opens: connect the wallet the owner approves payments with (inside Telegram,
 * HOT Wallet directly) and check that it signs as the contract's owner, with NEAR for network fees.
 * Connecting sends no transaction and pays nothing, but it goes the same way an approval does, so it
 * shows the wallet works here before a payment depends on it.
 */
import Link from "next/link";
import { useState } from "react";

import { HOT_WALLET_TELEGRAM, moneyRounded } from "@getleash/shared";

import { Check, Loading, StatusChip } from "@/components/ui";
import { policy, rpc } from "@/lib/chain";
import { plainError } from "@/lib/owner-action";
import { inTelegram, openTelegramLink } from "@/lib/telegram";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

/** Each approval costs well under 0.01 NEAR in network fees; 0.05 NEAR covers many. */
const ENOUGH_NEAR = 5n * 10n ** 22n;

/** What the owner can spend on fees: its balance less what its storage locks (10^19 yoctoNEAR per byte). */
async function spendableNear(accountId: string): Promise<bigint | null> {
  try {
    const account = (await rpc.viewAccount({ accountId })) as unknown as { amount: string; storage_usage: number };
    const free = BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
    return free > 0n ? free : 0n;
  } catch {
    return null;
  }
}

export default function WalletPage() {
  const { data, error: loadError } = useChain(async () => {
    const owner = (await policy.state()).owner_id;
    return { owner, near: await spendableNear(owner) };
  });
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <Loading error={loadError} />;
  const { owner, near } = data;
  const telegram = inTelegram();
  const account = wallet.accountId;

  async function connect(again = false) {
    setBusy(true);
    setError(null);
    try {
      if (again) await wallet.disconnect();
      await wallet.connect();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <section className="hero">
        <StatusChip label="Not connected" tone="warn" />
        <h1>Check your wallet</h1>
        <p className="lead">
          Payments you approve are signed in your wallet, as <span className="mono">{owner}</span>. Connect it to see that it&apos;s ready. Connecting pays
          nothing.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void connect()}>
            {busy ? "Waiting for your wallet…" : telegram ? "Connect HOT Wallet" : "Connect wallet"}
          </button>
        </div>
        {telegram && (
          <p className="hint">
            HOT Wallet not set up yet?{" "}
            <a
              href={HOT_WALLET_TELEGRAM}
              onClick={(e) => {
                e.preventDefault();
                openTelegramLink(HOT_WALLET_TELEGRAM);
              }}
            >
              Open HOT Wallet
            </a>
            , choose to import a wallet and enter the recovery phrase of {owner}, then come back here.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (account !== owner) {
    return (
      <section className="hero">
        <StatusChip label="Wrong account" tone="bad" />
        <h1>This isn&apos;t the owner&apos;s account</h1>
        <p className="lead">
          Your wallet is connected as <span className="mono">{account}</span>, but only <span className="mono">{owner}</span> can approve payments.{" "}
          {telegram ? `In HOT Wallet, switch to ${owner} (or import it with its recovery phrase), then connect again.` : `Switch to ${owner} in your wallet, then connect again.`}
        </p>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void connect(true)}>
            {busy ? "Waiting for your wallet…" : "Connect again"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  // An unreadable balance does not hold the owner back; a low one would make approvals fail.
  const enough = near === null || near >= ENOUGH_NEAR;
  return (
    <section className="hero">
      <StatusChip label={enough ? "Ready" : "Almost ready"} tone={enough ? "good" : "warn"} />
      <h1>{enough ? "Your wallet is ready" : "Add a little NEAR for fees"}</h1>
      <p className="lead">
        {enough
          ? "When the bot asks for your OK, tap its button and confirm in your wallet."
          : `Each approval needs a little NEAR for network fees. Send at least 0.05 NEAR to ${owner}.`}
      </p>
      <Check ok label={`Signs as ${owner}, the owner of your GetLeash contract`} />
      {near !== null && <Check ok={enough} label={`${moneyRounded(near, 24)} NEAR for network fees`} />}
      <div className="actions">
        <Link href="/">See payments</Link>
        <button className="ghost" onClick={() => void wallet.disconnect()}>
          Disconnect
        </button>
      </div>
    </section>
  );
}
