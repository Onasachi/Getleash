/**
 * The intake service: Telegram bot + agent pipeline (PLAN §4.3, §4.4).
 *
 *   pnpm bot
 *
 * Holds only the agent's function-call key (`propose`), TENANT_SECRET for obligation ids and
 * INVOICE_STORE_KEY for the encrypted invoice store. Without NEAR_AI_API_KEY it refuses to start
 * unless --offline is given (offline text reader, "Verification unavailable" on every invoice).
 *
 * The same bot serves the businesses that set up their own GetLeash through it (docs/decisions.md
 * D-30): each has its own contract, agent key, secrets and files under <data dir>/hosted/. Signup is
 * open when GETLEASH_DATA_DIR names a disk that survives restarts (their keys live there) and
 * DASHBOARD_URL is an https address; GETLEASH_SIGNUP=off closes it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Bot } from "grammy";

import { InvoiceAgent, InvoiceStore, NearAiExtractor, networkVerifiers, OfflineExtractor, parseStoreKey } from "@getleash/agent";
import { LIMITS, parseTenantSecret, Semaphore, UpdateLog } from "@getleash/ingestion";
import { AgentClient, networkId, PolicyView, provider, serviceRpcUrls, signSetupLink } from "@getleash/shared";
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

import { type BotApi, parseIdList, startBot, TelegramChannel, TelegramHub, telegramDownloader } from "./bot.ts";
import { SupplierOnboarding } from "./onboarding.ts";
import { PendingUpdates } from "./pending.ts";
import { BusinessSignup } from "./signup.ts";

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
const rpc = provider(serviceRpcUrls(network, process.env.NEAR_RPC_URL));
const dashboardUrl = dashboardUrlFromEnv();
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
const directory = () => loadServiceDirectory(directoryFile);
const agent = new InvoiceAgent({
  extractor,
  view,
  agent: new AgentClient(account, policyId),
  tenantSecret: parseTenantSecret(process.env.TENANT_SECRET),
  directory,
  store: new InvoiceStore(join(dir, "invoices"), parseStoreKey(process.env.INVOICE_STORE_KEY)),
  dashboardUrl,
  log: (line) => console.log(line),
});

const token = env("TELEGRAM_BOT_TOKEN");
const log = (line: string) => console.log(line);
const updateLog = new UpdateLog(join(dir, "telegram-updates.log"));
const download = telegramDownloader(token);
// One limit on invoices read at once, across every business.
const jobs = new Semaphore(LIMITS.maxConcurrentJobs);

// ── Hosted businesses (D-30) ──────────────────────────────────────────────────────────────────
const businesses = new HostedBusinesses(hostedDir(network));
/** How many businesses this service takes: GETLEASH_MAX_BUSINESSES, 50 when it is unset, empty or not a number. */
const maxBusinesses = (() => {
  const value = Number.parseInt(process.env.GETLEASH_MAX_BUSINESSES ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : 50;
})();
/** Invoices a hosted business can have read per day: its share of the operator's model budget (the contract takes 20 proposals a day). */
const HOSTED_INVOICES_PER_DAY = 50;

/** The hosted businesses, or null when the registry can't be read (then none is served, signup is closed, and the operator's own GetLeash runs as usual). */
const hostedList: HostedBusiness[] | null = (() => {
  try {
    return businesses.list();
  } catch (error) {
    console.error(`✗ ${businesses.root}/businesses.json can't be read (${(error as Error).message}): no hosted business is served until it is fixed`);
    return null;
  }
})();

/** Whether people outside the allowlist may set up their own GetLeash here, and if not, why. */
function signupClosed(): string | null {
  if (process.env.GETLEASH_SIGNUP === "off") return "GETLEASH_SIGNUP=off";
  if (hostedList === null) return "the hosted businesses' registry can't be read";
  if (!process.env.GETLEASH_DATA_DIR) return "GETLEASH_DATA_DIR is not set, and each business's keys need a disk that survives restarts";
  if (!dashboardUrl?.startsWith("https://")) return "DASHBOARD_URL is not an https address, which Telegram needs to open the setup page";
  return null;
}

/** A hosted business's channel: its own contract, agent key, secrets, supplier names and invoices; it answers its owner only. */
function hostedChannel(api: BotApi, business: HostedBusiness): TelegramChannel {
  const secrets = businesses.secrets(business.policy_id);
  const home = businesses.dir(business.policy_id);
  const businessView = new PolicyView(rpc, business.policy_id);
  const names = join(home, "directory.json");
  const businessDirectory = () => loadDirectory(names);
  const businessAgent = new InvoiceAgent({
    extractor,
    view: businessView,
    agent: new AgentClient(signingAccount(rpc, business.agent_id, { privateKey: secrets.agent_private_key }), business.policy_id),
    tenantSecret: parseTenantSecret(secrets.tenant_secret),
    directory: businessDirectory,
    store: new InvoiceStore(join(home, "invoices"), parseStoreKey(secrets.invoice_store_key)),
    dashboardUrl,
    dashboardContract: business.policy_id,
    log,
  });
  return new TelegramChannel({
    api,
    updateLog,
    allowedUsers: new Set([business.owner_user]),
    allowedChats: new Set([business.owner_chat]),
    download,
    agent: businessAgent,
    view: businessView,
    directory: businessDirectory,
    dashboardUrl,
    dashboardContract: business.policy_id,
    ownerChatId: business.owner_chat,
    ownerChatOnly: true,
    delivered: new DeliveredNotices(join(home, "owner-notices.jsonl")),
    onboarding: new SupplierOnboarding({ statePath: join(home, "supplier-onboarding.json"), directoryPath: names, directory: businessDirectory, view: businessView }),
    jobs,
    invoicesPerDay: HOSTED_INVOICES_PER_DAY,
    log,
  });
}

const closed = signupClosed();
// Updates taken from Telegram and not finished yet, kept across restarts (encrypted like the invoice store).
const pending = new PendingUpdates(join(dir, "telegram-pending.jsonl"), parseStoreKey(process.env.INVOICE_STORE_KEY));
/** The operator's own channel, one for each hosted business, and the signup, behind one hub. */
function makeHub(bot: Bot): TelegramHub {
  const hub = new TelegramHub(
    new TelegramChannel({
      api: bot.api,
      updateLog,
      allowedUsers: parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS),
      allowedChats: parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
      download,
      agent,
      view,
      directory,
      dashboardUrl,
      ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID ?? null,
      delivered: new DeliveredNotices(ownerNoticesPath(network)),
      // Suppliers added in Telegram: their names go to the directory file on this machine's disk.
      onboarding: new SupplierOnboarding({ statePath: join(dir, "supplier-onboarding.json"), directoryPath: directoryFile, directory, view }),
      jobs,
      log,
    }),
    null,
    log,
  );
  const serve = (business: HostedBusiness) => hub.add(hostedChannel(bot.api, business));
  for (const business of hostedList ?? []) {
    try {
      serve(business);
    } catch (error) {
      console.error(`✗ hosted ${business.policy_id}: ${(error as Error).message}`);
    }
  }
  if (!closed) {
    hub.setSignup(
      new BusinessSignup({
        api: bot.api,
        updateLog,
        statePath: join(businesses.root, "signup.json"),
        home: view,
        dashboardUrl: dashboardUrl!,
        isMember: (user) => hub.isMember(user),
        count: () => {
          try {
            return businesses.list().length;
          } catch {
            return Number.POSITIVE_INFINITY; // a registry that can't be read takes nobody new
          }
        },
        maxBusinesses,
        activate: async (business, secrets) => {
          businesses.add(business, secrets);
          serve(business);
        },
        hosted: (id) => {
          try {
            return businesses.list().find((b) => b.policy_id === id) ?? null;
          } catch {
            return null;
          }
        },
        move: async (business, to) => {
          const moved = businesses.move(business.policy_id, to);
          hub.replace(hostedChannel(bot.api, moved));
          return moved;
        },
        // The operator's agent key signs setup links; the page reads that agent's keys from the chain.
        signLink: (link) => signSetupLink(account.getSigner()!, agentId, link),
        viewOf: (id) => new PolicyView(rpc, id),
        log,
      }),
    );
  }
  return hub;
}
startBot(token, makeHub, log, pending);
console.log(`agent ${agentId} → ${policyId} on ${network}, extractor ${extractor.name}, dashboard ${dashboardUrl ?? "not set"}`);
console.log(`supplier names: ${directory().suppliers.length}; names added in Telegram are kept in ${directoryFile}`);
console.log(`hosted businesses: ${hostedList?.length ?? "unreadable"} (in ${businesses.root}); signup ${closed ? `closed: ${closed}` : `open: /start → ${dashboardUrl}/setup`}`);
