/**
 * Gathers what the Render services need into two files, to paste into Render (a service's
 * Environment page → "Add from .env"), so no secret is copied by hand or passes through a chat:
 *
 *   pnpm render:env --network mainnet
 *   → .env.render-worker     for the getleash-services worker: service keys, API keys, Telegram, secrets
 *   → .env.render-dashboard  for the getleash-dashboard web service
 *
 * Values come from .env, then .env.<network> (the later file wins), and the agent's and executor's key
 * files in .keys/<network>/ (pnpm keygen). Both files are git-ignored (.env.*), written with mode 0600,
 * and hold secrets: paste them into Render only, then delete them. Only variable names are printed.
 * The owner key is never included: setup, seeding and top-ups stay on the owner's machine.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { directoryPath, keyFileAccount, keyFilePath, readKeyFile } from "@getleash/shared/node";

import { fail, ok, parse, required } from "./lib/cli.ts";

const { values, common } = parse({}, "Usage: pnpm render:env --network <mainnet|testnet>");
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

const worker: Array<[string, string | undefined]> = [
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
  ["ONECLICK_JWT", env.ONECLICK_JWT],
  ["NEAR_AI_MODEL", env.NEAR_AI_MODEL],
  ["NEAR_RPC_URL", env.NEAR_RPC_URL],
];
// Telegram links must open on a phone: a localhost dashboard address is left for the owner to set.
const dashboardUrl = env.DASHBOARD_URL && !/localhost|127\.0\.0\.1/.test(env.DASHBOARD_URL) ? env.DASHBOARD_URL : undefined;

const dashboard: Array<[string, string | undefined]> = [
  ["NEXT_PUBLIC_NEAR_NETWORK", network],
  ["NEXT_PUBLIC_POLICY_CONTRACT_ID", need("POLICY_CONTRACT_ID")],
  ["DASHBOARD_SESSION_SECRET", env.DASHBOARD_SESSION_SECRET || randomBytes(32).toString("hex")],
];

function write(path: string, entries: Array<[string, string | undefined]>, extra: string[] = []) {
  const lines = entries.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, `${[...lines, ...extra].join("\n")}\n`, { mode: 0o600 });
  ok(`${path}: ${entries.filter(([, v]) => v).map(([k]) => k).join(", ")}`);
}

write(".env.render-worker", [...worker, ["DASHBOARD_URL", dashboardUrl]], dashboardUrl ? [] : ["# DASHBOARD_URL=https://<your dashboard>.onrender.com   (add it once the dashboard is up)"]);
write(".env.render-dashboard", dashboard);
const directory = directoryPath(network);
console.log(
  `\nSecret file for both services (Render: Environment → Secret Files, named directory.json):\n  ${existsSync(directory) ? directory : `${directory} (not found: run pnpm seed first)`}` +
    "\n\nThese files hold secrets: paste them into Render only, then delete them (rm .env.render-*).",
);
