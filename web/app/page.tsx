"use client";

/**
 * The owner's overview (PLAN §4.5; v2, docs/decisions.md D-28): the treasury, what needs the owner,
 * and recent payments, in plain words. Read from the chain in this browser. v2 keeps no ledger
 * on-chain: the treasury is the token balance, and today's counters only go up. How the money is
 * protected (the contract's limits, roles and keys) is one click away.
 */
import Link from "next/link";

import {
  assetName,
  durationText,
  type ExecutionStatus,
  type Intent,
  isExpired,
  isNative,
  money,
  moneyRounded,
  paymentState,
  shortAddress,
  type Supplier,
  TERMINAL_STATUSES,
  waitReason,
} from "@getleash/shared";

import { ArrowIcon, CheckIcon, CrossIcon, PauseIcon } from "@/components/icons";
import { Fold, Loading, Notice, StatusChip } from "@/components/ui";
import { accessKeyCount, oneclick, policy } from "@/lib/chain";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { whenText } from "@/lib/format";
import { useSupplierNames } from "@/lib/names";
import { useChain } from "@/lib/use-chain";

async function load() {
  const state = await policy.state();
  const [balance, intents, suppliers, keys] = await Promise.all([
    policy.treasuryBalance(state.token_id),
    policy.recentIntents(50),
    policy.suppliers(),
    accessKeyCount(POLICY_ID),
  ]);
  // 1Click's word on recent cross-chain payouts: delivered, refunded, or still on its way.
  const swaps = new Map<number, string>();
  await Promise.all(
    intents
      .filter((i) => i.status === "PAID" && i.attempt)
      .slice(-10)
      .map(async (i) => {
        try {
          swaps.set(i.id, (await oneclick.status(i.attempt!.deposit)).status);
        } catch {
          // Unreachable: shown as "On its way" until the payment page can check.
        }
      }),
  );
  return { state, balance, intents, suppliers, keys, swaps };
}

type Task = { intent: Intent; line: string; cta: string };

/** How much of a daily limit is used, as a bar (design system, stage 2). */
function Meter({ label, used, cap, decimals, brand }: { label: string; used: string; cap: string; decimals: number; brand?: boolean }) {
  const limit = BigInt(cap);
  const share = limit > 0n ? Number((BigInt(used) * 1000n) / limit) / 10 : 0;
  return (
    <div className="meter">
      <div className="meter-row">
        <span>{label}</span>
        <span>
          <strong>{moneyRounded(used, decimals)}</strong> <span className="muted">of {moneyRounded(cap, decimals)} USDC</span>
        </span>
      </div>
      <div className="bar" role="presentation">
        <span className={brand ? "fill brand" : "fill"} style={{ width: `${Math.min(100, share)}%` }} />
      </div>
    </div>
  );
}

