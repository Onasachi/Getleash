/**
 * Setting up GetLeash for another business, from Telegram (docs/decisions.md D-30).
 *
 * Someone who does not use this bot yet sends /start. The bot says what GetLeash does and what it costs,
 * and shows a "Set up GetLeash" button under the message box: a Telegram keyboard button that opens the
 * dashboard's /setup page inside Telegram. Its link carries the public halves of two keys the bot
 * generated for this person (the agent's and the executor's), when it expires (a day), the Telegram
 * account it is for as the bot saw it here, and the bot's username, all signed by the bot with the
 * operator's agent key; the page checks that signature against the chain and refuses any other link. On
 * that page their own wallet creates their GetLeash: the contract (the published release, no access keys,
 * owned by their wallet), the agent and executor accounts holding only those two keys, and the contract's
 * USDC registration.
 *
 * The setup becomes theirs only when two things reach the bot from the Telegram account it is for: the
 * claim their wallet signed (NEP-413: the contract, the link's key, that Telegram account), which the page
 * sends as Telegram's `web_app_data` (a message from that user to the bot that opened the page), and a
 * finish code the page made, whose SHA-256 is the claim's nonce. The page sends the code by opening this
 * bot's chat itself (`t.me/<bot>?start=finish_<code>`, the bot named in the signed link), where Telegram
 * sends START (Android, the chat being the one under the page) or the user taps it. A fake bot that opens
 * the real page with its own owner's setup link receives the claim but never the code: the victim's own
 * Telegram delivers the code to this bot, from the victim's account, and the bot refuses it.
 *
 * The bot believes none of it until it has checked: the claim's signature, by a full-access key of that
 * account (checkSetupClaim); then, from chain state alone, that the contract has no keys, runs the release,
 * names that account as its owner and the two role accounts, that each role account holds only the key
 * generated here, and that the contract is registered on the token (checkHostedSetup). Only then does the
 * business get its own channel, agent and executor.
 *
 * The same page, opened by someone whose wallet already owns a GetLeash this service serves, connects it
 * to their Telegram account instead (a "connect" claim): the owner's wallet can always move its GetLeash
 * to another account (a new phone, a lost account, or one that a copy of the page tricked it into naming),
 * and the account it leaves is told. Open setups, their keys and the business's two secrets (made
 * once, here) stay in the service's data directory (mode 0600), at most a day after the link expired.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { Update } from "grammy/types";
import { z } from "zod";

import type { Notice } from "@getleash/channel-core";
import type { UpdateLog } from "@getleash/ingestion";
import {
  canHost,
  type Check,
  checkHostedSetup,
  checkSetupClaim,
  dashboardLink,
  DEFAULT_POLICY,
  durationText,
  FINISH_PREFIX,
  finishNonce,
  hostedIds,
  money,
  nearRoundedUp,
  parseFinishCode,
  type Policy,
  type PolicyView,
  SetupClaim,
  type SetupLink,
  type SetupTarget,
  setupCost,
  setupNeeds,
} from "@getleash/shared";
import { type BusinessSecrets, type HostedBusiness, newKeyPair, writePrivateJson } from "@getleash/shared/node";

import type { BotApi } from "./bot.ts";

type Message = NonNullable<Update["message"]>;
type ClaimExpected = { agentPublicKey: string; telegramUser: string; telegramName: string };

const HOUR_MS = 3_600_000;
/** How long a setup link works; asking /start again renews it, with the same keys. */
export const LINK_TTL_MS = 24 * HOUR_MS;
/** How long the bot keeps a setup's keys after its link expired: a wallet may have signed just before. */
export const KEEP_AFTER_LINK_MS = 24 * HOUR_MS;
/** After a claim, the bot looks for the setup on-chain this long: blocks take a moment to reach every RPC. */
export const CHECK_FOR_MS = 3 * 60_000;
/** At most one look on-chain per setup this often, whoever asks. */
export const CHECK_EVERY_MS = 10_000;
/** At most one claim checked per person this often. */
export const CLAIM_EVERY_MS = 5_000;
/** How long a finish code waits for its claim: Telegram delivers the page's message just after the code, or just before it. */
export const FINISH_WAIT_MS = 60_000;
/** Open setups at once: each keeps two keys on disk until it is finished or dropped. */
export const MAX_OPEN_SETUPS = 1000;
/** The keyboard button's text (Telegram sends it back with the page's data, as `button_text`). Only a keyboard button lets the page send its claim back. */
export const SETUP_BUTTON = "Set up GetLeash";

