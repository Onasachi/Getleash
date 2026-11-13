/**
 * GetLeash's MCP server over stdio (PLAN §4.6, docs/decisions.md D-34), for AI assistants on the
 * owner's machine:
 *
 *   pnpm --silent mcp [--offline]
 *
 * It serves POLICY_CONTRACT_ID on NEAR_NETWORK (mainnet when unset), read through NEAR_RPC_URL or the
 * network's public RPCs. Without AGENT_ACCOUNT_ID it offers the views only, which need no key. With the
 * agent's function-call key (AGENT_PRIVATE_KEY, or its key file as for the bot), TENANT_SECRET and
 * NEAR_AI_API_KEY (or --offline: the text-only reader) it also takes invoices, through the same pipeline
 * as the Telegram bot. TENANT_SECRET must be the bot's: it makes the same invoice the same obligation,
 * so the contract refuses to pay it twice whichever way it came in. With INVOICE_STORE_KEY the invoices
 * are kept in the encrypted invoice store, as the bot keeps them.
 *
 * stdout carries the protocol and nothing else: logs go to stderr, and `--silent` keeps pnpm's banner off.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { InvoiceAgent, InvoiceStore, NearAiExtractor, networkVerifiers, OfflineExtractor, parseStoreKey } from "@getleash/agent";
import { parseTenantSecret } from "@getleash/ingestion";
import { AgentClient, networkId, PolicyView, provider, serviceRpcUrls } from "@getleash/shared";
import { dashboardUrlFromEnv, dataDir, directoryPath, keyFilePath, loadServiceDirectory, signingAccount } from "@getleash/shared/node";

import { createServer } from "./server.ts";

const log = (line: string) => console.error(line);
function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false } } });
const network = networkId(process.env.NEAR_NETWORK);
const rpc = provider(serviceRpcUrls(network, process.env.NEAR_RPC_URL));
const policyId = process.env.POLICY_CONTRACT_ID || fail("POLICY_CONTRACT_ID is not set: the GetLeash contract to serve, for example getleash.onanikes.near");
const view = new PolicyView(rpc, policyId);
const state = await view.state().catch((error: unknown) => fail(`${policyId} on ${network} can't be read as a GetLeash contract: ${(error as Error).message}`));
// The public dashboard reads any mainnet contract from `?c=`.
const dashboardUrl = dashboardUrlFromEnv() ?? (network === "mainnet" ? "https://www.getleash.xyz" : null);
const directoryFile = directoryPath(network);
const directory = () => loadServiceDirectory(directoryFile);

let agent: InvoiceAgent | null = null;
const agentId = process.env.AGENT_ACCOUNT_ID;
if (agentId) {
  if (state.agent_id !== agentId) fail(`${policyId} expects agent ${state.agent_id}, not ${agentId}`);
  const keyFile = process.env.AGENT_KEY_FILE ?? keyFilePath(network, agentId);
  const account = signingAccount(rpc, agentId, { privateKey: process.env.AGENT_PRIVATE_KEY, keyFile: existsSync(keyFile) ? keyFile : undefined });
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey && !values.offline) fail("NEAR_AI_API_KEY is not set. Use --offline for the text-only reader (no TEE, no verification badge).");
  const extractor = apiKey
    ? new NearAiExtractor({ apiKey, baseUrl: process.env.NEAR_AI_BASE_URL, model: process.env.NEAR_AI_MODEL || undefined, verifiers: await networkVerifiers() })
    : new OfflineExtractor();
  const storeKey = process.env.INVOICE_STORE_KEY;
  agent = new InvoiceAgent({
    extractor,
    view,
    agent: new AgentClient(account, policyId),
    tenantSecret: parseTenantSecret(process.env.TENANT_SECRET),
    directory,
    store: storeKey ? new InvoiceStore(join(dataDir(network), "invoices"), parseStoreKey(storeKey)) : null,
    dashboardUrl,
    dashboardContract: policyId,
    log,
  });
  log(`[mcp] invoices go to ${policyId} as ${agentId}, read by ${extractor.name}; ${storeKey ? "kept in the encrypted invoice store" : "not kept (INVOICE_STORE_KEY is not set)"}`);
  log(`[mcp] supplier names: ${directory().suppliers.length} (${directoryFile}${process.env.GETLEASH_DIRECTORY_BASE64 ? " and GETLEASH_DIRECTORY_BASE64" : ""})`);
} else {
  log(`[mcp] read-only: AGENT_ACCOUNT_ID is not set, so submit_invoice is not offered`);
}

const server = createServer({ view, network, directory, agent, dashboardUrl, log });
await server.connect(new StdioServerTransport());
log(`[mcp] GetLeash MCP server: ${policyId} on ${network}, dashboard ${dashboardUrl ?? "not set"}`);
