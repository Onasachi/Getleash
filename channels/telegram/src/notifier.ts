/**
 * Owner notices over the Telegram Bot API, for services that do not run the bot (the executor).
 * Only `sendMessage` to the configured owner chat; no polling, no reading.
 *
 * Links become buttons instead of bare links (`telegramMessage`, which the bot uses too). In a private
 * chat a GetLeash page opens as a Mini App (`web_app`): the dashboard runs inside Telegram, and the owner
 * signs in a wallet that also runs there (HOT Wallet), without leaving the chat. The owner's wallet still
 * signs every action; the button only opens the page. Groups get link buttons (Telegram allows `web_app`
 * buttons in private chats only), and anything else falls back to the links in the text.
 */
export type LinkButton = { text: string; url: string };

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

type Button = { text: string; web_app: { url: string } } | { text: string; url: string };
export type TelegramMessage = { text: string; reply_markup?: { inline_keyboard: Button[][] } };

function isTelegramLink(url: string): boolean {
  try {
    return new URL(url).hostname === "t.me";
  } catch {
    return false;
  }
}

/** A notice's links: its own (`link`, on a button named by `action`) first, then any further buttons. */
export function noticeLinks(
  notice: { link?: string | undefined; action?: string | undefined; buttons?: readonly LinkButton[] | undefined },
  label = "Open in GetLeash",
): LinkButton[] {
  return [...(notice.link ? [{ text: notice.action ?? label, url: notice.link }] : []), ...(notice.buttons ?? [])];
}

/**
 * A message with its links: https links become buttons, one per row, and the others stay in the text
 * ("label: address"). A GetLeash page opens as a Mini App in a private chat; in groups, and for t.me links
 * (another bot's Mini App, such as HOT Wallet, which Telegram opens itself), the button is a plain link.
 * `buttons: false` puts every link in the text, for when Telegram refused the buttons.
 */
export function telegramMessage(chatId: string | number, text: string, links: readonly LinkButton[], buttons = true): TelegramMessage {
  const privateChat = !String(chatId).startsWith("-");
  const onButton = (link: LinkButton) => buttons && link.url.startsWith("https://");
  const rows = links
    .filter(onButton)
    .map((link): Button[] => [privateChat && !isTelegramLink(link.url) ? { text: link.text, web_app: { url: link.url } } : { text: link.text, url: link.url }]);
  const inText = links.filter((link) => !onButton(link)).map((link) => `${link.text}: ${link.url}`);
  return { text: [text, ...inText].join("\n"), ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) };
}

export class TelegramNotifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async notify(notice: TelegramNotice): Promise<void> {
    const links = noticeLinks(notice, notice.kind ? ACTIONS[notice.kind] : undefined);
    const message = telegramMessage(this.chatId, notice.text, links);
    if (message.reply_markup && (await this.send(message))) return;
    await this.send(telegramMessage(this.chatId, notice.text, links, false), true);
  }

  /** Returns false when Telegram refused the buttons, so the caller can send the links as text instead. */
  private async send(message: TelegramMessage, mustSucceed = false): Promise<boolean> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: message.text, link_preview_options: { is_disabled: true }, ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return true;
    if (mustSucceed || response.status !== 400) throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
    return false;
  }
}
