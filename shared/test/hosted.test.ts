/**
 * Hosted setup (docs/decisions.md D-30): the transactions a business's wallet signs on the dashboard's
 * /setup page are the setup CLI's (one builder for both), in the wallet's action format; what they cost;
 * which accounts can hold GetLeash; and the dashboard links that name a hosted business's contract.
 */
import { KeyPair, KeyPairSigner, type Provider } from "near-api-js";
import { describe, expect, it } from "vitest";

import {
  AGENT_METHODS,
  bytesToHex,
  canHostUnder,
  checkSetupClaim,
  dashboardLink,
  DEFAULT_POLICY,
  EXECUTOR_METHODS,
  finishCodeText,
  finishNonce,
  FT_STORAGE_DEPOSIT,
  fromBase64Url,
  hostedSetupPlan,
  initArgs,
  near,
  nearApiActions,
  nearRoundedUp,
  newFinishCode,
  parseFinishCode,
  RELEASE_WASM_BYTES,
  SETUP_CLAIM_RECIPIENT,
  SetupClaim,
  setupClaimMessage,
  setupCost,
  setupLinkSigned,
  setupTransactions,
  signSetupLink,
  tgas,
  toBase64Url,
  walletActions,
} from "../src/index.ts";

const AGENT_KEY = "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB";
const EXECUTOR_KEY = "ed25519:9ZRMNuXdfDzoPMGcLj2ZTzEXzuRkTNM5uVrCAwKcYmS4";
const TOKEN = { token_id: "usdc.near", token_decimals: 6 };

const plan = () => hostedSetupPlan({ ownerId: "acme.tg", agentPublicKey: AGENT_KEY, executorPublicKey: EXECUTOR_KEY, wasm: new Uint8Array(RELEASE_WASM_BYTES), token: TOKEN });

describe("a hosted business's setup plan", () => {
  it("puts everything under the owner's account, with the service's two keys and the default limits", () => {
    const p = plan();
    expect(p.policyId).toBe("getleash.acme.tg");
    expect(p.agent).toEqual({ accountId: "agent-1.acme.tg", publicKey: AGENT_KEY, balance: near("0.15"), allowance: near("0.5") });
    expect(p.executor).toEqual({ accountId: "executor-1.acme.tg", publicKey: EXECUTOR_KEY, balance: near("0.2"), allowance: near("1") });
    expect(p.treasuryToken).toBe("usdc.near");
    expect(p.policy).toEqual(DEFAULT_POLICY);
    // 83,900 bytes of code at 1 NEAR per 100 kB, plus 0.2 NEAR for the contract's records, rounded up to 0.05.
    expect(p.policyBalance).toBe(near("1.05"));
  });

  it("costs what docs/deployment.md measured: about 1.43 NEAR with network fees", () => {
    expect(setupCost(RELEASE_WASM_BYTES)).toBe(near("0.15") + near("0.2") + near("1.05") + FT_STORAGE_DEPOSIT + near("0.025"));
    expect(nearRoundedUp(setupCost(RELEASE_WASM_BYTES))).toBe("1.43");
    expect(nearRoundedUp(near("1.4"))).toBe("1.40");
    expect(nearRoundedUp(near("0.001"))).toBe("0.01");
  });
});

