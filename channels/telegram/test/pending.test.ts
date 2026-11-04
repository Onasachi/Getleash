/**
 * The bot's per-chat queues and the log that keeps unfinished updates across a restart (pending.ts,
 * bot.ts chatQueues; docs/decisions.md D-30): one chat's slow invoice never holds up another chat, each
 * chat stays in order, and an update still queued when the service stops is handled after it restarts.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import { chatQueues, type UpdateHandler } from "../src/bot.ts";
import { PendingUpdates } from "../src/pending.ts";

const update = (id: number, chat: number, text = `invoice ${id}`): Update =>
  ({ update_id: id, message: { message_id: id, date: 1_793_600_000, chat: { id: chat, type: "private" }, text } }) as unknown as Update;

describe("unfinished updates on disk", () => {
  it("are kept encrypted (mode 0600) and come back after a restart, oldest first; finished ones don't", () => {
    const path = join(mkdtempSync(join(tmpdir(), "getleash-pending-")), "telegram-pending.jsonl");
    const key = randomBytes(32);
    const first = new PendingUpdates(path, key);
    first.add(update(3, 1, "Invoice INV-7 from Acme, 2.00 USD"));
    first.add(update(1, 1));
    first.add(update(2, 2));
    first.done(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("Acme");

    const restarted = new PendingUpdates(path, key);
    expect(restarted.load().map((u) => u.update_id)).toEqual([2, 3]);
    restarted.done(2);
    restarted.done(3);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(new PendingUpdates(path, key).load()).toEqual([]);
  });

  it("skips what another key wrote instead of failing to start", () => {
    const path = join(mkdtempSync(join(tmpdir(), "getleash-pending-")), "telegram-pending.jsonl");
    new PendingUpdates(path, randomBytes(32)).add(update(1, 1));
    expect(new PendingUpdates(path, randomBytes(32)).load()).toEqual([]);
  });
});

describe("per-chat queues", () => {
  function handler() {
    const order: string[] = [];
    const gates = new Map<number, () => void>();
    const channel: UpdateHandler = {
      handle: async (u) => {
        order.push(`start ${u.update_id}`);
        if (u.message?.text === "slow") await new Promise<void>((resolve) => gates.set(u.update_id, resolve));
        order.push(`end ${u.update_id}`);
        return "done";
      },
      tick: async () => undefined,
    };
    return { order, gates, channel };
  }

  it("one chat's slow update doesn't hold up another chat, and each chat keeps its order", async () => {
    const { order, gates, channel } = handler();
    const enqueue = chatQueues(channel, () => undefined);
    const slow = enqueue(update(1, 100, "slow"));
    const sameChat = enqueue(update(2, 100));
    await enqueue(update(3, 200));
    // Chat 200 finished while chat 100's first update is still running; chat 100's second waits its turn.
    expect(order).toEqual(["start 1", "start 3", "end 3"]);
    gates.get(1)!();
    await Promise.all([slow, sameChat]);
    expect(order).toEqual(["start 1", "start 3", "end 3", "end 1", "start 2", "end 2"]);
  });

  it("keeps each update in the log until it is handled, so a restart replays what was still queued", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "getleash-pending-")), "telegram-pending.jsonl");
    const key = randomBytes(32);
    const { gates, channel } = handler();
    const pending = new PendingUpdates(path, key);
    const enqueue = chatQueues(channel, () => undefined, pending);
    void enqueue(update(1, 100, "slow"));
    void enqueue(update(2, 100));
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending.size()).toBe(2);

    // The service stops here. After the restart both come back; the update log (not part of this test)
    // drops the one that had started.
    const after = new PendingUpdates(path, key);
    expect(after.load().map((u) => u.update_id)).toEqual([1, 2]);
    gates.get(1)!();
  });
});
