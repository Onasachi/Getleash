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
import { type SetupLink, signSetupLink } from "./hosted.ts";
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

// ── Hosted businesses (docs/decisions.md D-30) ───────────────────────────────────────────────

/** A business that set up its own GetLeash through this service's bot. */
export const HostedBusiness = z.object({
  policy_id: z.string().min(2).max(64),
  owner_id: z.string().min(2).max(64),
  agent_id: z.string().min(2).max(64),
  executor_id: z.string().min(2).max(64),
  /** The Telegram user who set it up, and their private chat with the bot: the only chat it answers. */
  owner_user: z.string().regex(/^\d+$/),
  owner_chat: z.string().regex(/^-?\d+$/),
  created_at: z.string(),
});
export type HostedBusiness = z.infer<typeof HostedBusiness>;

/** What the service holds for one business: its two function-call keys and its two off-chain secrets. */
export const BusinessSecrets = z.object({
  agent_private_key: z.string().startsWith("ed25519:"),
  executor_private_key: z.string().startsWith("ed25519:"),
  tenant_secret: z.string().regex(/^[0-9a-f]{64}$/),
  invoice_store_key: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BusinessSecrets = z.infer<typeof BusinessSecrets>;

const HostedRegistry = z.object({ businesses: z.array(HostedBusiness).default([]) });

/** Where hosted businesses live: `<data dir>/hosted/`. */
export function hostedDir(network: NetworkId): string {
  return join(dataDir(network), "hosted");
}

/**
 * The hosted businesses (`businesses.json`) and each one's own directory (`<contract>/`: its secrets,
 * supplier names, encrypted invoices, executor journal and notices), all mode 0600. The bot adds
 * businesses; the executor reads the list at every pass, so a new one is picked up without a restart.
 */
export class HostedBusinesses {
  constructor(readonly root: string) {}

  private get registryPath(): string {
    return join(this.root, "businesses.json");
  }

  list(): HostedBusiness[] {
    if (!existsSync(this.registryPath)) return [];
    return HostedRegistry.parse(JSON.parse(readFileSync(this.registryPath, "utf8"))).businesses;
  }

  /** A business's directory, named after its contract (a NEAR account id: no slashes, no "..", so it stays inside `root`). */
  dir(policyId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(policyId) || policyId.includes("..")) throw new Error(`not a NEAR account id: ${policyId}`);
    return join(this.root, policyId);
  }

  secrets(policyId: string): BusinessSecrets {
    return BusinessSecrets.parse(JSON.parse(readFileSync(join(this.dir(policyId), "secrets.json"), "utf8")));
  }

  /**
   * Adds a business: its secrets first, then the registry entry that makes the services use them. Adding
   * it again changes nothing, and a business's secrets are never replaced: its stored invoices and the
   * obligation ids that block paying an invoice twice depend on them.
   */
  add(business: HostedBusiness, secrets: BusinessSecrets): void {
    const entry = HostedBusiness.parse(business);
    const path = join(this.dir(entry.policy_id), "secrets.json");
    if (existsSync(path)) {
      const kept = BusinessSecrets.parse(JSON.parse(readFileSync(path, "utf8")));
      if (kept.agent_private_key !== secrets.agent_private_key) throw new Error(`${entry.policy_id} is already set up with other keys`);
    } else {
      writePrivateJson(path, BusinessSecrets.parse(secrets));
    }
    const all = this.list();
    if (all.some((b) => b.policy_id === entry.policy_id)) return;
    writePrivateJson(this.registryPath, { businesses: [...all, entry] });
  }

  /**
   * Moves a business to another Telegram account, which its owner's wallet asked for (a "connect" claim,
   * docs/decisions.md D-30): only the registry entry changes; its keys, secrets and files stay.
   */
  move(policyId: string, to: { owner_user: string; owner_chat: string }): HostedBusiness {
    const all = this.list();
    const at = all.findIndex((b) => b.policy_id === policyId);
    if (at < 0) throw new Error(`${policyId} is not hosted here`);
    const moved = HostedBusiness.parse({ ...all[at], owner_user: to.owner_user, owner_chat: to.owner_chat });
    all[at] = moved;
    writePrivateJson(this.registryPath, { businesses: all });
    return moved;
  }
}

/** Signs setup links with a private key, as the bot does with its agent's (tests and local runs). */
export function setupLinkSigner(accountId: string, privateKey: string): (link: SetupLink) => Promise<string> {
  const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  return (link) => signSetupLink(signer, accountId, link);
}

/** A new ed25519 key pair in near-cli's string form, for a key only this service will hold. */
export function newKeyPair(): { public_key: string; private_key: string } {
  const pair = KeyPair.fromRandom("ed25519");
  return { public_key: pair.getPublicKey().toString(), private_key: pair.toString() };
}