export default function Overview() {
  const { names, available } = useSupplierNames();
  const { data, error } = useChain(load);

  if (!POLICY_ID) return <p className="error">Set NEXT_PUBLIC_POLICY_CONTRACT_ID to the policy contract.</p>;
  if (!data) return <Loading error={error} />;
  const { state, balance, intents, suppliers, keys, swaps } = data;
  const d = state.token_decimals;
  const p = state.policy;
  const b = state.budgets;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const who = (i: Intent) => names.get(i.supplier_id) ?? (byId.get(i.supplier_id) ? shortAddress(byId.get(i.supplier_id)!.recipient) : `supplier #${i.supplier_id}`);
  const amount = (i: Intent, s: Supplier | undefined) => (s ? `${money(i.amount_out, s.decimals)} ${assetName(s, state.token_id)}` : `${money(i.value, d)}`);
  const refunded = (i: Intent) => {
    const swap = swaps.get(i.id);
    return !!swap && swap !== "SUCCESS" && TERMINAL_STATUSES.has(swap as ExecutionStatus);
  };

  const tasks: Task[] = [];
  for (const i of intents) {
    const pastGrace = i.status === "PAYING" && nowNs >= BigInt(i.since) + BigInt(p.callback_grace_ns);
    if (i.status === "PENDING" && !isExpired(i, p, nowNs)) tasks.push({ intent: i, line: `Needs your OK: ${waitReason(i.route, p, d)}.`, cta: "Review" });
    else if (i.status === "APPROVED" && i.attempt && !i.attempt.authorized)
      tasks.push({ intent: i, line: `Ready to send: confirm ${money(i.attempt.amount_in, d)} USDC from your treasury.`, cta: "Confirm" });
    else if (i.status === "FAILED") tasks.push({ intent: i, line: "Didn't go through: nothing left your treasury.", cta: "Try again" });
    else if (refunded(i)) tasks.push({ intent: i, line: "Not delivered: the USDC came back to your treasury.", cta: "Try again" });
    else if (pastGrace) tasks.push({ intent: i, line: "The transfer has not confirmed: please check it.", cta: "Check" });
  }
  const taskIds = new Set(tasks.map((t) => t.intent.id));
  const recent = intents
    .filter((i) => !taskIds.has(i.id))
    .slice(-12)
    .reverse();

  return (
    <>
      <section className="hero">
        <div className="label">Treasury</div>
        <div className="amount" title={`${money(balance, d)} USDC exactly`}>
          {moneyRounded(balance, d)} USDC
        </div>
        <div className="meters">
          <Meter label="Sent today" used={b.outflow} cap={p.daily_cap} decimals={d} />
          <Meter label="Paid by the agent on its own" used={b.autonomous} cap={p.autonomous_daily_budget} decimals={d} brand />
        </div>
        <p className="lead small">Above {money(p.approval_threshold, d)} USDC, a payment waits for you.</p>
        {state.paused && (
          <Notice icon={PauseIcon}>
            Payments are paused. <Link href="/pause">Unpause</Link>
          </Notice>
        )}
      </section>

      <h2>Needs you{tasks.length > 0 && ` (${tasks.length})`}</h2>
      {tasks.length === 0 ? (
        <div className="card calm">
          <CheckIcon size={18} />
          Nothing needs you right now.
        </div>
      ) : (
        tasks.map(({ intent: i, line, cta }) => (
          <Link key={i.id} href={`/intent/${i.id}`} className="task">
            <div>
              <div>
                <strong>{who(i)}</strong> · {amount(i, byId.get(i.supplier_id))}
              </div>
              <div className="muted small">{line}</div>
            </div>
            <span className="go">
              {cta}
              <ArrowIcon size={16} />
            </span>
          </Link>
        ))
      )}

      <h2>Recent payments</h2>
      {recent.length === 0 ? (
        <p className="muted">None yet. Send an invoice to the bot to start.</p>
      ) : (
        <ul className="payments">
          {recent.map((i) => {
            const s = byId.get(i.supplier_id);
            return (
              <li key={i.id}>
                <Link href={`/intent/${i.id}`}>
                  <StatusChip {...paymentState(i, !!s && isNative(s, state.token_id), swaps.get(i.id))} />
                  <span className="who">
                    {who(i)}
                    {i.route === "AUTONOMOUS" && <span className="muted small"> · paid by the agent</span>}
                  </span>
                  <span className="amt">{amount(i, s)}</span>
                  <span className="when">{whenText(i.since)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!available && (
        <p className="muted small">
          Supplier names are private: <Link href="/private">sign in</Link> to see them instead of addresses.
        </p>
      )}

      <Fold summary="How your money is protected">
        <ul className="rules">
          <li>
            {keys === 0 ? <CheckIcon size={16} className="inline-icon tone-good" /> : <CrossIcon size={16} className="inline-icon tone-bad" />}
            The treasury is held by a contract with <strong>{keys === 0 ? "no keys" : `${keys} access keys`}</strong>: only its rules move
            money, and only you can change them.
          </li>
          <li>
            The agent can pay on its own up to {money(p.approval_threshold, d)} USDC per payment and {money(p.autonomous_daily_budget, d)} USDC per day. Everything
            else waits for you.
          </li>
          <li>At most {money(p.daily_cap, d)} USDC can leave per day, whoever approves it.</li>
          <li>
            Only suppliers on your list can be paid, and only to the address on file. When an address changes, payments to that supplier wait for you for{" "}
            {durationText(p.cooldown_ns)}, and you can approve at most {money(p.cooldown_max, d)} USDC until then.
          </li>
          <li>
            {BigInt(p.executor_trust_daily_budget) === 0n
              ? "You confirm every cross-chain transfer yourself."
              : `The executor may send up to ${money(p.executor_trust_daily_budget, d)} USDC of cross-chain transfers per day on its own; you confirm the rest.`}
          </li>
        </ul>
        <p className="muted small">
          Contract{" "}
          <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer" className="mono">
            {POLICY_ID}
          </a>{" "}
          · owner {state.owner_id} · agent {state.agent_id} · executor {state.executor_id} · {state.paying} payment(s) in flight ·{" "}
          {state.stored_intents} of 50 payment slots in use
        </p>
      </Fold>
    </>
  );
}
