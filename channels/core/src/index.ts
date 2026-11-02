/**
 * The channel interface (PLAN §4.4): a channel turns its own updates into `InvoiceInput`s (after
 * allowlisting, durable dedupe and size limits) and delivers notices to approved chats. Telegram
 * implements it for the hackathon; WhatsApp can implement the same interface later.
 */
import type { InvoiceInput } from "@getleash/ingestion";

export type Notice = { text: string; link?: string | undefined };

export type Received =
  | { kind: "invoice"; input: InvoiceInput; replyTo: string }
  | { kind: "ignored"; reason: "DUPLICATE_UPDATE" | "NOT_ALLOWED" | "NO_CONTENT" | "LIMIT"; detail?: string };

export interface Channel<Update> {
  readonly name: string;
  receive(update: Update): Promise<Received>;
  send(chatId: string, notice: Notice): Promise<void>;
}
