/**
 * Owner notices over the Telegram Bot API, for services that do not run the bot (the executor).
 * Only `sendMessage` to the configured owner chat; no polling, no reading.
 *
 * A notice with an https link gets a button instead of a bare link. In a private chat it is a Mini App
 * button (`web_app`): the dashboard opens inside Telegram, and the owner signs in a wallet that also
 * runs there (HOT Wallet), without leaving the chat. The owner's wallet still signs every action; the
 * button only opens the page. Groups get a plain link button (Telegram allows `web_app` buttons in
 * private chats only), and anything else falls back to the link in the text.
 */
export type TelegramNotice = { key?: string; kind?: string; text: string; link?: string | undefined; action?: string | undefined };

const ACTIONS: Record<string, string> = {
  approval_needed: "Review and approve",
  authorization_needed: "Confirm the transfer",
  payout_failed: "Open the payment",
  swap_failed: "Open the payment",
  funding_failed: "Open the payment",
  callback_overdue: "Check the payment",
  quote_rejected: "Open the payment",
  paused: "Open the pause page",
};

/** The reply markup for a notice's link: a Mini App button in private chats, a link button in groups. */
export function linkButton(chatId: string | number, link: string | undefined, label = "Open in GetLeash") {
  if (!link?.startsWith("https://")) return null;
  const privateChat = !String(chatId).startsWith("-");
  const button = privateChat ? { text: label, web_app: { url: link } } : { text: label, url: link };
  return { inline_keyboard: [[button]] };
}

export class TelegramNotifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async notify(notice: TelegramNotice): Promise<void> {
    const button = linkButton(this.chatId, notice.link, notice.action ?? (notice.kind ? ACTIONS[notice.kind] : undefined));
    if (button && (await this.send(notice.text, button))) return;
    await this.send(notice.link ? `${notice.text}\n${notice.link}` : notice.text, null, true);
  }

  /** Returns false when Telegram refused the button, so the caller can send the plain link instead. */
  private async send(text: string, replyMarkup: object | null, mustSucceed = false): Promise<boolean> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return true;
    if (mustSucceed || response.status !== 400) throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
    return false;
  }
}
