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
import {
  assetName,
  cleanName,
  dashboardLink,
  type DetailsProblem,
  type Directory,
  durationText,
  FLAGS,
  HOT_WALLET_TELEGRAM,
  looksLikeEvmAddress,
  MAX_SUPPLIER_NAME,
  money,
  moneyRounded,
  paidAt,
  parseSupplierDetails,
  type Payee,
  type Policy,
  type PolicyView,
  REFUSALS,
  type StateView,
  utcTime,
  waitReason,
} from "@getleash/shared";
import { type DeliveredNotices, noticeKey } from "@getleash/shared/node";

import { type LinkButton, noticeLinks, telegramMessage } from "./notifier.ts";
import type { SupplierInvite, SupplierOnboarding } from "./onboarding.ts";
import type { PendingUpdates } from "./pending.ts";
import type { BusinessSignup } from "./signup.ts";

/** The subset of the Bot API the channel uses (grammY's `bot.api` provides it; tests fake it). */
export interface BotApi {
  sendMessage(chatId: string | number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  getFile(fileId: string): Promise<{ file_path?: string | undefined; file_size?: number | undefined }>;
  /** The bot's own account, for invite links (t.me/<username>). */
  getMe(): Promise<{ username?: string | undefined }>;
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
  /** A hosted business's contract (D-30), named in its dashboard links (`?c=`); null for the dashboard's own. */
  dashboardContract?: string | null;
  /** Invoices processed at once; one semaphore shared by every business keeps the model's load bounded. */
  jobs?: Semaphore;
  /** Invoices read per UTC day (a hosted business's share of the operator's model budget); null: no limit. */
  invoicesPerDay?: number | null;
  /** The owner's chat (TELEGRAM_OWNER_CHAT_ID), where the executor sends its notices too. */
  ownerChatId?: string | null;
  /**
   * A hosted business answers one chat: its supplier invites and requests report to `ownerChatId`, not the
   * chat they were made in, since its owner's wallet may have moved it to another Telegram account since.
   */
  ownerChatOnly?: boolean;
  /** Shared with the executor: replies in the owner's chat stand in for its notices of the same news. */
  delivered?: Pick<DeliveredNotices, "add"> | null;
  /** Adding suppliers from Telegram (/addsupplier, /invite); without it those commands say so. */
  onboarding?: SupplierOnboarding | null;
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
  { command: "addsupplier", description: "Add someone you pay" },
  { command: "invite", description: "Ask a supplier to send their payment details" },
  { command: "wallet", description: "Set up the wallet you approve payments with" },
  { command: "pause", description: "Stop every payment at once" },
] as const;

/** The first line of the bot's question for a new supplier; a reply to it carries the supplier's details. */
export const ADD_QUESTION = "➕ Who do you want to add?";

const DETAILS_FORMAT = ["• a NEAR account, paid in USDC (like acme.near)", "• or a Tron address, paid in USDT (T…, 34 characters)"];

/** Why supplier details could not be used, in plain words ("their" for the owner, "your" for a supplier). */
function detailsProblem(problem: DetailsProblem | "NO_NAME", text: string, whose: "their" | "your"): string {
  switch (problem) {
    case "NO_ADDRESS":
      return looksLikeEvmAddress(text)
        ? "That looks like an Ethereum-style address (0x…). GetLeash pays NEAR accounts (in USDC) and Tron addresses (in USDT)."
        : `I couldn't find a NEAR account (like acme.near) or a Tron address (T…, 34 characters) in that. Send ${whose} name on the first line and the address on the second.`;
    case "TWO_ADDRESSES":
      return "That has more than one address. Send one at a time: the name, then one address.";
    case "NAME_TOO_LONG":
      return `That name is too long: ${MAX_SUPPLIER_NAME} characters at most.`;
    case "NO_NAME":
      return `Send ${whose} name too: the name on the first line, the address on the second.`;
  }
}

/** What a supplier who opened an invite sees: nothing about the business, only what to send. */
function inviteGreeting(invite: Pick<SupplierInvite, "name">): Notice {
  return {
    text: [
      `👋 Hi${invite.name ? ` ${invite.name}` : ""}! A business you work with pays its suppliers through GetLeash, in stablecoins, and asked where to pay you.`,
      invite.name ? "Reply with where you want to be paid:" : "Reply with your business name and where you want to be paid, on two lines:",
      ...DETAILS_FORMAT,
      "I'll pass it on. Nothing changes until they confirm it.",
    ].join("\n"),
    ask: invite.name ? "Your NEAR account or Tron address" : "Your name, then your address",
  };
}

/** How a Telegram user shows up for the owner: @username, else the name on the account. */
function telegramName(from: Message["from"]): string {
  if (!from) return "someone on Telegram";
  return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ");
}

/** `/start join_<token>`: a supplier opening an invite link. */
const INVITE_START = /^\/start(?:@\w+)?\s+join_([A-Za-z0-9_-]{16,64})\s*$/;

/** A text reply to the bot's "Who do you want to add?" (a file sent as a reply is still an invoice). */
function isAddReply(message: Message): boolean {
  const asked = message.reply_to_message;
  return message.text !== undefined && !!asked?.from?.is_bot && (asked.text ?? "").startsWith(ADD_QUESTION);
}

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
  private readonly jobs: Semaphore;

