/**
 * GetLeash's hosted MCP endpoint (https://www.getleash.xyz/mcp, docs/decisions.md D-34): the read-only tools
 * (`views.ts`) over MCP's Streamable HTTP transport, for clients that take a URL (Claude's custom
 * connectors, Claude Code's `--transport http`). Each request gets its own server and transport (stateless,
 * JSON responses), as serverless functions need. It holds no key and no secret: it reads public contract
 * state over NEAR RPC, for any GetLeash contract a call names. Paying is not offered here.
 *
 * Web-standard `Request`/`Response` only, so a Next.js route handler can mount it as is (`web/app/mcp`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { PolicyView } from "@getleash/shared";

import { registerViewTools } from "./views.ts";

export const HOSTED_INSTRUCTIONS = `GetLeash pays a business's suppliers in USDC under rules in a NEAR contract that the AI cannot change.
These tools read any GetLeash contract: its limits and today's use of them (get_policy), its payments (list_intents) and its approved suppliers (list_suppliers). Name the contract with the contract argument; without it they read the team's own GetLeash.
This server cannot pay, approve or change anything: invoices go to a business's GetLeash through its Telegram bot or its own MCP server, and every approval is signed in the owner's wallet.`;

/** Requests one client address may send per window, per running instance. */
export const HOSTED_RATE = { requests: 60, windowMs: 60_000 } as const;
/** A tool call is a few hundred bytes; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export type HostedOptions = {
  network: string;
  /** A reader for a named contract (one shared RPC provider behind it). */
  contract: (contractId: string) => PolicyView;
  /** The contract a call reads when it names none: the dashboard's own GetLeash. */
  fallback: string;
  rate?: { requests: number; windowMs: number };
  log?: (line: string) => void;
  now?: () => number;
};

/** A fixed-window counter per client address. Per instance: a serverless platform runs several. */
class RateLimit {
  private readonly seen = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly rate: { requests: number; windowMs: number },
    private readonly now: () => number,
  ) {}

  /** Seconds until this client may ask again, or 0 when it may now. */
  take(client: string): number {
    const t = this.now();
    if (this.seen.size > 10_000) {
      for (const [key, w] of this.seen) if (t - w.start >= this.rate.windowMs) this.seen.delete(key);
    }
    const w = this.seen.get(client);
    if (!w || t - w.start >= this.rate.windowMs) {
      this.seen.set(client, { start: t, count: 1 });
      return 0;
    }
    if (w.count >= this.rate.requests) return Math.ceil((w.start + this.rate.windowMs - t) / 1000);
    w.count += 1;
    return 0;
  }
}

/** The client's address as the platform's proxy reports it (Vercel sets x-forwarded-for). */
function clientOf(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

/** Handles one HTTP request to the endpoint: POST carries MCP messages; anything else is answered here. */
export function hostedMcpHandler(opts: HostedOptions): (request: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const limit = new RateLimit(opts.rate ?? HOSTED_RATE, now);

  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      // Stateless: no event stream to open (GET) and no session to end (DELETE). The spec's answer is 405.
      return plain(
        405,
        `This is GetLeash's MCP server (read-only). Add ${url.origin}${url.pathname} to an MCP client as a remote server, for example Claude Code: claude mcp add --transport http --scope user getleash ${url.origin}${url.pathname}`,
        { allow: "POST" },
      );
    }
    const wait = limit.take(clientOf(request));
    if (wait > 0) return plain(429, `Too many requests; try again in ${wait} s.`, { "retry-after": String(wait) });

    const server = new McpServer({ name: "getleash", version: "0.1.0" }, { instructions: HOSTED_INSTRUCTIONS });
    registerViewTools(server, {
      network: opts.network,
      contracts: { named: opts.contract, fallback: opts.fallback },
      // Supplier names are private: the hosted server has none and shows each supplier's id and address.
      directory: () => ({ suppliers: [] }),
      unnamed: "(name private)",
      // Links go to this site's dashboard pages, which read the named contract from `?c=`.
      dashboardUrl: url.origin,
      log: opts.log,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}
