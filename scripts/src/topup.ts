/**
 * Owner top-up: a plain `ft_transfer` of USDC to the policy contract (v2 keeps no ledger, D-28:
 * the token balance is the treasury).
 *
 *   pnpm topup --network mainnet --owner yourbusiness.near --amount 20
 */
import { defaultRoleIds, fromUnits, PolicyView, toUnits, topUp } from "@getleash/shared";

import { confirm, ok, ownerAccount, parse, required } from "./lib/cli.ts";

const { values, common } = parse(
  { owner: { type: "string" }, "owner-key-file": { type: "string" }, policy: { type: "string" }, amount: { type: "string" } },
  "Usage: pnpm topup --network <net> --owner <you.near> --amount <USDC, e.g. 20 or 0.5> [--policy <contract>]",
);
const ownerId = required(values.owner, "owner");
const policyId = (values.policy as string | undefined) ?? defaultRoleIds(ownerId).policyId;
const view = new PolicyView(common.rpc, policyId);
const state = await view.state();
const amount = toUnits(required(values.amount, "amount"), state.token_decimals);

await confirm(common, `Top up ${policyId} with ${fromUnits(amount, state.token_decimals)} USDC from ${ownerId} (ft_transfer on ${state.token_id}).`);
const out = await topUp(ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined), { treasuryToken: state.token_id, policyId }, amount);
ok(`tx ${common.preset.explorerTx(out.txHash)}`);
ok(`treasury balance ${fromUnits(await view.treasuryBalance(state.token_id), state.token_decimals)} USDC`);
