/**
 * Executor service entry point.
 *
 *   pnpm executor            # loop, real 1Click (ONECLICK_BASE_URL, ONECLICK_JWT)
 *   pnpm executor --once     # one tick, then exit
 *   pnpm executor --mock     # against a running mock-1click (MOCK_ONECLICK_URL, default http://127.0.0.1:3031)
 *
 * Configuration comes from .env (see .env.example). The executor holds only its own function-call
 * key, generated on this machine with `pnpm keygen`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { TelegramNotifier } from "@getleash/channel-telegram/notifier";
import { ExecutorClient, NETWORKS, networkId, OneClickClient, PolicyView, provider } from "@getleash/shared";
import { dataDir, keyFilePath, signingAccount } from "@getleash/shared/node";

import { Executor } from "./executor.ts";
import { Journal } from "./journal.ts";

import { ConsoleNotifier, type Notifier } from "./notify.ts";

const { values } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
    interval: { type: "string" },
  },
});

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`✗ ${name} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const network = networkId(process.env.NEAR_NETWORK);
const rpc = provider(process.env.NEAR_RPC_URL ?? NETWORKS[network].rpcUrl);
const policyId = env("POLICY_CONTRACT_ID");
const executorId = env("EXECUTOR_ACCOUNT_ID");
const keyFile = process.env.EXECUTOR_KEY_FILE ?? keyFilePath(network, executorId);
const account = signingAccount(rpc, executorId, {
  privateKey: process.env.EXECUTOR_PRIVATE_KEY,
  keyFile: existsSync(keyFile) ? keyFile : undefined,
});

const view = new PolicyView(rpc, policyId);
const state = await view.state();
if (state.executor_id !== executorId) {
  console.error(`✗ ${policyId} expects executor ${state.executor_id}, not ${executorId}`);
  process.exit(1);
}

const oneclick = new OneClickClient({
  baseUrl: values.mock ? (process.env.MOCK_ONECLICK_URL ?? "http://127.0.0.1:3031") : process.env.ONECLICK_BASE_URL,
  jwt: values.mock ? undefined : process.env.ONECLICK_JWT,
});

// Owner notices go to Telegram when a bot token and the owner's chat id are configured.
const notifier: Notifier =
  process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_CHAT_ID
    ? new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_OWNER_CHAT_ID)
    : new ConsoleNotifier();

const executor = new Executor(
  {
    policyId,
    originAsset: `nep141:${state.token_id}`,
    dashboardUrl: process.env.DASHBOARD_URL ?? null,
  },
  {
    view,
    calls: new ExecutorClient(account, policyId),
    oneclick,
    notifier,
    journal: new Journal(process.env.EXECUTOR_JOURNAL ?? join(dataDir(network), "executor-journal.jsonl")),
    log: (line) => console.log(line),
  },
);

console.log(`executor ${executorId} → ${policyId} on ${network}${values.mock ? " (mock 1Click)" : ""}`);
if (values.once) {
  const report = await executor.tick();
  console.log(JSON.stringify(report, null, 2));
} else {
  process.on("SIGINT", () => executor.stop());
  process.on("SIGTERM", () => executor.stop());
  await executor.run(Number(values.interval ?? process.env.EXECUTOR_INTERVAL_MS ?? 5_000));
}
