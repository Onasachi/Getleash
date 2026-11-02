import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonRpcProvider, KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { DeliveredNotices, noticeKey, readKeyFile, signingAccount } from "../src/node.ts";

const rpc = new JsonRpcProvider({ url: "http://127.0.0.1:9" }); // never contacted: no call is made
const dir = mkdtempSync(join(tmpdir(), "getleash-keys-"));

function write(path: string, body: object): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** The legacy-keychain layout near-cli-rs 0.30.1 writes: no account_id, a seed phrase, named after the account. */
function nearCliRsKey(keyPair: KeyPair) {
  return {
    seed_phrase_hd_path: "m/44'/397'/0'",
    master_seed_phrase: "twelve words that must never travel further than this file one two three four",
    implicit_account_id: "00".repeat(32),
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
}

describe("key files", () => {
  const keyPair = KeyPair.fromRandom("ed25519");

  it("reads near-cli-rs files named after the account, and drops the seed phrase", () => {
    const path = write(join(dir, "alice.testnet.json"), nearCliRsKey(keyPair));
    const file = readKeyFile(path);
    expect(file).toEqual({ public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() });
    expect(signingAccount(rpc, "alice.testnet", { keyFile: path }).accountId).toBe("alice.testnet");
  });

  it("reads near-cli-rs per-key files under the account's directory", () => {
    const pk = keyPair.getPublicKey().toString().replace(":", "_");
    const path = write(join(dir, "alice.testnet", `${pk}.json`), nearCliRsKey(keyPair));
    expect(signingAccount(rpc, "alice.testnet", { keyFile: path }).accountId).toBe("alice.testnet");
  });

  it("refuses a file for another account, by name or by account_id", () => {
    const unnamed = write(join(dir, "bob.testnet.json"), nearCliRsKey(keyPair));
    expect(() => signingAccount(rpc, "alice.testnet", { keyFile: unnamed })).toThrow(/not named after alice\.testnet/);
    const named = write(join(dir, "alice.testnet-copy.json"), {
      account_id: "bob.testnet",
      public_key: keyPair.getPublicKey().toString(),
      private_key: keyPair.toString(),
    });
    expect(() => signingAccount(rpc, "alice.testnet", { keyFile: named })).toThrow(/holds a key for bob\.testnet/);
  });

  it("refuses a file whose public key is not the private key's", () => {
    const other = KeyPair.fromRandom("ed25519");
    const path = write(join(dir, "carol.testnet.json"), { ...nearCliRsKey(keyPair), public_key: other.getPublicKey().toString() });
    expect(() => readKeyFile(path)).toThrow(/public_key does not belong to private_key/);
  });
});

describe("delivered notices", () => {
  it("one service sees what another recorded, including later additions", () => {
    const path = join(dir, "notices", "owner-notices.jsonl");
    const bot = new DeliveredNotices(path);
    const executor = new DeliveredNotices(path);
    expect(executor.has("approval:1")).toBe(false); // no file yet
    bot.add([noticeKey.approval(1)], "telegram");
    expect(executor.has("approval:1")).toBe(true);
    expect(executor.has("approval:2")).toBe(false);
    bot.add([noticeKey.paid(2, "5"), noticeKey.failed(3, "6")], "telegram");
    expect(executor.has("paid:2:5")).toBe(true);
    expect(executor.has("failed:3:6")).toBe(true);
  });

  it("reads a line still being written only once it is complete", () => {
    const path = join(dir, "partial.jsonl");
    writeFileSync(path, `${JSON.stringify({ key: "approval:1" })}\n{"key":"appro`);
    const reader = new DeliveredNotices(path);
    expect(reader.has("approval:1")).toBe(true);
    expect(reader.has("approval:9")).toBe(false);
    appendFileSync(path, `val:9"}\n`);
    expect(reader.has("approval:9")).toBe(true);
  });
});