  constructor(private readonly deps: TelegramDeps) {
    this.jobs = deps.jobs ?? new Semaphore(LIMITS.maxConcurrentJobs);
  }

  /** The contract this channel serves. */
  get contractId(): string {
    return this.deps.view.contractId;
  }

  private link(path: string) {
    return dashboardLink(this.deps.dashboardUrl, path, this.deps.dashboardContract);
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
    if (notice.ask) {
      await this.question(chatId, notice);
      return;
    }
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

  /** A question: Telegram opens a reply box, so the answer comes back as a reply to it. Returns its message id when Telegram reports it. */
  private async question(chatId: string, notice: Notice): Promise<number | undefined> {
    const sent = await this.deps.api.sendMessage(chatId, notice.text, {
      link_preview_options: { is_disabled: true },
      reply_markup: { force_reply: true, input_field_placeholder: (notice.ask ?? "").slice(0, 64) || "Your answer" },
    });
    const id = (sent as { message_id?: unknown } | undefined)?.message_id;
    return typeof id === "number" ? id : undefined;
  }

  private allowed(message: Message): boolean {
    const user = message.from ? String(message.from.id) : "";
    return this.deps.allowedUsers.has(user) && this.deps.allowedChats.has(String(message.chat.id));
  }

  /** Whether this message is the owner's (sender and chat approved): the hub routes it here. */
  allows(message: Message): boolean {
    return this.allowed(message);
  }

  /** Whether this Telegram user is one of this GetLeash's approved users. */
  hasUser(user: string): boolean {
    return this.deps.allowedUsers.has(user);
  }

  /** Whether a message opens one of this channel's supplier invites (`/start join_<token>`). */
  opensInvite(message: Message): boolean {
    const onboarding = this.deps.onboarding;
    const user = message.from ? String(message.from.id) : "";
    const token = message.text?.match(INVITE_START)?.[1];
    return !!onboarding && !!user && message.chat.type === "private" && !this.allowed(message) && !!token && onboarding.knowsInvite(token, user);
  }

  /**
   * When a text message answers this channel's invite: the time that invite was opened (the hub picks the
   * latest), else null. Someone who uses a GetLeash here answers only by replying to the invite's question,
   * so the rest of what they send stays with their own business.
   */
  answersInvite(message: Message, member: boolean): number | null {
    const onboarding = this.deps.onboarding;
    const user = message.from ? String(message.from.id) : "";
    if (!onboarding || !user || message.chat.type !== "private" || this.allowed(message)) return null;
    const text = message.text ?? message.caption;
    if (text === undefined || text.startsWith("/") || message.web_app_data) return null;
    const invite = onboarding.inviteOf(user);
    if (!invite) return null;
    if (member && !invite.prompts.includes(message.reply_to_message?.message_id ?? -1)) return null;
    return invite.opened_at ?? invite.at;
  }

  /** Handles one update end to end. Returns what was done (tests and logs use it). */
  async handle(update: Update): Promise<string> {
    const message = update.message;
    const command = message?.text?.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1];
    // A supplier answering an invite: the only messages from outside the allowlist that get an answer.
    if (message && message.chat.type === "private" && this.deps.onboarding && !this.allowed(message)) {
      const answered = await this.fromSupplier(update, message, command);
      if (answered) return answered;
    }
    if (command) {
      // Commands go through the same dedupe and allowlist as invoices.
      if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return "duplicate";
      if (!this.allowed(message!)) return "not_allowed";
      await this.send(String(message!.chat.id), await this.command(command, message!));
      return `command:${command}`;
    }
    if (message && isAddReply(message)) {
      // The owner's answer to "Who do you want to add?": supplier details, not an invoice.
      if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return "duplicate";
      if (!this.allowed(message)) return "not_allowed";
      const chat = String(message.chat.id);
      await this.send(chat, await this.addSupplier(message.text ?? "", chat));
      return "supplier:details";
    }
    const received = await this.receive(update);
    if (received.kind === "ignored") {
      if (received.reason === "LIMIT" && update.message && this.allowed(update.message)) {
        await this.send(String(update.message.chat.id), { text: `Not processed: ${received.detail}` });
      }
      this.deps.log?.(`[telegram] update ${update.update_id} ignored: ${received.reason}${received.detail ? ` (${received.detail})` : ""}`);
      return `ignored:${received.reason}`;
    }
    if (!this.countInvoice()) {
      await this.send(received.replyTo, { text: `You've sent ${this.deps.invoicesPerDay} invoices today, as many as GetLeash reads for one business in a day. Send the rest tomorrow (UTC).` });
      return "ignored:QUOTA";
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

  private invoiceDay = "";
  private invoicesToday = 0;

  /** Counts an invoice against the day's quota; false once it is used up. */
  private countInvoice(): boolean {
    const limit = this.deps.invoicesPerDay;
    if (limit == null) return true;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.invoiceDay) {
      this.invoiceDay = day;
      this.invoicesToday = 0;
    }
    if (this.invoicesToday >= limit) return false;
    this.invoicesToday += 1;
    return true;
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
        if (r?.reason === "UNKNOWN_SUPPLIER") {
          lines.push("To pay them, add them first: /addsupplier with their name and the address they gave you themselves (an invoice can be faked), or let them send it with /invite.");
        }
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

  private async command(name: string, message: Message): Promise<Notice> {
    const view = this.deps.view;
    const chat = String(message.chat.id);
    const args = (message.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
    switch (name) {
      case "start":
      case "help":
        if (name === "start" && args.startsWith("join_")) {
          return { text: "That's your own invite link: send it to your supplier, and their answer comes to you here. To add a supplier yourself, use /addsupplier." };
        }
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
        const list = suppliers.map((s) => {
          const cooldown = now < BigInt(s.changed_at) + BigInt(state.policy.cooldown_ns) ? " (details changed recently: payments wait for you)" : "";
          return `• ${names.get(s.id) ?? `supplier #${s.id}`}: ${assetName(s, state.token_id)} to ${s.recipient}${cooldown}${s.active ? "" : " (switched off)"}`;
        });
        return { text: [...(list.length ? list : ["No suppliers yet."]), "Add one with /addsupplier, or ask them for their details with /invite."].join("\n") };
      }
      case "addsupplier": {
        if (args) return this.addSupplier(args, chat);
        return {
          text: [
            ADD_QUESTION,
            "Reply with their name and where they get paid, on two lines:",
            ...DETAILS_FORMAT,
            "Use the address they gave you themselves, not one copied from an invoice: invoices can be faked.",
          ].join("\n"),
          ask: "Their name, then their address",
        };
      }
      case "invite": {
        const onboarding = this.deps.onboarding;
        if (!onboarding) return { text: "Invites need the bot's data directory (GETLEASH_DATA_DIR)." };
        const name = args ? cleanName(args) : null;
        if (name && name.length > MAX_SUPPLIER_NAME) return { text: detailsProblem("NAME_TOO_LONG", args, "their") };
        const username = await this.username();
        if (!username) return { text: "Telegram didn't tell me my own username, which the invite link needs. Try again in a moment." };
        const invite = `https://t.me/${username}?start=join_${onboarding.createInvite(chat, name)}`;
        return {
          text: [
            `📨 Send this invite to ${name ?? "your supplier"} through a chat or email you already use with them. It works once, for 7 days: they open it in Telegram and tell me where they want to be paid, and I show it to you here before anything changes.`,
            invite,
          ].join("\n"),
          buttons: [{ text: "Share the invite", url: `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent("Send your payment details here:")}` }],
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

  // ── Adding suppliers (onboarding.ts) ─────────────────────────────────────────────────────────

  private botUsername: string | null = null;

  private async username(): Promise<string | null> {
    try {
      this.botUsername ??= (await this.deps.api.getMe()).username ?? null;
    } catch (error) {
      this.deps.log?.(`[telegram] getMe failed: ${(error as Error).message}`);
    }
    return this.botUsername;
  }

  /** The chain's word on a payee; null (after telling the chat) when NEAR could not be reached. */
  private async checkPayee(payee: Payee, chat: string) {
    try {
      return await this.deps.onboarding!.check(payee);
    } catch (error) {
      this.deps.log?.(`[telegram] supplier check failed: ${(error as Error).message}`);
      await this.send(chat, { text: "I couldn't reach the NEAR network to check that address. Send it again in a minute." });
      return null;
    }
  }

  /** The owner's /addsupplier details: checked, kept as a request, and a button to the page where the owner's wallet adds them. */
  private async addSupplier(text: string, chat: string): Promise<Notice> {
    const onboarding = this.deps.onboarding;
    if (!onboarding) return { text: "Adding suppliers here needs the bot's data directory (GETLEASH_DATA_DIR)." };
    const parsed = parseSupplierDetails(text);
    if ("problem" in parsed) return { text: detailsProblem(parsed.problem, text, "their") };
    const { name, payee } = parsed.details;
    if (!name) return { text: detailsProblem("NO_NAME", text, "their") };
    const check = await onboarding.check(payee).catch((error: Error) => {
      this.deps.log?.(`[telegram] supplier check failed: ${error.message}`);
      return null;
    });
    if (!check) return { text: "I couldn't reach the NEAR network to check that address. Send it again in a minute." };
    if (check.kind === "refused") return { text: `⚠️ ${check.why}` };
    if (check.kind === "listed") {
      const { supplier } = check;
      if (check.name) return { text: `${supplier.recipient} is already on your list as ${check.name} (supplier #${supplier.id}).` };
      return { text: `✅ ${supplier.recipient} was already on your list as supplier #${supplier.id}. I've saved its name: ${onboarding.saveName(supplier, name)}.` };
    }
    onboarding.request({ name, chain: payee.chain, recipient: payee.recipient, owner_chat: chat });
    return this.addOffer(name, check, `➕ Add ${name}, paid in ${paidAt(payee)}?`);
  }

  /** The owner's next step for a new supplier: one button to the page where the owner's wallet adds it. */
  private addOffer(name: string, check: { payee: Payee; state: StateView }, intro: string): Notice {
    const p = check.state.policy;
    const link = this.link(`/suppliers/new?to=${encodeURIComponent(check.payee.recipient)}`);
    const lines = [intro];
    if (BigInt(p.cooldown_ns) > 0n) {
      lines.push(
        `Once you add them, every payment to them waits for your OK for the first ${durationText(p.cooldown_ns)}, up to ${money(p.cooldown_max, check.state.token_decimals)} USDC each: send a small test payment and check with them that it arrived.`,
      );
    }
    if (!link) lines.push("(Set DASHBOARD_URL for the bot: its button opens the page where your wallet adds them.)");
    return { text: lines.join("\n"), link: link ?? undefined, action: `Add ${name.length > 40 ? `${name.slice(0, 39)}…` : name}` };
  }

  /**
   * A message from outside the allowlist, answered only when it opens an invite (/start join_<token>)
   * or answers the invite this user opened; anything else stays unanswered (null).
   */
  private async fromSupplier(update: Update, message: Message, command: string | undefined): Promise<string | null> {
    const onboarding = this.deps.onboarding!;
    const user = message.from ? String(message.from.id) : "";
    if (!user) return null;
    const token = command === "start" ? message.text?.match(INVITE_START)?.[1] : undefined;
    const invite = token ? onboarding.openInvite(token, user) : command ? null : onboarding.inviteOf(user);
    if (!invite) return null;
    if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return "duplicate";
    const chat = String(message.chat.id);
    if (token) {
      onboarding.notePrompt(invite, await this.question(chat, inviteGreeting(invite)));
      return "invite:opened";
    }

    const text = (message.text ?? message.caption ?? "").slice(0, 1000);
    const parsed = parseSupplierDetails(text);
    const details = "details" in parsed ? parsed.details : null;
    const name = details ? (invite.name ?? details.name) : null;
    let problem = "problem" in parsed ? detailsProblem(parsed.problem, text, "your") : !name ? detailsProblem("NO_NAME", text, "your") : null;
    const check = problem || !details ? null : await this.checkPayee(details.payee, chat);
    if (!problem && !check) return "invite:unchecked";
    if (check?.kind === "refused") problem = check.why;
    if (problem || !check || check.kind === "refused" || !name) {
      const left = onboarding.failedTry(invite);
      if (left > 0) {
        onboarding.notePrompt(invite, await this.question(chat, { text: `${problem} (${left} ${left === 1 ? "try" : "tries"} left)`, ask: inviteGreeting(invite).ask }));
      } else {
        await this.send(chat, { text: `${problem}\nThis invite is closed now: ask them for a new one.` });
      }
      return "invite:retry";
    }

    onboarding.closeInvite(invite);
    const who = telegramName(message.from);
    if (check.kind === "listed") {
      const { supplier } = check;
      const saved = check.name ?? onboarding.saveName(supplier, name);
      await this.tell(chat, { text: `✅ You're already set up: they pay you in ${paidAt(supplier)}.` });
      await this.tell(this.ownerChatFor(invite.owner_chat), {
        text: `📨 ${name} answered your invite (${who}) with ${supplier.recipient}, which is already on your list as ${saved} (supplier #${supplier.id}). Nothing else to do.`,
      });
      return "invite:listed";
    }
    onboarding.request({ name, chain: check.payee.chain, recipient: check.payee.recipient, owner_chat: invite.owner_chat, supplier_chat: chat });
    await this.tell(chat, { text: `✅ Thanks! I've passed it on: paid in ${paidAt(check.payee)}. I'll tell you here once they've added you.` });
    await this.tell(
      this.ownerChatFor(invite.owner_chat),
      this.addOffer(name, check, `📨 ${name} answered your invite (${who}). Add them, paid in ${paidAt(check.payee)}? Make sure that's who you sent the invite to.`),
    );
    return "invite:answered";
  }

  private ticks = 0;
  private ticking = false;

  /**
   * Called every 10 s: suppliers the owner has added since a request get their name saved, and the
   * owner (and a supplier who answered an invite) hear it. No chain reads while nothing is waiting,
   * and one look at a time (a slow, retried RPC must not announce a supplier twice).
   */
  async tick(): Promise<void> {
    const onboarding = this.deps.onboarding;
    if (!onboarding || this.ticking || !onboarding.due(this.ticks++)) return;
    this.ticking = true;
    try {
      await this.announce(await onboarding.settle());
    } finally {
      this.ticking = false;
    }
  }

  private async announce(settled: Awaited<ReturnType<SupplierOnboarding["settle"]>>): Promise<void> {
    for (const { request, supplier, name, state } of settled) {
      const until = BigInt(supplier.changed_at) + BigInt(state.policy.cooldown_ns);
      const waits =
        BigInt(Date.now()) * 1_000_000n < until
          ? ` Until ${utcTime(until)}, every payment to them waits for your OK, up to ${money(state.policy.cooldown_max, state.token_decimals)} USDC each.`
          : "";
      await this.tell(this.ownerChatFor(request.owner_chat), { text: `✅ ${name} is on your list now (supplier #${supplier.id}), paid in ${paidAt(supplier)}.${waits}` });
      if (request.supplier_chat) await this.tell(request.supplier_chat, { text: `✅ You've been added. Payments to you arrive in ${paidAt(supplier)}.` });
    }
  }

  /** Where an invite's or a request's news goes: a hosted business's one chat (ownerChatOnly), else the chat it was made in. */
  private ownerChatFor(stored: string): string {
    return this.deps.ownerChatOnly && this.deps.ownerChatId ? this.deps.ownerChatId : stored;
  }

  /** Sends, and logs instead of throwing: one chat that cannot be reached does not stop the others. */
  private async tell(chat: string, notice: Notice): Promise<void> {
    try {
      await this.send(chat, notice);
    } catch (error) {
      this.deps.log?.(`[telegram] could not send to ${chat}: ${(error as Error).message}`);
    }
  }
}

/** What the long-polling loop drives: one channel, or the hub of every business's channel. */
export interface UpdateHandler {
  handle(update: Update): Promise<string>;
  tick(): Promise<void>;
}

/**
 * One bot for many businesses (docs/decisions.md D-30). Each update goes to exactly one place:
 *   1. the channel whose owner sent it (sender and chat approved there): the operator's own, or a hosted
 *      business's;
 *   2. from anyone else, in a private chat: the business whose supplier invite it opens or answers, else
 *      the signup (starting or finishing a setup);
 *   3. everything else to the operator's channel, which ignores it as before (nothing is answered).
 * Businesses share nothing but the bot: each channel has its own contract, agent, keys, directory and
 * invoice store, and answers only its owner.
 */
export class TelegramHub implements UpdateHandler {
  private readonly hosted: TelegramChannel[] = [];

  constructor(
    private readonly home: TelegramChannel,
    private signup: BusinessSignup | null = null,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  get channels(): TelegramChannel[] {
    return [this.home, ...this.hosted];
  }

  /** Serves a hosted business from now on (once per contract). */
  add(channel: TelegramChannel): void {
    if (this.channels.some((c) => c.contractId === channel.contractId)) return;
    this.hosted.push(channel);
  }

  /** Serves a hosted business through this channel instead of the one it had: its owner's wallet moved it to another Telegram account. */
  replace(channel: TelegramChannel): void {
    const at = this.hosted.findIndex((c) => c.contractId === channel.contractId);
    if (at < 0) this.hosted.push(channel);
    else this.hosted[at] = channel;
  }

  setSignup(signup: BusinessSignup | null): void {
    this.signup = signup;
  }

  /** Whether this Telegram user already uses a GetLeash here. */
  isMember(user: string): boolean {
    return this.channels.some((c) => c.hasUser(user));
  }

  async handle(update: Update): Promise<string> {
    const message = update.message;
    if (message) {
      // An invite link goes to the business that sent it, whoever opens it (businesses supply each other).
      const inviting = this.channels.find((c) => c.opensInvite(message));
      if (inviting) return inviting.handle(update);
      const user = message.from ? String(message.from.id) : "";
      const member = this.isMember(user);
      // An answer to an invite goes to that invite (the one opened last); a member's only as a reply to its question.
      const answering = this.channels
        .map((c) => ({ c, at: c.answersInvite(message, member) }))
        .filter((x): x is { c: TelegramChannel; at: number } => x.at !== null)
        .sort((a, b) => b.at - a.at)[0]?.c;
      if (answering) return answering.handle(update);
      const owner = this.channels.find((c) => c.allows(message));
      if (owner) return owner.handle(update);
      if (message.chat.type === "private") {
        const done = await this.signup?.handle(update, message);
        if (done) return done;
      }
    }
    return this.home.handle(update);
  }

  private ticking = false;

  /** Every channel's periodic work, then the signup's, one pass at a time; one that fails does not hold up the others. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const channel of this.channels) {
        await channel.tick().catch((error: Error) => this.log(`[telegram] ${channel.contractId}: ${error.message}`));
      }
      await this.signup?.tick().catch((error: Error) => this.log(`[signup] ${error.message}`));
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Each chat's updates in order, on a queue of its own: one chat's slow invoice (a photo can take two
 * minutes) never holds up another chat, another business's above all. The model's limit stays the shared
 * semaphore (3 at once). `pending` keeps every update until it is handled, across restarts.
 */
export function chatQueues(channel: UpdateHandler, log: (line: string) => void, pending: PendingUpdates | null = null) {
  const queues = new Map<string, Promise<void>>();
  return (update: Update): Promise<void> => {
    pending?.add(update);
    const chat = String(update.message?.chat.id ?? "other");
    const run = async () => {
      try {
        const done = await channel.handle(update);
        log(`[telegram] update ${update.update_id}: ${done}`);
      } catch (error) {
        log(`[telegram] update ${update.update_id} failed: ${(error as Error).message}`);
      } finally {
        pending?.done(update.update_id);
      }
    };
    const next = (queues.get(chat) ?? Promise.resolve()).then(run);
    queues.set(chat, next);
    void next.then(() => {
      if (queues.get(chat) === next) queues.delete(chat);
    });
    return next;
  };
}

/** Long-polling bot wired to a channel or a hub. */
export function startBot(token: string, makeChannel: (bot: Bot) => UpdateHandler, log: (line: string) => void = console.log, pending: PendingUpdates | null = null) {
  const bot = new Bot(token);
  const channel = makeChannel(bot);
  // grammY confirms a batch as soon as the handler returns, before the queues have run it: updates still
  // queued at a restart are replayed from `pending` (the update log drops any that were already acted on).
  const enqueue = chatQueues(channel, log, pending);
  const replay = pending?.load() ?? [];
  if (replay.length > 0) log(`[telegram] replaying ${replay.length} update(s) not finished before the restart`);
  for (const update of replay) void enqueue(update);
  bot.use((ctx) => void enqueue(ctx.update));
  bot.catch((error) => log(`[telegram] ${error.message}`));
  // Suppliers the owner adds on the dashboard's page are picked up here (onboarding.ts).
  setInterval(() => void channel.tick().catch((error: Error) => log(`[telegram] supplier check failed: ${error.message}`)), 10_000);
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
