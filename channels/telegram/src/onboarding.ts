/**
 * Adding suppliers from Telegram (docs/decisions.md D-29). The owner names a supplier and its address
 * (/addsupplier), or sends the supplier a one-time invite (/invite) and the supplier answers with its
 * own details. The bot checks the address and keeps the request; the owner's wallet adds the supplier
 * on the dashboard's page (`add_supplier`, which only the owner can sign: the bot never adds anyone).
 * Once the supplier is on-chain, the bot saves its name in the directory the agent matches invoices
 * against, so nothing has to be copied to the hosts.
 *
 * Requests and invites live in `supplier-onboarding.json`, names in the directory file, both in the
 * services' data directory (mode 0600, written whole). An invite is kept as the SHA-256 of its token,
 * works for one Telegram user, for 7 days, and closes after 5 answers it could not use.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import {
  CHAINS,
  type Directory,
  distinctName,
  MAX_SUPPLIER_NAME,
  type Payee,
  type PolicyView,
  type StateView,
  type Supplier,
  supplierTerms,
  USDT_TRON_CONTRACT,
} from "@getleash/shared";
import { loadDirectory, saveDirectory, writePrivateJson } from "@getleash/shared/node";

const DAY_MS = 86_400_000;
export const INVITE_TTL_MS = 7 * DAY_MS;
export const REQUEST_TTL_MS = 7 * DAY_MS;
export const INVITE_TRIES = 5;
/** For this long after a request the bot looks for the new supplier at every tick; later, at every sixth. */
const FRESH_MS = 15 * 60_000;

const SupplierRequest = z.object({
  name: z.string().min(1).max(MAX_SUPPLIER_NAME + 8),
  chain: z.enum(CHAINS),
  recipient: z.string().min(2).max(64),
  /** The chat to tell once the supplier is added. */
  owner_chat: z.string(),
  /** The supplier's own chat, when it answered an invite: it hears when it was added. */
  supplier_chat: z.string().optional(),
  at: z.number().int(),
});
export type SupplierRequest = z.infer<typeof SupplierRequest>;

const SupplierInvite = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The name the owner gave the invite, if any; it wins over the one the supplier sends. */
  name: z.string().max(MAX_SUPPLIER_NAME).nullable(),
  owner_chat: z.string(),
  at: z.number().int(),
  /** The Telegram user who opened it first; nobody else can use it. */
  user: z.string().optional(),
  /** When that user opened it: a supplier with invites from two businesses answers the one opened last. */
  opened_at: z.number().int().optional(),
  /** The bot's questions for this invite (message ids): a reply to one is an answer to this invite. */
  prompts: z.array(z.number().int()).default([]),
  tries: z.number().int().default(0),
});
export type SupplierInvite = z.infer<typeof SupplierInvite>;

const OnboardingState = z.object({
  invites: z.array(SupplierInvite).default([]),
  requests: z.array(SupplierRequest).default([]),
});
type OnboardingState = z.infer<typeof OnboardingState>;

export type PayeeCheck =
  | { kind: "new"; payee: Payee; state: StateView }
  | { kind: "listed"; supplier: Supplier; name: string | null }
  | { kind: "refused"; why: string };

export type Settled = { request: SupplierRequest; supplier: Supplier; name: string; state: StateView };

