/**
 * Owner notifications. Notices carry ids, amounts and enum codes plus a dashboard link, never
 * invoice contents. The Telegram channel implements `Notifier`; the default prints to stdout.
 */
export type NoticeKind =
  | "approval_needed"
  | "authorization_needed"
  | "paid"
  | "delivered"
  | "swap_failed"
  | "payout_failed"
  | "callback_overdue"
  | "quote_rejected"
  | "funding_failed"
  | "paused";

export type Notice = {
  /** Stable key: the same notice is sent once (deduplicated through the journal). */
  key: string;
  kind: NoticeKind;
  text: string;
  link?: string | undefined;
  intentId?: number | undefined;
  attemptId?: number | undefined;
};

export interface Notifier {
  notify(notice: Notice): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  async notify(notice: Notice) {
    this.write(`🔔 [${notice.kind}] ${notice.text}${notice.link ? ` → ${notice.link}` : ""}`);
  }
}

/** Collects notices in memory (tests, demo). */
export class MemoryNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice) {
    this.notices.push(notice);
  }

  kinds(): string[] {
    return this.notices.map((n) => n.kind);
  }
}
