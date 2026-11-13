/**
 * The hosted MCP endpoint (D-34, https://www.getleash.xyz/mcp) through the SDK's own Streamable HTTP
 * client, whose fetch calls the handler directly: read-only tools for any GetLeash contract a call names,
 * no submit_invoice, no supplier names, and the HTTP answers around the protocol (405, 429, 413).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type Intent, type PolicyView, type StateView, type Supplier } from "@getleash/shared";

import { hostedMcpHandler, type HostedOptions } from "../src/http.ts";

const URL_ = "https://www.getleash.test/mcp";

function state(owner: string): StateView {
  return {
    owner_id: owner,
    agent_id: `agent-1.${owner}`,
    executor_id: `executor-1.${owner}`,
    token_id: "usdc.test",
    token_decimals: 6,
    paused: false,
    executor_epoch: 1,
    policy: DEFAULT_POLICY,
    budgets: { day: 20_405, autonomous: "0", outflow: "0", trust: "0", proposals: 0 },
    next_supplier_id: 2,
    next_intent_id: 6,
    stored_intents: 1,
    paying: 0,
  };
}

const SUPPLIER: Supplier = { id: 1, chain: "NEAR", asset_id: "nep141:usdc.test", recipient: "chisolu.near", decimals: 6, active: true, revision: 0, changed_at: "0" };
const PAID: Intent = {
  id: 5,
  supplier_id: 1,
  revision: 0,
  obligation: "ab".repeat(32),
  amount_out: "250000",
  value: "250000",
  max_in: "250000",
  status: "PAID",
  route: "AUTONOMOUS",
  flag: 0,
  since: "1794000000000000000",
  created_at: "1794000000000000000",
  attempt: null,
};

/** Fake contracts: the team's, a business's, and an account that is not GetLeash. */
function contracts(read: string[]): HostedOptions["contract"] {
  return (id) => {
    read.push(id);
    return {
      contractId: id,
      state: async () => {
        if (id === "not-getleash.near") throw new Error("wasm execution failed: MethodNotFound");
        return state(id === "getleash.team.near" ? "team.near" : "biz.near");
      },
      treasuryBalance: async () => (id === "getleash.team.near" ? 2_960_000n : 40_000_000n),
      suppliers: async () => [SUPPLIER],
      recentIntents: async () => [PAID],
    } as unknown as PolicyView;
  };
}

function setup(opts: Partial<HostedOptions> = {}) {
  const read: string[] = [];
  const handler = hostedMcpHandler({ network: "mainnet", contract: contracts(read), fallback: "getleash.team.near", ...opts });
  return { handler, read };
}

async function connect(handler: (r: Request) => Promise<Response>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), { fetch: (input, init) => handler(new Request(input, init)) });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

type Result = { content?: unknown; isError?: boolean };
const text = (r: Result) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
/** The summary for people, without the JSON that follows it. */
const summary = (r: Result) => (r.content as Array<{ text: string }>)[0]!.text;
const facts = (r: Result) => JSON.parse((r.content as Array<{ text: string }>)[1]!.text) as Record<string, unknown>;

describe("hosted tools", () => {
  it("offers the three views, each taking a contract, and nothing that pays", async () => {
    const client = await connect(setup().handler);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_policy", "list_intents", "list_suppliers"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys(t.inputSchema.properties ?? {})).toContain("contract");
      expect(t.inputSchema.required ?? []).not.toContain("contract");
    }
    expect(client.getInstructions()).toContain("cannot pay, approve or change anything");
  });

  it("reads the team's GetLeash by default and any other named one, with links to this site", async () => {
    const { handler, read } = setup();
    const client = await connect(handler);
    const own = (await client.callTool({ name: "get_policy", arguments: {} })) as Result;
    expect(text(own)).toContain("getleash.team.near on mainnet: payments are on.");
    expect(text(own)).toContain("Treasury: 2.96 USDC.");
    expect(text(own)).toContain("Dashboard: https://www.getleash.test/payments?c=getleash.team.near");

    const other = (await client.callTool({ name: "list_intents", arguments: { contract: "biz-near.getleash.near" } })) as Result;
    expect(summary(other)).toMatch(/^#5 Paid: 0\.25 USDC to supplier #1 \(chisolu\.near\)\. Since .* https:\/\/www\.getleash\.test\/intent\/5\?c=biz-near\.getleash\.near$/);
    expect(read).toEqual(["getleash.team.near", "biz-near.getleash.near"]);
  });

  it("shows no supplier names: they are private", async () => {
    const r = (await (await connect(setup().handler)).callTool({ name: "list_suppliers", arguments: {} })) as Result;
    expect(summary(r)).toBe("#1 (name private): USDC at chisolu.near.");
    expect(facts(r)).toMatchObject({ suppliers: [{ id: 1, name: null, recipient: "chisolu.near" }] });
  });

  it("refuses a malformed account id and explains an account that is not GetLeash", async () => {
    const client = await connect(setup().handler);
    const bad = (await client.callTool({ name: "get_policy", arguments: { contract: "Not An Account!" } })) as Result;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Input validation error/);
    const other = (await client.callTool({ name: "get_policy", arguments: { contract: "not-getleash.near" } })) as Result;
    expect(other.isError).toBe(true);
    expect(text(other)).toContain("not-getleash.near on mainnet can't be read as a GetLeash contract: wasm execution failed: MethodNotFound");
  });

  it("has no submit_invoice to call", async () => {
    const r = (await (await connect(setup().handler)).callTool({ name: "submit_invoice", arguments: { text: "Invoice INV-1" } })) as Result;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Tool submit_invoice not found");
  });
});

describe("hosted HTTP", () => {
  it("answers a browser's GET with 405 and how to add the server", async () => {
    const res = await setup().handler(new Request(URL_));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.text()).toContain("claude mcp add --transport http --scope user getleash https://www.getleash.test/mcp");
  });

  it("limits how often one client may call, per instance", async () => {
    let t = 0;
    const { handler } = setup({ rate: { requests: 2, windowMs: 60_000 }, now: () => t });
    const post = (ip: string) =>
      handler(
        new Request(URL_, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": `${ip}, 10.0.0.1` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    expect((await post("1.2.3.4")).status).toBe(200);
    expect((await post("1.2.3.4")).status).toBe(200);
    const third = await post("1.2.3.4");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    expect((await post("5.6.7.8")).status).toBe(200);
    t = 60_000;
    expect((await post("1.2.3.4")).status).toBe(200);
  });

  it("answers one tool call without a handshake, as a curl command sends it", async () => {
    const res = await setup().handler(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_policy", arguments: {} } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain("getleash.team.near on mainnet: payments are on.");
  });

  it("refuses a body far larger than any tool call", async () => {
    const res = await setup().handler(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } }),
      }),
    );
    expect(res.status).toBe(413);
  });
});
