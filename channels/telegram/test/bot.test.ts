/**
 * The Telegram channel with a fake Bot API: replay dedupe (§9 "Telegram update replayed → one
 * obligation"), the allowlist, size limits before download, and commands. The agent and the
 * contract views are faked; the agent pipeline itself is covered by the offline demo.
 */
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import type { AgentOutcome, InvoiceAgent } from "@getleash/agent";
import { UpdateLog } from "@getleash/ingestion";
import type { PolicyView } from "@getleash/shared";

import { parseIdList, TelegramChannel } from "../src/bot.ts";

const OWNER = 1001;
const CHAT = 2002;

function message(update_id: number, fields: Record<string, unknown>, from = OWNER, chat = CHAT): Update {
  return {
    update_id,
    message: { message_id: update_id, date: 1_793_600_000, chat: { id: chat, type: "private", first_name: "Owner" }, from: { id: from, is_bot: false, first_name: "Owner" }, ...fields },
  } as unknown as Update;
}

function setup(overrides: { download?: (p: string) => Promise<Uint8Array>; fileSize?: number } = {}) {
  const sent: Array<{ chatId: string | number; text: string }> = [];
  const processed: string[] = [];
  const downloads: string[] = [];
  const agent = {
    process: async (input: { key: string }) => {
      processed.push(input.key);
      return {
        key: input.key,
        status: "rejected_onchain",
        decision: { action: "propose", supplierId: 1, supplierName: "Acme", amountOut: 18_000_000n, invoiceNumber: "1001", reviewFlag: null, flags: [], notes: [] },
        result: { accepted: false, intent_id: null, status: null, route: null, intent_hash: null, reason: "OBLIGATION_OPEN_OR_PAID" },
        obligationId: "00".repeat(32),
        badge: "Verification unavailable",
        model: "offline-text-reader",
        summary: "refused by the contract: OBLIGATION_OPEN_OR_PAID",
        notices: [],
      } satisfies AgentOutcome;
    },
  } as unknown as InvoiceAgent;
  const view = {
    openWork: async () => [],
    suppliers: async () => [],
  } as unknown as PolicyView;
  const channel = new TelegramChannel({
    api: {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return {};
      },
      getFile: async (fileId) => ({ file_path: `documents/${fileId}.pdf`, file_size: overrides.fileSize ?? 1000 }),
    },
    updateLog: new UpdateLog(null),
    allowedUsers: parseIdList(String(OWNER)),
    allowedChats: parseIdList(String(CHAT)),
    download: async (path) => {
      downloads.push(path);
      return overrides.download ? overrides.download(path) : new TextEncoder().encode("%PDF-1.7 fake");
    },
    agent,
    view,
    directory: () => ({ suppliers: [] }),
    dashboardUrl: "https://getleash.example",
  });
  return { channel, sent, processed, downloads };
}

describe("Telegram channel", () => {
  it("a replayed update is processed once (§9 row: Telegram update replayed)", async () => {
    const { channel, processed } = setup();
    const update = message(500, { text: "INVOICE\nFrom: Acme\nInvoice No: 1001\nTotal: USD 18" });
    expect(await channel.handle(update)).toBe("invoice:rejected_onchain");
    expect(await channel.handle(update)).toBe("ignored:DUPLICATE_UPDATE");
    expect(processed).toEqual(["telegram-500"]);
  });

  it("ignores unapproved senders and chats silently", async () => {
    const { channel, sent, processed } = setup();
    expect(await channel.handle(message(501, { text: "invoice" }, 666))).toBe("ignored:NOT_ALLOWED");
    expect(await channel.handle(message(502, { text: "invoice" }, OWNER, 777))).toBe("ignored:NOT_ALLOWED");
    expect(await channel.handle(message(503, { text: "/status" }, 666))).toBe("not_allowed");
    expect(sent).toEqual([]);
    expect(processed).toEqual([]);
  });

  it("refuses an oversized file before downloading it", async () => {
    const { channel, downloads, sent } = setup();
    const result = await channel.handle(
      message(504, { document: { file_id: "big", file_unique_id: "u", file_name: "inv.pdf", file_size: 11 * 1024 * 1024 } }),
    );
    expect(result).toBe("ignored:LIMIT");
    expect(downloads).toEqual([]);
    expect(sent[0]!.text).toMatch(/FILE_TOO_LARGE/);
  });

  it("refuses files that are not PDFs or images, by content", async () => {
    const { channel } = setup({ download: async () => new TextEncoder().encode("MZ\x90\x00 not a pdf") });
    const result = await channel.handle(message(505, { document: { file_id: "exe", file_unique_id: "u", file_name: "invoice.pdf", file_size: 100 } }));
    expect(result).toBe("ignored:LIMIT");
  });

  it("answers commands only in approved chats and replies with links", async () => {
    const { channel, sent } = setup();
    expect(await channel.handle(message(506, { text: "/pending" }))).toBe("command:pending");
    expect(sent.at(-1)!.text).toBe("Nothing is waiting for you.");
    expect(await channel.handle(message(507, { text: "/pause" }))).toBe("command:pause");
    expect(sent.at(-1)!.text).toContain("https://getleash.example/pause");
  });

  it("reply to an invoice carries the enum code and the badge, not model text", async () => {
    const { channel, sent } = setup();
    await channel.handle(message(508, { text: "INVOICE\nFrom: Acme\nInvoice No: 1001\nTotal: USD 18" }));
    expect(sent.at(-1)!.text).toContain("OBLIGATION_OPEN_OR_PAID");
    expect(sent.at(-1)!.text).toContain("Inference: Verification unavailable");
  });
});
