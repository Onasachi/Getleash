/**
 * Adding suppliers from Telegram (onboarding.ts, docs/decisions.md D-29): the owner's /addsupplier and
 * /invite, a supplier answering an invite, and the bot saving the name once the owner's wallet has
 * added the supplier on the dashboard's page. The chain is faked; nothing here can add a supplier.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import type { InvoiceAgent } from "@getleash/agent";
import { UpdateLog } from "@getleash/ingestion";
import { type Directory, mergeDirectories, type PolicyView, type Supplier, USDT_TRON_ASSET } from "@getleash/shared";
import { loadDirectory } from "@getleash/shared/node";

import { ADD_QUESTION, parseIdList, TelegramChannel } from "../src/bot.ts";
import { INVITE_TRIES, INVITE_TTL_MS, SupplierOnboarding } from "../src/onboarding.ts";

const OWNER = 1001;
const CHAT = 2002;
const SUPPLIER = 3003;
const TRON = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TOKEN = "usdc.near";

type Sent = { chatId: string; text: string; other?: Record<string, unknown> | undefined };

function world(opts: { accounts?: string[]; suppliers?: Supplier[]; directory?: Directory; now?: () => number; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "getleash-onboarding-"));
  const directoryPath = join(dir, "directory.json");
  const statePath = join(dir, "supplier-onboarding.json");
  const fromVariable = opts.directory ?? { suppliers: [] };
  const directory = () => mergeDirectories(fromVariable, loadDirectory(directoryPath));
  const suppliers: Supplier[] = [...(opts.suppliers ?? [])];
  const accounts = new Set(opts.accounts ?? []);
  let reads = 0;
  const state = {
    owner_id: "owner.near",
    agent_id: "agent-1.owner.near",
    executor_id: "executor-1.owner.near",
    token_id: TOKEN,
    token_decimals: 6,
    paused: false,
    policy: { cooldown_ns: String(2n * 86_400n * 10n ** 9n), cooldown_max: "500000" },
  };
  const view = {
    contractId: "getleash.owner.near",
    state: async () => {
      reads++;
      return state;
    },
    suppliers: async () => [...suppliers],
    recentIntents: async () => [],
    provider: {
      viewAccount: async ({ accountId }: { accountId: string }) => {
        if (!accounts.has(accountId)) throw new Error(`Account ${accountId} does not exist at block height 1`);
        return {};
      },
    },
  } as unknown as PolicyView;
  /** What the owner's wallet does on the dashboard's page: add_supplier, with the cooldown starting now. */
  const addOnChain = (recipient: string, chain: "NEAR" | "TRON" = "NEAR") =>
    suppliers.push({
      id: suppliers.length + 1,
      chain,
      asset_id: chain === "NEAR" ? `nep141:${TOKEN}` : USDT_TRON_ASSET,
      recipient,
      decimals: 6,
      active: true,
      revision: 1,
      changed_at: String(BigInt(Date.now()) * 1_000_000n),
    });
  const onboarding = new SupplierOnboarding({ statePath, directoryPath, directory, view, now: opts.now });
  const sent: Sent[] = [];
  const channel = new TelegramChannel({
    api: {
      sendMessage: async (chatId, text, other) => {
        sent.push({ chatId: String(chatId), text, other });
        return {};
      },
      getFile: async () => ({}),
      getMe: async () => ({ username: "GetLeashBot" }),
    },
    updateLog: new UpdateLog(null),
    allowedUsers: parseIdList(String(OWNER)),
    allowedChats: parseIdList(String(CHAT)),
    download: async () => new Uint8Array(),
    agent: { process: async () => Promise.reject(new Error("no invoices in these tests")) } as unknown as InvoiceAgent,
    view,
    directory,
    dashboardUrl: "https://getleash.example",
    onboarding,
  });
  let updateId = 900;
  const say = (text: string, from: { id: number; username?: string } = { id: OWNER }, chat = from.id === OWNER ? CHAT : from.id, extra: Record<string, unknown> = {}) =>
    channel.handle({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 1_793_600_000,
        chat: { id: chat, type: "private", first_name: "Someone" },
        from: { id: from.id, is_bot: false, first_name: "Someone", ...(from.username ? { username: from.username } : {}) },
        text,
        ...extra,
      },
    } as unknown as Update);
  const last = (chat: number | string = CHAT) => sent.filter((m) => m.chatId === String(chat)).at(-1);
  return { dir, directoryPath, statePath, onboarding, channel, sent, say, last, addOnChain, accounts, reads: () => reads };
}

