/**
 * Telegram intake and owner commands (PLAN §4.4), on grammY.
 *
 * Order for every update, before anything else happens:
 *   1. durable dedupe on `update_id` (a replayed update is dropped, even after a restart);
 *   2. allowlist: the sender AND the chat must be approved (anything else is ignored silently, so
 *      nothing leaks to unapproved chats);
 *   3. limits: Telegram's reported file size is checked before downloading (≤ 10 MB); after
 *      download the bytes are sniffed and image dimensions checked; PDFs are capped at 10 pages
 *      when their text is read; at most 3 invoices are processed at once.
 * Then the invoice goes to the agent, and the reply carries ids, amounts, enum codes, the
 * verification badge and dashboard links.
 */
import { Bot } from "grammy";
import type { Update } from "grammy/types";

import type { AgentOutcome, InvoiceAgent } from "@getleash/agent";
import type { Channel, Notice, Received } from "@getleash/channel-core";
import { checkFile, type InvoiceFile, LIMITS, LimitError, Semaphore, type UpdateLog } from "@getleash/ingestion";
import { assetName, type Directory, FLAGS, HOT_WALLET_TELEGRAM, money, moneyRounded, type Policy, type PolicyView, REFUSALS, waitReason } from "@getleash/shared";
import { type DeliveredNotices, noticeKey } from "@getleash/shared/node";

import { type LinkButton, noticeLinks, telegramMessage } from "./notifier.ts";

/** The subset of the Bot API the channel uses (grammY's `bot.api` provides it; tests fake it). */
export interface BotApi {
  sendMessage(chatId: string | number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  getFile(fileId: string): Promise<{ file_path?: string | undefined; file_size?: number | undefined }>;
}

export type TelegramDeps = {
  api: BotApi;
  updateLog: UpdateLog;
  allowedUsers: ReadonlySet<string>;
  allowedChats: ReadonlySet<string>;
  /** Downloads a file by its Bot API `file_path`. */
  download: (filePath: string) => Promise<Uint8Array>;
  agent: InvoiceAgent;
  view: PolicyView;
  directory: () => Directory;
  dashboardUrl: string | null;
  /** The owner's chat (TELEGRAM_OWNER_CHAT_ID), where the executor sends its notices too. */
  ownerChatId?: string | null;
  /** Shared with the executor: replies in the owner's chat stand in for its notices of the same news. */
  delivered?: Pick<DeliveredNotices, "add"> | null;
  log?: (line: string) => void;
};

type Message = NonNullable<Update["message"]>;

/** The executor notices that a reply to this invoice already gives: its approval request or payment result. */
export function coveredNotices(outcome: AgentOutcome): string[] {
  const id = outcome.result?.intent_id;
  if (outcome.status !== "proposed" || id == null) return [];
  const since = outcome.intentSince;
  switch (outcome.intentStatus) {
    case "PENDING":
      return [noticeKey.approval(id)];
    case "PAID":
      return since ? [noticeKey.paid(id, since)] : [];
    case "FAILED":
      return since ? [noticeKey.failed(id, since)] : [];
    default:
      return [];
  }
}

/** The bot's commands, for /help and Telegram's command menu. */
export const COMMANDS = [
  { command: "pending", description: "Payments waiting for you" },
  { command: "status", description: "Your treasury and what was spent today" },
  { command: "suppliers", description: "Who can be paid" },
  { command: "wallet", description: "Set up the wallet you approve payments with" },
  { command: "pause", description: "Stop every payment at once" },
] as const;

export function parseIdList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s)),
  );
}

export class TelegramChannel implements Channel<Update> {
  readonly name = "telegram";
  private readonly jobs = new Semaphore(LIMITS.maxConcurrentJobs);

  constructor(private readonly deps: TelegramDeps) {}

  private link(path: string) {
    return this.deps.dashboardUrl ? `${this.deps.dashboardUrl.replace(/\/$/, "")}${path}` : null;
  }

