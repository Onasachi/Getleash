/**
 * Another business setting up GetLeash through the bot (signup.ts, docs/decisions.md D-30), and the hub
 * that routes each message to the business it belongs to. The chain and the wallet are faked: `chain`
 * stands for the business's wallet having signed the setup page's transactions, and a claim's signature
 * `signed:<kind>:<owner>:<telegram user>:<telegram name>:<agent key>` for that wallet having signed the
 * claim message (the real signature check is tested in shared/test/hosted.test.ts). The setup links are
 * really signed, with a key that stands for the operator's agent key.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import type { AgentOutcome, InvoiceAgent } from "@getleash/agent";
import { UpdateLog } from "@getleash/ingestion";
import { type ClaimKind, DEFAULT_POLICY, FINISH_PREFIX, finishCodeText, finishNonce, newFinishCode, type PolicyView, type SetupClaim, setupLinkSigned } from "@getleash/shared";
import { HostedBusinesses, newKeyPair, publicKeyOf, setupLinkSigner } from "@getleash/shared/node";

import { parseIdList, TelegramChannel, TelegramHub } from "../src/bot.ts";
import { SupplierOnboarding } from "../src/onboarding.ts";
import { BusinessSignup, CHECK_FOR_MS, displayName, FINISH_WAIT_MS, KEEP_AFTER_LINK_MS, LINK_TTL_MS, SETUP_BUTTON } from "../src/signup.ts";

const OWNER = 1001; // the operator, on the allowlist
const CHAT = 2002;
const NEWCOMER = 4004; // someone setting up their own GetLeash
const SUPPLIER = 5005;
const OTHER = 6006;
const TOKEN = "usdc.near";

type Sent = { chatId: string; text: string; other?: Record<string, unknown> | undefined; id: number };

const REFUSED = {
  status: "rejected_onchain",
  decision: null,
  result: { accepted: false, intent_id: null, status: null, route: null, reason: "UNKNOWN_SUPPLIER" },
  intentStatus: null,
  intentSince: null,
  supplier: null,
  obligationId: null,
  badge: "Verification unavailable",
  model: null,
  notices: [],
  summary: "refused by the contract: UNKNOWN_SUPPLIER",
} satisfies Omit<AgentOutcome, "key">;

function world(opts: { now?: () => number; max?: number; dir?: string; invoicesPerDay?: number } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "getleash-signup-"));
  const sent: Sent[] = [];
  let messageId = 500;
  const api = {
    sendMessage: async (chatId: string | number, text: string, other?: Record<string, unknown>) => {
      const id = messageId++;
      sent.push({ chatId: String(chatId), text, other, id });
      return { message_id: id };
    },
    getFile: async () => ({}),
    getMe: async () => ({ username: "GetLeashBot" }),
  };
  const updateLog = new UpdateLog(null);
  const processed: string[] = [];
  const view = (contractId: string, owner: string, treasury: bigint) =>
    ({
      contractId,
      state: async () => ({
        owner_id: owner,
        agent_id: `agent-1.${owner}`,
        executor_id: `executor-1.${owner}`,
        token_id: TOKEN,
        token_decimals: 6,
        paused: false,
        paying: 0,
        policy: DEFAULT_POLICY,
        budgets: { outflow: "0", autonomous: "0" },
      }),
      treasuryBalance: async () => treasury,
      suppliers: async () => [],
      recentIntents: async () => [],
      provider: { viewAccount: async () => ({}) },
    }) as unknown as PolicyView;
  const channel = (v: PolicyView, user: string, chat: string, contract: string | null) =>
    new TelegramChannel({
      api,
      updateLog,
      allowedUsers: parseIdList(user),
      allowedChats: parseIdList(chat),
      download: async () => new Uint8Array(),
      agent: {
        process: async (input: { key: string }) => {
          processed.push(`${v.contractId}:${input.key}`);
          return { key: input.key, ...REFUSED };
        },
      } as unknown as InvoiceAgent,
      view: v,
      directory: () => ({ suppliers: [] }),
      dashboardUrl: "https://getleash.example",
      dashboardContract: contract,
      ownerChatId: contract ? chat : null,
      ownerChatOnly: contract !== null,
      invoicesPerDay: contract ? (opts.invoicesPerDay ?? null) : null,
      onboarding: new SupplierOnboarding({
        // On disk, as in main.ts: a business's channel made again (its owner moved it) picks up its invites.
        statePath: join(dir, `${v.contractId}-onboarding.json`),
        directoryPath: join(dir, `${v.contractId}-directory.json`),
        directory: () => ({ suppliers: [] }),
        view: v,
      }),
    });
  const home = view("getleash.owner.near", "owner.near", 9_000_000n);
  const hub = new TelegramHub(channel(home, String(OWNER), String(CHAT), null));
  const businesses = new HostedBusinesses(join(dir, "hosted"));
  /** Setups the business's wallet has signed on-chain: contract → the two public keys its role accounts hold. */
  const chain = new Map<string, { agent: string; executor: string }>();
  /** Stands for the operator's agent key, which signs the setup links. */
  const linkKey = newKeyPair();
  let activations = 0;
  const signup = new BusinessSignup({
    api,
    updateLog,
    statePath: join(dir, "hosted", "signup.json"),
    home,
    dashboardUrl: "https://getleash.example",
    isMember: (user) => hub.isMember(user),
    count: () => businesses.list().length,
    maxBusinesses: opts.max ?? 50,
    activate: async (business, secrets) => {
      activations++;
      businesses.add(business, secrets);
      hub.add(channel(view(business.policy_id, business.owner_id, 3_000_000n), business.owner_user, business.owner_chat, business.policy_id));
    },
    hosted: (id) => businesses.list().find((b) => b.policy_id === id) ?? null,
    move: async (business, to) => {
      const moved = businesses.move(business.policy_id, to);
      hub.replace(channel(view(moved.policy_id, moved.owner_id, 3_000_000n), moved.owner_user, moved.owner_chat, moved.policy_id));
      return moved;
    },
    signLink: setupLinkSigner("agent-1.owner.near", linkKey.private_key),
    viewOf: (id) => view(id, id.replace(/^getleash\./, ""), 0n),
    checkClaim: async (claim, expected) =>
      claim.signature === `signed:${claim.kind}:${claim.owner}:${expected.telegramUser}:${expected.telegramName}:${expected.agentPublicKey}`.padEnd(40, ".") ? "ok" : "bad",
    verify: async (target) => {
      const keys = chain.get(target.policyId);
      const ok = !!keys && keys.agent === target.agent.publicKey && keys.executor === target.executor.publicKey;
      return [
        { name: `${target.policyId} has no access keys`, ok, detail: "" },
        { name: `${target.agent.accountId} holds only its function-call key`, ok, detail: "" },
      ];
    },
    now: opts.now,
  });
  hub.setSignup(signup);
  let id = 100;
  /** Each test user's Telegram account: user `n` is @user<n>. */
  const update = (from: number, fields: Record<string, unknown>, chat = from === OWNER ? CHAT : from) =>
    hub.handle({
      update_id: id++,
      message: {
        message_id: id,
        date: 1_793_600_000,
        chat: { id: chat, type: "private", first_name: "Someone" },
        from: { id: from, is_bot: false, first_name: "Someone", username: `user${from}` },
        ...fields,
      },
    } as unknown as Update);
  const say = (text: string, from = NEWCOMER, extra: Record<string, unknown> = {}) => update(from, { text, ...extra });
  const last = (chat: number) => sent.filter((m) => m.chatId === String(chat)).at(-1);
  /** The setup link in the last offer to a chat: the two public keys it carries and its expiry. */
  const offered = (chat = NEWCOMER) => {
    const offer = sent.filter((m) => m.chatId === String(chat) && (m.other?.reply_markup as { keyboard?: unknown } | undefined)?.keyboard).at(-1)!;
    const markup = offer.other!.reply_markup as { keyboard: Array<Array<{ text: string; web_app: { url: string } }>> };
    const button = markup.keyboard[0]![0]!;
    const url = new URL(button.web_app.url);
    return {
      offer,
      button,
      url,
      agent: url.searchParams.get("agent")!,
      executor: url.searchParams.get("executor")!,
      until: Number(url.searchParams.get("until")),
      for: url.searchParams.get("for")!,
      name: url.searchParams.get("name")!,
      bot: url.searchParams.get("bot")!,
      sig: url.searchParams.get("sig")!,
    };
  };
  /** The finish code each sender's last page made. */
  const codes = new Map<number, Uint8Array>();
  /**
   * What the setup page sends the bot that opened it, from `from`: a claim that `owner`'s wallet signed for
   * the Telegram account `signedFor` (as the page's link showed it: @user<n>) and this setup's agent key,
   * with the SHA-256 of the page's finish code as its nonce.
   */
  const page = (owner: string, from = NEWCOMER, signedFor = from, agentKey?: string, shownName = `@user${signedFor}`, opts: { kind?: ClaimKind; code?: Uint8Array } = {}) => {
    const key = agentKey ?? offered(from).agent;
    const kind = opts.kind ?? "setup";
    const code = opts.code ?? newFinishCode();
    codes.set(from, code);
    const claim: SetupClaim = {
      kind,
      owner,
      publicKey: "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB",
      signature: `signed:${kind}:${owner}:${signedFor}:${shownName}:${key}`.padEnd(40, "."),
      nonce: finishNonce(code),
    };
    return update(from, { web_app_data: { data: JSON.stringify(claim), button_text: SETUP_BUTTON } });
  };
  /** START in this bot's chat, which the page opened with its finish code: `/start finish_<code>` from `from`. */
  const finish = (from = NEWCOMER, code = codes.get(from)!) => say(`/start ${FINISH_PREFIX}${finishCodeText(code)}`, from);
  /** The page's Finish, then START: what a setup's owner does at the end. */
  const complete = async (owner: string, from = NEWCOMER, opts: { kind?: ClaimKind } = {}) => {
    await page(owner, from, from, undefined, undefined, opts);
    return finish(from);
  };
  /** The business's wallet signs the setup page's transactions with the keys offered to `from`. */
  const onChain = (owner: string, from = NEWCOMER) => {
    const { agent, executor } = offered(from);
    chain.set(`getleash.${owner}`, { agent, executor });
  };
  return { dir, sent, hub, signup, businesses, chain, linkKey, say, update, page, finish, complete, onChain, last, offered, processed, activations: () => activations };
}

