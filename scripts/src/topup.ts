/**
 * Owner top-up through `ft_transfer_call`, the only way the contract credits funds by itself.
 *
 *   pnpm topup --network mainnet --owner yourbusiness.near --amount 20
 */
import { fromUnits, PolicyView, toUnits } from "@getleash/shared";

import { confirm, ok, ownerAccount, parse, required } from "./lib/cli.ts";
import { defaultRoleIds, topUp } from "@getleash/shared";

const { values, common } = parse(
  { owner: { type: "string" }, "owner-key-file": { type: "string" }, policy: { type: "string" }, amount: { type: "string" } },
  "Usage: pnpm topup --network <net> --owner <you.near> --amount <USDC, e.g. 20 or 0.5> [--policy <contract>]",
);
const ownerId = required(values.owner, "owner");
const policyId = (values.policy as string | undefined) ?? defaultRoleIds(ownerId).policyId;
const view = new PolicyView(common.rpc, policyId);
const config = await view.config();
const amount = toUnits(required(values.amount, "amount"), config.treasury_decimals);

await confirm(common, `Top up ${policyId} with ${fromUnits(amount, config.treasury_decimals)} from ${ownerId} (ft_transfer_call on ${config.treasury_token}).`);
const out = await topUp(ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined), { treasuryToken: config.treasury_token, policyId }, amount);
const ledger = await view.ledger();
ok(`tx ${common.preset.explorerTx(out.txHash)}`);
ok(`cash ${fromUnits(ledger.cash, config.treasury_decimals)}, reserved ${fromUnits(ledger.reserved, config.treasury_decimals)}`);
