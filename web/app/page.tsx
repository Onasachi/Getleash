"use client";

import Link from "next/link";

import { routeReason, type BudgetLine } from "@getleash/shared";

import { Loading, Pill } from "@/components/ui";
import { accessKeyCount, policy, tokenBalance } from "@/lib/chain";
import { EXPLORER, POLICY_ID } from "@/lib/config";
import { nsToDate, usdc } from "@/lib/format";
import { useChain } from "@/lib/use-chain";

function Budget({ name, line }: { name: string; line: BudgetLine }) {
  const used = BigInt(line.used);
  const limit = BigInt(line.limit);
  const pct = limit === 0n ? 0 : Number((used * 100n) / limit);
  return (
    <div className="card">
      <div className="label">{name}</div>
      <div className="value">
        {usdc(line.used)} <span className="muted small">of {usdc(line.limit)}</span>
      </div>
      <div className="bar">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

export default function Overview() {
  const { data, error } = useChain(async () => {
    const [config, ledger, budgets, work, rejections, keys] = await Promise.all([
      policy.config(),
      policy.ledger(),
      policy.budgetsToday(),
      policy.openWork(),
      policy.recentRejections(),
      accessKeyCount(POLICY_ID),
    ]);
    const balance = await tokenBalance(config.treasury_token, POLICY_ID);
    return { config, ledger, budgets, work, rejections, keys, balance };
  });

  if (!POLICY_ID) return <p className="error">Set NEXT_PUBLIC_POLICY_CONTRACT_ID to the policy contract.</p>;
  if (!data) return <Loading error={error} />;
  const { config, ledger, budgets, work, rejections, keys, balance } = data;
  const d = config.treasury_decimals;
  const unreconciled = balance - BigInt(ledger.cash);

  return (
    <>
      <h1>
        Treasury{" "}
        {config.paused && <Pill value="PAUSED" />}
        {config.hosted_mode && <span className="pill">hosted mode</span>}
      </h1>
      <p className="muted small">
        Contract{" "}
        <a href={EXPLORER.explorerAccount(POLICY_ID)} target="_blank" rel="noreferrer" className="mono">
          {POLICY_ID}
        </a>{" "}
        · owner {config.owner_id} · agent {config.agent_id} · executor {config.executor_id} ·{" "}
        <span className={keys === 0 ? "success" : "error"}>{keys === 0 ? "no access keys on the contract ✓" : `${keys} access keys on the contract ✗`}</span>
      </p>

      <div className="grid">
        <div className="card">
          <div className="label">Cash (recognised)</div>
          <div className="value">{usdc(ledger.cash, d)}</div>
        </div>
        <div className="card">
          <div className="label">Reserved (approved, unfunded)</div>
          <div className="value">{usdc(ledger.reserved, d)}</div>
        </div>
        <div className="card">
          <div className="label">In flight</div>
          <div className="value">{usdc(ledger.in_flight, d)}</div>
        </div>
        <div className="card">
          <div className="label">Available</div>
          <div className="value">{usdc(budgets.available, d)}</div>
        </div>
        <div className="card">
          <div className="label">Unreconciled inflow</div>
          <div className="value">{usdc(unreconciled, d)}</div>
          {unreconciled > 0n && (
            <Link href="/reconcile" className="small">
              attribute it →
            </Link>
          )}
        </div>
      </div>

      <h2>Budgets today (UTC)</h2>
      <div className="grid">
        <Budget name="Autonomous (agent alone)" line={budgets.autonomous} />
        <Budget name="Daily cap" line={budgets.daily} />
        <Budget name="Monthly cap" line={budgets.monthly} />
        <Budget name="Executor trust (cross-chain)" line={budgets.executor_trust} />
      </div>

      <h2>Open payments ({work.length})</h2>
      {work.length === 0 ? (
        <p className="muted">Nothing open.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Supplier</th>
              <th>Amount out</th>
              <th>Max in</th>
              <th>Status</th>
              <th>Attempt</th>
            </tr>
          </thead>
          <tbody>
            {work.map(({ intent, attempt }) => (
              <tr key={intent.terms.id}>
                <td>
                  <Link href={`/approve/${intent.terms.id}`}>#{intent.terms.id}</Link>
                </td>
                <td>
                  #{intent.terms.supplier_id} <span className="muted small">{intent.terms.chain}</span>
                </td>
                <td>{usdc(intent.terms.amount_out)}</td>
                <td>{usdc(intent.terms.max_in, d)}</td>
                <td>
                  <Pill value={intent.status} />{" "}
                  {routeReason(intent.terms.route) && <span className="muted small">{routeReason(intent.terms.route)}</span>}
                </td>
                <td>
                  {attempt ? (
                    <Link href={`/attempt/${attempt.terms.id}`}>
                      #{attempt.terms.id} <Pill value={attempt.status} />
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Recent rejections (enum codes only)</h2>
      {rejections.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>When</th>
              <th>Supplier</th>
              <th>Amount</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {[...rejections].reverse().map((r, i) => (
              <tr key={i}>
                <td className="small">{nsToDate(r.at)}</td>
                <td>#{r.supplier_id}</td>
                <td>{usdc(r.amount_out)}</td>
                <td>
                  <Pill value={r.reason} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
