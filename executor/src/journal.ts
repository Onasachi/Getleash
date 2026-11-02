/**
 * The executor's local journal: an append-only JSON-lines log of what it did. It is a convenience
 * (notification dedupe, retry back-off, an audit trail on the machine that ran it). The contract is
 * the source of truth: on restart the executor rebuilds its queue from `get_open_work()`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalEntry = { at: string; type: string; [field: string]: unknown };

export class Journal {
  private readonly notified = new Set<string>();
  private readonly failures = new Map<number, number>();
  readonly entries: JournalEntry[] = [];

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as JournalEntry);
        } catch {
          // A torn last line after a crash is skipped.
        }
      }
    }
  }

  record(type: string, fields: Record<string, unknown> = {}) {
    const entry: JournalEntry = { at: new Date().toISOString(), type, ...fields };
    this.apply(entry);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    }
  }

  wasNotified(key: string): boolean {
    return this.notified.has(key);
  }

  failuresFor(intentId: number): number {
    return this.failures.get(intentId) ?? 0;
  }

  private apply(entry: JournalEntry) {
    this.entries.push(entry);
    if (entry.type === "notified" && typeof entry.key === "string") this.notified.add(entry.key);
    if (entry.type === "funding_failed" && typeof entry.intentId === "number") {
      this.failures.set(entry.intentId, (this.failures.get(entry.intentId) ?? 0) + 1);
    }
    if (entry.type === "failures_reset" && typeof entry.intentId === "number") this.failures.delete(entry.intentId);
  }
}
