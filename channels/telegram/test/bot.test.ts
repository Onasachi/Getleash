/**
 * The Telegram channel with a fake Bot API: replay dedupe (§9 "Telegram update replayed → one
 * obligation"), the allowlist, size limits before download, and commands. The agent and the
 * contract views are faked; the agent pipeline itself is covered by the offline demo.
 */
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import type { AgentOutcome, InvoiceAgent } from "@getleash/agent";
import { UpdateLog } from "@getleash/ingestion";
import type { IntentStatus, PolicyView } from "@getleash/shared";

import { coveredNotices, parseIdList, TelegramChannel } from "../src/bot.ts";

const OWNER = 1001;
const CHAT = 2002;

function message(update_id: number, fields: Record<string, unknown>, from = OWNER, chat = CHAT): Update {
  return {
    update_id,
    message: { message_id: update_id, date: 1_793_600_000, chat: { id: chat, type: "private", first_name: "Owner" }, from: { id: from, is_bot: false, first_name: "Owner" }, ...fields },
  } as unknown as Update;
}

const REFUSED = {
  status: "rejected_onchain",
  result: { accepted: false, intent_id: null, status: null, route: null, reason: "OBLIGATION_OPEN_OR_PAID" },
  intentStatus: null,
  intentSince: null,
  supplier: null,
  summary: "refused by the contract: OBLIGATION_OPEN_OR_PAID",
} satisfies Partial<AgentOutcome>;

function setup(
  overrides: {
    download?: (p: string) => Promise<Uint8Array>;
    fileSize?: number;
    outcome?: Partial<AgentOutcome>;
    ownerChatId?: string;
  } = {},
) {
  const sent: Array<{ chatId: string | number; text: string }> = [];
  const processed: string[] = [];
  const downloads: string[] = [];
  const delivered: string[] = [];
  const agent = {
    process: async (input: { key: string }) => {
      processed.push(input.key);
      return {
        key: input.key,
        decision: { action: "propose", supplierId: 1, supplierName: "Acme", amountOut: 18_000_000n, invoiceNumber: "1001", reviewFlag: null, flags: [], notes: [] },
        obligationId: "00".repeat(32),
        badge: "Verification unavailable",
        model: "offline-text-reader",
        notices: [],
        ...REFUSED,
        ...overrides.outcome,
      } satisfies AgentOutcome;
    },
  } as unknown as InvoiceAgent;
  const view = {
    state: async () => ({ token_decimals: 6, policy: { cooldown_ns: "0" } }),
    recentIntents: async () => [],
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
    ownerChatId: overrides.ownerChatId ?? null,
    delivered: { add: (keys: readonly string[]) => void delivered.push(...keys) },
  });
  return { channel, sent, processed, downloads, delivered };
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

  it("reply to an invoice says why in plain words, with the enum code and the badge, not model text", async () => {
    const { channel, sent } = setup();
    await channel.handle(message(508, { text: "INVOICE\nFrom: Acme\nInvoice No: 1001\nTotal: USD 18" }));
    expect(sent.at(-1)!.text).toContain("⛔ Not paid: this invoice was already paid, or is already waiting for you (OBLIGATION_OPEN_OR_PAID).");
    expect(sent.at(-1)!.text).toContain("Inference: Verification unavailable");
  });

  it("a reply in the owner's chat stands in for the executor's notice of the same news", async () => {
    const pending = { status: "proposed", intentStatus: "PENDING", result: { accepted: true, intent_id: 2, status: "PENDING", route: "ABOVE_THRESHOLD", reason: null } } as const;
    const inOwnerChat = setup({ outcome: pending, ownerChatId: String(CHAT) });
    await inOwnerChat.channel.handle(message(509, { text: "INVOICE\nTotal: USD 3" }));
    expect(inOwnerChat.sent.at(-1)!.text).toContain("Acme asks for 18.00. It needs your OK because it is above what the agent may pay on its own (payment #2).");
    expect(inOwnerChat.sent.at(-1)!.text).toContain("Review and approve: https://getleash.example/intent/2");
    expect(inOwnerChat.delivered).toEqual(["approval:2"]);

    // Invoices from any other approved chat leave the owner's notices to the executor.
    const elsewhere = setup({ outcome: pending, ownerChatId: "4004" });
    await elsewhere.channel.handle(message(510, { text: "INVOICE\nTotal: USD 3" }));
    expect(elsewhere.delivered).toEqual([]);
  });

  it("names the payment results it covered by their status time", () => {
    const proposed = (intentStatus: IntentStatus, intentSince: string | null): AgentOutcome => ({
      key: "k",
      status: "proposed",
      decision: null,
      result: { accepted: true, intent_id: 1, status: intentStatus === "APPROVED" ? "APPROVED" : "PAYING", route: "AUTONOMOUS", reason: null },
      intentStatus,
      intentSince,
      supplier: null,
      obligationId: null,
      badge: "",
      model: null,
      summary: "",
      notices: [],
    });
    expect(coveredNotices(proposed("PAID", "7"))).toEqual(["paid:1:7"]);
    expect(coveredNotices(proposed("FAILED", "8"))).toEqual(["failed:1:8"]);
    // Still in flight, or cross-chain: the executor's later notices carry news the reply did not.
    expect(coveredNotices(proposed("PAYING", null))).toEqual([]);
    expect(coveredNotices(proposed("APPROVED", null))).toEqual([]);
  });
});