const button = (m: Sent | undefined) => (m?.other?.reply_markup as { inline_keyboard?: Array<Array<{ text: string; web_app?: { url: string }; url?: string }>> } | undefined)?.inline_keyboard?.[0]?.[0];

describe("adding a supplier (/addsupplier)", () => {
  it("checks the account and offers the page where the owner's wallet adds them; nothing is added yet", async () => {
    const w = world({ accounts: ["acme.near"] });
    expect(await w.say("/addsupplier Acme Packaging acme.near")).toBe("command:addsupplier");
    expect(w.last()!.text).toContain("➕ Add Acme Packaging, paid in USDC at acme.near?");
    expect(w.last()!.text).toContain("every payment to them waits for your OK for the first 2 days, up to 0.50 USDC each");
    expect(button(w.last())).toEqual({ text: "Add Acme Packaging", web_app: { url: "https://getleash.example/suppliers/new?to=acme.near" } });
    expect(w.onboarding.requests().map((r) => [r.name, r.recipient])).toEqual([["Acme Packaging", "acme.near"]]);
    expect(loadDirectory(w.directoryPath).suppliers).toEqual([]);
  });

  it("asks when sent alone, and the reply to its question carries the details", async () => {
    const w = world({ accounts: ["chisolu.near"] });
    await w.say("/addsupplier");
    const question = w.last()!;
    expect(question.text.startsWith(ADD_QUESTION)).toBe(true);
    expect(question.other?.reply_markup).toMatchObject({ force_reply: true });
    const reply = { reply_to_message: { message_id: 1, date: 0, chat: { id: CHAT, type: "private" }, from: { id: 42, is_bot: true, first_name: "GetLeash" }, text: question.text } };
    // Phones capitalise the first letter of each line; NEAR accounts are lowercase.
    expect(await w.say("Chisolu\nChisolu.near", { id: OWNER }, CHAT, reply)).toBe("supplier:details");
    expect(w.last()!.text).toContain("➕ Add Chisolu, paid in USDC at chisolu.near?");
  });

  it("refuses what can't be a supplier, in plain words, and keeps no request", async () => {
    const w = world({ accounts: ["acme.near"] });
    const answer = async (text: string) => {
      await w.say(text);
      return w.last()!.text;
    };
    expect(await answer("/addsupplier Ghost ghost.near")).toContain("There is no NEAR account called ghost.near");
    expect(await answer("/addsupplier Me owner.near")).toContain("one of this GetLeash's own accounts");
    expect(await answer("/addsupplier Token TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toContain("the USDT token itself");
    expect(await answer("/addsupplier Acme 0x52908400098527886E0F7030069857D2E4169EE7")).toContain("Ethereum-style address");
    expect(await answer("/addsupplier acme.near")).toContain("Send their name too");
    expect(await answer("/addsupplier Acme a.near b.near")).toContain("more than one address");
    expect(w.onboarding.requests()).toEqual([]);
  });

  it("an address already on the list: a name on file is kept; without one, the name is saved, with no signature", async () => {
    const named = world({ accounts: ["acme.near"], directory: { suppliers: [{ supplier_id: 1, name: "Acme", aliases: [], payment_details: ["acme.near"], currency: "USD" }] } });
    named.addOnChain("acme.near");
    await named.say("/addsupplier Acme Two acme.near");
    expect(named.last()!.text).toBe("acme.near is already on your list as Acme (supplier #1).");

    const unnamed = world({ accounts: ["shop.near"] });
    unnamed.addOnChain("shop.near");
    await unnamed.say("/addsupplier Corner Shop shop.near");
    expect(unnamed.last()!.text).toBe("✅ shop.near was already on your list as supplier #1. I've saved its name: Corner Shop.");
    expect(loadDirectory(unnamed.directoryPath).suppliers).toEqual([
      { supplier_id: 1, name: "Corner Shop", aliases: [], payment_details: ["shop.near"], currency: "USDC" },
    ]);
  });

  it("once the owner's wallet has added the supplier, the bot saves the name and tells the owner when the cooldown ends", async () => {
    const w = world({ accounts: ["acme.near"] });
    await w.say("/addsupplier Acme acme.near");
    await w.channel.tick();
    expect(w.sent).toHaveLength(1); // not on-chain yet: nothing to say
    w.addOnChain("acme.near");
    await w.channel.tick();
    expect(w.last()!.text).toMatch(/^✅ Acme is on your list now \(supplier #1\), paid in USDC at acme\.near\. Until \w{3} \d{1,2} \w{3}, \d\d:\d\d UTC, every payment to them waits for your OK, up to 0\.50 USDC each\.$/);
    expect(loadDirectory(w.directoryPath).suppliers).toEqual([{ supplier_id: 1, name: "Acme", aliases: [], payment_details: ["acme.near"], currency: "USDC" }]);
    expect(statSync(w.directoryPath).mode & 0o777).toBe(0o600);
    expect(w.onboarding.requests()).toEqual([]);
    // Nothing left to look for: no more chain reads.
    const reads = w.reads();
    await w.channel.tick();
    expect(w.reads()).toBe(reads);
  });

  it("announces an added supplier once, even when a slow look at the chain overlaps the next tick", async () => {
    const w = world({ accounts: ["acme.near"] });
    await w.say("/addsupplier Acme acme.near");
    w.addOnChain("acme.near");
    await Promise.all([w.channel.tick(), w.channel.tick()]);
    expect(w.sent.filter((m) => m.text.startsWith("✅ Acme is on your list now"))).toHaveLength(1);
  });

  it("a file sent as a reply to the question is an invoice, not supplier details", async () => {
    const w = world();
    await w.say("/addsupplier");
    const reply = { reply_to_message: { message_id: 1, date: 0, chat: { id: CHAT, type: "private" }, from: { id: 42, is_bot: true, first_name: "GetLeash" }, text: w.last()!.text } };
    // It goes to the agent (which these tests fake to refuse every invoice).
    const handled = w.channel.handle({
      update_id: 1,
      message: { message_id: 1, date: 1_793_600_000, chat: { id: CHAT, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, caption: "acme.near", photo: [], ...reply },
    } as unknown as Update);
    await expect(handled).rejects.toThrow("no invoices in these tests");
  });

  it("a name another supplier already goes by gets the new supplier's number, so invoices stay unambiguous", async () => {
    const w = world({ accounts: ["acme2.near"], directory: { suppliers: [{ supplier_id: 1, name: "Acme Ltd", aliases: [], payment_details: ["acme.near"], currency: "USD" }] } });
    w.addOnChain("acme.near");
    await w.say("/addsupplier Acme acme2.near");
    w.addOnChain("acme2.near");
    await w.channel.tick();
    expect(w.last()!.text).toContain("✅ Acme #2 is on your list now (supplier #2)");
  });
});

describe("inviting a supplier (/invite)", () => {
  async function invited(w: ReturnType<typeof world>, name = "") {
    await w.say(`/invite ${name}`.trim());
    const token = w.last()!.text.match(/start=join_([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();
    return token!;
  }

  it("the supplier's own answer reaches the owner with the Add button, and both hear when it is added", async () => {
    const w = world();
    const token = await invited(w, "Shenzhen Parts");
    expect(w.last()!.text).toContain("📨 Send this invite to Shenzhen Parts through a chat or email you already use with them.");
    expect(button(w.last())!.url).toMatch(/^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2FGetLeashBot%3Fstart%3Djoin_/);

    const supplier = { id: SUPPLIER, username: "shenzhen_parts" };
    expect(await w.say(`/start join_${token}`, supplier)).toBe("invite:opened");
    const greeting = w.last(SUPPLIER)!;
    expect(greeting.text).toContain("👋 Hi Shenzhen Parts! A business you work with pays its suppliers through GetLeash");
    expect(greeting.text).toContain("Reply with where you want to be paid:");
    expect(greeting.text).not.toContain("owner.near"); // nothing about the business
    expect(greeting.other?.reply_markup).toMatchObject({ force_reply: true });

    expect(await w.say(TRON, supplier)).toBe("invite:answered");
    expect(w.last(SUPPLIER)!.text).toBe(`✅ Thanks! I've passed it on: paid in USDT on Tron at ${TRON}. I'll tell you here once they've added you.`);
    expect(w.last()!.text).toContain(`📨 Shenzhen Parts answered your invite (@shenzhen_parts). Add them, paid in USDT on Tron at ${TRON}? Make sure that's who you sent the invite to.`);
    expect(button(w.last())).toEqual({ text: "Add Shenzhen Parts", web_app: { url: `https://getleash.example/suppliers/new?to=${TRON}` } });

    w.addOnChain(TRON, "TRON");
    await w.channel.tick();
    expect(w.last()!.text).toContain(`✅ Shenzhen Parts is on your list now (supplier #1), paid in USDT on Tron at ${TRON}.`);
    expect(w.last(SUPPLIER)!.text).toBe(`✅ You've been added. Payments to you arrive in USDT on Tron at ${TRON}.`);
    expect(loadDirectory(w.directoryPath).suppliers[0]).toMatchObject({ supplier_id: 1, name: "Shenzhen Parts", currency: "USDT" });
  });

  it("without a name on the invite, the supplier sends its own; it is checked like the owner's", async () => {
    const w = world({ accounts: ["chisolu.near"] });
    const token = await invited(w);
    await w.say(`/start join_${token}`, { id: SUPPLIER });
    expect(w.last(SUPPLIER)!.text).toContain("Reply with your business name and where you want to be paid, on two lines:");
    expect(await w.say("chisolu.near", { id: SUPPLIER })).toBe("invite:retry");
    expect(w.last(SUPPLIER)!.text).toBe("Send your name too: the name on the first line, the address on the second. (4 tries left)");
    expect(await w.say("Chisolu Enterprises\nchisolu.near", { id: SUPPLIER })).toBe("invite:answered");
    expect(w.last()!.text).toContain("📨 Chisolu Enterprises answered your invite (Someone).");
  });

  it("works once, for the first person who opens it, for 7 days; strangers get no answer at all", async () => {
    let now = Date.now();
    const w = world({ now: () => now });
    const token = await invited(w);
    await w.say(`/start join_${token}`, { id: SUPPLIER });
    const before = w.sent.length;
    expect(await w.say(`/start join_${token}`, { id: 4004 })).toBe("not_allowed"); // someone else with the same link
    expect(await w.say("/start join_AAAAAAAAAAAAAAAAAAAAAA", { id: 5005 })).toBe("not_allowed");
    expect(await w.say("hello", { id: 5005 })).toBe("ignored:NOT_ALLOWED");
    expect(w.sent.length).toBe(before);

    const late = await invited(w);
    now += INVITE_TTL_MS + 1;
    expect(await w.say(`/start join_${late}`, { id: 6006 })).toBe("not_allowed");
  });

  it(`closes after ${INVITE_TRIES} answers it could not use`, async () => {
    const w = world();
    const token = await invited(w, "Acme");
    await w.say(`/start join_${token}`, { id: SUPPLIER });
    for (let i = 1; i < INVITE_TRIES; i++) expect(await w.say("my wallet is on binance", { id: SUPPLIER })).toBe("invite:retry");
    await w.say("still no address", { id: SUPPLIER });
    expect(w.last(SUPPLIER)!.text).toContain("This invite is closed now: ask them for a new one.");
    expect(await w.say("acme.near", { id: SUPPLIER })).toBe("ignored:NOT_ALLOWED");
  });

  it("tells the owner who opens their own invite to send it on", async () => {
    const w = world();
    const token = await invited(w);
    await w.say(`/start join_${token}`);
    expect(w.last()!.text).toContain("That's your own invite link: send it to your supplier");
  });

  it("open requests and invites survive a restart; the file keeps a hash of each token, not the token", async () => {
    const w = world({ accounts: ["acme.near"] });
    const token = await invited(w, "Acme");
    await w.say("/addsupplier Acme acme.near");
    const file = readFileSync(w.statePath, "utf8");
    expect(file).not.toContain(token);
    expect(statSync(w.statePath).mode & 0o777).toBe(0o600);

    const again = world({ accounts: ["acme.near"], dir: w.dir });
    expect(again.onboarding.requests().map((r) => r.recipient)).toEqual(["acme.near"]);
    expect(await again.say(`/start join_${token}`, { id: SUPPLIER })).toBe("invite:opened");
  });
});

describe("looking for added suppliers", () => {
  it("looks at every tick for 15 minutes after a request, then at every sixth", () => {
    let now = 0;
    const onboarding = new SupplierOnboarding({ statePath: null, directoryPath: "/nonexistent/directory.json", directory: () => ({ suppliers: [] }), view: {} as PolicyView, now: () => now });
    expect(onboarding.due(1)).toBe(false);
    onboarding.request({ name: "Acme", chain: "NEAR", recipient: "acme.near", owner_chat: String(CHAT) });
    expect(onboarding.due(1)).toBe(true);
    now += 16 * 60_000;
    expect(onboarding.due(1)).toBe(false);
    expect(onboarding.due(6)).toBe(true);
  });
});
