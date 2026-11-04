/**
 * Updates the bot took from Telegram and has not finished (docs/decisions.md D-30). The bot handles each
 * chat on its own queue, so grammY confirms a batch to Telegram before every update in it is handled; a
 * restart would lose the ones still queued. This log keeps them, and the bot replays the unfinished ones
 * when it starts; the update log still makes sure nothing is acted on twice. Entries are encrypted
 * (AES-256-GCM with INVOICE_STORE_KEY): an invoice pasted as text is in them. The file is emptied whenever
 * nothing is pending.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Update } from "grammy/types";

export class PendingUpdates {
  private readonly open = new Map<number, Update>();

  constructor(
    private readonly path: string | null,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("the pending-update key must be 32 bytes");
  }

  /** The updates a previous run took and didn't finish, oldest first. The file then holds only those. */
  load(): Update[] {
    if (!this.path || !existsSync(this.path)) return [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { add?: string; done?: number };
        if (typeof entry.done === "number") this.open.delete(entry.done);
        else if (typeof entry.add === "string") {
          const update = this.decrypt(entry.add);
          this.open.set(update.update_id, update);
        }
      } catch {
        // A line cut short by a crash, or written with another key: skipped.
      }
    }
    this.rewrite();
    return [...this.open.values()].sort((a, b) => a.update_id - b.update_id);
  }

  add(update: Update): void {
    if (this.open.has(update.update_id)) return;
    this.open.set(update.update_id, update);
    this.append({ add: this.encrypt(update) });
  }

  done(updateId: number): void {
    if (!this.open.delete(updateId)) return;
    if (this.open.size === 0) this.rewrite();
    else this.append({ done: updateId });
  }

  /** Updates taken and not finished (for tests and logs). */
  size(): number {
    return this.open.size;
  }

  private append(entry: object): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  private rewrite(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lines = [...this.open.values()].map((update) => `${JSON.stringify({ add: this.encrypt(update) })}\n`);
    writeFileSync(this.path, lines.join(""), { mode: 0o600 });
  }

  private encrypt(update: Update): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(update), "utf8"), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }

  private decrypt(text: string): Update {
    const blob = Buffer.from(text, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const plain = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as Update;
  }
}
