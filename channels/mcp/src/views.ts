/**
 * The read-only MCP tools (D-34): `get_policy`, `list_intents` and `list_suppliers`. They read public
 * contract views and need no key, so both servers offer them: the local one (`server.ts`) for its one
 * contract, the hosted one (`http.ts`, https://www.getleash.xyz/mcp) for any GetLeash contract a call names.
 *
 * Only `@getleash/shared` (browser-safe) and the SDK: no files, no keys, no Node-only modules. Replies are
 * deterministic text in the dashboard's and the bot's words, followed by the same facts as JSON.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  assetName,
  dashboardLink,
  type Directory,
  flagText,
  type Intent,
  isOpen,
  money,
  paidAt,
  paymentState,
  type PolicyView,
  STATUSES,
  type StateView,
  type Supplier,
  utcTime,
  waitReason,
} from "@getleash/shared";

/** A NEAR account id (the same rule as the dashboard's `?c=`). */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

export type Contracts =
  /** The local server: every call reads this contract. */
  | { fixed: PolicyView }
  /** The hosted server: a call may name a contract (`contract`), else it reads `fallback`. */
  | { named: (contractId: string) => PolicyView; fallback: string };

export type ViewDeps = {
  network: string;
  contracts: Contracts;
  /** Supplier names on this machine; suppliers without one show their id and address. */
  directory: () => Directory;
  /** What a supplier without a name is called in `list_suppliers`; default "(no name on this machine)". */
  unnamed?: string;
  /** The dashboard, for links to a payment's page (`?c=` names the contract); null for no links. */
  dashboardUrl?: string | null;
  log?: (line: string) => void;
  now?: () => Date;
};

/** One summary for people, then the same facts as JSON for programs. */
export function reply(summary: readonly string[], details: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary.join("\n") },
      { type: "text", text: JSON.stringify(details, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) },
    ],
  };
}

export function refused(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Ends a sentence once: "Shenzhen Parts Co." keeps its period, "Acme" gets one. */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** "2 days", "36 hours", "90 minutes": a policy duration in nanoseconds, for reading. */
export function duration(ns: string): string {
  const minutes = BigInt(ns) / 60_000_000_000n;
  const plural = (n: bigint, unit: string) => `${n} ${unit}${n === 1n ? "" : "s"}`;
  if (minutes > 0n && minutes % 1_440n === 0n) return plural(minutes / 1_440n, "day");
  if (minutes > 0n && minutes % 60n === 0n) return plural(minutes / 60n, "hour");
  return plural(minutes, "minute");
}

/** Runs a tool's work; a failure (an RPC down, a contract that is not GetLeash) becomes a tool error. */
export function guarded<A>(log: ((line: string) => void) | undefined, work: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await work(args);
    } catch (error) {
      // Input limits (`LimitError` in @getleash/ingestion, not imported here) carry a code worth showing.
      const e = error as Error & { code?: string };
      const message = e.name === "LimitError" && e.code ? `${e.code}: ${e.message}` : e.message;
      log?.(`[mcp] tool failed: ${message}`);
      return refused(message);
    }
  };
}

const LIST_SHAPE = {
  status: z
    .enum(["all", "open", ...STATUSES])
    .default("all")
    .describe("all, open (waiting for the owner, or being paid), or one status: PENDING, APPROVED, PAYING, PAID, FAILED, REJECTED."),
  limit: z.number().int().min(1).max(50).default(20).describe("How many of the newest payments to return (1 to 50)."),
};
const ContractArg = z.string().regex(NEAR_ACCOUNT, "a NEAR account id, such as getleash.onanikes.near").optional();
/** The input types the handlers see; the local server's schemas simply have no `contract` field. */
const WithContract = z.strictObject({ contract: ContractArg });
const ListWithContract = z.strictObject({ ...LIST_SHAPE, contract: ContractArg });

