/**
 * Read-only overview: ledger, today's budgets, open work, and the health of every key that matters
 * (the policy account must have none; role keys report their remaining allowance).
 *
 *   pnpm status --network mainnet --policy getleash.yourbusiness.near
 */
import { fromUnits, PolicyView, routeReason, YOCTO_PER_NEAR } from "@getleash/shared";

import { parse, required } from "./lib/cli.ts";

const { values, common } = parse(
  { policy: { type: "string" }, "warn-below": { type: "string", default: "0.05" } },
  "Usage: pnpm status --network <net> --policy <contract> [--warn-below <NEAR allowance>]",
);
const policyId = required(values.policy ?? process.env.POLICY_CONTRACT_ID, "policy");
const view = new PolicyView(common.rpc, policyId);
const [config, ledger, budgets, work, rejections] = await Promise.all([
  view.config(),
  view.ledger(),
  view.budgetsToday(),
  view.openWork(),
  view.recentRejections(),
]);
const d = config.treasury_decimals;
const u = (x: string) => fromUnits(x, d);

const balance = (await common.rpc.callFunction({
  contractId: config.treasury_token,
  method: "ft_balance_of",
  args: { account_id: policyId },
})) as string;
console.log(`${policyId} on ${common.network}${config.paused ? "  ⏸ PAUSED" : ""}${config.hosted_mode ? "  (hosted mode)" : ""}`);
console.log(`  cash ${u(ledger.cash)}  reserved ${u(ledger.reserved)}  in flight ${u(ledger.in_flight)}  available ${u(budgets.available)}`);
// Tokens in flight have already left the contract, so the unrecognised part is balance − cash.
console.log(`  token balance ${u(balance)}  → unreconciled inflow ${fromUnits(BigInt(balance) - BigInt(ledger.cash), d)}`);
for (const [name, line] of Object.entries({ daily: budgets.daily, monthly: budgets.monthly, autonomous: budgets.autonomous, "executor trust": budgets.executor_trust })) {
  console.log(`  ${name.padEnd(14)} used ${u(line.used)} of ${u(line.limit)}`);
}
console.log(`\nOpen work (${work.length}):`);
for (const { intent, attempt } of work) {
  const reason = routeReason(intent.terms.route);
  console.log(
    `  intent ${intent.terms.id} ${intent.status.padEnd(9)} supplier ${intent.terms.supplier_id} ${intent.terms.kind} out ${intent.terms.amount_out} max_in ${u(intent.terms.max_in)}` +
      (reason ? ` [${reason}]` : "") +
      (attempt ? `  attempt ${attempt.terms.id} ${attempt.status} (${attempt.authorization})` : ""),
  );
}
if (rejections.length > 0) {
  console.log(`\nRecent rejections:`);
  for (const r of rejections.slice(-5)) console.log(`  supplier ${r.supplier_id} amount ${r.amount_out}: ${r.reason}`);
}

console.log(`\nKeys:`);
const warnBelow = BigInt(Math.round(Number(values["warn-below"]) * 1e6)) * 10n ** 18n;
for (const accountId of [policyId, config.agent_id, config.executor_id]) {
  const { keys } = (await common.rpc.viewAccessKeyList({ accountId })) as unknown as {
    keys: Array<{ public_key: string; access_key: { permission: unknown } }>;
  };
  if (accountId === policyId) {
    console.log(`  ${keys.length === 0 ? "✓" : "✗"} ${accountId}: ${keys.length} access keys (must be 0)`);
    continue;
  }
  for (const key of keys) {
    const fc = (key.access_key.permission as { FunctionCall?: { allowance: string | null; receiver_id: string } }).FunctionCall;
    if (!fc) {
      console.log(`  ✗ ${accountId}: FULL ACCESS key ${key.public_key}`);
      continue;
    }
    const allowance = fc.allowance === null ? null : BigInt(fc.allowance);
    const low = allowance !== null && allowance < warnBelow;
    const shown = allowance === null ? "unlimited" : `${Number(allowance / 10n ** 18n) / 1e6} NEAR`;
    console.log(`  ${low ? "⚠" : "✓"} ${accountId}: allowance ${shown}${low ? "  → rotate soon (pnpm rotate)" : ""}`);
  }
}
void YOCTO_PER_NEAR;