  async receive(update: Update): Promise<Received> {
    if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return { kind: "ignored", reason: "DUPLICATE_UPDATE" };
    const message = update.message;
    if (!message) return { kind: "ignored", reason: "NO_CONTENT", detail: "only new messages are processed (edits are not)" };
    if (!this.allowed(message)) return { kind: "ignored", reason: "NOT_ALLOWED" };

    const files: InvoiceFile[] = [];
    try {
      const document = message.document;
      const photo = message.photo?.at(-1); // largest size Telegram offers
      const fileId = document?.file_id ?? photo?.file_id;
      if (fileId) {
        const reported = document?.file_size ?? photo?.file_size;
        if (reported !== undefined && reported > LIMITS.maxFileBytes) {
          throw new LimitError("FILE_TOO_LARGE", `file is ${reported} bytes (max 10 MB)`);
        }
        if (photo && (photo.width > LIMITS.maxImagePixels || photo.height > LIMITS.maxImagePixels)) {
          throw new LimitError("IMAGE_TOO_LARGE", `image is ${photo.width}×${photo.height}`);
        }
        const info = await this.deps.api.getFile(fileId);
        if (!info.file_path) throw new LimitError("UNSUPPORTED_FILE", "Telegram did not return the file");
        if (info.file_size !== undefined && info.file_size > LIMITS.maxFileBytes) {
          throw new LimitError("FILE_TOO_LARGE", `file is ${info.file_size} bytes (max 10 MB)`);
        }
        const bytes = await this.deps.download(info.file_path);
        const kind = checkFile(bytes);
        if (kind === "text") throw new LimitError("UNSUPPORTED_FILE", "text files are not accepted; paste the text instead");
        files.push({ kind, bytes, name: document?.file_name });
      }
    } catch (error) {
      if (error instanceof LimitError) return { kind: "ignored", reason: "LIMIT", detail: `${error.code}: ${error.message}` };
      throw error;
    }
    const text = (message.text ?? message.caption ?? "").slice(0, LIMITS.maxTextChars);
    if (files.length === 0 && !text.trim()) return { kind: "ignored", reason: "NO_CONTENT" };
    return {
      kind: "invoice",
      replyTo: String(message.chat.id),
      input: {
        key: `telegram-${update.update_id}`,
        source: "telegram",
        receivedAt: new Date(message.date * 1000).toISOString(),
        chatId: String(message.chat.id),
        userId: message.from ? String(message.from.id) : undefined,
        text: text || undefined,
        files,
      },
    };
  }

  /** Links become buttons (GetLeash pages as a Mini App in private chats, see notifier.ts); if Telegram refuses them, the links go in the text. */
  async send(chatId: string, notice: Notice): Promise<void> {
    const options = { link_preview_options: { is_disabled: true } };
    const links = noticeLinks(notice);
    const message = telegramMessage(chatId, notice.text, links);
    if (message.reply_markup) {
      try {
        await this.deps.api.sendMessage(chatId, message.text, { ...options, reply_markup: message.reply_markup });
        return;
      } catch (error) {
        this.deps.log?.(`[telegram] buttons refused (${(error as Error).message}); sending the links as text`);
      }
    }
    await this.deps.api.sendMessage(chatId, telegramMessage(chatId, notice.text, links, false).text, options);
  }

  private allowed(message: Message): boolean {
    const user = message.from ? String(message.from.id) : "";
    return this.deps.allowedUsers.has(user) && this.deps.allowedChats.has(String(message.chat.id));
  }

