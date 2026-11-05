"use client";

/**
 * The owner's limits: what the agent may pay alone, the daily cap, the wait after a supplier's address
 * changes, and the executor's cross-chain allowance. Changing them is one owner signature (`set_policy`, the
 * whole policy with these fields changed; shared/src/limits.ts), checked here by the contract's own rules
 * first, so the wallet only ever shows a call the contract takes. Every other field stays exactly as it is.
 */
import { useEffect, useState } from "react";

import { applyLimits, changedLimits, LIMIT_FIELDS, type LimitsForm, limitsForm, loosens } from "@getleash/shared";

import { CrossIcon, InfoIcon, WalletIcon, WarningIcon } from "@/components/icons";
import { Fold, Loading, StatusChip, TerminalOption, TxNote, Waiting } from "@/components/ui";
import { policy } from "@/lib/chain";
import { nearCliCommand } from "@/lib/cli";
import { useOwnerAction } from "@/lib/owner-action";
import { useChain } from "@/lib/use-chain";

const MAIN = LIMIT_FIELDS.filter((f) => f.key !== "crossChainPerDay");
const CROSS = LIMIT_FIELDS.filter((f) => f.key === "crossChainPerDay");

export default function LimitsPage() {
  const { data, error: loadError, reload } = useChain(() => policy.state());
  const { busy, result, error, run, wallet } = useOwnerAction(data?.owner_id, reload);
  const [form, setForm] = useState<LimitsForm | null>(null);
  // Filled from the chain on load, and again once a change has gone through.
  useEffect(() => {
    if (data && (form === null || result?.ok)) setForm(limitsForm(data.policy, data.token_decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, result]);

  if (!data || !form) return <Loading error={loadError} />;
  const d = data.token_decimals;
  const current = limitsForm(data.policy, d);
  const changed = changedLimits(current, form, d);
  const applied = applyLimits(data.policy, form, d);
  const ready = changed.length > 0 && applied.policy !== null;
  const wrongAccount = !!wallet.accountId && wallet.accountId !== data.owner_id;

  const field = (f: (typeof LIMIT_FIELDS)[number]) => (
    <label key={f.key} className={changed.includes(f.key) ? "field changed" : "field"}>
      <span className="field-text">
        <span className="field-label">{f.label}</span>
        <span className="field-help">{f.help}</span>
      </span>
      <span className="field-input">
        <input inputMode="decimal" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} aria-label={f.label} />
        <span className="unit">{f.unit}</span>
      </span>
    </label>
  );

  return (
    <div className="single">
      <section className="hero">
        <StatusChip label={data.paused ? "Payments paused" : "Your limits"} tone={data.paused ? "bad" : "plain"} />
        <h1>Your limits</h1>
        <p className="lead">Only your wallet can change them, and they apply at once.</p>

        <div className="fields">{MAIN.map(field)}</div>
        <Fold summary="Cross-chain payments" open={changed.includes("crossChainPerDay")}>
          <div className="fields">{CROSS.map(field)}</div>
        </Fold>

        {changed.length > 0 && (
          <ul className="changes">
            {changed.map((key) => {
              const f = LIMIT_FIELDS.find((x) => x.key === key)!;
              return (
                <li key={key}>
                  <span>{f.label}</span>
                  <span className="mono">
                    {current[key]} → {form[key].trim() || "?"} {f.unit}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {applied.problem && (
          <p className="note bad">
            <WarningIcon size={16} />
            <span>{applied.problem}</span>
          </p>
        )}
        {applied.policy && changed.length > 0 && loosens(data.policy, applied.policy) && (
          <p className="note">
            <InfoIcon size={16} />
            <span>This lets more go out without your OK.</span>
          </p>
        )}

        <div className="actions">
          <button
            className={busy ? "primary busy" : "primary"}
            disabled={!ready || !!busy || wrongAccount}
            onClick={() => applied.policy && void run("save", "set_policy", applied.policy, 30)}
          >
            {busy ? <Waiting /> : changed.length > 0 ? "Save limits" : "No changes yet"}
          </button>
          {changed.length > 0 && !busy && (
            <button className="ghost" onClick={() => setForm(current)}>
              Undo changes
            </button>
          )}
        </div>
        {!wallet.accountId && (
          <p className="note soft sign">
            <WalletIcon size={16} />
            <span>You&apos;ll sign in your wallet, as {data.owner_id}.</span>
          </p>
        )}
        {wrongAccount && (
          <p className="note bad">
            <CrossIcon size={16} />
            <span>
              You&apos;re connected as {wallet.accountId}; only the owner, {data.owner_id}, can change limits.{" "}
              <button className="link" onClick={() => void wallet.disconnect()}>
                Use another account
              </button>
            </span>
          </p>
        )}
        <TxNote result={result} error={error} />
        {ready && applied.policy && (
          <TerminalOption
            command={nearCliCommand(data.owner_id, "set_policy", applied.policy, 30)}
            owner={data.owner_id}
            open={wallet.walletId === "near-cli"}
            onCopied={() => void setTimeout(() => void reload(), 15_000)}
          />
        )}
      </section>
    </div>
  );
}