const KeyPairJson = z.object({ public_key: z.string().startsWith("ed25519:"), private_key: z.string().startsWith("ed25519:") });
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

const PendingSetup = z.object({
  user: z.string(),
  /** How Telegram showed this user at /start ("@acme" or a name): the page shows it, the claim names it. */
  name: z.string().min(1).max(140),
  chat: z.string(),
  agent: KeyPairJson,
  executor: KeyPairJson,
  /** The business's off-chain secrets, made once with the setup: activating twice can never change them. */
  tenant_secret: z.string().regex(/^[0-9a-f]{64}$/),
  invoice_store_key: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.number().int(),
  /** When the setup link stops working (the page refuses it after that). */
  until: z.number().int(),
  /** The owner's signed claim, from this user's own chat. It counts once a finish code from the same user matches its nonce. */
  claim: z.object({ kind: z.enum(["setup", "connect"]), owner: z.string(), nonce: Hex32, at: z.number().int() }).optional(),
  /** A finish code from this user (its SHA-256) that arrived before their claim. */
  finish: z.object({ nonce: Hex32, at: z.number().int() }).optional(),
  /** The account being checked on-chain (a claim and its finish code matched), and since when. */
  owner: z.string().optional(),
  claimed_at: z.number().int().optional(),
});
type PendingSetup = z.infer<typeof PendingSetup>;

const SignupState = z.object({ setups: z.array(PendingSetup).default([]) });

export type SignupDeps = {
  api: Pick<BotApi, "sendMessage" | "getMe">;
  updateLog: UpdateLog;
  /** Open setups, with their keys (mode 0600); null keeps them in memory only (tests). */
  statePath: string | null;
  /** The operator's own GetLeash: hosted businesses use its treasury token, and its RPC. */
  home: PolicyView;
  dashboardUrl: string;
  /** Whether this Telegram user already uses a GetLeash here: the operator's, or one set up before. One each. */
  isMember: (user: string) => boolean;
  /** Hosted businesses so far, and how many this service takes. */
  count: () => number;
  maxBusinesses: number;
  /** Records the business and its secrets, and starts serving it. */
  activate: (business: HostedBusiness, secrets: BusinessSecrets) => Promise<void>;
  /** A business this service already serves, by contract: a "connect" claim moves it. */
  hosted: (policyId: string) => HostedBusiness | null;
  /** Moves a business to another Telegram account: recorded, then served there and no longer where it was. */
  move: (business: HostedBusiness, to: { owner_user: string; owner_chat: string }) => Promise<HostedBusiness>;
  /** Signs a setup link with the operator's agent key (signSetupLink): the page checks it against the chain. */
  signLink: (link: SetupLink) => Promise<string>;
  /** The chain view of a new business's contract (for its limits in the welcome message). */
  viewOf: (policyId: string) => PolicyView;
  /** The claim's signature check; the default is checkSetupClaim on the home RPC. */
  checkClaim?: (claim: SetupClaim, expected: ClaimExpected) => Promise<"ok" | "bad">;
  /** The on-chain checks; the default is checkHostedSetup with the home token. */
  verify?: (target: SetupTarget) => Promise<Check[]>;
  newKey?: () => { public_key: string; private_key: string };
  now?: () => number;
  log?: (line: string) => void;
};

/** The limits in plain words, from a contract's policy (DEFAULT_POLICY before it exists). */
function limitsText(p: Pick<Policy, "approval_threshold" | "autonomous_daily_budget" | "daily_cap" | "cooldown_ns" | "cooldown_max">, decimals = 6): string {
  const parts = [
    `I pay up to ${money(p.approval_threshold, decimals)} USDC a payment on my own, ${money(p.autonomous_daily_budget, decimals)} USDC a day; anything above that waits for your OK.`,
    `At most ${money(p.daily_cap, decimals)} USDC leaves a day in all.`,
  ];
  if (BigInt(p.cooldown_ns) > 0n) {
    parts.push(`For a new supplier's first ${durationText(p.cooldown_ns)}, every payment to them waits for you, up to ${money(p.cooldown_max, decimals)} USDC each.`);
  }
  return parts.join(" ");
}

