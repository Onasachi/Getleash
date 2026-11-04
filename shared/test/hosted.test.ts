/**
 * Hosted setup (docs/decisions.md D-30): the transactions a business's wallet signs on the dashboard's
 * /setup page are the setup CLI's (one builder for both), in the wallet's action format; what they cost;
 * which accounts can hold GetLeash; and the dashboard links that name a hosted business's contract.
 */
import { KeyPair, KeyPairSigner, PublicKey, type Provider } from "near-api-js";
import { describe, expect, it } from "vitest";

import {
  AGENT_METHODS,
  bytesToHex,
  canHost,
  checkSetupClaim,
  dashboardLink,
  DEFAULT_POLICY,
  defaultRoleIds,
  EXECUTOR_METHODS,
  finishCodeText,
  finishNonce,
  FT_STORAGE_DEPOSIT,
  fromBase64Url,
  factoryDeposit,
  hostedIds,
  hostedSetupPlan,
  hostedSetupTransaction,
  initArgs,
  near,
  nearApiActions,
  nearRoundedDown,
  nearRoundedUp,
  newFinishCode,
  parseFinishCode,
  RELEASE_WASM_BYTES,
  SETUP_CLAIM_RECIPIENT,
  SetupClaim,
  setupClaimMessage,
  setupCost,
  setupNeeds,
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

const plan = () => hostedSetupPlan({ ownerId: "acme.tg", agentPublicKey: AGENT_KEY, executorPublicKey: EXECUTOR_KEY, token: TOKEN });

describe("a hosted business's setup plan", () => {
  it("names everything after the owner's account, under the factory, with the service's two keys and the default limits", () => {
    const p = plan();
    expect(p.policyId).toBe("acme-tg.getleash.near");
    expect(p.agent).toEqual({ accountId: "acme-tg-agent.getleash.near", publicKey: AGENT_KEY, balance: near("0.15"), allowance: near("0.5") });
    expect(p.executor).toEqual({ accountId: "acme-tg-executor.getleash.near", publicKey: EXECUTOR_KEY, balance: near("0.2"), allowance: near("1") });
    expect(p.treasuryToken).toBe("usdc.near");
    expect(p.policy).toEqual(DEFAULT_POLICY);
    // 83,900 bytes of code at 1 NEAR per 100 kB, plus 0.2 NEAR for the contract's records, rounded up to 0.05.
    expect(p.policyBalance).toBe(near("1.05"));
    expect(hostedIds("shop.acme.near")).toEqual({ policyId: "shop-acme-near.getleash.near", agentId: "shop-acme-near-agent.getleash.near", executorId: "shop-acme-near-executor.getleash.near" });
  });

  it("costs about 1.43 NEAR with network fees, and the wallet needs about 1.491 while it signs, more if gas costs more", () => {
    expect(factoryDeposit()).toBe(near("0.15") + near("0.2") + near("1.05") + FT_STORAGE_DEPOSIT + near("0.002"));
    expect(setupCost()).toBe(factoryDeposit() + near("0.025"));
    expect(nearRoundedUp(setupCost())).toBe("1.43");
    // 85 Tgas held at 10.2 times NEAR's lowest gas price, and a little for the transaction itself.
    expect(setupNeeds()).toBe(factoryDeposit() + near("0.0867") + near("0.001"));
    expect(nearRoundedUp(setupNeeds(), 3)).toBe("1.491");
    expect(setupNeeds(200_000_000n)).toBe(factoryDeposit() + near("0.1734") + near("0.001"));
    expect(setupNeeds(50_000_000n)).toBe(setupNeeds());
    expect(nearRoundedUp(near("1.4"))).toBe("1.40");
    expect(nearRoundedUp(near("0.001"))).toBe("0.01");
  });

  it("shows what a wallet needs rounded up and what it holds rounded down, so the two never look equal when it falls short", () => {
    // The first live wallet: 1.5 NEAR and 182 bytes of its own.
    const available = 1_500_000_000_000_000_000_001_000n - 182n * 10n ** 19n;
    expect(nearRoundedDown(available, 3)).toBe("1.498");
    expect(setupNeeds()).toBeLessThan(available);
    expect(nearRoundedUp(near("1.4955"), 2)).toBe("1.50");
    expect(nearRoundedDown(near("1.4955"), 2)).toBe("1.49");
    expect(nearRoundedDown(near("0.0009"), 3)).toBe("0.000");
  });
});

describe("the setup transaction", () => {
  it("is one call to the factory: the service's two public keys in hex and exactly the setup's cost (D-32)", () => {
    const tx = hostedSetupTransaction(plan());
    expect(tx).toEqual({
      receiverId: "getleash.near",
      actions: [
        {
          type: "FunctionCall",
          method: "create",
          args: { agent: bytesToHex(PublicKey.fromString(AGENT_KEY).data), executor: bytesToHex(PublicKey.fromString(EXECUTOR_KEY).data) },
          gas: tgas(85),
          deposit: factoryDeposit(),
        },
      ],
    });
    // The factory reads exactly this text: {"agent":"<64 hex>","executor":"<64 hex>"}.
    expect(JSON.stringify((tx.actions[0] as { args: unknown }).args)).toMatch(/^\{"agent":"[0-9a-f]{64}","executor":"[0-9a-f]{64}"\}$/);
  });

  it("converts to near-connect's action format: a plain call with a deposit, which HOT Wallet shows without a warning", () => {
    expect(walletActions(hostedSetupTransaction(plan()).actions)).toEqual([
      {
        type: "FunctionCall",
        params: {
          methodName: "create",
          args: { agent: bytesToHex(PublicKey.fromString(AGENT_KEY).data), executor: bytesToHex(PublicKey.fromString(EXECUTOR_KEY).data) },
          gas: "85000000000000",
          deposit: "1403250000000000000000000",
        },
      },
    ]);
  });

  it("the CLI's own setup still creates the accounts under the owner, keyless, deploying the release itself", () => {
    const cli = setupTransactions({ ...plan(), ...defaultRoleIds("acme.tg"), agent: { ...plan().agent, accountId: "agent-1.acme.tg" }, executor: { ...plan().executor, accountId: "executor-1.acme.tg" }, policyId: "getleash.acme.tg", wasm: new Uint8Array(RELEASE_WASM_BYTES) });
    expect(cli.map((t) => t.receiverId)).toEqual(["agent-1.acme.tg", "executor-1.acme.tg", "getleash.acme.tg", "usdc.near"]);
    expect(cli[0]!.actions[2]).toEqual({ type: "AddKey", publicKey: AGENT_KEY, receiverId: "getleash.acme.tg", methodNames: [...AGENT_METHODS], allowance: near("0.5") });
    expect(cli[1]!.actions[2]).toEqual({ type: "AddKey", publicKey: EXECUTOR_KEY, receiverId: "getleash.acme.tg", methodNames: [...EXECUTOR_METHODS], allowance: near("1") });
    expect(cli[2]!.actions.map((a) => a.type)).toEqual(["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
    expect(cli[3]!.actions).toEqual([
      { type: "FunctionCall", method: "storage_deposit", args: { account_id: "getleash.acme.tg", registration_only: true }, gas: tgas(10), deposit: FT_STORAGE_DEPOSIT },
    ]);
    expect(nearApiActions(cli[2]!.actions)[2]!.deployContract?.code.length).toBe(RELEASE_WASM_BYTES);
  });

  it("the contract's `new` arguments are the plan's: the owner, the two role accounts, the token, the default limits", () => {
    expect(initArgs(plan())).toMatchObject({ owner_id: "acme.tg", agent_id: "acme-tg-agent.getleash.near", executor_id: "acme-tg-executor.getleash.near", token_id: "usdc.near", token_decimals: 6, executor_trust_daily_budget: "0" });
  });
});

describe("who can have a hosted GetLeash", () => {
  it("any NEAR account short enough for <name>-executor.getleash.near to fit NEAR's 64 characters", () => {
    expect(canHost("acme.near")).toBe(true);
    expect(canHost("acme.tg")).toBe(true);
    expect(canHost("shop.acme.near")).toBe(true);
    expect(canHost("near")).toBe(true);
    expect(canHost("a".repeat(36) + ".near")).toBe(true);
    expect(canHost("a".repeat(37) + ".near")).toBe(false);
  });

  it("not an account whose name would end like a role account's: the factory refuses those", () => {
    expect(canHost("v.agent")).toBe(false);
    expect(canHost("shop-agent")).toBe(false);
    expect(canHost("v.executor")).toBe(false);
    expect(canHost("ops-executor")).toBe(false);
    expect(canHost("agent.near")).toBe(true);
    expect(canHost("my-agent-shop.near")).toBe(true);
  });

  it("not implicit accounts (too long), nor anything that isn't an account", () => {
    expect(canHost("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")).toBe(false);
    expect(canHost("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(false);
    expect(canHost("Acme.near")).toBe(false);
    expect(canHost("acme..near")).toBe(false);
    expect(canHost("")).toBe(false);
  });
});

describe("dashboard links", () => {
  it("name a hosted business's contract, and leave the dashboard's own links as they were", () => {
    expect(dashboardLink("https://getleash.example/", "/intent/4")).toBe("https://getleash.example/intent/4");
    expect(dashboardLink("https://getleash.example", "/intent/4", "acme-tg.getleash.near")).toBe("https://getleash.example/intent/4?c=acme-tg.getleash.near");
    expect(dashboardLink("https://getleash.example", "/suppliers/new?to=acme.near", "acme-tg.getleash.near")).toBe("https://getleash.example/suppliers/new?to=acme.near&c=acme-tg.getleash.near");
    expect(dashboardLink(null, "/intent/4", "acme-tg.getleash.near")).toBeNull();
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
