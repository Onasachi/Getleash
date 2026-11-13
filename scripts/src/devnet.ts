/**
 * A long-running local deployment for development and for looking at the dashboard offline:
 * local NEAR node + contract + mock-1click + executor loop, seeded with suppliers and a few
 * fixture invoices. Prints the environment for `pnpm dashboard`.
 *
 *   pnpm devnet        (Ctrl-C to stop; everything is thrown away)
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvoiceAgent, OfflineExtractor } from "@getleash/agent";
import { REPO_ROOT } from "@getleash/devkit/paths";
import { startWorld, TRON_RECIPIENT, TRON_USDT } from "@getleash/devkit/world";
import type { Directory } from "@getleash/shared";

const world = await startWorld({ log: (l) => console.log(l) });
const acme = await world.addSupplier({ chain: "NEAR", recipient: "acme.near", register: true });
const shenzhen = await world.addSupplier({ chain: "TRON", recipient: TRON_RECIPIENT, assetId: TRON_USDT });
const directory: Directory = {
  suppliers: [
    { supplier_id: acme, name: "Acme Packaging Ltd", aliases: ["Acme Packaging"], payment_details: ["acme.near"], typical_amount: "18", currency: "USD" },
    { supplier_id: shenzhen, name: "Shenzhen Parts Co.", aliases: [], payment_details: [TRON_RECIPIENT], typical_amount: "2", currency: "USDT" },
  ],
};
// Shared with the MCP server printed below, so an invoice is the same obligation whichever way it comes in.
const tenantSecret = randomBytes(32);
const agent = new InvoiceAgent({
  extractor: new OfflineExtractor(),
  view: world.view,
  agent: world.agent,
  tenantSecret,
  directory: () => directory,
  dashboardUrl: "http://localhost:3000",
  log: (l) => console.log(l),
});
const { executor } = world.makeExecutor({ dashboardUrl: "http://localhost:3000" });
for (const file of ["01-acme-clean.txt", "02-shenzhen-clean.txt", "05-poisoned-unknown-supplier.txt", "06-shenzhen-address-swap.txt", "09-acme-above-threshold.txt"]) {
  await agent.process({ key: `devnet-${file.slice(0, 2)}`, source: "demo", receivedAt: new Date().toISOString(), text: readFileSync(join(REPO_ROOT, "fixtures/invoices", file), "utf8"), files: [] });
  for (let i = 0; i < 8; i++) {
    await executor.tick();
    await new Promise((r) => setTimeout(r, 300));
  }
}
// One cross-chain payment above the trust budget, left waiting for the owner's signature.
const big = await world.agent.propose({ obligationId: "ee".repeat(32), supplierId: shenzhen, amountOut: 8_000_000n, reviewFlag: null });
console.log(`intent ${big.value.intent_id}: ${big.value.status}`);

// The MCP server (channels/mcp) as the agent of this deployment: the throwaway agent key of this local
// node, the same tenant secret and supplier names, and the offline reader.
const directoryFile = join(tmpdir(), `getleash-devnet-${process.pid}-directory.json`);
writeFileSync(directoryFile, JSON.stringify(directory));
const mcpEnv = [
  "NEAR_NETWORK=sandbox",
  `NEAR_RPC_URL=${world.net.rpcUrl}`,
  `POLICY_CONTRACT_ID=${world.policyId}`,
  `AGENT_ACCOUNT_ID=${(await world.view.state()).agent_id}`,
  `AGENT_PRIVATE_KEY=${world.agentPrivateKey}`,
  `TENANT_SECRET=${tenantSecret.toString("hex")}`,
  `GETLEASH_DIRECTORY=${directoryFile}`,
  "DASHBOARD_URL=http://localhost:3000",
].join(" ");

console.log(`
Local deployment is up. In another terminal:

  NEXT_PUBLIC_NEAR_NETWORK=testnet NEXT_PUBLIC_NEAR_RPC_URL=${world.net.rpcUrl} NEXT_PUBLIC_POLICY_CONTRACT_ID=${world.policyId} NEXT_PUBLIC_ONECLICK_URL=${world.mock.url} pnpm dashboard

(The wallet button cannot sign on a local node; owner actions are exercised by the tests.)

GetLeash's MCP server as this deployment's agent (a throwaway key on this local node), for example:

  ${mcpEnv} pnpm --silent mcp:ask submit_invoice --offline --text-file fixtures/invoices/01-acme-clean.txt

or as a server for an MCP client: the same variables, then \`pnpm --silent mcp --offline\`.
Ctrl-C stops everything.`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  executor.stop();
  rmSync(directoryFile, { force: true });
  await world.stop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
await executor.run(2_000);
