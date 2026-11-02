/**
 * Owner notices over the Telegram Bot API, for services that do not run the bot (the executor).
 * Only `sendMessage` to the configured owner chat; no polling, no reading.
 */
export type TelegramNotice = { key: string; kind: string; text: string; link?: string | undefined };

export class TelegramNotifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async notify(notice: TelegramNotice): Promise<void> {
    const text = notice.link ? `${notice.text}\n${notice.link}` : notice.text;
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
  }
}