export type OnboardingDeps = {
  /** Where requests and invites are kept; null keeps them in memory only (tests, no data directory). */
  statePath: string | null;
  /** The directory file the bot writes names to (the variable's suppliers are never copied into it). */
  directoryPath: string;
  /** The directory as the services read it (the variable's suppliers and the file's). */
  directory: () => Directory;
  view: PolicyView;
  now?: () => number;
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const sameTerms = (s: Supplier, t: { chain: string; asset_id: string; recipient: string }) =>
  s.chain === t.chain && s.asset_id === t.asset_id && s.recipient === t.recipient;

export class SupplierOnboarding {
  private state: OnboardingState = { invites: [], requests: [] };

  constructor(private readonly deps: OnboardingDeps) {
    if (!deps.statePath || !existsSync(deps.statePath)) return;
    const parsed = OnboardingState.safeParse(JSON.parse(readFileSync(deps.statePath, "utf8")));
    // A damaged file only loses open requests and invites: the owner asks again.
    if (parsed.success) this.state = parsed.data;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    const now = this.now();
    this.state.invites = this.state.invites.filter((i) => now - i.at < INVITE_TTL_MS);
    this.state.requests = this.state.requests.filter((r) => now - r.at < REQUEST_TTL_MS);
    if (this.deps.statePath) writePrivateJson(this.deps.statePath, this.state);
  }

  // ── Invites ──────────────────────────────────────────────────────────────────────────────────

  /** A new one-time invite; returns its token, for the link `t.me/<bot>?start=join_<token>`. */
  createInvite(ownerChat: string, name: string | null): string {
    const token = randomBytes(16).toString("base64url");
    this.state.invites.push({ hash: hash(token), name, owner_chat: ownerChat, at: this.now(), prompts: [], tries: 0 });
    this.save();
    return token;
  }

  /** The invite behind a token, claimed by the first Telegram user who opens it; null for anyone else. */
  openInvite(token: string, user: string): SupplierInvite | null {
    const invite = this.liveInvites().find((i) => i.hash === hash(token));
    if (!invite || (invite.user !== undefined && invite.user !== user)) return null;
    if (invite.user === undefined) {
      // One open invite per user: one opened before is closed.
      this.state.invites = this.state.invites.filter((i) => i === invite || i.user !== user);
      invite.user = user;
      invite.opened_at = this.now();
      this.save();
    }
    return invite;
  }

  /** Remembers a question the bot asked for this invite, so a reply to it reaches this invite. */
  notePrompt(invite: SupplierInvite, messageId: number | undefined): void {
    if (messageId === undefined || !this.state.invites.includes(invite)) return;
    invite.prompts = [...invite.prompts.slice(-9), messageId];
    this.save();
  }

  /** Whether `openInvite` would give this user the invite behind the token (it changes nothing). */
  knowsInvite(token: string, user: string): boolean {
    const invite = this.liveInvites().find((i) => i.hash === hash(token));
    return !!invite && (invite.user === undefined || invite.user === user);
  }

  /** The open invite this Telegram user is answering, if any. */
  inviteOf(user: string): SupplierInvite | null {
    return this.liveInvites().find((i) => i.user === user) ?? null;
  }

  /** Counts an answer that could not be used; returns the tries left (0: the invite is closed). */
  failedTry(invite: SupplierInvite): number {
    invite.tries += 1;
    if (invite.tries >= INVITE_TRIES) this.closeInvite(invite);
    else this.save();
    return Math.max(0, INVITE_TRIES - invite.tries);
  }

  closeInvite(invite: SupplierInvite): void {
    this.state.invites = this.state.invites.filter((i) => i !== invite);
    this.save();
  }

  private liveInvites(): SupplierInvite[] {
    const now = this.now();
    return this.state.invites.filter((i) => now - i.at < INVITE_TTL_MS);
  }

  // ── Checks and names ─────────────────────────────────────────────────────────────────────────

  /** Whether a payee can be added: not one of GetLeash's own accounts, an existing NEAR account, not on the list yet. */
  async check(payee: Payee): Promise<PayeeCheck> {
    const view = this.deps.view;
    const [state, suppliers] = await Promise.all([view.state(), view.suppliers()]);
    const listed = suppliers.find((s) => sameTerms(s, supplierTerms(payee, state)));
    if (listed) return { kind: "listed", supplier: listed, name: this.nameOf(listed.id) };
    if (payee.recipient === USDT_TRON_CONTRACT) {
      return { kind: "refused", why: "That's the address of the USDT token itself on Tron, not a wallet. Ask them for their own Tron address." };
    }
    if (payee.chain === "NEAR") {
      if ([view.contractId, state.token_id, state.owner_id, state.agent_id, state.executor_id].includes(payee.recipient)) {
        return { kind: "refused", why: `${payee.recipient} is one of this GetLeash's own accounts, so it can't be a supplier.` };
      }
      if (!/^[0-9a-f]{64}$/.test(payee.recipient) && !(await accountExists(view, payee.recipient))) {
        return { kind: "refused", why: `There is no NEAR account called ${payee.recipient}. Check the spelling with them.` };
      }
    }
    return { kind: "new", payee, state };
  }

  private nameOf(supplierId: number): string | null {
    return this.deps.directory().suppliers.find((s) => s.supplier_id === supplierId)?.name ?? null;
  }

  /** Saves a name for an on-chain supplier in the directory file and returns it (with `#id` if another supplier has it). */
  saveName(supplier: Supplier, wanted: string): string {
    const name = distinctName(wanted, supplier.id, this.deps.directory());
    const file = loadDirectory(this.deps.directoryPath);
    file.suppliers = file.suppliers.filter((s) => s.supplier_id !== supplier.id);
    file.suppliers.push({
      supplier_id: supplier.id,
      name,
      aliases: [],
      payment_details: [supplier.recipient],
      currency: supplier.chain === "TRON" ? "USDT" : "USDC",
    });
    saveDirectory(this.deps.directoryPath, file);
    return name;
  }

  // ── Requests ─────────────────────────────────────────────────────────────────────────────────

  /** Keeps a request until the owner has added the supplier; a newer one for the same address replaces it. */
  request(request: Omit<SupplierRequest, "at">): void {
    this.state.requests = this.state.requests.filter((r) => !(r.chain === request.chain && r.recipient === request.recipient));
    this.state.requests.push({ ...request, at: this.now() });
    this.save();
  }

  requests(): SupplierRequest[] {
    const now = this.now();
    return this.state.requests.filter((r) => now - r.at < REQUEST_TTL_MS);
  }

  /** Whether to look on-chain at this tick: at every tick while a request is fresh, at every sixth after that. */
  due(tick: number): boolean {
    const now = this.now();
    const open = this.requests();
    return open.some((r) => now - r.at < FRESH_MS) || (open.length > 0 && tick % 6 === 0);
  }

  /**
   * The requests whose supplier the owner has now added: each one's name is saved in the directory
   * (unless that supplier already has one) and the request is done.
   */
  async settle(): Promise<Settled[]> {
    const open = this.requests();
    if (open.length === 0) return [];
    const [state, suppliers] = await Promise.all([this.deps.view.state(), this.deps.view.suppliers()]);
    const settled: Settled[] = [];
    for (const request of open) {
      const supplier = suppliers.find((s) => sameTerms(s, supplierTerms(request, state)));
      if (!supplier) continue;
      settled.push({ request, supplier, name: this.nameOf(supplier.id) ?? this.saveName(supplier, request.name), state });
    }
    if (settled.length > 0) {
      this.state.requests = this.state.requests.filter((r) => !settled.some((s) => s.request === r));
      this.save();
    }
    return settled;
  }
}

async function accountExists(view: PolicyView, accountId: string): Promise<boolean> {
  try {
    await view.provider.viewAccount({ accountId });
    return true;
  } catch (error) {
    // near-api-js 7.4 throws AccountDoesNotExistError ("Account x.near does not exist at block height …").
    if (/does not exist/i.test((error as Error).message)) return false;
    throw error;
  }
}
