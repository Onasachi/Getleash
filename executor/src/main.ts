/**
 * Executor service entry point.
 *
 *   pnpm executor            # loop, real 1Click (ONECLICK_BASE_URL, ONECLICK_JWT)
 *   pnpm executor --once     # one tick, then exit
 *   pnpm executor --mock     # against a running mock-1click (MOCK_ONECLICK_URL, default http://127.0.0.1:3031)
 *
 * Configuration comes from .env (see .env.example). The executor holds only its own function-call
 * key, generated on this machine with `pnpm keygen`.
 *
 * It also runs for each business set up through the bot (docs/decisions.md D-30), with that business's
 * own executor key, journal and owner chat from <data dir>/hosted/; it reads that list at every pass,
 * so a new business is picked up without a restart. Each pass looks at this GetLeash and at one hosted
 * one, in turn, to stay within the public RPCs' limits.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { TelegramNotifier } from "@getleash/channel-telegram/notifier";
import { ExecutorClient, NETWORKS, networkId, OneClickClient, PolicyView, provider, serviceRpcUrls } from "@getleash/shared";
import {
  dashboardUrlFromEnv,
  dataDir,
  DeliveredNotices,
  directoryPath,
  type HostedBusiness,
  HostedBusinesses,
  hostedDir,
  keyFilePath,
  loadDirectory,
  loadServiceDirectory,
  ownerNoticesPath,
  signingAccount,
} from "@getleash/shared/node";

import { Executor, type TickReport } from "./executor.ts";
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
const rpc = provider(serviceRpcUrls(network, process.env.NEAR_RPC_URL));
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

// Owner notices go to Telegram when a bot token and the owner's chat id are configured. The bot
// records what it already told the owner in their chat (same data directory), so it isn't repeated.
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const ownerChat = process.env.TELEGRAM_OWNER_CHAT_ID;
const telegram = Boolean(botToken && ownerChat);
const notifier: Notifier = botToken && ownerChat ? new TelegramNotifier(botToken, ownerChat) : new ConsoleNotifier();

// Without its journal (a first start, or a host without a disk), the executor would repeat every notice
// for the intents still stored; it starts quietly instead.
const journalPath = process.env.EXECUTOR_JOURNAL ?? join(dataDir(network), "executor-journal.jsonl");
const quietStart = !existsSync(journalPath);

const executor = new Executor(
  {
    policyId,
    quietStart,
    originAsset: `nep141:${state.token_id}`,
    dashboardUrl: dashboardUrlFromEnv(),
  },
  {
    view,
    calls: new ExecutorClient(account, policyId),
    oneclick,
    notifier,
    journal: new Journal(journalPath),
    delivered: telegram ? new DeliveredNotices(ownerNoticesPath(network)) : null,
    // Names from the owner's directory on this machine (written by `pnpm seed`), for notices.
    names: (supplierId) => {
      try {
        return loadServiceDirectory(directoryPath(network)).suppliers.find((s) => s.supplier_id === supplierId)?.name ?? null;
      } catch {
        return null;
      }
    },
    log: (line) => console.log(line),
  },
);

// ── Hosted businesses (D-30) ──────────────────────────────────────────────────────────────────
const businesses = new HostedBusinesses(hostedDir(network));
/** Each hosted business's executor, with the registry entry it was made from (a business its owner moved to another Telegram account gets a new one). */
const hosted = new Map<string, { business: HostedBusiness; executor: Executor }>();
/** Hosted businesses looked at per pass, in turn: each look is about four RPC calls from the same address. */
const HOSTED_PER_PASS = 1;

function hostedExecutor(business: HostedBusiness): Executor {
  const secrets = businesses.secrets(business.policy_id);
  const home = businesses.dir(business.policy_id);
  const journal = join(home, "executor-journal.jsonl");
  return new Executor(
    {
      policyId: business.policy_id,
      quietStart: !existsSync(journal),
      originAsset: `nep141:${state.token_id}`,
      dashboardUrl: dashboardUrlFromEnv(),
      dashboardContract: business.policy_id,
    },
    {
      view: new PolicyView(rpc, business.policy_id),
      calls: new ExecutorClient(signingAccount(rpc, business.executor_id, { privateKey: secrets.executor_private_key }), business.policy_id),
      oneclick,
      notifier: botToken ? new TelegramNotifier(botToken, business.owner_chat) : new ConsoleNotifier(),
      journal: new Journal(journal),
      delivered: botToken ? new DeliveredNotices(join(home, "owner-notices.jsonl")) : null,
      names: (supplierId) => {
        try {
          return loadDirectory(join(home, "directory.json")).suppliers.find((s) => s.supplier_id === supplierId)?.name ?? null;
        } catch {
          return null;
        }
      },
      log: (line) => console.log(`${line} [${business.policy_id}]`),
    },
  );
}

/** Starts an executor for each business the bot has added since the last pass, and a new one for each business that now answers another chat. */
function syncHosted() {
  let list: HostedBusiness[];
  try {
    list = businesses.list();
  } catch (error) {
    console.error(`[executor] could not read the hosted businesses: ${(error as Error).message}`);
    return;
  }
  for (const business of list) {
    const known = hosted.get(business.policy_id);
    if (known && known.business.owner_chat === business.owner_chat) continue;
    try {
      hosted.set(business.policy_id, { business, executor: hostedExecutor(business) });
      console.log(`executor ${business.executor_id} → ${business.policy_id} (hosted${known ? ", moved to another Telegram chat" : ""})`);
    } catch (error) {
      console.error(`✗ hosted ${business.policy_id}: ${(error as Error).message}`);
    }
  }
}

const logErrors = (report: TickReport, label: string) => {
  for (const error of report.errors) console.log(`[executor] error: ${error}${label}`);
};

let turn = 0;
/** This GetLeash, then up to HOSTED_PER_PASS hosted ones in turn (all of them with `all`). */
async function pass(all = false): Promise<TickReport> {
  let report: TickReport;
  try {
    report = await executor.tick();
  } catch (error) {
    // This GetLeash's trouble doesn't stop the hosted ones; the next pass tries again.
    report = { items: 0, actions: [], errors: [(error as Error).message] };
  }
  logErrors(report, "");
  syncHosted();
  const list = [...hosted.entries()];
  const count = all ? list.length : Math.min(HOSTED_PER_PASS, list.length);
  for (let i = 0; i < count; i++) {
    const [id, hostedOne] = list[(turn + i) % list.length]!;
    try {
      logErrors(await hostedOne.executor.tick(), ` [${id}]`);
    } catch (error) {
      // One business's trouble never stops the others' payments.
      console.log(`[executor] error: ${(error as Error).message} [${id}]`);
    }
  }
  if (list.length > 0) turn = (turn + count) % list.length;
  return report;
}

console.log(`executor ${executorId} → ${policyId} on ${network}${values.mock ? " (mock 1Click)" : ""}, dashboard ${dashboardUrlFromEnv() ?? "not set"}`);
if (quietStart) console.log("no journal yet: the first pass records what is already true without notifying");
if (values.once) {
  console.log(JSON.stringify(await pass(true), null, 2));
} else {
  let stopped = false;
  process.on("SIGINT", () => (stopped = true));
  process.on("SIGTERM", () => (stopped = true));
  // Every 10 s: each look at a contract makes about four RPC calls, and the public RPCs limit how many a
  // shared host address (Render's) may make.
  const interval = Number(values.interval ?? process.env.EXECUTOR_INTERVAL_MS ?? 10_000);
  while (!stopped) {
    await pass();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
