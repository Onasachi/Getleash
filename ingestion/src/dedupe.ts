/**
 * Durable dedupe of channel updates (PLAN §4.4: "dedupe on update_id before any processing").
 * `claim()` records the id on disk (fsync'd) before the update is processed, so a replayed or
 * redelivered Telegram update is ignored even across restarts.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export class UpdateLog {
  private readonly seen = new Set<string>();

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) this.seen.add(line.trim());
    }
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** True the first time a key is claimed; false for every repeat. */
  claim(key: string): boolean {
    if (!/^[\w.-]{1,128}$/.test(key)) throw new Error("bad update key");
    if (this.seen.has(key)) return false;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(this.path, "a", 0o600);
      try {
        writeSync(fd, `${key}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.seen.add(key);
    return true;
  }
}
