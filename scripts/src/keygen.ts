/**
 * Generates a service key ON THE MACHINE THAT WILL RUN THE SERVICE (PLAN §3.1 step 2) and prints
 * only the public key. The owner then authorises it as a function-call key with `pnpm setup`.
 *
 *   pnpm keygen --network mainnet --account agent-1.yourbusiness.near
 */
import { generateKeyFile, keyFilePath } from "@getleash/shared/node";

import { fail, parse, required } from "./lib/cli.ts";

const { values, common } = parse(
  { account: { type: "string" } },
  `
Usage: pnpm keygen --network <mainnet|testnet> --account <agent-N.owner.near | executor-N.owner.near>

Writes .keys/<network>/<account>.json (mode 0600, git-ignored) and prints the public key.
Set GETLEASH_KEYS_DIR to store keys elsewhere.`,
);

const accountId = required(values.account, "account");
const path = keyFilePath(common.network, accountId);
try {
  const file = generateKeyFile(common.network, accountId, path);
  console.log(`✓ new key for ${accountId} written to ${path} (mode 0600)`);
  console.log(`\npublic key: ${file.public_key}\n`);
  console.log("Give the owner only this public key. The private key never leaves this machine.");
} catch (error) {
  fail((error as Error).message);
}
