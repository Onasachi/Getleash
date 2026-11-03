/**
 * The Telegram channel with a fake Bot API: replay dedupe (§9 "Telegram update replayed → one
 * obligation"), the allowlist, size limits before download, and commands. The agent and the
 * contract views are faked; the agent pipeline itself is covered by the offline demo.
 */
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import type { AgentOutcome, InvoiceAgent } from "@getleash/agent";
import { UpdateLog } from "@getleash/ingestion";
import type { Intent, IntentStatus, PolicyView } from "@getleash/shared";

import { coveredNotices, parseIdList, TelegramChannel } from "../src/bot.ts";
import { telegramMessage, TelegramNotifier } from "../src/notifier.ts";

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
    dashboardUrl?: string;
    refuseButtons?: boolean;
    intents?: Array<Partial<Intent>>;
  } = {},
) {
  const sent: Array<{ chatId: string | number; text: string; other?: Record<string, unknown> }> = [];
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
    state: async () => ({ owner_id: "owner.near", paused: false, token_decimals: 6, policy: { cooldown_ns: "0" } }),
    recentIntents: async () => overrides.intents ?? [],
    suppliers: async () => [],
  } as unknown as PolicyView;
  const channel = new TelegramChannel({
    api: {
      sendMessage: async (chatId, text, other) => {
        if (overrides.refuseButtons && other?.reply_markup) throw new Error("Bad Request: BUTTON_TYPE_INVALID");
        sent.push({ chatId, text, other });
        return {};
      },
      getFile: async (fileId) => ({ file_path: `documents/${fileId}.pdf`, file_size: overrides.fileSize ?? 1000 }),
      getMe: async () => ({ username: "GetLeashBot" }),
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
    directory: () => ({ suppliers: [{ supplier_id: 1, name: "Acme" }] }) as never,
    dashboardUrl: overrides.dashboardUrl ?? "https://getleash.example",
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

  it("answers commands only in approved chats, with buttons for the pages they point to", async () => {
    const { channel, sent } = setup();
    expect(await channel.handle(message(506, { text: "/pending" }))).toBe("command:pending");
    expect(sent.at(-1)!.text).toBe("Nothing is waiting for you.");
    expect(await channel.handle(message(507, { text: "/pause" }))).toBe("command:pause");
    expect(sent.at(-1)!.other?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Pause payments", web_app: { url: "https://getleash.example/pause" } }]] });

    const waiting = setup({ intents: [{ id: 4, status: "PENDING", supplier_id: 1, value: "500000", attempt: null }, { id: 3, status: "PAID", supplier_id: 1, value: "1", attempt: null }] });
    await waiting.channel.handle(message(514, { text: "/pending" }));
    expect(waiting.sent.at(-1)!.text).toBe("• Acme · 0.50: needs your OK (payment #4)");
    expect(waiting.sent.at(-1)!.other?.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Payment #4: Acme · 0.50", web_app: { url: "https://getleash.example/intent/4" } }]],
    });
  });

  it("/wallet opens HOT Wallet in Telegram and the page that checks it signs as the owner", async () => {
    const { channel, sent } = setup();
    expect(await channel.handle(message(515, { text: "/wallet" }))).toBe("command:wallet");
    expect(sent.at(-1)!.text).toContain("signed in your NEAR wallet, as owner.near");
    expect(sent.at(-1)!.text).toContain("Never send that phrase in a chat");
    // HOT Wallet is another bot's Mini App: a t.me link button, which Telegram opens itself.
    expect(sent.at(-1)!.other?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Open HOT Wallet", url: "https://t.me/hot_wallet/app" }],
        [{ text: "Check my wallet", web_app: { url: "https://getleash.example/wallet" } }],
      ],
    });
    // With a local dashboard the check page cannot be a button; its address goes in the text.
    const local = setup({ dashboardUrl: "http://localhost:3000" });
    await local.channel.handle(message(516, { text: "/wallet" }));
    expect(local.sent.at(-1)!.text).toContain("Check my wallet: http://localhost:3000/wallet");
    expect(local.sent.at(-1)!.other?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Open HOT Wallet", url: "https://t.me/hot_wallet/app" }]] });
  });

  it("reply to an invoice says why in plain words, with the enum code and the badge, not model text", async () => {
    const { channel, sent } = setup();
    await channel.handle(message(508, { text: "INVOICE\nFrom: Acme\nInvoice No: 1001\nTotal: USD 18" }));
    expect(sent.at(-1)!.text).toContain("⛔ Not paid: this invoice was already paid, or is already waiting for you (OBLIGATION_OPEN_OR_PAID).");
    expect(sent.at(-1)!.text).toContain("Inference: Verification unavailable");
  });

  it("an invoice from someone not on the list says how to add them, without offering the invoice's own address", async () => {
    const { channel, sent } = setup({
      outcome: {
        result: { accepted: false, intent_id: null, status: null, route: null, reason: "UNKNOWN_SUPPLIER" },
        decision: { action: "propose", supplierId: 0, supplierName: "Global Freight Solutions", amountOut: 45_000_000n, invoiceNumber: "GFS7781", reviewFlag: null, flags: [], notes: [] },
      },
    });
    await channel.handle(message(517, { text: "INVOICE\nFrom: Global Freight Solutions\nInvoice No: GFS-7781\nTotal: USDT 45.00" }));
    expect(sent.at(-1)!.text).toContain("⛔ Not paid: the supplier is not on your approved list (UNKNOWN_SUPPLIER). That was 45.00 to Global Freight Solutions.");
    expect(sent.at(-1)!.text).toContain("add them first: /addsupplier with their name and the address they gave you themselves (an invoice can be faked)");
    expect(sent.at(-1)!.other?.reply_markup).toBeUndefined();
  });

  it("a reply in the owner's chat stands in for the executor's notice of the same news", async () => {
    const pending = { status: "proposed", intentStatus: "PENDING", result: { accepted: true, intent_id: 2, status: "PENDING", route: "ABOVE_THRESHOLD", reason: null } } as const;
    const inOwnerChat = setup({ outcome: pending, ownerChatId: String(CHAT) });
    await inOwnerChat.channel.handle(message(509, { text: "INVOICE\nTotal: USD 3" }));
    expect(inOwnerChat.sent.at(-1)!.text).toContain("Acme asks for 18.00. It needs your OK because it is above what the agent may pay on its own (payment #2).");
    // The page opens inside Telegram (a Mini App button), so the address is not in the text.
    expect(inOwnerChat.sent.at(-1)!.text).not.toContain("https://");
    expect(inOwnerChat.sent.at(-1)!.other?.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Review and approve", web_app: { url: "https://getleash.example/intent/2" } }]],
    });
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

  it("links become Mini App buttons in private chats, link buttons in groups, and text when needed", async () => {
    const pending = { status: "proposed", intentStatus: "PENDING", result: { accepted: true, intent_id: 7, status: "PENDING", route: "ABOVE_THRESHOLD", reason: null } } as const;
    expect(telegramMessage("-100123", "Needs your OK.", [{ text: "Review and approve", url: "https://getleash.example/intent/7" }])).toEqual({
      text: "Needs your OK.",
      reply_markup: { inline_keyboard: [[{ text: "Review and approve", url: "https://getleash.example/intent/7" }]] },
    });
    // Telegram opens Mini Apps over https only: a local dashboard keeps the address in the text.
    const local = setup({ outcome: pending, dashboardUrl: "http://localhost:3000" });
    await local.channel.handle(message(511, { text: "INVOICE\nTotal: USD 3" }));
    expect(local.sent.at(-1)!.text).toContain("Review and approve: http://localhost:3000/intent/7");
    expect(local.sent.at(-1)!.other?.reply_markup).toBeUndefined();
    // If Telegram refuses the button, the reply still goes out, with the address in the text.
    const refused = setup({ outcome: pending, refuseButtons: true });
    await refused.channel.handle(message(512, { text: "INVOICE\nTotal: USD 3" }));
    expect(refused.sent.at(-1)!.text).toContain("https://getleash.example/intent/7");
    // Refusals carry no button: there is nothing to approve.
    const plain = setup();
    await plain.channel.handle(message(513, { text: "INVOICE\nTotal: USD 3" }));
    expect(plain.sent.at(-1)!.other?.reply_markup).toBeUndefined();
  });
});

describe("Telegram notifier (executor notices)", () => {
  function fakeTelegram(status: (body: Record<string, unknown>) => number) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response("{}", { status: status(body) });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  it("sends the link as a Mini App button named after the notice", async () => {
    const telegram = fakeTelegram(() => 200);
    await new TelegramNotifier("token", "1001", telegram.fetchImpl).notify({ kind: "authorization_needed", text: "Ready to send.", link: "https://getleash.example/intent/3" });
    expect(telegram.bodies).toHaveLength(1);
    expect(telegram.bodies[0]!.text).toBe("Ready to send.");
    expect(telegram.bodies[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: "Confirm the transfer", web_app: { url: "https://getleash.example/intent/3" } }]] });
  });

  it("falls back to the link in the text when Telegram refuses the button", async () => {
    const telegram = fakeTelegram((body) => (body.reply_markup ? 400 : 200));
    await new TelegramNotifier("token", "1001", telegram.fetchImpl).notify({ kind: "approval_needed", text: "Needs your OK.", link: "https://getleash.example/intent/2" });
    expect(telegram.bodies.map((b) => b.text)).toEqual(["Needs your OK.", "Needs your OK.\nReview and approve: https://getleash.example/intent/2"]);
  });
});