function offerText(): string {
  const p = DEFAULT_POLICY;
  return [
    "👋 GetLeash pays your suppliers for you. Send me an invoice: I pay it in USDC (or USDT on Tron) if it fits the limits your own wallet sets on NEAR, and ask you first when it doesn't.",
    "",
    "Set it up in a minute:",
    `1. Tap "${SETUP_BUTTON}" below. It opens here in Telegram and connects your NEAR wallet (HOT Wallet works inside Telegram).`,
    `2. Your wallet creates your own GetLeash: a contract that holds your USDC, has no keys, and that only your wallet can change. It costs about ${nearRoundedUp(setupCost())} NEAR, from your wallet, which needs about ${nearRoundedUp(setupNeeds(), 3)} NEAR while it signs (the rest comes back).`,
    "3. Tap Finish on the page, then START here. I'll tell you when it's ready; then you send it USDC and add the people you pay.",
    "",
    `What you trust this service with: it reads the invoices you send, and pays suppliers you added on its own up to ${money(p.approval_threshold)} USDC a payment and ${money(p.autonomous_daily_budget)} USDC a day. Everything else waits for your OK in your wallet.`,
    "Already set up GetLeash here from another Telegram account? The same button moves it to this one, with your wallet.",
    "The button is yours, in this chat, for a day.",
  ].join("\n");
}

function readyText(business: HostedBusiness, policy: Policy | null, decimals: number): string {
  const contract = business.policy_id;
  return [
    `✅ Your GetLeash is ready: ${contract}, owned by your wallet ${business.owner_id}.`,
    "",
    "Next:",
    `1. Send USDC on NEAR to ${contract} from your wallet. That's your treasury: payments only ever come from it.`,
    "2. Add the people you pay: /addsupplier with their name and their NEAR account or Tron address, or /invite to let them send it themselves.",
    "3. Send me an invoice: a PDF, a photo or pasted text.",
    "",
    `Your limits: ${limitsText(policy ?? DEFAULT_POLICY, decimals)}`,
    "/help lists everything.",
  ].join("\n");
}

/**
 * How a Telegram user shows up in their setup link and in the message their wallet signs: @username when
 * they have one (unique, letters, digits and _ only), else the name on the account in quotes, cleaned so
 * it can't pass for a username or a user id: a first name "@victor (user 4004)" shows as “victor user 4004”.
 */
