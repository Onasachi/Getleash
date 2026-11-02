/**
 * Runs the executor and the Telegram bot side by side, for one always-on host (a Render background
 * worker with one disk; docs/deployment.md, "Host the services and the dashboard"). They share
 * GETLEASH_DATA_DIR, so each owner notice is sent once (DeliveredNotices) and the executor's journal,
 * the bot's update log and the encrypted invoice store survive restarts. A service that exits is
 * started again, after a pause that grows to a minute while it keeps failing; SIGTERM stops both.
 *
 *   pnpm services        (configuration from the environment, as for each service on its own)
 */
import { type ChildProcess, spawn } from "node:child_process";

const SERVICES: Record<string, string> = {
  executor: "executor/src/main.ts",
  bot: "channels/telegram/src/main.ts",
};

const running = new Map<string, ChildProcess>();
const restarts = new Set<NodeJS.Timeout>();
let stopping = false;

function start(name: string, entry: string, pause = 2) {
  if (stopping) return;
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit", env: process.env });
  running.set(name, child);
  child.on("exit", (code, signal) => {
    running.delete(name);
    if (stopping) {
      if (running.size === 0) process.exit(0);
      return;
    }
    // A service that ran for a while comes back at once; one that keeps failing backs off.
    const next = Date.now() - startedAt > 60_000 ? 2 : Math.min(pause * 2, 60);
    console.error(`[services] ${name} exited (${signal ?? `code ${code}`}); starting it again in ${next} s`);
    const timer = setTimeout(() => {
      restarts.delete(timer);
      start(name, entry, next);
    }, next * 1000);
    restarts.add(timer);
  });
}

function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  for (const timer of restarts) clearTimeout(timer);
  restarts.clear();
  if (running.size === 0) process.exit(0);
  console.error(`[services] ${signal}: stopping ${[...running.keys()].join(", ")}`);
  for (const child of running.values()) child.kill(signal);
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
for (const [name, entry] of Object.entries(SERVICES)) start(name, entry);