describe("someone new sets up their own GetLeash", () => {
  it("/start offers the setup page on a keyboard button, with two fresh public keys and a day to use it", async () => {
    const now = 1_800_000_000_000;
    const w = world({ now: () => now });
    expect(await w.say("/start")).toBe("signup:offered");
    const reply = w.last(NEWCOMER)!;
    expect(reply.text).toContain("Your wallet creates your own GetLeash");
    expect(reply.text).toContain("about 1.43 NEAR");
    expect(reply.text).toContain("up to 2.50 USDC a payment and 5.00 USDC a day");
    const first = w.offered();
    expect(first.button.text).toBe(SETUP_BUTTON);
    expect(first.url.origin + first.url.pathname).toBe("https://getleash.example/setup");
    expect(first.agent).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(first.executor).not.toBe(first.agent);
    expect(first.until).toBe(now + LINK_TTL_MS);
    // Whose setup it is, as the bot saw them: the page shows it and the wallet signs it.
    expect(first.for).toBe(String(NEWCOMER));
    expect(first.name).toBe(`@user${NEWCOMER}`);
    // All of it signed by the operator's agent key, with the bot the page sends the last step to.
    expect(first.bot).toBe("GetLeashBot");
    const link = { agent: first.agent, executor: first.executor, until: first.until, user: first.for, name: first.name, bot: first.bot };
    expect(await setupLinkSigned(link, first.sig, [w.linkKey.public_key])).toBe(true);
    expect(await setupLinkSigned({ ...link, name: "@victor" }, first.sig, [w.linkKey.public_key])).toBe(false);
    expect(await setupLinkSigned({ ...link, bot: "GetLeashSetupBot" }, first.sig, [w.linkKey.public_key])).toBe(false);
    expect(await setupLinkSigned(link, first.sig, [newKeyPair().public_key])).toBe(false);
    // A keyboard button (only that kind lets the page send its result back), kept until the setup is done.
    expect(reply.other?.reply_markup).toMatchObject({ resize_keyboard: true, is_persistent: true });

    await w.say("/start");
    expect(w.offered().agent).toBe(first.agent);
    expect(w.signup.open()).toBe(1);
  });

  it("the owner's signed claim, its finish code and the chain are checked; then the business is served and its keys are kept", async () => {
    const w = world();
    await w.say("/start");
    const { agent, executor } = w.offered();
    w.onChain("acme.tg");

    // The page's claim alone serves nothing: it waits for START, with the code, from the same account.
    expect(await w.page("acme.tg")).toBe("signup:claimed");
    expect(w.last(NEWCOMER)!.text).toContain("Last step: tap START");
    expect(w.businesses.list()).toEqual([]);
    expect(await w.finish()).toBe("signup:checking");
    const ready = w.last(NEWCOMER)!;
    expect(ready.text).toContain("✅ Your GetLeash is ready: getleash.acme.tg, owned by your wallet acme.tg.");
    expect(ready.text).toContain("Send USDC on NEAR to getleash.acme.tg");
    expect(ready.other?.reply_markup).toEqual({ remove_keyboard: true });

    const [business] = w.businesses.list();
    expect(business).toMatchObject({
      policy_id: "getleash.acme.tg",
      owner_id: "acme.tg",
      agent_id: "agent-1.acme.tg",
      executor_id: "executor-1.acme.tg",
      owner_user: String(NEWCOMER),
      owner_chat: String(NEWCOMER),
    });
    const secrets = w.businesses.secrets("getleash.acme.tg");
    expect(publicKeyOf(secrets.agent_private_key)).toBe(agent);
    expect(publicKeyOf(secrets.executor_private_key)).toBe(executor);
    expect(secrets.tenant_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.invoice_store_key).not.toBe(secrets.tenant_secret);
    expect(statSync(join(w.businesses.dir("getleash.acme.tg"), "secrets.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.dir, "hosted", "businesses.json")).mode & 0o777).toBe(0o600);
    // The open setup, and its copy of the keys, is gone.
    expect(w.signup.open()).toBe(0);
    expect(readFileSync(join(w.dir, "hosted", "signup.json"), "utf8")).not.toContain("ed25519:");
  });

  it("each business hears only from its own owner, and the operator's chat is unchanged", async () => {
    const w = world();
    await w.say("/start");
    w.onChain("acme.tg");
    await w.complete("acme.tg");

    expect(await w.say("/status")).toBe("command:status");
    expect(w.last(NEWCOMER)!.text).toContain("Treasury: 3.00 USDC");
    expect(await w.say("/status", OWNER)).toBe("command:status");
    expect(w.last(CHAT)!.text).toContain("Treasury: 9.00 USDC");
    expect(await w.say("Invoice INV-1 from Acme, 2.00 USD")).toBe("invoice:rejected_onchain");
    expect(w.processed.map((p) => p.split(":")[0])).toEqual(["getleash.acme.tg"]);
    // The new owner's /start is their own GetLeash's help now, not another setup.
    expect(await w.say("/start")).toBe("command:start");
    expect(w.last(NEWCOMER)!.text).toContain("Send me an invoice");
  });

  it("their dashboard links name their contract; the operator's don't", async () => {
    const w = world();
    await w.say("/start");
    w.onChain("acme.tg");
    await w.complete("acme.tg");
    await w.say("/pause");
    const markup = w.last(NEWCOMER)!.other?.reply_markup as { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> };
    expect(markup.inline_keyboard[0]![0]!.web_app!.url).toBe("https://getleash.example/pause?c=getleash.acme.tg");
    await w.say("/pause", OWNER);
    const home = w.last(CHAT)!.other?.reply_markup as { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> };
    expect(home.inline_keyboard[0]![0]!.web_app!.url).toBe("https://getleash.example/pause");
  });

  it("a hosted business has a number of invoices read a day; the operator's GetLeash has no such limit", async () => {
    const w = world({ invoicesPerDay: 1 });
    await w.say("/start");
    w.onChain("acme.tg");
    await w.complete("acme.tg");
    expect(await w.say("Invoice 1, 2.00 USD")).toBe("invoice:rejected_onchain");
    expect(await w.say("Invoice 2, 2.00 USD")).toBe("ignored:QUOTA");
    expect(w.last(NEWCOMER)!.text).toContain("as many as GetLeash reads for one business in a day");
    expect(await w.say("Invoice 3, 2.00 USD", OWNER)).toBe("invoice:rejected_onchain");
    expect(await w.say("Invoice 4, 2.00 USD", OWNER)).toBe("invoice:rejected_onchain");
  });
});

describe("invites across businesses", () => {
  async function hosted() {
    const w = world();
    await w.say("/start");
    w.onChain("acme.tg");
    await w.complete("acme.tg");
    await w.say("/invite Shenzhen Parts");
    const link = w.last(NEWCOMER)!.text.match(/https:\/\/t\.me\/GetLeashBot\?start=(join_[\w-]+)/)![1]!;
    return { w, link };
  }

  it("a supplier opening a hosted business's invite reaches that business; an unknown invite stays unanswered", async () => {
    const { w, link } = await hosted();
    expect(await w.say(`/start ${link}`, SUPPLIER)).toBe("invite:opened");
    expect(w.last(SUPPLIER)!.text).toContain("Hi Shenzhen Parts!");
    expect(await w.say("/start join_AAAAAAAAAAAAAAAAAAAAAA", OTHER)).toBe("not_allowed");
    expect(w.last(OTHER)).toBeUndefined();
  });

  it("someone with their own GetLeash can answer another business's invite, by replying to its question", async () => {
    const { w, link } = await hosted();
    // The operator opens Acme's invite: it goes to Acme's GetLeash, not "that's your own invite link".
    expect(await w.say(`/start ${link}`, OWNER)).toBe("invite:opened");
    const greeting = w.last(CHAT)!;
    expect(greeting.text).toContain("Hi Shenzhen Parts!");
    // Anything else the operator sends stays with their own GetLeash …
    expect(await w.say("/status", OWNER)).toBe("command:status");
    expect(w.last(CHAT)!.text).toContain("Treasury: 9.00 USDC");
    expect(await w.say("Invoice 9, 2.00 USD", OWNER)).toBe("invoice:rejected_onchain");
    // … and the reply to Acme's question goes to Acme's invite.
    const reply = { reply_to_message: { message_id: greeting.id, from: { id: 1, is_bot: true, first_name: "GetLeash" }, text: greeting.text } };
    expect(await w.say("ops.near", OWNER, reply)).toMatch(/^invite:/);
    expect(w.sent.some((m) => m.chatId === String(NEWCOMER) && m.text.includes("Shenzhen Parts answered your invite"))).toBe(true);
  });

  it("a supplier can answer a hosted business's invite with a photo and a caption", async () => {
    const { w, link } = await hosted();
    await w.say(`/start ${link}`, SUPPLIER);
    expect(await w.update(SUPPLIER, { caption: "parts.near", photo: [{ file_id: "p", file_unique_id: "p", width: 10, height: 10 }] })).toMatch(/^invite:/);
  });

  it("the setup page's message never goes to an invite the same person opened", async () => {
    const { w, link } = await hosted();
    await w.say(`/start ${link}`, SUPPLIER);
    await w.say("/start", SUPPLIER);
    w.onChain("supplier.near", SUPPLIER);
    expect(await w.page("supplier.near", SUPPLIER)).toBe("signup:claimed");
    expect(await w.finish(SUPPLIER)).toBe("signup:checking");
    expect(w.businesses.list().map((b) => b.owner_id)).toContain("supplier.near");
  });
});

describe("what the bot does not believe", () => {
  it("a forwarded setup link gives the sender nothing: the claim must be the owner's wallet's, for the sender", async () => {
    const w = world();
    // Mallory starts a setup and forwards her link to Victor, who signs the setup with his own wallet …
    await w.say("/start", OTHER);
    w.onChain("victor.near", OTHER);
    // … but Victor's wallet signs a claim only for Victor's own Telegram account, which Mallory can't use.
    expect(await w.page("victor.near", OTHER, NEWCOMER)).toBe("signup:bad_claim");
    expect(w.last(OTHER)!.text).toContain("That signature isn't victor.near's for this setup");
    expect(w.businesses.list()).toEqual([]);
  });

  it("a setup that isn't on the chain yet is checked for a while, and served once it is", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    expect(await w.complete("acme.tg")).toBe("signup:checking");
    expect(w.last(NEWCOMER)!.text).toBe("⏳ Checking getleash.acme.tg on NEAR…");
    now += 10_000;
    await w.hub.tick();
    expect(w.businesses.list()).toEqual([]);
    w.onChain("acme.tg");
    now += 10_000;
    await w.hub.tick();
    expect(w.businesses.list().map((b) => b.policy_id)).toEqual(["getleash.acme.tg"]);
  });

  it("gives up after CHECK_FOR_MS, says which checks failed, and keeps the setup open", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    await w.complete("acme.tg");
    now += CHECK_FOR_MS;
    await w.hub.tick();
    const reply = w.last(NEWCOMER)!.text;
    expect(reply).toContain("⚠️ getleash.acme.tg isn't set up the way GetLeash needs yet:");
    expect(reply).toContain("• not yet: getleash.acme.tg has no access keys");
    expect(w.signup.open()).toBe(1);
  });

  it("a link edited to show another account yields a claim that never matches the bot's record", async () => {
    const w = world();
    await w.say("/start", OTHER);
    w.onChain("victor.near", OTHER);
    // Mallory's lookalike shows Victor his own name; his wallet signs that, but the bot recorded @user6006.
    expect(await w.page("victor.near", OTHER, OTHER, undefined, `@user${NEWCOMER}`)).toBe("signup:bad_claim");
    expect(w.businesses.list()).toEqual([]);
  });

  it("someone else's GetLeash does not count: the keys on the chain must be the ones generated for this person", async () => {
    const w = world();
    await w.say("/start");
    w.chain.set("getleash.owner.near", { agent: "ed25519:other", executor: "ed25519:keys" });
    await w.complete("owner.near");
    expect(w.businesses.list()).toEqual([]);
  });

  it("refuses data that isn't a claim for an account GetLeash can live under, and throttles claims honestly", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    expect(await w.update(NEWCOMER, { web_app_data: { data: "not json", button_text: SETUP_BUTTON } })).toBe("signup:bad_claim");
    expect(await w.page("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")).toBe("signup:bad_claim");
    // A wrong signature, then a right one a moment later: no check is running, so it doesn't say "checking".
    expect(await w.page("acme.tg", NEWCOMER, OTHER)).toBe("signup:bad_claim");
    expect(await w.page("acme.tg")).toBe("signup:busy");
    expect(w.last(NEWCOMER)!.text).toBe("Wait a few seconds, then tap Finish again.");
    now += 5_000;
    const code = newFinishCode();
    expect(await w.page("acme.tg", NEWCOMER, NEWCOMER, undefined, undefined, { code })).toBe("signup:claimed");
    expect(await w.finish(NEWCOMER, code)).toBe("signup:checking");
    // While that check runs (or waits for the next tick), another claim or START hears so.
    expect(await w.page("acme.tg")).toBe("signup:busy");
    expect(w.last(NEWCOMER)!.text).toContain("Still checking");
    expect(await w.finish(NEWCOMER, code)).toBe("signup:busy");
  });

  it("serves a business once, even when claims and the periodic check overlap", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    await w.complete("acme.tg");
    w.onChain("acme.tg");
    now += 10_000;
    await Promise.all([w.hub.tick(), w.hub.tick(), w.finish()]);
    now += 10_000;
    await w.hub.tick();
    expect(w.activations()).toBe(1);
    expect(w.sent.filter((m) => m.text.startsWith("✅ Your GetLeash is ready")).length).toBe(1);
  });

  it("answers strangers only about setting up; the operator's users never get the offer", async () => {
    const w = world();
    expect(await w.say("hello")).toBe("ignored:NOT_ALLOWED");
    expect(w.last(NEWCOMER)).toBeUndefined();
    expect(await w.page("acme.tg", NEWCOMER, NEWCOMER, "ed25519:none")).toBe("signup:none");
    expect(await w.say("/start", OWNER)).toBe("command:start");
    expect(w.last(CHAT)!.text).not.toContain(SETUP_BUTTON);
    // Someone in the middle of a setup gets a reminder instead of silence.
    await w.say("/start");
    expect(await w.say("hello")).toBe("signup:reminded");
    expect(w.last(NEWCOMER)!.text).toContain(SETUP_BUTTON);
  });

  it("stops offering setups when the service is full", async () => {
    const w = world({ max: 0 });
    expect(await w.say("/start")).toBe("signup:full");
    expect(w.last(NEWCOMER)!.text).toContain("isn't taking new businesses");
    expect(w.signup.open()).toBe(0);
  });
});

