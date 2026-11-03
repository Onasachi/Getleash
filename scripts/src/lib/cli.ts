/** Small helpers shared by the CLI scripts: arguments, the owner's signer, confirmation, output. */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";

import type { Account, JsonRpcProvider } from "near-api-js";

import { NETWORKS, networkId, provider, type NetworkId, type NetworkPreset } from "@getleash/shared";
import { nearCliCredentialsPath, signingAccount } from "@getleash/shared/node";

export type Common = { network: NetworkId; preset: NetworkPreset; rpc: JsonRpcProvider; rpcUrl: string; yes: boolean };

export const COMMON_OPTIONS = {
  network: { type: "string" },
  rpc: { type: "string" },
  yes: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const satisfies ParseArgsConfig["options"];

export type Values = Record<string, string | boolean | undefined>;

export function parse(options: NonNullable<ParseArgsConfig["options"]>, usage: string) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true });
  } catch (error) {
    console.error(`✗ ${(error as Error).message.split(". ")[0]}\n\n${usage.trim()}`);
    process.exit(1);
  }
  const values = parsed.values as Values;
  const positionals = parsed.positionals;
  if (values.help) {
    console.log(usage.trim());
    process.exit(0);
  }
  const network = networkId((values.network as string | undefined) ?? process.env.NEAR_NETWORK);
  const preset = NETWORKS[network];
  const rpcUrl = (values.rpc as string | undefined) ?? process.env.NEAR_RPC_URL ?? preset.rpcUrl;
  const common: Common = { network, preset, rpc: provider(rpcUrl), rpcUrl, yes: Boolean(values.yes) };
  return { values, positionals, common };
}

export function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value as string;
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * The owner's signing account. The key is read on the owner's own machine from their near-cli
 * credentials (or an explicit file); GetLeash never receives it.
 */
export function ownerAccount(common: Common, ownerId: string, keyFile?: string): Account {
  const path = keyFile ?? nearCliCredentialsPath(common.network, ownerId);
  if (!existsSync(path)) {
    fail(
      `no key for ${ownerId} at ${path}.\n  Import your wallet with near-cli-rs and save it to the legacy keychain:\n` +
        `  near account import-account   (then: seed phrase or private key, ${common.network}, legacy keychain)\n` +
        `  or pass --owner-key-file <path to a {account_id, public_key, private_key} file>\n` +
        `  (near-cli-rs files without account_id work when named <account>.json or <account>/ed25519_<key>.json).`,
    );
  }
  return signingAccount(common.rpc, ownerId, { keyFile: path });
}

export async function confirm(common: Common, summary: string): Promise<void> {
  console.log(summary.trim());
  if (common.yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nSign these transactions on ${common.network}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") fail("aborted, nothing was signed");
}

export function step(text: string) {
  console.log(`→ ${text}`);
}

export function ok(text: string) {
  console.log(`✓ ${text}`);
}
