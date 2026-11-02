/**
 * Gathers what the hosted services need into two files to paste into the hosts, so no secret is copied
 * by hand or passes through a chat (docs/deployment.md, "Host the services and the dashboard"):
 *
 *   pnpm deploy:env --network mainnet
 *   → .env.render   the executor and the bot (a Render worker): service keys, API keys, Telegram, secrets
 *   → .env.vercel   the dashboard (Vercel): network, contract, the private view's session secret
 *
 * Values come from .env, then .env.<network> (the later file wins), the agent's and executor's key files
 * in .keys/<network>/ (pnpm keygen), and the supplier directory written by `pnpm seed`, carried as
 * GETLEASH_DIRECTORY_BASE64 because the hosts do not have the owner's files. Both files are git-ignored
 * (.env.*), written with mode 0600, and hold secrets: paste them into the hosts only, then delete them.
 * Only variable names are printed. The owner key is never included: setup, seeding and top-ups stay on
 * the owner's machine.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { directoryPath, keyFileAccount, keyFilePath, loadDirectory, readKeyFile } from "@getleash/shared/node";

import { fail, ok, parse, required } from "./lib/cli.ts";

const { values, common } = parse({}, "Usage: pnpm deploy:env --network <mainnet|testnet>");
required(values.network, "network");
const network = common.network;

const load = (path: string) => (existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string | undefined>) : {});
const env: Record<string, string | undefined> = { ...load(".env"), ...load(`.env.${network}`) };
if (env.NEAR_NETWORK !== network) fail(`.env.${network} should set NEAR_NETWORK=${network} (docs/deployment.md, step 5)`);

const need = (key: string) => env[key] || fail(`${key} is not set in .env or .env.${network}`);

function serviceKey(accountKey: "AGENT_ACCOUNT_ID" | "EXECUTOR_ACCOUNT_ID"): string {
  const accountId = need(accountKey);
  const path = keyFilePath(network, accountId);
  if (!existsSync(path)) fail(`${path} not found; run pnpm keygen --network ${network} --account ${accountId}`);
  const file = readKeyFile(path);
  if (keyFileAccount(path, file) !== accountId) fail(`${path} is not a key for ${accountId}`);
  return file.private_key;
}

const directoryFile = directoryPath(network);
if (!existsSync(directoryFile)) fail(`${directoryFile} not found; run pnpm seed first`);
const directory = Buffer.from(JSON.stringify(loadDirectory(directoryFile))).toString("base64");
// Telegram links must open on a phone: a localhost dashboard address is left for the owner to set.
const dashboardUrl = env.DASHBOARD_URL && !/localhost|127\.0\.0\.1/.test(env.DASHBOARD_URL) ? env.DASHBOARD_URL : undefined;

const services: Array<[string, string | undefined]> = [
  ["NEAR_NETWORK", network],
  ["OWNER_ACCOUNT_ID", need("OWNER_ACCOUNT_ID")],
  ["POLICY_CONTRACT_ID", need("POLICY_CONTRACT_ID")],
  ["AGENT_ACCOUNT_ID", need("AGENT_ACCOUNT_ID")],
  ["EXECUTOR_ACCOUNT_ID", need("EXECUTOR_ACCOUNT_ID")],
  ["AGENT_PRIVATE_KEY", serviceKey("AGENT_ACCOUNT_ID")],
  ["EXECUTOR_PRIVATE_KEY", serviceKey("EXECUTOR_ACCOUNT_ID")],
  ["NEAR_AI_API_KEY", need("NEAR_AI_API_KEY")],
  ["TELEGRAM_BOT_TOKEN", need("TELEGRAM_BOT_TOKEN")],
  ["TELEGRAM_OWNER_CHAT_ID", need("TELEGRAM_OWNER_CHAT_ID")],
  ["TELEGRAM_ALLOWED_USER_IDS", need("TELEGRAM_ALLOWED_USER_IDS")],
  ["TELEGRAM_ALLOWED_CHAT_IDS", need("TELEGRAM_ALLOWED_CHAT_IDS")],
  ["TENANT_SECRET", need("TENANT_SECRET")],
  ["INVOICE_STORE_KEY", need("INVOICE_STORE_KEY")],
  ["GETLEASH_DIRECTORY_BASE64", directory],
  ["ONECLICK_JWT", env.ONECLICK_JWT],
  ["NEAR_AI_MODEL", env.NEAR_AI_MODEL],
  ["NEAR_RPC_URL", env.NEAR_RPC_URL],
  ["DASHBOARD_URL", dashboardUrl],
];

const dashboard: Array<[string, string | undefined]> = [
  ["NEXT_PUBLIC_NEAR_NETWORK", network],
  ["NEXT_PUBLIC_POLICY_CONTRACT_ID", need("POLICY_CONTRACT_ID")],
  ["DASHBOARD_SESSION_SECRET", env.DASHBOARD_SESSION_SECRET || randomBytes(32).toString("hex")],
  ["GETLEASH_DIRECTORY_BASE64", directory],
  // Vercel then installs with the repository's own pnpm (package.json "packageManager").
  ["ENABLE_EXPERIMENTAL_COREPACK", "1"],
];

function write(path: string, entries: Array<[string, string | undefined]>, extra: string[] = []) {
  const set = entries.filter(([, v]) => v);
  writeFileSync(path, `${[...set.map(([k, v]) => `${k}=${v}`), ...extra].join("\n")}\n`, { mode: 0o600 });
  ok(`${path}: ${set.map(([k]) => k).join(", ")}`);
}

write(".env.render", services, dashboardUrl ? [] : ["# DASHBOARD_URL=https://<your dashboard>.vercel.app   (add it once the dashboard is up)"]);
write(".env.vercel", dashboard);
console.log("\nThese files hold secrets: paste them into Render and Vercel only, then delete them (rm .env.render .env.vercel).");