  /** Handles one update end to end. Returns what was done (tests and logs use it). */
  async handle(update: Update): Promise<string> {
    const command = update.message?.text?.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1];
    if (command) {
      // Commands go through the same dedupe and allowlist as invoices.
      if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return "duplicate";
      const message = update.message!;
      if (!this.allowed(message)) return "not_allowed";
      await this.send(String(message.chat.id), await this.command(command));
      return `command:${command}`;
    }
    const received = await this.receive(update);
    if (received.kind === "ignored") {
      if (received.reason === "LIMIT" && update.message && this.allowed(update.message)) {
        await this.send(String(update.message.chat.id), { text: `Not processed: ${received.detail}` });
      }
      this.deps.log?.(`[telegram] update ${update.update_id} ignored: ${received.reason}${received.detail ? ` (${received.detail})` : ""}`);
      return `ignored:${received.reason}`;
    }
    const outcome = await this.jobs.run(() => this.deps.agent.process(received.input));
    const limits = outcome.intentStatus === "PENDING" ? await this.limits() : undefined;
    await this.send(received.replyTo, this.describe(outcome, limits));
    // Recorded only after the reply went out: if it failed, the executor's notice still comes.
    if (this.deps.delivered && received.replyTo === this.deps.ownerChatId) {
      this.deps.delivered.add(coveredNotices(outcome), "telegram");
    }
    return `invoice:${outcome.status}`;
  }

  /** The owner's limits, to say why a payment waits ("above the 2.50 USDC the agent may pay on its own"). */
  private async limits(): Promise<Policy | undefined> {
    try {
      const policy = (await this.deps.view.state()).policy;
      return policy.approval_threshold ? policy : undefined;
    } catch {
      return undefined;
    }
  }

  describe(outcome: AgentOutcome, limits?: Policy): Notice {
    const r = outcome.result;
    const proposed = outcome.decision?.action === "propose" ? outcome.decision : null;
    const who = proposed ? (proposed.supplierName ?? `supplier #${proposed.supplierId}`) : null;
    const asset = outcome.supplier ? ` ${assetName(outcome.supplier)}` : "";
    const amount = proposed ? `${money(proposed.amountOut, outcome.supplier?.decimals ?? 6)}${asset}` : null;
    const id = r?.intent_id;
    const link = id != null ? this.link(`/intent/${id}`) : null;
    const lines: string[] = [];
    let action: string | undefined;
    switch (outcome.status) {
      case "proposed": {
        switch (outcome.intentStatus) {
          case "PAID":
            lines.push(`✅ Paid ${who} ${amount}, within the limits you gave the agent (payment #${id}).`);
            break;
          case "PAYING":
            lines.push(`✅ ${amount} to ${who} is approved and on its way (payment #${id}).`);
            break;
          case "APPROVED":
            lines.push(`✅ ${amount} to ${who} is approved within the agent's limits (payment #${id}). Getting a quote from NEAR Intents to send it.`);
            break;
          case "FAILED":
            lines.push(`⚠️ ${amount} to ${who} was approved, but the USDC token refused the transfer, so nothing left your treasury (payment #${id}).`);
            action = "Retry the payment";
            break;
          default:
            lines.push(`👋 ${who} asks for ${amount}. It needs your OK because ${waitReason(r?.route ?? "ABOVE_THRESHOLD", limits)} (payment #${id}).`);
            action = "Review and approve";
        }
        if (proposed?.flags.length) {
          lines.push(`⚠️ Please check: ${proposed.notes.length ? proposed.notes.join("; ") : proposed.flags.map((f) => FLAGS[f]).join("; ")}.`);
        }
        break;
      }
      case "rejected_onchain":
        lines.push(`⛔ Not paid: ${r?.reason ? REFUSALS[r.reason] : "the contract refused it"} (${r?.reason}).${who ? ` That was ${amount} to ${who}.` : ""}`);
        if (proposed?.notes.length) lines.push(proposed.notes.join("; "));
        break;
      case "needs_owner":
      case "ignored":
        lines.push(`ℹ️ ${outcome.summary}`);
        break;
      default:
        lines.push(`⚠️ ${outcome.summary}`);
    }
    lines.push(`Inference: ${outcome.badge}${outcome.model ? ` (${outcome.model})` : ""}`);
    // Only payments that need the owner carry the page as a button.
    return { text: lines.join("\n"), link: action && link ? link : undefined, action };
  }

  private async command(name: string): Promise<Notice> {
    const view = this.deps.view;
    switch (name) {
      case "start":
      case "help":
        return {
          text: [
            "Send me an invoice (a PDF, a photo or pasted text). I pay it if it fits the rules you set on-chain, and ask you when it doesn't.",
            ...(name === "start" ? ["New here? Start with /wallet: it sets up the wallet you approve payments with, inside Telegram."] : []),
            ...COMMANDS.map((c) => `/${c.command}: ${c.description.charAt(0).toLowerCase()}${c.description.slice(1)}`),
          ].join("\n"),
        };
      case "status": {
        const state = await view.state();
        const balance = await view.treasuryBalance(state.token_id);
        const d = state.token_decimals;
        const b = state.budgets;
        const p = state.policy;
        return {
          text: [
            `${state.paused ? "⏸ Payments are paused.\n" : ""}💰 Treasury: ${moneyRounded(balance, d)} USDC`,
            `Sent today: ${moneyRounded(b.outflow, d)} of ${moneyRounded(p.daily_cap, d)} USDC`,
            `Paid by the agent on its own today: ${moneyRounded(b.autonomous, d)} of ${moneyRounded(p.autonomous_daily_budget, d)} USDC`,
            `Payments above ${money(p.approval_threshold, d)} USDC wait for you.${state.paying ? ` ${state.paying} payment(s) on the way.` : ""}`,
          ].join("\n"),
        };
      }
      case "pending": {
        const [state, intents] = await Promise.all([view.state(), view.recentIntents(50)]);
        const names = new Map(this.deps.directory().suppliers.map((s) => [s.supplier_id, s.name]));
        const lines: string[] = [];
        const buttons: LinkButton[] = [];
        for (const i of intents) {
          const waiting = i.status === "PENDING" || i.status === "FAILED" || (i.status === "APPROVED" && i.attempt !== null && !i.attempt.authorized);
          if (!waiting) continue;
          const who = names.get(i.supplier_id) ?? `supplier #${i.supplier_id}`;
          const amount = money(i.value, state.token_decimals);
          const what = i.status === "PENDING" ? "needs your OK" : i.status === "FAILED" ? "didn't go through; retry?" : "ready to send; confirm the transfer";
          lines.push(`• ${who} · ${amount}: ${what} (payment #${i.id})`);
          const link = this.link(`/intent/${i.id}`);
          if (link) buttons.push({ text: `Payment #${i.id}: ${who} · ${amount}`, url: link });
        }
        return lines.length ? { text: lines.join("\n"), buttons } : { text: "Nothing is waiting for you." };
      }
      case "suppliers": {
        const [state, suppliers] = await Promise.all([view.state(), view.suppliers()]);
        const names = new Map(this.deps.directory().suppliers.map((s) => [s.supplier_id, s.name]));
        const now = BigInt(Date.now()) * 1_000_000n;
        return {
          text:
            suppliers
              .map((s) => {
                const cooldown = now < BigInt(s.changed_at) + BigInt(state.policy.cooldown_ns) ? " (details changed recently: payments wait for you)" : "";
                return `• ${names.get(s.id) ?? `supplier #${s.id}`}: ${assetName(s, state.token_id)} to ${s.recipient}${cooldown}${s.active ? "" : " (switched off)"}`;
              })
              .join("\n") || "No suppliers yet.",
        };
      }
      case "wallet": {
        // Signing stays in the owner's wallet: the bot only points to it and to the page that checks it.
        const owner = (await view.state()).owner_id;
        const check = this.link("/wallet");
        return {
          text: [
            `🔑 Payments you approve are signed in your NEAR wallet, as ${owner}. GetLeash never holds that key.`,
            `1. Open HOT Wallet: it runs inside Telegram. The first time, choose to import a wallet and enter the recovery phrase of ${owner}. Never send that phrase in a chat, this one included.`,
            ...(check ? [`2. Check my wallet: it connects HOT Wallet and shows whether it signs as ${owner}. Connecting pays nothing.`] : []),
          ].join("\n"),
          buttons: [{ text: "Open HOT Wallet", url: HOT_WALLET_TELEGRAM }, ...(check ? [{ text: "Check my wallet", url: check }] : [])],
        };
      }
      case "pause": {
        const link = this.link("/pause");
        if (!link) return { text: 'Pause from your wallet: call set_paused {"paused": true} on the contract with 1 yoctoNEAR.' };
        const paused = (await view.state()).paused;
        return paused
          ? { text: "⏸ Payments are paused. One signature in your wallet resumes them.", link, action: "Resume payments" }
          : { text: "One signature in your wallet stops every payment at once.", link, action: "Pause payments" };
      }
      default:
        return { text: "Unknown command. /help lists them." };
    }
  }
}

