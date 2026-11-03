/**
 * Local key files (Node only; import from "@getleash/shared/node").
 *
 * Key files use the near-cli credentials layout (`{ account_id, public_key, private_key }`), are
 * written with mode 0600 and live under `.keys/<network>/` (git-ignored) unless configured
 * otherwise. Services only ever hold the function-call keys they generated themselves; the
 * owner's key stays in the owner's wallet or the owner's own near-cli credentials.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Account, KeyPair, KeyPairSigner, type JsonRpcProvider, type KeyPairString } from "near-api-js";
import { z } from "zod";

import { Directory, mergeDirectories } from "./directory.ts";
import type { NetworkId } from "./networks.ts";

/**
 * near-cli (JS) and `keygen` write `account_id`. near-cli-rs's legacy keychain (checked with
 * 0.30.1) leaves it out and names the file after the account instead: `<account>.json` and
 * `<account>/ed25519_<key>.json`. It also stores the seed phrase, which this schema drops.
 */
export const KeyFile = z.object({
  account_id: z.string().optional(),
  public_key: z.string().startsWith("ed25519:"),
  private_key: z.string().startsWith("ed25519:"),
});
export type KeyFile = z.infer<typeof KeyFile>;

export function keysDir(network: NetworkId): string {
  const base = process.env.GETLEASH_KEYS_DIR ?? resolve(process.cwd(), ".keys");
  return join(base, network);
}

export function keyFilePath(network: NetworkId, accountId: string): string {
  return join(keysDir(network), `${accountId}.json`);
}

/** near-cli's legacy credentials location, where an owner's key usually lives. */
export function nearCliCredentialsPath(network: NetworkId, accountId: string): string {
  return join(homedir(), ".near-credentials", network, `${accountId}.json`);
}

/** Generates a new ed25519 key for `accountId` and writes it with mode 0600. Never overwrites. */
export function generateKeyFile(network: NetworkId, accountId: string, path = keyFilePath(network, accountId)): KeyFile {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a key`);
  const keyPair = KeyPair.fromRandom("ed25519");
  const file: KeyFile = {
    account_id: accountId,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return file;
}

export function readKeyFile(path: string): KeyFile {
  const parsed = KeyFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a NEAR key file: ${parsed.error.message}`);
  if (publicKeyOf(parsed.data.private_key) !== parsed.data.public_key) {
    throw new Error(`${path}: public_key does not belong to private_key`);
  }
  return parsed.data;
}

/** The account a key file is for: its `account_id`, else the near-cli-rs file name. */
export function keyFileAccount(path: string, file: KeyFile): string {
  if (file.account_id) return file.account_id;
  const name = basename(path, ".json");
  return name.startsWith("ed25519_") ? basename(dirname(path)) : name;
}

/** Loads a signing account from an explicit private key or a key file. */
export function signingAccount(
  rpc: JsonRpcProvider,
  accountId: string,
  source: { privateKey?: string | undefined; keyFile?: string | undefined },
): Account {
  let secret: string | undefined = source.privateKey;
  if (!secret && source.keyFile) {
    const file = readKeyFile(source.keyFile);
    if (keyFileAccount(source.keyFile, file) !== accountId) {
      throw new Error(
        file.account_id
          ? `${source.keyFile} holds a key for ${file.account_id}, not ${accountId}`
          : `${source.keyFile} has no account_id and is not named after ${accountId}; add "account_id": "${accountId}" to it`,
      );
    }
    secret = file.private_key;
  }
  if (!secret) throw new Error(`no key configured for ${accountId}`);
  return new Account(accountId, rpc, KeyPairSigner.fromSecretKey(secret as KeyPairString));
}

export function publicKeyOf(privateKey: string): string {
  return KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
}

// ── Supplier directory files ────────────────────────────────────────────────────────────────


export function dataDir(network: NetworkId): string {
  const base = process.env.GETLEASH_DATA_DIR ?? resolve(process.cwd(), ".data");
  return join(base, network);
}

export function directoryPath(network: NetworkId): string {
  return process.env.GETLEASH_DIRECTORY ?? join(dataDir(network), "directory.json");
}

export function loadDirectory(path: string): Directory {
  if (!existsSync(path)) return { suppliers: [] };
  return Directory.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * The directory as a service reads it: the suppliers in GETLEASH_DIRECTORY_BASE64 (the directory `pnpm
 * seed` writes, as base64, for hosts that do not have the owner's files: Render, Vercel), then those in
 * the file at `path` that the variable does not name. The bot saves suppliers added in Telegram to that
 * file, on the service's disk, so they need no change to the variable.
 */
export function loadServiceDirectory(path: string): Directory {
  const file = loadDirectory(path);
  const encoded = process.env.GETLEASH_DIRECTORY_BASE64;
  if (!encoded) return file;
  return mergeDirectories(Directory.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))), file);
}

/**
 * The dashboard's public address from DASHBOARD_URL, for the links in Telegram. An address typed without
 * a scheme ("www.getleash.xyz") gets https://, since Telegram makes buttons from https links only.
 */
export function dashboardUrlFromEnv(value = process.env.DASHBOARD_URL): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function saveDirectory(path: string, directory: Directory): void {
  writePrivateJson(path, Directory.parse(directory));
}

/** Writes JSON readable by this user only (0600), whole: through a temporary file renamed over the old one. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// ── Owner notices sent by more than one service ─────────────────────────────────────────────

/**
 * Keys of the owner notices that two services can send: the bot, when it replies to an invoice in the
 * owner's own chat, and the executor. The executor uses the same keys for its own dedupe.
 */
export const noticeKey = {
  approval: (intentId: number) => `approval:${intentId}`,
  paid: (intentId: number, since: string) => `paid:${intentId}:${since}`,
  failed: (intentId: number, since: string) => `failed:${intentId}:${since}`,
};

export function ownerNoticesPath(network: NetworkId): string {
  return join(dataDir(network), "owner-notices.jsonl");
}

/**
 * Notices the owner already received, shared through an append-only JSON-lines file by services on
 * the same machine, so the owner gets each one once. Each `has` reads only what was appended since
 * the last read. A convenience like the executor journal: without the file the owner gets a message twice,
 * never one fewer.
 */
export class DeliveredNotices {
  private readonly keys = new Set<string>();
  private offset = 0;

  constructor(private readonly path: string) {}

  has(key: string): boolean {
    this.refresh();
    return this.keys.has(key);
  }

  add(keys: readonly string[], by: string): void {
    if (keys.length === 0) return;
    const at = new Date().toISOString();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, keys.map((key) => `${JSON.stringify({ at, by, key })}\n`).join(""), { mode: 0o600 });
    for (const key of keys) this.keys.add(key);
  }

  private refresh() {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.offset) {
      // Replaced or truncated: read it again from the start.
      this.offset = 0;
      this.keys.clear();
    }
    if (size === this.offset) return;
    const bytes = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, bytes, 0, bytes.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const end = bytes.lastIndexOf(0x0a); // a line still being written is read next time
    if (end < 0) return;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as { key?: unknown };
        if (typeof entry.key === "string") this.keys.add(entry.key);
      } catch {
        // A line from a crashed writer is skipped.
      }
    }
    this.offset += end + 1;
  }
}
