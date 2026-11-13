/**
 * Asks GetLeash's MCP server one question, as an MCP client does: it starts `main.ts` over stdio with this
 * process's environment, calls one tool and prints the answer (the server's log lines go to stderr).
 *
 *   POLICY_CONTRACT_ID=getleash.onanikes.near pnpm --silent mcp:ask list_intents
 *   pnpm --silent mcp:ask list_intents '{"status": "open"}'
 *   pnpm --silent mcp:ask get_policy --json        (the facts as JSON instead of the summary)
 *   pnpm --silent mcp:ask submit_invoice --text-file invoice.txt [--offline]   (sent as the tool's `text`)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    "text-file": { type: "string" },
  },
});
const [tool, json] = positionals;
if (!tool) {
  console.error(
    "Usage: pnpm --silent mcp:ask <tool> ['<JSON arguments>'] [--text-file <invoice.txt>] [--offline] [--json]\n" +
      "Tools: get_policy, list_intents, list_suppliers, and submit_invoice when the server has the agent's key.",
  );
  process.exit(1);
}
const args = (json ? JSON.parse(json) : {}) as Record<string, unknown>;
if (values["text-file"]) args.text = readFileSync(values["text-file"], "utf8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url)), ...(values.offline ? ["--offline"] : [])],
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  stderr: "inherit",
});
const client = new Client({ name: "getleash-mcp-ask", version: "0.1.0" });
await client.connect(transport);
try {
  const result = await client.callTool({ name: tool, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  console.log((values.json && !result.isError ? content[1] : content[0])?.text ?? "");
  process.exitCode = result.isError ? 1 : 0;
} finally {
  await client.close();
}
