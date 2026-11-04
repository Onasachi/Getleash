/**
 * Publishes GetLeash's factory (docs/decisions.md D-32), once, from the operator's account, on the operator's
 * machine with the operator's key: the account every hosted business's wallet calls to set GetLeash up.
 *
 *   pnpm publish:factory --network mainnet [--owner onanikes.near]
 *
 * 1. Claims getleash.near through the `near` account's linkdrop (`create_account`), paid by the operator,
 *    with a key made here for this alone, kept in .keys/mainnet/getleash.near.json (mode 0600) meanwhile;
 * 2. signed with that key, in one transaction: deploys the factory and deletes the key. From then on
 *    getleash.near has no key, so it does only what the factory's code says, and nobody can change it;
 * 3. checks it from chain state, and removes the key file.
 * Safe to re-run: it carries on where it stopped, and only checks a factory that is published.
 */
import { existsSync, rmSync } from "node:fs";

import { actions, PublicKey } from "near-api-js";

import { accountExists, codeSha256, FACTORY_ID, FACTORY_WASM, FACTORY_WASM_SHA256, near, parseOutcome, RELEASE_STORE_ID, tgas } from "@getleash/shared";
import { generateKeyFile, keyFilePath, readKeyFile, signingAccount } from "@getleash/shared/node";

import { confirm, fail, ok, ownerAccount, parse, step } from "./lib/cli.ts";

const { values, common } = parse(
  { owner: { type: "string" }, "owner-key-file": { type: "string" } },
  `
Usage: pnpm publish:factory --network mainnet [options]

  Claims ${FACTORY_ID} and publishes GetLeash's factory there, keyless.

  --owner <account>         the operator, who pays (default: ${RELEASE_STORE_ID.slice(RELEASE_STORE_ID.indexOf(".") + 1)}, the release store's)
  --owner-key-file <path>   its credentials (default ~/.near-credentials/mainnet/<owner>.json)
  --yes                     do not ask for confirmation`,
);

if (common.network !== "mainnet") fail(`${FACTORY_ID} is a mainnet account, so there is nothing to publish on ${common.network}`);
const operator = (values.owner as string | undefined) ?? RELEASE_STORE_ID.slice(RELEASE_STORE_ID.indexOf(".") + 1);
const fmt = (yocto: bigint) => `${Number(yocto / 10n ** 21n) / 1000} NEAR`;
/** Its code's storage, the account's, the key's while it exists, and the deploy transaction's fee. */
const FUNDING = near("0.09");
const CREATE_GAS = tgas(50);
const keyPath = keyFilePath(common.network, FACTORY_ID);

type KeyView = { public_key: string };
const keysOf = async (accountId: string) => ((await common.rpc.viewAccessKeyList({ accountId })) as unknown as { keys: KeyView[] }).keys.map((k) => k.public_key);

