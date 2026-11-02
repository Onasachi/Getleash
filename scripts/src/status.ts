/**
 * Read-only overview: treasury, today's budgets, intents that still need someone, the contract's
 * NEAR and storage, and the health of every key that matters (the policy account must have none;
 * role accounts report their NEAR, which pays their gas).
 *
 *   pnpm status --network mainnet --policy getleash.yourbusiness.near
 */
import { fromUnits, isOpen, PolicyView } from "@getleash/shared";

import { parse, required } from "./lib/cli.ts";

const { values, common } = parse(
  { policy: { type: "string" }, "warn-below": { type: "string", default: "0.1" } },
  "Usage: pnpm status --network <net> --policy <contract> [--warn-below <NEAR per role account>]",
);
const policyId = required(values.policy ?? process.env.POLICY_CONTRACT_ID, "policy");
const view = new PolicyView(common.rpc, policyId);
const state = await view.state();
const [balance, intents] = await Promise.all([view.treasuryBalance(state.token_id), view.recentIntents(50)]);
const d = state.token_decimals;
const u = (x: string | bigint) => fromUnits(x, d);
const nearOf = (yocto: bigint) => `${Number(yocto / 10n ** 21n) / 1000} NEAR`;

console.log(`${policyId} on ${common.network}${state.paused ? "  ⏸ PAUSED" : ""}`);
console.log(`  treasury ${u(balance)} USDC   payouts in flight ${state.paying}   stored intents ${state.stored_intents}/50`);
const b = state.budgets;
const p = state.policy;
console.log(`  autonomous     used ${u(b.autonomous)} of ${u(p.autonomous_daily_budget)} today (approval above ${u(p.approval_threshold)})`);
console.log(`  sent today     ${u(b.outflow)} of ${u(p.daily_cap)}`);
console.log(`  executor trust ${u(b.trust)} of ${u(p.executor_trust_daily_budget)} (epoch ${state.executor_epoch})`);
console.log(`  proposals      ${b.proposals} of ${p.max_proposals_per_day} today`);

const open = intents.filter(isOpen);
console.log(`\nOpen intents (${open.length} of the newest ${intents.length}):`);
for (const i of open) {
  const attempt = i.attempt ? `  deposit ${i.attempt.deposit.slice(0, 10)}… ${u(i.attempt.amount_in)} in${i.attempt.authorized ? " (owner-signed)" : ""}` : "";
  console.log(`  intent ${i.id} ${i.status.padEnd(8)} supplier ${i.supplier_id} value ${u(i.value)} [${i.route}]${attempt}`);
}

const account = (await common.rpc.viewAccount({ accountId: policyId })) as unknown as { amount: string; storage_usage: number };
const staked = BigInt(account.storage_usage) * 10n ** 19n;
console.log(`\nContract NEAR: ${nearOf(BigInt(account.amount))}, of which ${nearOf(staked)} covers ${account.storage_usage} bytes of storage.`);

console.log(`\nKeys:`);
const warnBelow = BigInt(Math.round(Number(values["warn-below"]) * 1e6)) * 10n ** 18n;
for (const accountId of [policyId, state.agent_id, state.executor_id]) {
  const { keys } = (await common.rpc.viewAccessKeyList({ accountId })) as unknown as { keys: Array<{ public_key: string; access_key: { permission: unknown } }> };
  if (accountId === policyId) {
    console.log(`  ${keys.length === 0 ? "✓" : "✗"} ${accountId}: ${keys.length} access keys (must be 0)`);
    continue;
  }
  const near = BigInt(((await common.rpc.viewAccount({ accountId })) as unknown as { amount: string }).amount);
  const low = near < warnBelow;
  for (const key of keys) {
    const fc = (key.access_key.permission as { FunctionCall?: unknown }).FunctionCall;
    console.log(`  ${fc ? (low ? "⚠" : "✓") : "✗"} ${accountId}: ${fc ? "function-call key" : `FULL ACCESS key ${key.public_key}`}, ${nearOf(near)} for gas${low ? "  → top it up (each call needs ~0.08 NEAR spendable)" : ""}`);
  }
}
