/**
 * The owner's setup, run on the owner's machine with the owner's key (PLAN §3.1, D-11).
 *
 *   pnpm setup --network mainnet --owner yourbusiness.near --wasm-sha256 <published hash>
 *
 * Creates agent-N / executor-N with only their function-call keys, creates the policy account in one
 * keyless batch (create, fund, deploy, init), registers it on USDC, then verifies everything from
 * chain state. Safe to re-run: existing accounts are verified, not recreated.
 */
import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_POLICY, fromUnits, near, Policy, type NetworkId } from "@getleash/shared";
import { keyFilePath, readKeyFile } from "@getleash/shared/node";

import { confirm, fail, ok, ownerAccount, parse, required, step } from "./lib/cli.ts";
import { POLICY_WASM } from "@getleash/devkit/paths";
import {
  accountExists,
  AGENT_METHODS,
  createRoleAccount,
  defaultRoleIds,
  deployPolicy,
  EXECUTOR_METHODS,
  registerTreasury,
  sha256Hex,
  suggestedPolicyBalance,
  verifySetup,
  type SetupPlan,
} from "@getleash/shared";

const { values, common } = parse(
  {
    owner: { type: "string" },
    "owner-key-file": { type: "string" },
    n: { type: "string", default: "1" },
    "agent-public-key": { type: "string" },
    "executor-public-key": { type: "string" },
    token: { type: "string" },
    decimals: { type: "string", default: "6" },
    wasm: { type: "string" },
    "wasm-sha256": { type: "string" },
    policy: { type: "string" },
    "policy-near": { type: "string" },
    // NEAR checks a signer's balance against attached gas at a worst-case price, so a role
    // account needs ~0.07–0.08 NEAR spendable per call; these leave room for many calls.
    "agent-near": { type: "string", default: "0.15" },
    "executor-near": { type: "string", default: "0.2" },
    "agent-allowance": { type: "string", default: "0.5" },
    "executor-allowance": { type: "string", default: "1" },
  },
  `
Usage: pnpm setup --network <mainnet|testnet> --owner <you.near> [options]

  --owner-key-file <path>     owner credentials (default ~/.near-credentials/<network>/<owner>.json)
  --n <N>                     role account number: agent-N / executor-N (default 1)
  --agent-public-key <key>    default: read from .keys/<network>/agent-N.<owner>.json (pnpm keygen)
  --executor-public-key <key> default: read from .keys/<network>/executor-N.<owner>.json
  --token <account>           treasury token (default: Circle USDC for the network)
  --wasm <path>               contract wasm (default contract/release/getleash_policy.wasm, the release)
  --wasm-sha256 <hex>         required on mainnet: the published hash the wasm must match
  --policy <file.json>        full Policy JSON (default: deploy/mainnet-policy.json's values)
  --policy-near <NEAR>        NEAR for the policy account (default: code storage + 0.2)
  --agent-near, --executor-near   NEAR for the role accounts (default 0.15 and 0.2)
  --yes                       do not ask for confirmation`,
);

const ownerId = required(values.owner, "owner");
const n = Number(values.n);
const ids = defaultRoleIds(ownerId, n);

function publicKeyFor(role: "agent" | "executor", accountId: string, network: NetworkId): string {
  const given = values[`${role}-public-key`] as string | undefined;
  if (given) return given;
  const path = keyFilePath(network, accountId);
  if (!existsSync(path)) {
    fail(`no public key for ${accountId}: run \`pnpm keygen --network ${network} --account ${accountId}\` on the
  machine that will run the ${role}, then pass --${role}-public-key <key>`);
  }
  return readKeyFile(path).public_key;
}

const wasmPath = (values.wasm as string | undefined) ?? POLICY_WASM;
if (!existsSync(wasmPath)) fail(`${wasmPath} not found; restore the release with \`git checkout -- contract/release\`, or build one with \`cd contract && cargo near build\``);
const wasm = readFileSync(wasmPath);
const wasmSha = sha256Hex(wasm);
const expectedSha = values["wasm-sha256"] as string | undefined;
if (common.network === "mainnet" && !expectedSha) {
  fail(`on mainnet pass --wasm-sha256 with the hash published in the README (this wasm: ${wasmSha})`);
}
if (expectedSha && expectedSha.toLowerCase() !== wasmSha) fail(`wasm sha256 is ${wasmSha}, expected ${expectedSha}`);

const token = (values.token as string | undefined) ?? common.preset.usdc;
if (!token) fail("--token is required on this network");

let policy: Policy = DEFAULT_POLICY;
if (values.policy) {
  const parsed = Policy.safeParse(JSON.parse(readFileSync(values.policy as string, "utf8")));
  if (!parsed.success) fail(`${values.policy} is not a valid Policy: ${parsed.error.message}`);
  policy = parsed.data;
}

