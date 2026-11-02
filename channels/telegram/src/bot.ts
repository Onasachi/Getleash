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
import { type Directory, fromUnits, type PolicyView } from "@getleash/shared";

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
  log?: (line: string) => void;
};

type Message = NonNullable<Update["message"]>;

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

  async send(chatId: string, notice: Notice): Promise<void> {
    await this.deps.api.sendMessage(chatId, notice.link ? `${notice.text}\n${notice.link}` : notice.text, {
      link_preview_options: { is_disabled: true },
    });
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
      const reply = await this.command(command);
      await this.send(String(message.chat.id), { text: reply });
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
    await this.send(received.replyTo, { text: this.describe(outcome) });
    return `invoice:${outcome.status}`;
  }

  describe(outcome: AgentOutcome): string {
    const r = outcome.result;
    const decision = outcome.decision;
    const who = decision && decision.action === "propose" ? (decision.supplierName ?? `supplier ${decision.supplierId}`) : null;
    const amount = decision && decision.action === "propose" ? fromUnits(decision.amountOut, 6) : null;
    const link = r?.intent_id != null ? this.link(`/intent/${r.intent_id}`) : null;
    const lines: string[] = [];
    switch (outcome.status) {
      case "proposed": {
        const id = r?.intent_id;
        switch (outcome.intentStatus) {
          case "PAID":
            lines.push(`✅ Paid ${amount} to ${who} within the autonomous budget (intent ${id}).`);
            break;
          case "PAYING":
            lines.push(`✅ ${amount} to ${who}: intent ${id} approved; the payment is being sent.`);
            break;
          case "APPROVED":
            lines.push(`✅ ${amount} to ${who}: intent ${id} approved within the autonomous budget. The executor pays it cross-chain.`);
            break;
          case "FAILED":
            lines.push(`⚠️ ${amount} to ${who}: intent ${id} was approved, but the token refused the transfer, so nothing left the treasury. Retry it from the dashboard.`);
            if (link) lines.push(link);
            break;
          default:
            lines.push(`⏳ ${amount} to ${who}: intent ${id} needs your approval (${r?.route}).`);
            if (link) lines.push(link);
        }
        if (decision?.action === "propose" && decision.flags.length) lines.push(`Flags: ${decision.flags.join(", ")}. ${decision.notes.join("; ")}`);
        break;
      }
      case "rejected_onchain":
        lines.push(`⛔ The contract refused it: ${r?.reason}.${who ? ` (${amount} to ${who})` : ""}`);
        if (decision?.action === "propose" && decision.notes.length) lines.push(decision.notes.join("; "));
        break;
      case "needs_owner":
      case "ignored":
        lines.push(`ℹ️ ${outcome.summary}`);
        break;
      default:
        lines.push(`⚠️ ${outcome.summary}`);
    }
    lines.push(`Inference: ${outcome.badge}${outcome.model ? ` (${outcome.model})` : ""}`);
    return lines.join("\n");
  }

  private async command(name: string): Promise<string> {
    const view = this.deps.view;
    switch (name) {
      case "start":
      case "help":
        return [
          "Forward an invoice (PDF, photo or text) and I'll propose paying it under your on-chain rules.",
          "/status: treasury and today's budgets",
          "/pending: payments waiting for you",
          "/suppliers: approved suppliers",
          "/pause: link to pause all payments (signed in your wallet)",
        ].join("\n");
      case "status": {
        const state = await view.state();
        const balance = await view.treasuryBalance(state.token_id);
        const d = state.token_decimals;
        const b = state.budgets;
        const p = state.policy;
        return [
          `${state.paused ? "⏸ PAUSED\n" : ""}Treasury: ${fromUnits(balance, d)} USDC`,
          `Autonomous today: ${fromUnits(b.autonomous, d)} of ${fromUnits(p.autonomous_daily_budget, d)}`,
          `Sent today: ${fromUnits(b.outflow, d)} of ${fromUnits(p.daily_cap, d)}`,
          `Executor trust today: ${fromUnits(b.trust, d)} of ${fromUnits(p.executor_trust_daily_budget, d)}`,
          `Payments in flight: ${state.paying}`,
        ].join("\n");
      }
      case "pending": {
        const [state, intents] = await Promise.all([view.state(), view.recentIntents(50)]);
        const names = new Map(this.deps.directory().suppliers.map((s) => [s.supplier_id, s.name]));
        const lines = intents
          .filter((i) => i.status === "PENDING" || i.status === "FAILED" || (i.status === "APPROVED" && i.attempt !== null && !i.attempt.authorized))
          .map((i) => {
            const who = names.get(i.supplier_id) ?? `supplier ${i.supplier_id}`;
            const what =
              i.status === "PENDING" ? `waits for your approval (${i.route})` : i.status === "FAILED" ? "transfer refused, retry?" : "deposit waiting for your signature, unless it fits the trust budget";
            return `• intent ${i.id}: ${fromUnits(i.value, state.token_decimals)} to ${who}, ${what} ${this.link(`/intent/${i.id}`) ?? ""}`;
          });
        return lines.length ? lines.join("\n") : "Nothing is waiting for you.";
      }
      case "suppliers": {
        const [state, suppliers] = await Promise.all([view.state(), view.suppliers()]);
        const names = new Map(this.deps.directory().suppliers.map((s) => [s.supplier_id, s.name]));
        const now = BigInt(Date.now()) * 1_000_000n;
        return (
          suppliers
            .map((s) => {
              const cooldown = now < BigInt(s.changed_at) + BigInt(state.policy.cooldown_ns) ? " (new address: cooldown)" : "";
              return `#${s.id} ${names.get(s.id) ?? "(no name on file)"}: ${s.chain} ${s.recipient}${cooldown}${s.active ? "" : " (inactive)"}`;
            })
            .join("\n") || "No suppliers yet."
        );
      }
      case "pause":
        return this.link("/pause")
          ? `Pause every payment by signing in your wallet: ${this.link("/pause")}`
          : 'Pause from your wallet: call set_paused {"paused": true} on the contract with 1 yoctoNEAR.';
      default:
        return "Unknown command. /help lists them.";
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
