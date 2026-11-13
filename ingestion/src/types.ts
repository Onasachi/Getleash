/** What ingestion hands the agent: a deduplicated, size-checked invoice from an approved sender. */
export type InvoiceFile = { kind: "pdf" | "png" | "jpeg" | "webp"; bytes: Uint8Array; name?: string | undefined };

export type InvoiceInput = {
  /** Channel-scoped unique id, already claimed in the update log (e.g. "telegram-123456"). */
  key: string;
  source: "telegram" | "mcp" | "cli" | "demo";
  receivedAt: string;
  chatId?: string | undefined;
  userId?: string | undefined;
  /** Pasted text, a caption, or the text layer of a PDF. */
  text?: string | undefined;
  files: InvoiceFile[];
};
