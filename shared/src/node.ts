/**
 * Local key files (Node only; import from "@getleash/shared/node").
 *
 * Key files use the near-cli credentials layout (`{ account_id, public_key, private_key }`), are
 * written with mode 0600 and live under `.keys/<network>/` (git-ignored) unless configured
 * otherwise. Services only ever hold the function-call keys they generated themselves; the
 * owner's key stays in the owner's wallet or the owner's own near-cli credentials.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Account, KeyPair, KeyPairSigner, type JsonRpcProvider, type KeyPairString } from "near-api-js";
import { z } from "zod";

import { Directory } from "./directory.ts";
import type { NetworkId } from "./networks.ts";

export const KeyFile = z.object({
  account_id: z.string(),
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
  return parsed.data;
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
    if (file.account_id !== accountId) {
      throw new Error(`${source.keyFile} holds a key for ${file.account_id}, not ${accountId}`);
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

export function saveDirectory(path: string, directory: Directory): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(Directory.parse(directory), null, 2)}\n`, { mode: 0o600 });
}