export function registerViewTools(server: McpServer, deps: ViewDeps): void {
  const now = deps.now ?? (() => new Date());
  const nowNs = () => BigInt(now().getTime()) * 1_000_000n;
  const named = "named" in deps.contracts ? deps.contracts : null;

  // The hosted server takes the contract as an argument; the local one serves one contract and has no such field.
  const contract = named
    ? ContractArg.describe(
        `The GetLeash contract to read: a business's own (its owner can name it), for example getleash.onanikes.near or <name>.getleash.near. Default: ${named.fallback}.`,
      )
    : null;
  const NoInput = (contract ? z.strictObject({ contract }) : z.strictObject({})) as unknown as typeof WithContract;
  const ListInput = (contract ? z.strictObject({ ...LIST_SHAPE, contract }) : z.strictObject(LIST_SHAPE)) as unknown as typeof ListWithContract;

  /** The contract a call reads, checked to be a GetLeash contract by reading its state. */
  async function open(contract: string | undefined): Promise<{ view: PolicyView; state: StateView }> {
    const view = named ? named.named(contract ?? named.fallback) : (deps.contracts as { fixed: PolicyView }).fixed;
    try {
      return { view, state: await view.state() };
    } catch (error) {
      if (!named) throw error;
      throw new Error(`${view.contractId} on ${deps.network} can't be read as a GetLeash contract: ${(error as Error).message}`);
    }
  }

  const link = (view: PolicyView, path: string) => dashboardLink(deps.dashboardUrl, path, view.contractId);

  /** Names on file, then "supplier #3 (acme.near)". */
  function naming(suppliers: readonly Supplier[]) {
    const names = new Map(deps.directory().suppliers.map((s) => [s.supplier_id, s.name]));
    const byId = new Map(suppliers.map((s) => [s.id, s]));
    return {
      byId,
      name: (id: number) => names.get(id) ?? null,
      who: (id: number) => names.get(id) ?? (byId.get(id) ? `supplier #${id} (${byId.get(id)!.recipient})` : `supplier #${id}`),
    };
  }

  server.registerTool(
    "get_policy",
    {
      title: "GetLeash limits and today's budgets",
      description:
        "The contract's limits as the owner set them, what has been used today, the treasury's balance, whether payments are paused, and who the owner, agent and executor are.",
      inputSchema: NoInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(deps.log, async ({ contract }: { contract?: string }) => {
      const { view, state } = await open(contract);
      const balance = await view.treasuryBalance(state.token_id);
      const d = state.token_decimals;
      const usdc = (units: string | bigint) => `${money(units, d)} USDC`;
      const p = state.policy;
      const b = state.budgets;
      const lines = [
        `${view.contractId} on ${deps.network}: ${state.paused ? "payments are PAUSED by the owner" : "payments are on"}.`,
        `Treasury: ${usdc(balance)}.`,
        `The agent pays on its own up to ${usdc(p.approval_threshold)} a payment and ${usdc(p.autonomous_daily_budget)} a day (used today: ${usdc(b.autonomous)}). Anything else waits for the owner's approval in their wallet.`,
        `Sent today: ${usdc(b.outflow)} of the ${usdc(p.daily_cap)} daily cap.`,
        p.executor_trust_daily_budget === "0"
          ? "Every cross-chain payment needs the owner's signature (the executor's trust budget is 0)."
          : `Cross-chain payments the executor may fund without the owner's signature: ${usdc(b.trust)} of ${usdc(p.executor_trust_daily_budget)} today.`,
        BigInt(p.cooldown_ns) > 0n
          ? `For ${duration(p.cooldown_ns)} after a supplier is added or their payment details change, every payment to them waits for the owner, who can approve at most ${usdc(p.cooldown_max)} a payment.`
          : "Suppliers have no cooldown after they are added or changed.",
        `Proposals today: ${b.proposals} of ${p.max_proposals_per_day}. Payments stored: ${state.stored_intents} (${state.paying} being sent).`,
        `Owner ${state.owner_id}, agent ${state.agent_id}, executor ${state.executor_id}.`,
      ];
      const page = link(view, "/payments");
      if (page) lines.push(`Dashboard: ${page}`);
      return reply(lines, { contract: view.contractId, network: deps.network, treasury: balance.toString(), ...stateFacts(state) });
    }),
  );

  server.registerTool(
    "list_intents",
    {
      title: "GetLeash payments",
      description:
        "The newest payments the contract holds (it forgets closed ones after its retention period), newest first: amount, supplier, where each stands and why one waits for the owner.",
      inputSchema: ListInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(deps.log, async ({ status, limit, contract }: z.infer<typeof ListWithContract>) => {
      const { view, state } = await open(contract);
      const named_ = naming(await view.suppliers());
      const wanted = (i: Intent) => status === "all" || (status === "open" ? isOpen(i) : i.status === status);
      const intents = (await view.recentIntents(50)).filter(wanted).sort((a, b) => b.id - a.id).slice(0, limit);
      const lines = intents.length
        ? []
        : [
            `No ${status === "all" ? "" : `${status} `}payments stored on ${view.contractId}. It forgets a payment ${duration(state.policy.retention_ns)} after it closes; the chain's history keeps every transaction.`,
          ];
      const details = intents.map((i) => {
        const supplier = named_.byId.get(i.supplier_id) ?? null;
        const amount = `${money(i.amount_out, supplier?.decimals ?? state.token_decimals)} ${supplier ? assetName(supplier, state.token_id) : ""}`.trim();
        const where = paymentState(i, supplier?.chain === "NEAR").label;
        const why = i.status === "PENDING" ? `, waiting because ${waitReason(i.route, state.policy, state.token_decimals)}` : "";
        const flag = flagText(i.flag);
        const page = link(view, `/intent/${i.id}`);
        lines.push(`#${i.id} ${where}: ${sentence(`${amount} to ${named_.who(i.supplier_id)}${why}`)} Since ${utcTime(i.since)}.${flag ? ` Flagged: ${flag}.` : ""}${page ? ` ${page}` : ""}`);
        return {
          id: i.id,
          status: i.status,
          state: where,
          route: i.route,
          supplier_id: i.supplier_id,
          supplier_name: named_.name(i.supplier_id),
          amount_out: i.amount_out,
          amount,
          flag: flag ?? null,
          since: i.since,
          link: page,
        };
      });
      return reply(lines, { contract: view.contractId, payments: details });
    }),
  );

  server.registerTool(
    "list_suppliers",
    {
      title: "GetLeash approved suppliers",
      description:
        "The suppliers the owner approved: the only ones the contract pays, each at the address on file. Shows whether each is active and whether a recent change still holds its payments for the owner.",
      inputSchema: NoInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(deps.log, async ({ contract }: { contract?: string }) => {
      const { view, state } = await open(contract);
      const suppliers = await view.suppliers();
      const named_ = naming(suppliers);
      const lines = suppliers.length ? [] : [`${view.contractId} has no approved suppliers yet.`];
      const details = suppliers.map((s) => {
        const coolingUntil = BigInt(s.changed_at) + BigInt(state.policy.cooldown_ns);
        const cooling = nowNs() < coolingUntil;
        lines.push(
          `#${s.id} ${named_.name(s.id) ?? deps.unnamed ?? "(no name on this machine)"}: ${paidAt(s)}${s.active ? "" : ", switched off"}${cooling ? `. Added or changed ${utcTime(s.changed_at)}: payments wait for the owner until ${utcTime(coolingUntil)}` : ""}.`,
        );
        return { id: s.id, name: named_.name(s.id), chain: s.chain, asset: assetName(s, state.token_id), recipient: s.recipient, active: s.active, revision: s.revision, changed_at: s.changed_at, in_cooldown: cooling };
      });
      return reply(lines, { contract: view.contractId, suppliers: details });
    }),
  );
}

function stateFacts(state: StateView) {
  return {
    paused: state.paused,
    owner_id: state.owner_id,
    agent_id: state.agent_id,
    executor_id: state.executor_id,
    token_id: state.token_id,
    token_decimals: state.token_decimals,
    policy: state.policy,
    today: state.budgets,
    stored_intents: state.stored_intents,
    paying: state.paying,
  };
}