describe("the last step happens in this bot's chat, from the setup's own account", () => {
  it("START may come before the page's claim: whichever is second completes it", async () => {
    const w = world();
    await w.say("/start");
    w.onChain("acme.tg");
    const code = newFinishCode();
    expect(await w.finish(NEWCOMER, code)).toBe("signup:finishing");
    expect(w.businesses.list()).toEqual([]);
    expect(await w.page("acme.tg", NEWCOMER, NEWCOMER, undefined, undefined, { code })).toBe("signup:checking");
    expect(w.businesses.list().map((b) => b.owner_user)).toEqual([String(NEWCOMER)]);
  });

  it("a lookalike bot gets nothing: the claim it relays never meets the code, which the victim's own Telegram sends here", async () => {
    const w = world();
    // Mallory starts a setup here, and her lookalike bot opens the real page for Victor with her link.
    await w.say("/start", OTHER);
    const mallory = w.offered(OTHER);
    // Victor doesn't notice whose setup the page says it is: his wallet pays, with Mallory's keys …
    w.onChain("victor.near", OTHER);
    const code = newFinishCode(); // made by the page on Victor's phone
    // … and signs the claim, which goes to the bot that opened the page: Mallory's. She relays it here.
    expect(await w.page("victor.near", OTHER, OTHER, mallory.agent, `@user${OTHER}`, { code })).toBe("signup:claimed");
    // The page sends the code to this bot's chat from Victor's own Telegram, so it comes from Victor: refused.
    expect(await w.finish(NEWCOMER, code)).toBe("signup:not_yours");
    expect(w.last(NEWCOMER)!.text).toContain(`That setup was started by another Telegram account (@user${OTHER})`);
    expect(w.businesses.list()).toEqual([]);
    // Mallory never sees the code; any code she makes up is just one more code.
    expect(await w.finish(OTHER, newFinishCode())).toBe("signup:finishing");
    expect(w.businesses.list()).toEqual([]);
  });

  it("in the other order too: a code that came first is told whose it is once the claim shows up from that account", async () => {
    const w = world();
    await w.say("/start", OTHER);
    const mallory = w.offered(OTHER);
    await w.say("/start"); // Victor happens to have a setup of his own open
    w.onChain("victor.near", OTHER);
    const code = newFinishCode();
    expect(await w.finish(NEWCOMER, code)).toBe("signup:finishing");
    expect(await w.page("victor.near", OTHER, OTHER, mallory.agent, `@user${OTHER}`, { code })).toBe("signup:claimed");
    expect(w.last(NEWCOMER)!.text).toContain("That setup was started by another Telegram account");
    expect(w.businesses.list()).toEqual([]);
  });

  it("a code whose claim never comes is let go after a minute; broken and unknown codes are answered", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    expect(await w.finish(NEWCOMER, newFinishCode())).toBe("signup:finishing");
    now += FINISH_WAIT_MS;
    await w.hub.tick();
    expect(w.last(NEWCOMER)!.text).toContain("I didn't get the setup page's part");
    expect(await w.say(`/start ${FINISH_PREFIX}short`)).toBe("signup:bad_code");
    expect(await w.finish(SUPPLIER, newFinishCode())).toBe("signup:unknown_code");
    expect(w.businesses.list()).toEqual([]);
  });
});