describe("the setup transactions", () => {
  it("are the agent's account, the executor's, the keyless contract and its USDC registration, in that order", () => {
    const p = plan();
    const txs = setupTransactions(p);
    expect(txs.map((t) => t.receiverId)).toEqual(["agent-1.acme.tg", "executor-1.acme.tg", "getleash.acme.tg", "usdc.near"]);
    expect(txs[0]!.actions).toEqual([
      { type: "CreateAccount" },
      { type: "Transfer", deposit: near("0.15") },
      { type: "AddKey", publicKey: AGENT_KEY, receiverId: "getleash.acme.tg", methodNames: [...AGENT_METHODS], allowance: near("0.5") },
    ]);
    expect(txs[1]!.actions[2]).toEqual({ type: "AddKey", publicKey: EXECUTOR_KEY, receiverId: "getleash.acme.tg", methodNames: [...EXECUTOR_METHODS], allowance: near("1") });
    // The contract never gets a key: create, fund, deploy, initialise.
    expect(txs[2]!.actions.map((a) => a.type)).toEqual(["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
    expect(txs[2]!.actions[3]).toEqual({ type: "FunctionCall", method: "new", args: initArgs(p), gas: tgas(100), deposit: 0n });
    expect(initArgs(p)).toMatchObject({ owner_id: "acme.tg", agent_id: "agent-1.acme.tg", executor_id: "executor-1.acme.tg", token_id: "usdc.near", token_decimals: 6, executor_trust_daily_budget: "0" });
    expect(txs[3]!.actions).toEqual([
      { type: "FunctionCall", method: "storage_deposit", args: { account_id: "getleash.acme.tg", registration_only: true }, gas: tgas(30), deposit: FT_STORAGE_DEPOSIT },
    ]);
  });

  it("convert to near-connect's action format for the browser wallet", () => {
    const [agent, , contract] = setupTransactions(plan());
    expect(walletActions(agent!.actions)).toEqual([
      { type: "CreateAccount" },
      { type: "Transfer", params: { deposit: "150000000000000000000000" } },
      { type: "AddKey", params: { publicKey: AGENT_KEY, accessKey: { permission: { receiverId: "getleash.acme.tg", methodNames: ["propose"], allowance: "500000000000000000000000" } } } },
    ]);
    const [, , deploy, init] = walletActions(contract!.actions);
    expect(deploy).toEqual({ type: "DeployContract", params: { code: new Uint8Array(RELEASE_WASM_BYTES) } });
    expect(init).toMatchObject({ type: "FunctionCall", params: { methodName: "new", gas: "100000000000000", deposit: "0" } });
  });

  it("convert to near-api-js actions for a key on this machine (the CLI and the sandbox tests)", () => {
    const list = setupTransactions(plan()).map((t) => nearApiActions(t.actions));
    expect(list.map((a) => a.length)).toEqual([3, 3, 4, 1]);
    expect(list[2]![2]!.deployContract?.code.length).toBe(RELEASE_WASM_BYTES);
    expect(list[0]![2]!.addKey?.accessKey.permission.functionCall?.receiverId).toBe("getleash.acme.tg");
  });
});

describe("who can hold a hosted GetLeash", () => {
  it("named accounts with a dot, short enough for executor-1.<account>", () => {
    expect(canHostUnder("acme.near")).toBe(true);
    expect(canHostUnder("acme.tg")).toBe(true);
    expect(canHostUnder("shop.acme.near")).toBe(true);
    expect(canHostUnder("a".repeat(48) + ".near")).toBe(true);
    expect(canHostUnder("a".repeat(49) + ".near")).toBe(false);
  });

  it("not implicit accounts, which cannot create sub-accounts, nor anything that isn't an account", () => {
    expect(canHostUnder("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")).toBe(false);
    expect(canHostUnder("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(false);
    expect(canHostUnder("near")).toBe(false);
    expect(canHostUnder("Acme.near")).toBe(false);
    expect(canHostUnder("acme..near")).toBe(false);
    expect(canHostUnder("")).toBe(false);
  });
});

describe("dashboard links", () => {
  it("name a hosted business's contract, and leave the dashboard's own links as they were", () => {
    expect(dashboardLink("https://getleash.example/", "/intent/4")).toBe("https://getleash.example/intent/4");
    expect(dashboardLink("https://getleash.example", "/intent/4", "getleash.acme.tg")).toBe("https://getleash.example/intent/4?c=getleash.acme.tg");
    expect(dashboardLink("https://getleash.example", "/suppliers/new?to=acme.near", "getleash.acme.tg")).toBe("https://getleash.example/suppliers/new?to=acme.near&c=getleash.acme.tg");
    expect(dashboardLink(null, "/intent/4", "getleash.acme.tg")).toBeNull();
  });
});

describe("the owner's claim", () => {
  const owner = KeyPair.fromRandom("ed25519");
  const other = KeyPair.fromRandom("ed25519");
  /** The chain's view of acme.tg's keys: `owner` has full access, `other` only a function-call key. */
  const rpc = (fail?: Error) =>
    ({
      viewAccessKey: async ({ accountId, publicKey }: { accountId: string; publicKey: string }) => {
        if (fail) throw fail;
        if (accountId !== "acme.tg") throw new Error(`account ${accountId} does not exist while viewing`);
        if (publicKey === owner.getPublicKey().toString()) return { nonce: 1n, permission: "FullAccess" };
        if (publicKey === other.getPublicKey().toString()) return { nonce: 1n, permission: { FunctionCall: { receiver_id: "x.near", method_names: [] } } };
        throw new Error(`access key ${publicKey} does not exist while viewing`);
      },
    }) as unknown as Provider;
  const sign = async (key: KeyPair, message: string, kind: "setup" | "connect" = "setup") => {
    const nonce = new Uint8Array(32).fill(7);
    const signed = await KeyPairSigner.fromSecretKey(key.toString() as never).signNep413Message("acme.tg", { message, recipient: SETUP_CLAIM_RECIPIENT, nonce });
    return { kind, owner: "acme.tg", publicKey: key.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString("base64"), nonce: bytesToHex(nonce) };
  };
  const expected = { agentPublicKey: AGENT_KEY, telegramUser: "4004", telegramName: "@acme_owner" };

  it("holds when the owner's full-access key signed it for this setup's agent key and this Telegram user", async () => {
    const claim = await sign(owner, setupClaimMessage({ ownerId: "acme.tg", ...expected }));
    expect(await checkSetupClaim(rpc(), claim, expected)).toBe("ok");
  });

  it("does not hold for another Telegram user, another setup, or a key without full access", async () => {
    const claim = await sign(owner, setupClaimMessage({ ownerId: "acme.tg", ...expected }));
    // The same signature presented by someone else (a forwarded setup link): it names user 4004.
    expect(await checkSetupClaim(rpc(), claim, { ...expected, telegramUser: "6666" })).toBe("bad");
    expect(await checkSetupClaim(rpc(), claim, { ...expected, agentPublicKey: EXECUTOR_KEY })).toBe("bad");
    // A page that showed another name than the bot recorded: the bot's message doesn't match what was signed.
    expect(await checkSetupClaim(rpc(), claim, { ...expected, telegramName: "@victor" })).toBe("bad");
    const weak = await sign(other, setupClaimMessage({ ownerId: "acme.tg", ...expected }));
    expect(await checkSetupClaim(rpc(), weak, expected)).toBe("bad");
    const stranger = KeyPair.fromRandom("ed25519");
    expect(await checkSetupClaim(rpc(), await sign(stranger, setupClaimMessage({ ownerId: "acme.tg", ...expected })), expected)).toBe("bad");
  });

  it("a connect claim (an existing GetLeash, moved to this Telegram account) is its own message: neither stands in for the other", async () => {
    const connect = await sign(owner, setupClaimMessage({ kind: "connect", ownerId: "acme.tg", ...expected }), "connect");
    expect(setupClaimMessage({ kind: "connect", ownerId: "acme.tg", ...expected })).toContain("instead of any account it served before");
    expect(await checkSetupClaim(rpc(), connect, expected)).toBe("ok");
    expect(await checkSetupClaim(rpc(), { ...connect, kind: "setup" }, expected)).toBe("bad");
    const setup = await sign(owner, setupClaimMessage({ ownerId: "acme.tg", ...expected }));
    expect(await checkSetupClaim(rpc(), { ...setup, kind: "connect" }, expected)).toBe("bad");
    // A claim without a kind (as the page sent them before) reads as a setup claim.
    expect(SetupClaim.parse({ owner: "acme.tg", publicKey: setup.publicKey, signature: setup.signature, nonce: setup.nonce }).kind).toBe("setup");
  });

  it("throws when NEAR can't be reached, instead of calling a good claim bad", async () => {
    const claim = await sign(owner, setupClaimMessage({ ownerId: "acme.tg", ...expected }));
    await expect(checkSetupClaim(rpc(new Error("fetch failed")), claim, expected)).rejects.toThrow("fetch failed");
  });
});

describe("setup links and finish codes", () => {
  const agentKey = KeyPair.fromRandom("ed25519");
  const signer = KeyPairSigner.fromSecretKey(agentKey.toString() as never);
  const link = { agent: AGENT_KEY, executor: EXECUTOR_KEY, until: 1_800_086_400_000, user: "4004", name: "@acme_owner", bot: "GetLeashBot" };

  it("a link signed with the operator's agent key checks out against that key, and only as signed", async () => {
    const sig = await signSetupLink(signer, "agent-1.owner.near", link);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const keys = [KeyPair.fromRandom("ed25519").getPublicKey().toString(), agentKey.getPublicKey().toString()];
    expect(await setupLinkSigned(link, sig, keys)).toBe(true);
    // Another name, account, key, expiry or bot: not what was signed.
    for (const changed of [{ name: "@victor" }, { user: "6006" }, { agent: EXECUTOR_KEY }, { until: link.until + 1 }, { bot: "GetLeashSetupBot" }]) {
      expect(await setupLinkSigned({ ...link, ...changed }, sig, keys)).toBe(false);
    }
    expect(await setupLinkSigned(link, sig, [KeyPair.fromRandom("ed25519").getPublicKey().toString()])).toBe(false);
    expect(await setupLinkSigned(link, "not a signature", keys)).toBe(false);
  });

  it("isn't a setup claim, nor anything else the agent key could be asked to sign", async () => {
    // The same key and bytes under the claim's recipient don't verify: NEP-413 signs the recipient too.
    const sig = await signSetupLink(signer, "agent-1.owner.near", link);
    const claim = { kind: "setup" as const, owner: "acme.tg", publicKey: agentKey.getPublicKey().toString(), signature: Buffer.from(fromBase64Url(sig)!).toString("base64"), nonce: "07".repeat(32) };
    const rpc = { viewAccessKey: async () => ({ nonce: 1n, permission: "FullAccess" }) } as unknown as Provider;
    expect(await checkSetupClaim(rpc, claim, { agentPublicKey: AGENT_KEY, telegramUser: "4004", telegramName: "@acme_owner" })).toBe("bad");
  });

  it("a finish code is 32 random bytes that fit a deep link; the claim's nonce is its SHA-256", () => {
    const code = newFinishCode();
    const text = finishCodeText(code);
    expect(`finish_${text}`.length).toBeLessThanOrEqual(64);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseFinishCode(text)).toEqual(code);
    expect(finishNonce(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(finishNonce(code)).not.toBe(bytesToHex(code));
    expect(newFinishCode()).not.toEqual(code);
    expect(parseFinishCode("short")).toBeNull();
    expect(parseFinishCode(toBase64Url(new Uint8Array(31)))).toBeNull();
    expect(parseFinishCode("+/+/")).toBeNull();
  });
});
