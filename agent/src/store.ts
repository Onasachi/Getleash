/**
 * Encrypted invoice store (PLAN §5, F-10): the original document, the extraction, the decision and
 * the verification evidence, AES-256-GCM encrypted at rest with INVOICE_STORE_KEY. Only the
 * authenticated private dashboard view reads it. Nothing in here goes on-chain.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StoredInvoice = {
  key: string;
  receivedAt: string;
  source: string;
  model: string;
  badge: string;
  extraction: unknown;
  decision: unknown;
  outcome: unknown;
  verification: unknown;
  files: Array<{ kind: string; name?: string | undefined; base64: string }>;
  text: string | null;
};

export function parseStoreKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("INVOICE_STORE_KEY must be 32 bytes as hex (openssl rand -hex 32)");
  return Buffer.from(hex, "hex");
}

export class InvoiceStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private path(key: string) {
    if (!/^[\w.-]{1,128}$/.test(key)) throw new Error(`invoice key ${JSON.stringify(key)} is not filesystem-safe`);
    return join(this.dir, `${key}.enc`);
  }

  put(record: StoredInvoice): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(record.key));
    const body = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), body]);
    writeFileSync(this.path(record.key), blob, { mode: 0o600 });
  }

  get(key: string): StoredInvoice | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    const blob = readFileSync(path);
    const decipher = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(blob.subarray(12, 28));
    const json = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(json) as StoredInvoice;
  }

  keys(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".enc"))
      .map((f) => f.slice(0, -4));
  }
}
