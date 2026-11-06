/**
 * PDF text layer extraction (no rendering, no OCR), with the page and time limits enforced.
 *
 * pdf.js runs in a short-lived child process under plain Node (pdf-worker.mjs), one PDF at a time
 * (docs/decisions.md D-33). Loaded in the services' own process, which runs through tsx, pdf.js alone took
 * about 380 MB and kept it, more than the hosted instance (512 MB for the bot and the executor together)
 * can spare. On its own it needs about 90 MB, given back when it exits. The child also gets no environment
 * (so no secrets), at most 128 MB of heap, and is killed at the time limit, so a PDF that crashes or hangs
 * the reader stops only that process.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { LIMITS, LimitError, Semaphore } from "./limits.ts";

const WORKER = fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url));
const MAX_ANSWER_BYTES = 1024 * 1024;
const readers = new Semaphore(1);

const Answer = z.union([
  z.object({ pages: z.number().int().min(0), text: z.string() }).strict(),
  z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);

export function pdfText(bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<{ pages: number; text: string }> {
  return readers.run(() => readInChild(bytes, opts.timeoutMs ?? LIMITS.extractTimeoutMs));
}

function readInChild(bytes: Uint8Array, timeoutMs: number): Promise<{ pages: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", WORKER, String(LIMITS.maxPdfPages), String(LIMITS.maxTextChars)], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {},
    });
    let settled = false;
    const settle = (error: Error | null, value?: { pages: number; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new LimitError("TIMEOUT", `reading the PDF took longer than ${timeoutMs} ms`));
    }, timeoutMs);

    const out: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_ANSWER_BYTES) out.push(chunk);
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code, signal) => {
      let parsed: z.infer<typeof Answer> | null = null;
      try {
        parsed = Answer.parse(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch {
        // No answer: the reader crashed or was killed.
      }
      if (!parsed) return settle(new Error(`the PDF reader stopped without an answer (${signal ?? `exit code ${code}`})`));
      if ("error" in parsed) {
        const { code: reason, message } = parsed.error;
        return settle(reason === "TOO_MANY_PAGES" ? new LimitError("TOO_MANY_PAGES", message) : new Error(`the PDF could not be read: ${message}`));
      }
      settle(null, { pages: parsed.pages, text: parsed.text.slice(0, LIMITS.maxTextChars) });
    });
    // The reader may exit before reading all of its input (a crash): that is reported on "close", not here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}
