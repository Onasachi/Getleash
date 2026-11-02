"use client";

/**
 * Overview (PLAN §4.5; v2, docs/decisions.md D-28): read from the chain in this browser. v2 keeps
 * no ledger on-chain: the treasury is the token balance, and today's counters only go up.
 */
import Link from "next/link";

import { isOpen } from "@getleash/shared";

import { Loading, Pill } from "@/components/ui";
import { accessKeyCount, policy } from "@/lib/chain";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";

function Budget({ name, used, limit }: { name: string; used: string; limit: string }) {
  const u = BigInt(used);
  const l = BigInt(limit);
  const pct = l === 0n ? 0 : Number((u * 100n) / l);
  return (
    <div className="card">
      <div className="label">{name}</div>
      <div className="value">
        {usdc(used)} <span className="muted small">of {usdc(limit)}</span>
      </div>
      <div className="bar">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

export default function Overview() {
  const { data, error } = useChain(async () => {
    const state = await policy.state();
    const [balance, intents, suppliers, keys] = await Promise.all([
      policy.treasuryBalance(state.token_id),
      policy.recentIntents(50),
      policy.suppliers(),
      accessKeyCount(POLICY_ID),
    ]);
    return { state, balance, intents, suppliers, keys };
  });

  if (!POLICY_ID) return <p className="error">Set NEXT_PUBLIC_POLICY_CONTRACT_ID to the policy contract.</p>;
  if (!data) return <Loading error={error} />;
  const { state, balance, intents, suppliers, keys } = data;
  const d = state.token_decimals;
  const p = state.policy;
  const b = state.budgets;
  const open = intents.filter((i) => isOpen(i) || i.status === "FAILED");
  const recent = intents.filter((i) => !open.includes(i)).slice(-10).reverse();
  const supplier = new Map(suppliers.map((s) => [s.id, s]));

  const row = (i: (typeof intents)[number]) => {
    const s = supplier.get(i.supplier_id);
    return (
      <tr key={i.id}>
        <td>
          <Link href={`/intent/${i.id}`}>#{i.id}</Link>
        </td>
        <td>
          #{i.supplier_id} <span className="muted small">{s ? `${s.chain} ${s.recipient.slice(0, 18)}${s.recipient.length > 18 ? "…" : ""}` : ""}</span>
        </td>
        <td>{usdc(i.value, d)}</td>
        <td>
          <Pill value={i.status} /> {i.route !== "AUTONOMOUS" && <span className="muted small">{i.route}</span>}
        </td>
        <td className="small">{i.attempt ? `${usdc(i.attempt.amount_in, d)} → ${i.attempt.deposit.slice(0, 8)}…${i.attempt.authorized ? " (signed)" : ""}` : "—"}</td>
      </tr>
    );
  };

  return (
    <>
      <h1>Treasury {state.paused && <Pill value="PAUSED" />}</h1>
      <p className="muted small">
        Contract{" "}
        <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer" className="mono">
          {POLICY_ID}
        </a>{" "}
        · owner {state.owner_id} · agent {state.agent_id} · executor {state.executor_id} ·{" "}
        <span className={keys === 0 ? "success" : "error"}>{keys === 0 ? "no access keys on the contract ✓" : `${keys} access keys on the contract ✗`}</span>
      </p>

      <div className="grid">
        <div className="card">
          <div className="label">Treasury (USDC held by the contract)</div>
          <div className="value">{usdc(balance, d)}</div>
        </div>
        <div className="card">
          <div className="label">Payouts in flight</div>
          <div className="value">{state.paying}</div>
        </div>
        <div className="card">
          <div className="label">Stored intents</div>
          <div className="value">
            {state.stored_intents} <span className="muted small">of 50</span>
          </div>
        </div>
      </div>

      <h2>Today (UTC): counters only go up</h2>
      <div className="grid">
        <Budget name="Approved by the agent alone" used={b.autonomous} limit={p.autonomous_daily_budget} />
        <Budget name="Sent (daily cap)" used={b.outflow} limit={p.daily_cap} />
        <Budget name="Executor trust (cross-chain)" used={b.trust} limit={p.executor_trust_daily_budget} />
      </div>
      <p className="muted small">
        Payments above {usdc(p.approval_threshold, d)} wait for you. After an address change, every payment to that supplier waits for you for{" "}
        {Number(BigInt(p.cooldown_ns) / 3_600_000_000_000n)} h, and you can approve at most {usdc(p.cooldown_max, d)} until it ends.
      </p>

      <h2>Needs someone ({open.length})</h2>
      {open.length === 0 ? (
        <p className="muted">Nothing open.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Supplier</th>
              <th>Value</th>
              <th>Status</th>
              <th>1Click deposit</th>
            </tr>
          </thead>
          <tbody>{open.map(row)}</tbody>
        </table>
      )}

      <h2>Recent</h2>
      {recent.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Supplier</th>
              <th>Value</th>
              <th>Status</th>
              <th>1Click deposit</th>
            </tr>
          </thead>
          <tbody>{recent.map(row)}</tbody>
        </table>
      )}
      <p className="muted small">Refused proposals store nothing on-chain; they are returned to the agent and logged as events in its transactions.</p>
    </>
  );
}
