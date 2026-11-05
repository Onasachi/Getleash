"use client";

/**
 * Where "Try app" on the landing page leads: the visitor connects their wallet, and the page opens the
 * dashboard of the GetLeash that wallet owns. That is the dashboard's own GetLeash when this wallet owns it,
 * else the one the bot sets up for the account (named after it, docs/decisions.md D-30), or one the visitor
 * names. A wallet without one is sent to the bot to set it up. Nothing is signed here, and no other
 * business's GetLeash is shown.
 */
import { type FormEvent, useEffect, useState } from "react";

import { accountExists, canHost, defaultRoleIds, hostedIds, PolicyView } from "@getleash/shared";

import { ArrowIcon, CrossIcon, InfoIcon } from "@/components/icons";
import { Fold, Loading, Notice, StatusChip, Waiting } from "@/components/ui";
import { homePolicy, rpc, runsRelease } from "@/lib/chain";
import { HOME_POLICY_ID } from "@/lib/config";
import { plainError } from "@/lib/owner-action";
import { openTelegramLink } from "@/lib/telegram";
import { useWallet } from "@/lib/wallet";

const BOT_URL = `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT || "GetLeash_bot"}`;
const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/** Whether `contract` is a GetLeash (it runs the release) owned by `account`; why not, in words, if it isn't. */
async function ownedBy(contract: string, account: string): Promise<string | null> {
  if (!(await accountExists(rpc, contract))) return `There is no account called ${contract}.`;
  if (!(await runsRelease(contract))) return `${contract} doesn't run the GetLeash release, so it isn't a GetLeash.`;
  const owner = (await new PolicyView(rpc, contract).state()).owner_id;
  return owner === account ? null : `${contract} belongs to ${owner}, not ${account}.`;
}

/**
 * The GetLeash `account` owns: the dashboard's own, else the one the bot sets up for it (`<account, dots made
 * dashes>.getleash.near`), else one it set up itself (`getleash.<account>`, scripts' setup:owner); null if none.
 */
async function findGetLeash(account: string): Promise<string | null> {
  if (HOME_POLICY_ID && (await homePolicy.state()).owner_id === account) return HOME_POLICY_ID;
  const named = [...(canHost(account) ? [hostedIds(account).policyId] : []), defaultRoleIds(account).policyId];
  for (const contract of named) {
    if ((await ownedBy(contract, account)) === null) return contract;
  }
  return null;
}

/** Opens the dashboard for `contract`. A full load: the pages read which contract to show once, when they load (lib/config.ts). */
function openDashboard(contract: string) {
  window.location.replace(`/payments?c=${encodeURIComponent(contract)}`);
}

export default function OpenYourGetLeash() {
  const wallet = useWallet();
  const account = wallet.accountId;
  const [result, setResult] = useState<{ account: string; contract: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setError(null);
    setResult(null);
    findGetLeash(account).then(
      (contract) => {
        if (cancelled) return;
        setResult({ account, contract });
        if (contract) openDashboard(contract);
      },
      (e: unknown) => {
        if (!cancelled) setError(plainError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [account]);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      await wallet.connect();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setConnecting(false);
    }
  }

  async function openTyped(event: FormEvent) {
    event.preventDefault();
    const contract = typed.trim().toLowerCase();
    if (!account) return;
    if (!NEAR_ACCOUNT.test(contract)) {
      setTypedError("That isn't a NEAR account name, like yourname.getleash.near.");
      return;
    }
    setTypedError(null);
    try {
      const why = await ownedBy(contract, account);
      if (why) setTypedError(why);
      else openDashboard(contract);
    } catch (e) {
      setTypedError(plainError(e));
    }
  }

  const setUp = (
    <button className="primary" onClick={() => openTelegramLink(BOT_URL)}>
      Set up in Telegram
      <ArrowIcon size={18} />
    </button>
  );

  if (!account) {
    return (
      <div className="setup">
        <section className="hero">
          <StatusChip label="Your dashboard" tone="plain" />
          <h1>Open your GetLeash</h1>
          <p className="lead">Connect the wallet that owns your GetLeash to see your payments. Connecting signs nothing.</p>
          <div className="actions">
            <button className={connecting ? "primary busy" : "primary"} disabled={connecting} onClick={() => void connect()}>
              {connecting ? <Waiting /> : "Connect your wallet"}
            </button>
          </div>
          <p className="hint">
            No GetLeash yet?{" "}
            <button className="link" onClick={() => openTelegramLink(BOT_URL)}>
              Set it up in Telegram
            </button>
          </p>
          {error && (
            <p className="note bad">
              <CrossIcon size={16} />
              <span>{error}</span>
            </p>
          )}
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="setup">
        <Loading error={error} />
      </div>
    );
  }

  if (!result || result.account !== account || result.contract) {
    return (
      <div className="setup">
        <Loading error={null} text={result?.contract ? "Opening your dashboard…" : "Finding your GetLeash…"} />
      </div>
    );
  }

  return (
    <div className="setup">
      <section className="hero">
        <StatusChip label="Not set up yet" tone="warn" />
        <h1>No GetLeash for {account} yet</h1>
        <p className="lead">Set one up in Telegram in a few minutes; the bot walks you through it.</p>
        <div className="actions">
          {setUp}
          <button className="ghost" onClick={() => void wallet.disconnect()}>
            Use another account
          </button>
        </div>
        <Fold summary="Set yours up another way? Open it by name">
          <form className="actions" onSubmit={(e) => void openTyped(e)}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="yourname.getleash.near" aria-label="Your GetLeash contract" />
            <button type="submit">Open</button>
          </form>
          {typedError && (
            <Notice tone="warn" icon={InfoIcon}>
              {typedError}
            </Notice>
          )}
        </Fold>
      </section>
    </div>
  );
}
