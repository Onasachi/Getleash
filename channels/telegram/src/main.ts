/**
 * The intake service: Telegram bot + agent pipeline (PLAN §4.3, §4.4).
 *
 *   pnpm bot
 *
 * Holds only the agent's function-call key (propose_payment), TENANT_SECRET for obligation ids and
 * INVOICE_STORE_KEY for the encrypted invoice store. Without NEAR_AI_API_KEY it refuses to start
 * unless --offline is given (offline text reader, "Verification unavailable" on every invoice).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { InvoiceAgent, InvoiceStore, NearAiExtractor, networkVerifiers, OfflineExtractor, parseStoreKey } from "@getleash/agent";
import { parseTenantSecret, UpdateLog } from "@getleash/ingestion";
import { AgentClient, NETWORKS, networkId, PolicyView, provider } from "@getleash/shared";
import { dataDir, directoryPath, keyFilePath, loadDirectory, signingAccount } from "@getleash/shared/node";

import { parseIdList, startBot, TelegramChannel, telegramDownloader } from "./bot.ts";

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false } } });

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ ${name} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const network = networkId(process.env.NEAR_NETWORK);
const rpc = provider(process.env.NEAR_RPC_URL ?? NETWORKS[network].rpcUrl);
const policyId = env("POLICY_CONTRACT_ID");
const agentId = env("AGENT_ACCOUNT_ID");
const keyFile = process.env.AGENT_KEY_FILE ?? keyFilePath(network, agentId);
const account = signingAccount(rpc, agentId, {
  privateKey: process.env.AGENT_PRIVATE_KEY,
  keyFile: existsSync(keyFile) ? keyFile : undefined,
});
const view = new PolicyView(rpc, policyId);
const state = await view.state();
if (state.agent_id !== agentId) {
  console.error(`✗ ${policyId} expects agent ${state.agent_id}, not ${agentId}`);
  process.exit(1);
}

const apiKey = process.env.NEAR_AI_API_KEY;
if (!apiKey && !values.offline) {
  console.error("✗ NEAR_AI_API_KEY is not set. Use --offline for the text-only reader (no TEE, no verification badge).");
  process.exit(1);
}
const extractor = apiKey
  ? new NearAiExtractor({ apiKey, baseUrl: process.env.NEAR_AI_BASE_URL, model: process.env.NEAR_AI_MODEL || undefined, verifiers: await networkVerifiers() })
  : new OfflineExtractor();

const dir = dataDir(network);
const directoryFile = directoryPath(network);
const agent = new InvoiceAgent({
  extractor,
  view,
  agent: new AgentClient(account, policyId),
  tenantSecret: parseTenantSecret(process.env.TENANT_SECRET),
  directory: () => loadDirectory(directoryFile),
  store: new InvoiceStore(join(dir, "invoices"), parseStoreKey(process.env.INVOICE_STORE_KEY)),
  dashboardUrl: process.env.DASHBOARD_URL ?? null,
  log: (line) => console.log(line),
});

const token = env("TELEGRAM_BOT_TOKEN");
startBot(token, (bot) =>
  new TelegramChannel({
    api: bot.api,
    updateLog: new UpdateLog(join(dir, "telegram-updates.log")),
    allowedUsers: parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS),
    allowedChats: parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    download: telegramDownloader(token),
    agent,
    view,
    directory: () => loadDirectory(directoryFile),
    dashboardUrl: process.env.DASHBOARD_URL ?? null,
    log: (line) => console.log(line),
  }),
);
console.log(`agent ${agentId} → ${policyId} on ${network}, extractor ${extractor.name}`);