/** The factory as hosted setups need it, from chain state: the published code, no keys. */
async function verify(): Promise<boolean> {
  const keys = await keysOf(FACTORY_ID);
  const code = await codeSha256(common.rpc, FACTORY_ID);
  const checks = [
    { name: `${FACTORY_ID} has no access keys`, ok: keys.length === 0, detail: keys.length === 0 ? "0 keys" : keys.join(", ") },
    { name: "it runs the published factory", ok: code === FACTORY_WASM_SHA256, detail: `sha256 ${code ?? "none"}` },
  ];
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name} (${check.detail})`);
  return checks.every((c) => c.ok);
}

if (await accountExists(common.rpc, FACTORY_ID)) {
  const keys = await keysOf(FACTORY_ID);
  if (keys.length === 0) {
    console.log(`${FACTORY_ID} exists already. Checking it from chain state:`);
    if (!(await verify())) fail(`${FACTORY_ID} isn't the factory hosted setups need`);
    console.log("Nothing to do: the setup page can use it.");
    process.exit(0);
  }
  const mine = existsSync(keyPath) ? readKeyFile(keyPath).public_key : null;
  // Exactly the key this script made: deleting it must leave none (a wallet may have added another).
  if (!mine || keys.length !== 1 || keys[0] !== mine) {
    fail(`${FACTORY_ID} has keys other than the one this script made (${keys.join(", ")}): delete them first, or it wouldn't end up keyless`);
  }
  console.log(`${FACTORY_ID} was claimed with the key in ${keyPath}; carrying on.`);
} else {
  const { amount, storage_usage } = (await common.rpc.viewAccount({ accountId: operator })) as unknown as { amount: string; storage_usage: number };
  const available = BigInt(amount) - BigInt(storage_usage) * 10n ** 19n;
  // NEAR holds the attached gas at about 10× its price until the call has run.
  const needed = FUNDING + CREATE_GAS * 1_000_000_000n + near("0.005");
  if (available < needed) fail(`${operator} has ${fmt(available)} available; publishing needs ${fmt(needed)} while it runs (${fmt(FUNDING)} stays in ${FACTORY_ID})`);
  const owner = ownerAccount(common, operator, values["owner-key-file"] as string | undefined);
  await confirm(
    common,
    `
Publish GetLeash's factory on ${common.network} (${common.rpcUrl}):

  1. signed by ${operator}: near.create_account(${FACTORY_ID}) with ${fmt(FUNDING)}, for its storage
     (with a key made here for step 2 alone, kept in ${keyPath} meanwhile)
  2. signed by ${FACTORY_ID} with that key: DeployContract (the factory, ${FACTORY_WASM.length} bytes,
     sha256 ${FACTORY_WASM_SHA256}) + DeleteKey (that key): NO access key afterwards
  ≈ ${fmt(FUNDING)}, plus about 0.003 NEAR of gas (${operator} has ${fmt(available)} available; ${fmt(needed)} is needed while it runs)`,
  );
  const file = generateKeyFile(common.network, FACTORY_ID, keyPath);
  step(`claiming ${FACTORY_ID}`);
  const created = parseOutcome(
    await owner.signAndSendTransaction({
      receiverId: "near",
      actions: [actions.functionCall("create_account", { new_account_id: FACTORY_ID, new_public_key: file.public_key }, CREATE_GAS, FUNDING)],
      throwOnFailure: false,
    }),
  );
  if (!created.ok || !(await accountExists(common.rpc, FACTORY_ID))) {
    fail(`${FACTORY_ID} wasn't created: ${created.failures.map((f) => f.panic ?? f.message).join("; ") || "unknown"} (tx ${created.txHash}); the linkdrop returns the NEAR when it fails`);
  }
  ok(`tx ${common.preset.explorerTx(created.txHash)}`);
}

const key = readKeyFile(keyPath);
const factory = signingAccount(common.rpc, FACTORY_ID, { keyFile: keyPath });
step(`deploying the factory to ${FACTORY_ID} and deleting its only key, in one transaction`);
const deployed = parseOutcome(
  await factory.signAndSendTransaction({
    receiverId: FACTORY_ID,
    actions: [actions.deployContract(FACTORY_WASM), actions.deleteKey(PublicKey.fromString(key.public_key))],
    throwOnFailure: false,
  }),
);
// The transaction's gas refund goes to the key's account after the key is gone; that is all right.
if (!deployed.finalOk) fail(`the deploy failed, so ${FACTORY_ID} still has the key in ${keyPath}: ${deployed.failures.map((f) => f.panic ?? f.message).join("; ")} (tx ${deployed.txHash})`);
ok(`tx ${common.preset.explorerTx(deployed.txHash)}`);

console.log("\nChecking from chain state:");
if (!(await verify())) fail(`${FACTORY_ID} isn't as hosted setups need it; the key file stays in ${keyPath}`);
rmSync(keyPath);
console.log(`\nDone: the key file is removed, and the setup page can use ${FACTORY_ID}.`);