const plan: SetupPlan = {
  ownerId,
  policyId: ids.policyId,
  agent: {
    accountId: ids.agentId,
    publicKey: publicKeyFor("agent", ids.agentId, common.network),
    balance: near(values["agent-near"] as string),
    allowance: near(values["agent-allowance"] as string),
  },
  executor: {
    accountId: ids.executorId,
    publicKey: publicKeyFor("executor", ids.executorId, common.network),
    balance: near(values["executor-near"] as string),
    allowance: near(values["executor-allowance"] as string),
  },
  treasuryToken: token,
  treasuryDecimals: Number(values.decimals),
  policy,
  wasm,
  policyBalance: values["policy-near"] ? near(values["policy-near"] as string) : suggestedPolicyBalance(wasm.length),
};

const owner = ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined);
const exists = {
  agent: await accountExists(common.rpc, plan.agent.accountId),
  executor: await accountExists(common.rpc, plan.executor.accountId),
  policy: await accountExists(common.rpc, plan.policyId),
};
const fmt = (yocto: bigint) => `${Number(yocto / 10n ** 21n) / 1000} NEAR`;
const usdc = (units: string) => fromUnits(units, plan.treasuryDecimals);
const total = plan.policyBalance + plan.agent.balance + plan.executor.balance;

await confirm(
  common,
  `
GetLeash setup on ${common.network} (${common.rpcUrl}), signed by ${ownerId}:

  ${exists.agent ? "✓ exists " : "+ create "} ${plan.agent.accountId}  (${fmt(plan.agent.balance)}, function-call key ${plan.agent.publicKey}
               → ${plan.policyId} [${AGENT_METHODS.join(", ")}], allowance ${fmt(plan.agent.allowance)})
  ${exists.executor ? "✓ exists " : "+ create "} ${plan.executor.accountId}  (${fmt(plan.executor.balance)}, function-call key ${plan.executor.publicKey}
               → ${plan.policyId} [${EXECUTOR_METHODS.join(", ")}], allowance ${fmt(plan.executor.allowance)})
  ${exists.policy ? "✓ exists " : "+ create "} ${plan.policyId}  (${fmt(plan.policyBalance)}, NO access key)
               one batch: CreateAccount + Transfer + DeployContract + new(...)
               wasm sha256 ${wasmSha} (${wasm.length} bytes)
               treasury ${token} (${plan.treasuryDecimals} decimals)
               policy ${values.policy ?? "(defaults)"}: autonomous ${usdc(policy.autonomous_daily_budget)}/day,
                 approval above ${usdc(policy.approval_threshold)}, daily cap ${usdc(policy.daily_cap)},
                 executor trust ${usdc(policy.executor_trust_daily_budget)}/day, cooldown max ${usdc(policy.cooldown_max)}
  + register ${plan.policyId} on ${token} (0.00125 NEAR) if needed
  ≈ ${fmt(total)} in all, plus gas`,
);

if (!exists.agent) {
  step(`creating ${plan.agent.accountId}`);
  ok(`tx ${common.preset.explorerTx((await createRoleAccount(owner, plan.policyId, plan.agent, AGENT_METHODS)).txHash)}`);
}
if (!exists.executor) {
  step(`creating ${plan.executor.accountId}`);
  ok(`tx ${common.preset.explorerTx((await createRoleAccount(owner, plan.policyId, plan.executor, EXECUTOR_METHODS)).txHash)}`);
}
if (!exists.policy) {
  step(`creating, deploying and initialising ${plan.policyId} in one batch`);
  ok(`tx ${common.preset.explorerTx((await deployPolicy(owner, plan)).txHash)}`);
}
const registered = await common.rpc.callFunction({
  contractId: token,
  method: "storage_balance_of",
  args: { account_id: plan.policyId },
});
if (registered === null || registered === undefined) {
  step(`registering ${plan.policyId} on ${token}`);
  ok(`tx ${common.preset.explorerTx((await registerTreasury(owner, plan)).txHash)}`);
}

console.log("\nVerifying from chain state:");
const checks = await verifySetup(common.rpc, { ...plan, wasmSha256: wasmSha });
for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name} (${check.detail})`);
if (checks.some((c) => !c.ok)) fail("setup verification failed");

console.log(`
Done. Add to the services' .env:
  NEAR_NETWORK=${common.network}
  POLICY_CONTRACT_ID=${plan.policyId}
  AGENT_ACCOUNT_ID=${plan.agent.accountId}
  EXECUTOR_ACCOUNT_ID=${plan.executor.accountId}
Next: pnpm topup --network ${common.network} --owner ${ownerId} --amount <USDC>`);
