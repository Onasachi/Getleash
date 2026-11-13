/**
 * GetLeash's hosted MCP server, read-only (docs/decisions.md D-34): https://www.getleash.xyz/mcp. MCP clients
 * add it as a remote server (Claude's custom connectors; `claude mcp add --transport http getleash <url>`).
 * The handler is `@getleash/channel-mcp/http`: no key and no secret, only public contract views over NEAR RPC,
 * for the dashboard's own GetLeash or any other a call names. Paying is not offered here.
 */
import { hostedMcpHandler } from "@getleash/channel-mcp/http";
import { PolicyView, provider } from "@getleash/shared";

import { HOME_POLICY_ID, NETWORK, RPC_URL } from "@/lib/config";

/** A tool call reads a few views; a stuck RPC should not hold the function for long. */
export const maxDuration = 30;

const rpc = provider(RPC_URL);
const handle = hostedMcpHandler({
  network: NETWORK,
  contract: (id) => new PolicyView(rpc, id),
  fallback: HOME_POLICY_ID || "getleash.onanikes.near",
  log: (line) => console.log(line),
});

export async function POST(request: Request) {
  return handle(request);
}

/** No event stream and no session (stateless): both answer 405, with how to add the server. */
export async function GET(request: Request) {
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}