describe("the owner's wallet can always move its GetLeash to another Telegram account", () => {
  it("one served here moves: the account it leaves is told and no longer served; its keys and files stay", async () => {
    const w = world();
    await w.say("/start");
    const { agent } = w.offered();
    w.onChain("acme.tg");
    await w.complete("acme.tg");
    // A new phone number: the owner starts again from another account and connects their GetLeash with their wallet.
    await w.say("/start", OTHER);
    expect(await w.page("acme.tg", OTHER, OTHER, undefined, undefined, { kind: "connect" })).toBe("signup:claimed");
    expect(await w.finish(OTHER)).toBe("signup:moved");
    expect(w.last(NEWCOMER)!.text).toContain("Your GetLeash getleash.acme.tg now answers another Telegram account: its owner's wallet, acme.tg, moved it there.");
    expect(w.last(OTHER)).toMatchObject({ text: expect.stringContaining("✅ getleash.acme.tg answers to you now"), other: { reply_markup: { remove_keyboard: true } } });
    expect(w.businesses.list()).toHaveLength(1);
    expect(w.businesses.list()[0]).toMatchObject({ policy_id: "getleash.acme.tg", owner_user: String(OTHER), owner_chat: String(OTHER) });
    expect(publicKeyOf(w.businesses.secrets("getleash.acme.tg").agent_private_key)).toBe(agent);
    expect(await w.say("/status", OTHER)).toBe("command:status");
    expect(w.last(OTHER)!.text).toContain("Treasury: 3.00 USDC");
    expect(await w.say("/status")).toBe("not_allowed");
    expect(w.signup.open()).toBe(0);
  });

  it("an open setup is never taken by connecting: copying its public keys onto your own accounts gets you nothing", async () => {
    const w = world();
    // Victor is setting up: his first transactions put his setup's public keys on-chain, for anyone to read.
    await w.say("/start");
    const victor = w.offered();
    // Mallory puts those same public keys on accounts of her own and asks to connect her contract.
    w.chain.set("getleash.mallory.near", { agent: victor.agent, executor: victor.executor });
    await w.say("/start", OTHER);
    expect(await w.complete("mallory.near", OTHER, { kind: "connect" })).toBe("signup:not_here");
    expect(w.last(OTHER)!.text).toContain("GetLeash doesn't serve getleash.mallory.near");
    // Victor's setup is untouched and finishes as usual.
    w.onChain("victor.near");
    expect(await w.complete("victor.near")).toBe("signup:checking");
    expect(w.businesses.list()).toEqual([expect.objectContaining({ policy_id: "getleash.victor.near", owner_user: String(NEWCOMER) })]);
    expect(publicKeyOf(w.businesses.secrets("getleash.victor.near").agent_private_key)).toBe(victor.agent);
  });

  it("nothing this service doesn't serve", async () => {
    const w = world();
    await w.say("/start");
    w.chain.set("getleash.self.near", { agent: "ed25519:theirs", executor: "ed25519:own" });
    expect(await w.complete("self.near", NEWCOMER, { kind: "connect" })).toBe("signup:not_here");
    expect(w.last(NEWCOMER)!.text).toContain("GetLeash doesn't serve getleash.self.near");
    expect(w.businesses.list()).toEqual([]);
  });

  it("after a move, the business's supplier invites report to its new chat, not the one they were made in", async () => {
    const w = world();
    await w.say("/start");
    w.onChain("acme.tg");
    await w.complete("acme.tg");
    await w.say("/invite Shenzhen Parts");
    const link = w.last(NEWCOMER)!.text.match(/https:\/\/t\.me\/GetLeashBot\?start=(join_[\w-]+)/)![1]!;
    await w.say("/start", OTHER);
    await w.complete("acme.tg", OTHER, { kind: "connect" });
    const before = w.sent.filter((m) => m.chatId === String(NEWCOMER)).length;
    expect(await w.say(`/start ${link}`, SUPPLIER)).toBe("invite:opened");
    expect(await w.say("parts.near", SUPPLIER)).toMatch(/^invite:/);
    expect(w.sent.some((m) => m.chatId === String(OTHER) && m.text.includes("Shenzhen Parts answered your invite"))).toBe(true);
    expect(w.sent.filter((m) => m.chatId === String(NEWCOMER)).length).toBe(before);
  });
});

