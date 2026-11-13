/**
 * GetLeash's MCP server (PLAN §4.6, docs/decisions.md D-34) against the real contract on a local NEAR
 * node: an MCP client hands fixture invoices to submit_invoice, and the agent pipeline (offline reader)
 * and the contract decide exactly as they do for the Telegram bot. The views read the same contract, and
 * so does the hosted endpoint (https://www.getleash.xyz/mcp) over HTTP, for a contract the call names.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InvoiceAgent, OfflineExtractor } from "@getleash/agent";
import { createServer } from "@getleash/channel-mcp";
import { hostedMcpHandler } from "@getleash/channel-mcp/http";
import { type Directory, PolicyView } from "@getleash/shared";

import { REPO_ROOT } from "../src/paths.ts";
import { startWorld, TRON_RECIPIENT, TRON_USDT, USDC, type World } from "../src/world.ts";

type Result = { content?: unknown; isError?: boolean };
const text = (r: Result) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
const facts = (r: Result) => JSON.parse((r.content as Array<{ text: string }>)[1]!.text) as Record<string, unknown>;
const fixture = (name: string) => readFileSync(join(REPO_ROOT, "fixtures/invoices", name), "utf8");

let world: World;
let client: Client;

beforeAll(async () => {
  world = await startWorld();
  const acme = await world.addSupplier({ chain: "NEAR", recipient: "acme.near", register: true });
  const shenzhen = await world.addSupplier({ chain: "TRON", recipient: TRON_RECIPIENT, assetId: TRON_USDT });
  // The directory the demo and `pnpm devnet` use.
  const directory: Directory = {
    suppliers: [
      { supplier_id: acme, name: "Acme Packaging Ltd", aliases: ["Acme Packaging"], payment_details: ["acme.near"], typical_amount: "18", currency: "USD" },
      { supplier_id: shenzhen, name: "Shenzhen Parts Co.", aliases: [], payment_details: [TRON_RECIPIENT], typical_amount: "2", currency: "USDT" },
    ],
  };
  const agent = new InvoiceAgent({ extractor: new OfflineExtractor(), view: world.view, agent: world.agent, tenantSecret: randomBytes(32), directory: () => directory });
  const server = createServer({ view: world.view, network: "sandbox", directory: () => directory, agent, dashboardUrl: "http://dashboard.test" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "sandbox-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client?.close();
  await world?.stop();
});

const submit = async (file: string) => (await client.callTool({ name: "submit_invoice", arguments: { text: fixture(file) } })) as Result;

describe("submit_invoice on a real contract", () => {
  it("pays an invoice within the agent's limits", async () => {
    const before = await world.balance();
    const r = await submit("01-acme-clean.txt");
    expect(text(r)).toContain("Paid Acme Packaging Ltd 18.00 USDC, within the limits the owner gave the agent");
    const id = facts(r).payment_id as number;
    expect((await world.view.intent(id))?.status).toBe("PAID");
    expect(before - (await world.balance())).toBe(18n * USDC);
  });

  it("refuses the same invoice in another layout: one payment per invoice", async () => {
    const before = await world.balance();
    const r = await submit("03-acme-duplicate-reformatted.txt");
    expect(text(r)).toContain("Not paid: this invoice was already paid, or is already waiting for you (OBLIGATION_OPEN_OR_PAID).");
    expect(await world.balance()).toBe(before);
  });

  it("refuses the poisoned invoice from a supplier who is not on the list", async () => {
    const before = await world.balance();
    const r = await submit("05-poisoned-unknown-supplier.txt");
    expect(facts(r)).toMatchObject({ outcome: "rejected_onchain", refusal: "UNKNOWN_SUPPLIER" });
    expect(text(r)).toContain("Not paid: the supplier is not on your approved list (UNKNOWN_SUPPLIER).");
    expect(await world.balance()).toBe(before);
  });

  it("leaves a large, unusual invoice waiting for the owner, with its page", async () => {
    const before = await world.balance();
    const r = await submit("09-acme-above-threshold.txt");
    const id = facts(r).payment_id as number;
    expect(text(r)).toContain(`Acme Packaging Ltd asks for 40.00 USDC. It waits for the owner's approval in their wallet because the agent flagged it for a closer look (payment #${id}).`);
    expect(text(r)).toContain(`Payment page: http://dashboard.test/intent/${id}?c=${world.policyId}`);
    expect((await world.view.intent(id))?.status).toBe("PENDING");
    expect(await world.balance()).toBe(before);
  });
});

describe("views on a real contract", () => {
  it("list_intents shows what was paid and what waits", async () => {
    const r = (await client.callTool({ name: "list_intents", arguments: {} })) as Result;
    const payments = facts(r).payments as Array<{ status: string; supplier_name: string; amount: string }>;
    expect(payments.map((p) => [p.status, p.supplier_name, p.amount])).toEqual([
      ["PENDING", "Acme Packaging Ltd", "40.00 USDC"],
      ["PAID", "Acme Packaging Ltd", "18.00 USDC"],
    ]);
  });

  it("get_policy shows today's use of the agent's budget", async () => {
    const r = (await client.callTool({ name: "get_policy", arguments: {} })) as Result;
    expect(text(r)).toContain("The agent pays on its own up to 25.00 USDC a payment and 50.00 USDC a day (used today: 18.00 USDC).");
    expect(text(r)).toContain("Treasury: 482.00 USDC.");
  });

  it("list_suppliers shows where each supplier is paid", async () => {
    const r = (await client.callTool({ name: "list_suppliers", arguments: {} })) as Result;
    expect(text(r)).toContain("#1 Acme Packaging Ltd: USDC at acme.near.");
    expect(text(r)).toContain(`#2 Shenzhen Parts Co.: USDT on Tron at ${TRON_RECIPIENT}.`);
  });
});

describe("the hosted endpoint on a real contract", () => {
  it("reads the contract a call names, over HTTP, with no key and no names", async () => {
    // As web/app/mcp/route.ts mounts it, with the local node's RPC and a default that is not this contract.
    const handler = hostedMcpHandler({ network: "sandbox", contract: (id) => new PolicyView(world.net.rpc, id), fallback: "getleash.elsewhere.near" });
    const hosted = new Client({ name: "sandbox-hosted", version: "1.0.0" });
    await hosted.connect(new StreamableHTTPClientTransport(new URL("https://www.getleash.test/mcp"), { fetch: (input, init) => handler(new Request(input, init)) }));
    try {
      expect((await hosted.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_policy", "list_intents", "list_suppliers"]);
      const policy = (await hosted.callTool({ name: "get_policy", arguments: { contract: world.policyId } })) as Result;
      expect(text(policy)).toContain(`${world.policyId} on sandbox: payments are on.`);
      expect(text(policy)).toContain("Treasury: 482.00 USDC.");
      const payments = (await hosted.callTool({ name: "list_intents", arguments: { contract: world.policyId } })) as Result;
      const list = facts(payments).payments as Array<{ status: string; supplier_name: string | null; link: string }>;
      expect(list.map((p) => [p.status, p.supplier_name])).toEqual([
        ["PENDING", null],
        ["PAID", null],
      ]);
      expect(list[0]!.link).toMatch(new RegExp(`^https://www\\.getleash\\.test/intent/\\d+\\?c=${world.policyId.replace(/\./g, "\\.")}$`));
    } finally {
      await hosted.close();
    }
  });
});