/** Long-polling bot wired to the channel. */
export function startBot(token: string, makeChannel: (bot: Bot) => TelegramChannel, log: (line: string) => void = console.log) {
  const bot = new Bot(token);
  const channel = makeChannel(bot);
  bot.use(async (ctx) => {
    try {
      const done = await channel.handle(ctx.update);
      log(`[telegram] update ${ctx.update.update_id}: ${done}`);
    } catch (error) {
      log(`[telegram] update ${ctx.update.update_id} failed: ${(error as Error).message}`);
    }
  });
  bot.catch((error) => log(`[telegram] ${error.message}`));
  // The menu Telegram shows when the owner types "/".
  const menu = [...COMMANDS.map(({ command, description }) => ({ command, description })), { command: "help", description: "What I can do" }];
  bot.api.setMyCommands(menu).catch((error: Error) => log(`[telegram] could not set the command menu: ${error.message}`));
  void bot.start({ allowed_updates: ["message"], onStart: (me) => log(`[telegram] @${me.username} is listening`) });
  return bot;
}

export function telegramDownloader(token: string) {
  return async (filePath: string): Promise<Uint8Array> => {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > LIMITS.maxFileBytes) throw new LimitError("FILE_TOO_LARGE", `file is ${length} bytes (max 10 MB)`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > LIMITS.maxFileBytes) throw new LimitError("FILE_TOO_LARGE", `file is ${bytes.length} bytes (max 10 MB)`);
    return bytes;
  };
}