describe("names in setup links", () => {
  it("are @username when there is one; else the name in quotes, which can't pass for a username or a user id", () => {
    expect(displayName({ id: 6006, is_bot: false, first_name: "Mallory", username: "mallory_m" })).toBe("@mallory_m");
    expect(displayName({ id: 6006, is_bot: false, first_name: "@victor (user 4004)" })).toBe("“victor user 4004”");
    expect(displayName({ id: 6006, is_bot: false, first_name: "＠victor", last_name: "（user 4004）\u202e" })).toBe("“victor user 4004”");
    expect(displayName({ id: 6006, is_bot: false, first_name: "Ada", last_name: "Lovelace" })).toBe("“Ada Lovelace”");
    expect(displayName({ id: 6006, is_bot: false, first_name: "@()" })).toBe("user 6006");
  });
});

describe("open setups and businesses on disk", () => {
  it("keep their keys (mode 0600) across restarts; a day after the link expired, the keys and the button go", async () => {
    let now = 1_800_000_000_000;
    const first = world({ now: () => now });
    await first.say("/start");
    const keys = first.offered();
    const path = join(first.dir, "hosted", "signup.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(keys.agent);

    const again = world({ now: () => now, dir: first.dir });
    await again.say("/start");
    expect(again.offered().agent).toBe(keys.agent);

    now += LINK_TTL_MS + KEEP_AFTER_LINK_MS;
    await again.hub.tick();
    expect(readFileSync(path, "utf8")).not.toContain(keys.agent);
    expect(again.last(NEWCOMER)).toMatchObject({ text: "Your GetLeash setup link expired. Send /start for a new one.", other: { reply_markup: { remove_keyboard: true } } });
    await again.say("/start");
    expect(again.offered().agent).not.toBe(keys.agent);
  });

  it("an expired link is still announced when other setups were saved before the tick", async () => {
    let now = 1_800_000_000_000;
    const w = world({ now: () => now });
    await w.say("/start");
    now += LINK_TTL_MS + KEEP_AFTER_LINK_MS;
    await w.say("/start", OTHER); // saves the open setups before the tick runs
    await w.hub.tick();
    expect(w.last(NEWCOMER)).toMatchObject({ text: "Your GetLeash setup link expired. Send /start for a new one." });
    expect(w.signup.open()).toBe(1);
  });

  it("a business is added once, and its secrets are never replaced", () => {
    const businesses = new HostedBusinesses(join(mkdtempSync(join(tmpdir(), "getleash-hosted-")), "hosted"));
    const business = {
      policy_id: "getleash.acme.tg",
      owner_id: "acme.tg",
      agent_id: "agent-1.acme.tg",
      executor_id: "executor-1.acme.tg",
      owner_user: "4004",
      owner_chat: "4004",
      created_at: "2026-11-03T00:00:00.000Z",
    };
    const secrets = { agent_private_key: "ed25519:agent", executor_private_key: "ed25519:executor", tenant_secret: "11".repeat(32), invoice_store_key: "22".repeat(32) };
    businesses.add(business, secrets);
    businesses.add(business, secrets);
    expect(businesses.list()).toHaveLength(1);
    expect(() => businesses.add(business, { ...secrets, agent_private_key: "ed25519:other", tenant_secret: "33".repeat(32) })).toThrow("already set up with other keys");
    expect(businesses.secrets("getleash.acme.tg").tenant_secret).toBe("11".repeat(32));
    expect(() => businesses.dir("../../etc")).toThrow("not a NEAR account id");
    // Moving it changes only whom it answers.
    expect(businesses.move("getleash.acme.tg", { owner_user: "6006", owner_chat: "6006" })).toMatchObject({ owner_user: "6006", owner_chat: "6006", owner_id: "acme.tg" });
    expect(businesses.list()).toEqual([{ ...business, owner_user: "6006", owner_chat: "6006" }]);
    expect(businesses.secrets("getleash.acme.tg").agent_private_key).toBe("ed25519:agent");
    expect(() => businesses.move("getleash.other.tg", { owner_user: "1", owner_chat: "1" })).toThrow("not hosted here");
  });
});