export function displayName(from: Message["from"]): string {
  if (!from) return "a Telegram user";
  if (from.username && /^[A-Za-z0-9_]{3,32}$/.test(from.username)) return `@${from.username}`;
  const name = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ")
    .replace(/[\p{C}]/gu, "")
    .replace(/[@＠﹫()（）﹙﹚[\]{}<>"“”'‘’`«»\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
  return name ? `“${name}”` : `user ${from.id}`;
}

const FINISH_THERE = `Tap "${SETUP_BUTTON}" below and finish there.`;
const TRY_AGAIN = `Tap "${SETUP_BUTTON}" below and tap Finish again in a minute.`;

/** To someone whose finish code belongs to a setup another Telegram account started (a lookalike bot's victim, or a forwarded link). */
function notYoursText(name: string): string {
  return [
    `⚠️ That setup was started by another Telegram account (${name}), so I won't connect it to you.`,
    "If someone sent you their setup link, don't use it again. Nobody can use what your wallet created with it: GetLeash never connects it to anyone without a new signature from your wallet.",
    "To set up GetLeash yourself, send /start here, with a NEAR account that has no GetLeash yet.",
  ].join("\n");
}

function movedAwayText(policyId: string, owner: string): string {
  return [
    `Your GetLeash ${policyId} now answers another Telegram account: its owner's wallet, ${owner}, moved it there.`,
    `If you didn't ask for that, send /start here and connect it back with your wallet.`,
  ].join("\n");
}

function movedHereText(business: HostedBusiness): string {
  return `✅ ${business.policy_id} answers to you now: its owner's wallet, ${business.owner_id}, connected it to this Telegram account.\n/help lists everything.`;
}

/** The accounts a setup made with these keys must show on-chain, under `owner`. */
function targetOf(setup: PendingSetup, owner: string): SetupTarget {
  const ids = hostedIds(owner);
  return {
    ownerId: owner,
    policyId: ids.policyId,
    agent: { accountId: ids.agentId, publicKey: setup.agent.public_key },
    executor: { accountId: ids.executorId, publicKey: setup.executor.public_key },
  };
}

function parseClaim(data: string): SetupClaim | null {
  try {
    const parsed = SetupClaim.safeParse(JSON.parse(data));
    return parsed.success ? { ...parsed.data, owner: parsed.data.owner.toLowerCase() } : null;
  } catch {
    return null;
  }
}

export class BusinessSignup {
  private state: z.infer<typeof SignupState> = { setups: [] };
  private readonly checking = new Set<string>();
  private readonly lastTry = new Map<string, number>();
  private readonly lastClaim = new Map<string, number>();
  private username: string | null = null;
  private ticking = false;

  constructor(private readonly deps: SignupDeps) {
    if (!deps.statePath || !existsSync(deps.statePath)) return;
    const parsed = SignupState.safeParse(JSON.parse(readFileSync(deps.statePath, "utf8")));
    // A damaged file only loses open setups: those people send /start again.
    if (parsed.success) this.state = parsed.data;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Kept: a setup being checked until it is served or given up on; any other until a day after its link expired. */
  private kept(setup: PendingSetup): boolean {
    return setup.owner !== undefined || this.now() < setup.until + KEEP_AFTER_LINK_MS;
  }

  private live(): PendingSetup[] {
    return this.state.setups.filter((s) => this.kept(s));
  }

  /** Writes the open setups as they are; only the tick removes expired ones, so it can tell their owners. */
  private save(): void {
    if (this.deps.statePath) writePrivateJson(this.deps.statePath, this.state);
  }

  private drop(...setups: PendingSetup[]): void {
    this.state.setups = this.state.setups.filter((s) => !setups.includes(s));
    this.save();
  }

  private setupOf(user: string): PendingSetup | null {
    return this.live().find((s) => s.user === user) ?? null;
  }

  /** Open setups (for logs and tests). */
  open(): number {
    return this.live().length;
  }

  /**
   * A private message from someone who does not use GetLeash here yet. Answered when it starts a setup
   * (/start), carries the page's signed claim, carries a finish code (`/start finish_<code>`) or comes from
   * someone in the middle of a setup; anything else returns null and stays unanswered.
   */
  async handle(update: Update, message: Message): Promise<string | null> {
    const user = message.from && !message.from.is_bot ? String(message.from.id) : "";
    if (!user || message.chat.type !== "private" || this.deps.isMember(user)) return null;
    const command = message.text?.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    const name = command?.[1]?.toLowerCase();
    const args = (command?.[2] ?? "").trim();
    const data = message.web_app_data?.data;
    const starting = (name === "start" && (args === "" || args === "setup")) || name === "setup";
    const finishing = name === "start" && args.startsWith(FINISH_PREFIX) ? args.slice(FINISH_PREFIX.length) : null;
    const setup = this.setupOf(user);
    if (data === undefined && !starting && finishing === null && !setup) return null;
    if (!this.deps.updateLog.claim(`telegram-${update.update_id}`)) return "duplicate";
    const chat = String(message.chat.id);
    if (starting) return this.offer(user, chat, displayName(message.from));
    if (finishing !== null) return this.finish(user, chat, finishing);
    if (!setup) {
      await this.tell(chat, { text: "That setup has expired, or never started here. Send /start for a new one." });
      return "signup:none";
    }
    if (data === undefined) {
      await this.tell(chat, { text: `Tap "${SETUP_BUTTON}" below to finish setting up GetLeash.` });
      return "signup:reminded";
    }
    return this.claim(setup, data);
  }

  /**
   * The page's signed claim, from this user's own chat: the owner's wallet says this setup (or its existing
   * GetLeash) is for this Telegram account. Kept until the finish code arrives from the same account.
   */
  private async claim(setup: PendingSetup, data: string): Promise<string> {
    const claim = parseClaim(data);
    if (!claim || !canHost(claim.owner)) {
      await this.tell(setup.chat, { text: `⚠️ That didn't come from the setup page as I expected. ${FINISH_THERE}` });
      return "signup:bad_claim";
    }
    // A check under way (or due at the next tick) is answered by that check; a new claim waits a few seconds.
    if (this.checking.has(setup.user) || setup.owner !== undefined) {
      await this.tell(setup.chat, { text: "⏳ Still checking. I'll tell you here." });
      return "signup:busy";
    }
    if (this.now() - (this.lastClaim.get(setup.user) ?? 0) < CLAIM_EVERY_MS) {
      await this.tell(setup.chat, { text: "Wait a few seconds, then tap Finish again." });
      return "signup:busy";
    }
    this.lastClaim.set(setup.user, this.now());
    let verdict: "ok" | "bad";
    try {
      const check = this.deps.checkClaim ?? ((c: SetupClaim, e: ClaimExpected) => checkSetupClaim(this.deps.home.provider, c, e));
      verdict = await check(claim, { agentPublicKey: setup.agent.public_key, telegramUser: setup.user, telegramName: setup.name });
    } catch (error) {
      this.deps.log?.(`[signup] checking a claim for ${claim.owner} failed: ${(error as Error).message}`);
      await this.tell(setup.chat, { text: `I couldn't reach NEAR to check it. ${TRY_AGAIN}` });
      return "signup:unchecked";
    }
    if (verdict === "bad") {
      await this.tell(setup.chat, { text: `⚠️ That signature isn't ${claim.owner}'s for this setup, so nothing changes. ${FINISH_THERE}` });
      return "signup:bad_claim";
    }
    setup.claim = { kind: claim.kind, owner: claim.owner, nonce: claim.nonce, at: this.now() };
    this.save();
    // A finish code that came first from this same account completes it; one that came from anyone else isn't theirs.
    if (setup.finish?.nonce === claim.nonce) return this.proceed(setup);
    for (const other of this.live()) {
      if (other === setup || other.finish?.nonce !== claim.nonce) continue;
      delete other.finish;
      this.save();
      this.deps.log?.(`[signup] the finish code for the setup of ${setup.user} came from ${other.user}: refused`);
      await this.tell(other.chat, { text: notYoursText(setup.name) });
    }
    // On Android, Telegram sends START by itself when the page opens this chat; elsewhere it shows the button.
    await this.tell(setup.chat, {
      text: `Last step: tap START at the bottom of this chat, if Telegram shows it (it may send START for you). Nothing happens? Open the page again with "${SETUP_BUTTON}", tap Finish, then "Open the GetLeash chat".`,
    });
    return "signup:claimed";
  }

  /**
   * `/start finish_<code>`: the page opened this bot's chat with the code it made, and the user tapped
   * START. It counts only for the setup of the account that sent it, against that setup's claim.
   */
  private async finish(user: string, chat: string, text: string): Promise<string> {
    const code = parseFinishCode(text);
    if (!code) {
      await this.tell(chat, { text: `That finish link is incomplete. Open the setup page again with "${SETUP_BUTTON}" and tap Finish.` });
      return "signup:bad_code";
    }
    const nonce = finishNonce(code);
    const own = this.setupOf(user);
    if (own?.claim?.nonce === nonce) return this.proceed(own);
    const theirs = this.live().find((s) => s !== own && s.claim?.nonce === nonce);
    if (theirs) {
      this.deps.log?.(`[signup] the finish code for the setup of ${theirs.user} came from ${user}: refused`);
      await this.tell(chat, { text: notYoursText(theirs.name) });
      return "signup:not_yours";
    }
    if (own) {
      // The page's message with the claim is on its way (or never comes: the tick says so after a minute).
      own.finish = { nonce, at: this.now() };
      this.save();
      return "signup:finishing";
    }
    await this.tell(chat, { text: "I don't know that finish code. To set up GetLeash, send /start." });
    return "signup:unknown_code";
  }

  /** A claim and its finish code met, both from the setup's own account: check the chain, or connect the existing GetLeash. */
  private async proceed(setup: PendingSetup): Promise<string> {
    const claim = setup.claim!;
    if (setup.owner !== undefined || this.checking.has(setup.user)) {
      await this.tell(setup.chat, { text: "⏳ Still checking. I'll tell you here." });
      return "signup:busy";
    }
    delete setup.finish;
    if (claim.kind === "connect") return this.connect(setup, claim.owner);
    setup.owner = claim.owner;
    setup.claimed_at = this.now();
    this.save();
    await this.tell(setup.chat, { text: `⏳ Checking ${hostedIds(claim.owner).policyId} on NEAR…` });
    await this.check(setup);
    return "signup:checking";
  }

  /**
   * A "connect" claim: the owner's wallet moves its GetLeash, which this service serves, to this Telegram
   * account; the account it leaves is told. Nothing else is connected: a setup that is still open belongs to
   * whoever started it here (anyone can put its public keys on accounts of their own), and a GetLeash this
   * service doesn't serve isn't its to connect.
   */
  private async connect(setup: PendingSetup, owner: string): Promise<string> {
    const policyId = hostedIds(owner).policyId;
    const business = this.deps.hosted(policyId);
    if (!business || business.owner_id !== owner) {
      delete setup.claim;
      this.save();
      await this.tell(setup.chat, { text: `GetLeash doesn't serve ${policyId}, so there's nothing to connect. If you set it up yourself, keep running it that way.` });
      return "signup:not_here";
    }
    const before = business.owner_chat;
    const moved = await this.deps.move(business, { owner_user: setup.user, owner_chat: setup.chat });
    this.drop(setup);
    this.deps.log?.(`[signup] ${moved.policy_id} moved to another Telegram account by its owner's wallet (${owner})`);
    if (before !== moved.owner_chat) await this.tell(before, { text: movedAwayText(moved.policy_id, owner) });
    await this.send(moved.owner_chat, movedHereText(moved), { reply_markup: { remove_keyboard: true } });
    return "signup:moved";
  }

  /** The bot's username, for the signed link (the page sends the finish code there and nowhere else). */
  private async botUsername(): Promise<string | null> {
    try {
      this.username ??= (await this.deps.api.getMe()).username ?? null;
    } catch (error) {
      this.deps.log?.(`[signup] getMe failed: ${(error as Error).message}`);
    }
    return this.username;
  }

  /** The button to the setup page, with this person's two public keys; the same keys, and a renewed link, if they ask again. */
  private async offer(user: string, chat: string, name: string): Promise<string> {
    let setup = this.setupOf(user);
    if (!setup) {
      if (this.deps.count() >= this.deps.maxBusinesses || this.live().length >= MAX_OPEN_SETUPS) {
        await this.tell(chat, { text: "GetLeash isn't taking new businesses right now. Try again later." });
        return "signup:full";
      }
      const key = this.deps.newKey ?? newKeyPair;
      setup = {
        user,
        name,
        chat,
        agent: key(),
        executor: key(),
        tenant_secret: randomBytes(32).toString("hex"),
        invoice_store_key: randomBytes(32).toString("hex"),
        at: this.now(),
        until: this.now() + LINK_TTL_MS,
      };
      // An expired setup of theirs that the tick hasn't removed yet goes quietly: they're getting a new link.
      this.state.setups = this.state.setups.filter((s) => s.user !== user || this.kept(s));
      this.state.setups.push(setup);
    } else if (setup.owner === undefined) {
      // Renewed, with the same keys (a wallet may already have used them) and the name Telegram shows now.
      setup.until = this.now() + LINK_TTL_MS;
      setup.name = name;
    }
    this.save();
    const bot = await this.botUsername();
    let signature: string | null = null;
    if (bot) {
      try {
        signature = await this.deps.signLink({ agent: setup.agent.public_key, executor: setup.executor.public_key, until: setup.until, user: setup.user, name: setup.name, bot });
      } catch (error) {
        this.deps.log?.(`[signup] signing a setup link failed: ${(error as Error).message}`);
      }
    }
    if (!bot || !signature) {
      await this.tell(chat, { text: "I can't make your setup link right now. Send /start again in a minute." });
      return "signup:unavailable";
    }
    // Everything the page shows and acts on, signed: it refuses a link this bot didn't make.
    const query = new URLSearchParams({
      agent: setup.agent.public_key,
      executor: setup.executor.public_key,
      until: String(setup.until),
      for: setup.user,
      name: setup.name,
      bot,
      sig: signature,
    });
    const url = dashboardLink(this.deps.dashboardUrl, `/setup?${query.toString()}`)!;
    await this.deps.api.sendMessage(chat, offerText(), {
      link_preview_options: { is_disabled: true },
      // A keyboard button, not an inline one: only a page opened from it can send its result back (web_app_data).
      reply_markup: { keyboard: [[{ text: SETUP_BUTTON, web_app: { url } }]], resize_keyboard: true, is_persistent: true },
    });
    return "signup:offered";
  }

  private verify(target: SetupTarget): Promise<Check[]> {
    if (this.deps.verify) return this.deps.verify(target);
    return this.deps.home.state().then((home) => checkHostedSetup(this.deps.home.provider, target, home.token_id));
  }

  /** Looks for the setup on-chain; once everything checks out, the business is served from here on. */
  private async check(setup: PendingSetup): Promise<void> {
    const owner = setup.owner;
    if (!owner || this.checking.has(setup.user)) return;
    this.checking.add(setup.user);
    this.lastTry.set(setup.user, this.now());
    const target = targetOf(setup, owner);
    const late = () => this.now() - (setup.claimed_at ?? 0) >= CHECK_FOR_MS;
    try {
      const failed = (await this.verify(target)).filter((c) => !c.ok);
      if (failed.length === 0) {
        await this.serve(setup, target);
        return;
      }
      if (!late()) return;
      this.giveUp(setup);
      await this.tell(setup.chat, {
        text: [`⚠️ ${target.policyId} isn't set up the way GetLeash needs yet:`, ...failed.map((c) => `• not yet: ${c.name}`), `Tap "${SETUP_BUTTON}" again: the page carries on from where it stopped.`].join("\n"),
      });
    } catch (error) {
      this.deps.log?.(`[signup] checking ${target.policyId} failed: ${(error as Error).message}`);
      if (!late()) return;
      this.giveUp(setup);
      await this.tell(setup.chat, { text: `I couldn't reach NEAR to check ${target.policyId}. ${TRY_AGAIN}` });
    } finally {
      this.checking.delete(setup.user);
    }
  }

  private giveUp(setup: PendingSetup): void {
    delete setup.owner;
    delete setup.claimed_at;
    this.save();
  }

  /** Serves the business set up with this setup's keys to its account. Once only: a setup served meanwhile (by an overlapping check, or before a restart) is just dropped. */
  private async serve(setup: PendingSetup, target: SetupTarget): Promise<void> {
    if (!this.state.setups.includes(setup)) return;
    if (this.deps.isMember(setup.user)) {
      this.drop(setup);
      return;
    }
    const business: HostedBusiness = {
      policy_id: target.policyId,
      owner_id: target.ownerId,
      agent_id: target.agent.accountId,
      executor_id: target.executor.accountId,
      owner_user: setup.user,
      owner_chat: setup.chat,
      created_at: new Date(this.now()).toISOString(),
    };
    const secrets: BusinessSecrets = {
      agent_private_key: setup.agent.private_key,
      executor_private_key: setup.executor.private_key,
      tenant_secret: setup.tenant_secret,
      invoice_store_key: setup.invoice_store_key,
    };
    // Recorded and running first; only then is the open setup (and its copy of the keys) dropped.
    await this.deps.activate(business, secrets);
    this.drop(setup);
    this.deps.log?.(`[signup] ${business.policy_id} is set up (owner ${business.owner_id})`);
    const state = await this.deps
      .viewOf(business.policy_id)
      .state()
      .catch(() => null);
    await this.send(setup.chat, readyText(business, state?.policy ?? null, state?.token_decimals ?? 6), { reply_markup: { remove_keyboard: true } });
  }

  /**
   * Every 10 s, one pass at a time: setups being checked are checked again until they check out or
   * CHECK_FOR_MS passes; a finish code whose claim never came is let go after FINISH_WAIT_MS; setups whose
   * link expired a day ago leave the file with their keys, and their button leaves the chat.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const setup of this.live()) {
        if (setup.finish && now - setup.finish.at >= FINISH_WAIT_MS) {
          delete setup.finish;
          this.save();
          await this.tell(setup.chat, { text: `I didn't get the setup page's part. Open it again with "${SETUP_BUTTON}" and tap Finish.` });
        }
        if (!setup.owner || now - (this.lastTry.get(setup.user) ?? 0) < CHECK_EVERY_MS) continue;
        await this.check(setup);
      }
      const expired = this.state.setups.filter((s) => !this.kept(s));
      if (expired.length === 0) return;
      this.state.setups = this.state.setups.filter((s) => this.kept(s));
      this.save();
      for (const setup of expired) {
        await this.send(setup.chat, "Your GetLeash setup link expired. Send /start for a new one.", { reply_markup: { remove_keyboard: true } });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async send(chat: string, text: string, other: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.api.sendMessage(chat, text, { link_preview_options: { is_disabled: true }, ...other });
    } catch (error) {
      this.deps.log?.(`[signup] could not send to ${chat}: ${(error as Error).message}`);
    }
  }

  private tell(chat: string, notice: Notice): Promise<void> {
    return this.send(chat, notice.text);
  }
}
