/**
 * Publishes GetLeash's release store (docs/decisions.md D-31), once, from the operator's account, on the
 * operator's machine with the operator's key: the account the installer copies the release from.
 *
 *   pnpm publish:release --network mainnet
 *
 * Creates the store the installer is built for (release-<first 8 hex of the release's SHA-256>.<operator>)
 * in one batch: CreateAccount, Transfer (its storage, about 0.86 NEAR, locked as long as it exists),
 * DeployContract (the store's code), set (the release's wasm). No key is ever added, so nobody can change
 * or delete it. Then it checks the store from chain state. Safe to re-run: a store that exists is checked,
 * not created again.
 */
import { existsSync, readFileSync } from "node:fs";

import { POLICY_WASM } from "@getleash/devkit/paths";
import {
  accountExists,
  codeSha256,
  INSTALLER_BUILD,
  nearApiActions,
  parseOutcome,
  RELEASE_STORE_ID,
  releaseStoreTransaction,
  sha256Hex,
  STORE_WASM,
  STORE_WASM_SHA256,
  storeHoldsRelease,
} from "@getleash/shared";

import { confirm, fail, ok, ownerAccount, parse, step } from "./lib/cli.ts";

const { values, common } = parse(
  { "owner-key-file": { type: "string" }, wasm: { type: "string" } },
  `
Usage: pnpm publish:release --network mainnet [options]

  Creates ${RELEASE_STORE_ID}, the store the setup page's installer copies the release from.

  --owner-key-file <path>   the operator's credentials (default ~/.near-credentials/mainnet/<operator>.json)
  --wasm <path>             the release's wasm (default contract/target/near/getleash_policy.wasm)
  --yes                     do not ask for confirmation`,
);

const operator = RELEASE_STORE_ID.slice(RELEASE_STORE_ID.indexOf(".") + 1);
if (common.network !== "mainnet") {
  fail(`the installer is built for ${RELEASE_STORE_ID}, on mainnet, so there is nothing to publish on ${common.network}`);
}
const fmt = (yocto: bigint) => `${Number(yocto / 10n ** 21n) / 1000} NEAR`;

/** The store as the installer needs it, from chain state: no keys, the store's code, the release. */
async function verify(): Promise<boolean> {
  const { keys } = (await common.rpc.viewAccessKeyList({ accountId: RELEASE_STORE_ID })) as unknown as { keys: Array<{ public_key: string }> };
  const code = await codeSha256(common.rpc, RELEASE_STORE_ID);
  const holds = await storeHoldsRelease(common.rpc);
  const checks = [
    { name: `${RELEASE_STORE_ID} has no access keys`, ok: keys.length === 0, detail: keys.length === 0 ? "0 keys" : keys.map((k) => k.public_key).join(", ") },
    { name: "it runs the store's code", ok: code === STORE_WASM_SHA256, detail: `sha256 ${code ?? "none"}` },
    { name: "it gives the release the installer installs", ok: holds, detail: `sha256 ${INSTALLER_BUILD.release}` },
  ];
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name} (${check.detail})`);
  return checks.every((c) => c.ok);
}

if (await accountExists(common.rpc, RELEASE_STORE_ID)) {
  console.log(`${RELEASE_STORE_ID} exists already. Checking it from chain state:`);
  if (!(await verify())) fail(`${RELEASE_STORE_ID} isn't the store the installer needs`);
  console.log("Nothing to do: setups from the dashboard can install the release.");
  process.exit(0);
}

const wasmPath = (values.wasm as string | undefined) ?? POLICY_WASM;
if (!existsSync(wasmPath)) fail(`${wasmPath} not found; build the release with \`cd contract && cargo near build reproducible-wasm\``);
const release = new Uint8Array(readFileSync(wasmPath));
if (sha256Hex(release) !== INSTALLER_BUILD.release) {
  fail(`${wasmPath} has sha256 ${sha256Hex(release)}, but the installer installs ${INSTALLER_BUILD.release} (the published release)`);
}
const tx = releaseStoreTransaction(release);
const deposit = tx.actions.find((a) => a.type === "Transfer")!.deposit;
// NEAR holds the attached gas at about 10× its price until the batch has run (signingReserve's rule), and
// the batch itself burns about 0.002 NEAR: what the account must have, though most of it comes back.
const attached = tx.actions.reduce((sum, a) => sum + (a.type === "FunctionCall" ? a.gas : 0n), 0n);
const needed = deposit + attached * 1_000_000_000n + 10n ** 22n;

const { amount, storage_usage } = (await common.rpc.viewAccount({ accountId: operator })) as unknown as { amount: string; storage_usage: number };
const available = BigInt(amount) - BigInt(storage_usage) * 10n ** 19n;
if (available < needed) fail(`${operator} has ${fmt(available)} available; publishing needs ${fmt(needed)} while it runs (${fmt(deposit)} stays in the store)`);

const owner = ownerAccount(common, operator, values["owner-key-file"] as string | undefined);
await confirm(
  common,
  `
Publish GetLeash's release store on ${common.network} (${common.rpcUrl}), signed by ${operator}:

  + create ${RELEASE_STORE_ID}  (${fmt(deposit)} for its storage, locked as long as it exists; NO access key)
      one batch: CreateAccount + Transfer + DeployContract + set(...)
      store code sha256 ${STORE_WASM_SHA256} (${STORE_WASM.length} bytes)
      holding the release, sha256 ${INSTALLER_BUILD.release} (${release.length} bytes)
  ≈ ${fmt(deposit)}, plus about 0.002 NEAR of gas (${operator} has ${fmt(available)} available; ${fmt(needed)} is needed while it runs)`,
);

step(`creating ${RELEASE_STORE_ID} with the release, in one batch`);
const outcome = parseOutcome(await owner.signAndSendTransaction({ receiverId: tx.receiverId, actions: nearApiActions(tx.actions), throwOnFailure: false }));
if (!outcome.ok) fail(`the batch failed, so nothing was created: ${outcome.failures.map((f) => f.panic ?? f.message).join("; ")} (tx ${outcome.txHash})`);
ok(`tx ${common.preset.explorerTx(outcome.txHash)}`);

console.log("\nChecking from chain state:");
if (!(await verify())) fail("the store isn't as the installer needs it");
console.log("\nDone: setups from the dashboard can install the release now.");
