/**
 * Rotation by account swap (PLAN §3): creates agent-(N+1) or executor-(N+1) with a new
 * function-call key, then points the contract at it. The old account keeps nothing it can use.
 *
 *   pnpm keygen --network mainnet --account executor-2.yourbusiness.near   (on the service machine)
 *   pnpm rotate --network mainnet --owner yourbusiness.near --role executor --n 2 --public-key ed25519:…
 */
import { near, OwnerClient, PolicyView } from "@getleash/shared";

import { confirm, fail, ok, ownerAccount, parse, required } from "./lib/cli.ts";
import { AGENT_METHODS, createRoleAccount, defaultRoleIds, EXECUTOR_METHODS } from "@getleash/shared";

const { values, common } = parse(
  {
    owner: { type: "string" },
    "owner-key-file": { type: "string" },
    role: { type: "string" },
    n: { type: "string" },
    "public-key": { type: "string" },
    near: { type: "string", default: "0.2" },
    allowance: { type: "string", default: "1" },
  },
  "Usage: pnpm rotate --network <net> --owner <you.near> --role <agent|executor> --n <N> --public-key <ed25519:…>",
);
const ownerId = required(values.owner, "owner");
const role = required(values.role, "role");
if (role !== "agent" && role !== "executor") fail("--role must be agent or executor");
const ids = defaultRoleIds(ownerId, Number(required(values.n, "n")));
const accountId = role === "agent" ? ids.agentId : ids.executorId;
const publicKey = required(values["public-key"], "public-key");

await confirm(
  common,
  `Create ${accountId} with function-call key ${publicKey} and make it the ${role} of ${ids.policyId}.` +
    (role === "executor" ? "\nThe executor epoch moves on: attempts the old executor created can no longer be funded from the trust budget (D-19)." : ""),
);
const owner = ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined);
await createRoleAccount(
  owner,
  ids.policyId,
  { accountId, publicKey, balance: near(values.near as string), allowance: near(values.allowance as string) },
  role === "agent" ? AGENT_METHODS : EXECUTOR_METHODS,
);
const client = new OwnerClient(owner, ids.policyId);
const state = await new PolicyView(common.rpc, ids.policyId).state();
const out =
  role === "agent" ? await client.setRoles(accountId, state.executor_id) : await client.setRoles(state.agent_id, accountId);
ok(`${role} is now ${accountId} (tx ${common.preset.explorerTx(out.txHash)})`);
