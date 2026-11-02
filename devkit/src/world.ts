/**
 * A complete local GetLeash deployment for integration tests and the offline demo:
 * a NEAR sandbox node, the mock USDC token, the v2 policy contract set up through the real setup
 * functions (keyless policy account, function-call-key role accounts), and mock-1click settling
 * against the same node.
 */
import type { Account } from "near-api-js";
import { KeyPair } from "near-api-js";

import { Executor, type ExecutorConfig } from "@getleash/executor";
import { Journal } from "@getleash/executor/journal";
import { MemoryNotifier, type Notifier } from "@getleash/executor/notify";
import { MockOneClick, type MockOptions } from "@getleash/mock-1click";
import {
  AGENT_METHODS,
  AgentClient,
  type Chain,
  createRoleAccount,
  defaultRoleIds,
  deployPolicy,
  EXECUTOR_METHODS,
  ExecutorClient,
  near,
  OneClickClient,
  OwnerClient,
  type Policy,
  PolicyView,
  registerOnToken,
  registerTreasury,
  suggestedPolicyBalance,
  topUp,
} from "@getleash/shared";

import { type Devnet, ensureWasm, startDevnet, USDC } from "./sandbox.ts";

export { USDC };

export const TRON_USDT = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
/** A valid Tron address (base58check test vector, docs/verified-facts.md). */
export const TRON_RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

const SECOND = 1_000_000_000n;
const DAY = 86_400n * SECOND;

/** The demo/test policy: v1's default amounts, no cooldown (sandbox time barely moves), and a
 *  small executor-trust budget (self-hosted). `trust: false` → every cross-chain payment needs
 *  the owner ("hosted mode" is just a trust budget of 0, D-28). */
export function worldPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    autonomous_daily_budget: (50n * USDC).toString(),
    approval_threshold: (25n * USDC).toString(),
    daily_cap: (200n * USDC).toString(),
    executor_trust_daily_budget: (5n * USDC).toString(),
    cooldown_max: (USDC / 2n).toString(),
    max_fixed_fee: (3n * USDC / 2n).toString(),
    max_fee_bps: 100,
    cooldown_ns: "0",
    intent_ttl_ns: (3n * DAY).toString(),
    quote_min_validity_ns: (300n * SECOND).toString(),
    funding_margin_ns: (180n * SECOND).toString(),
    callback_grace_ns: (3_600n * SECOND).toString(),
    retention_ns: (7n * DAY).toString(),
    max_proposals_per_day: 100,
    ...overrides,
  };
}

export type WorldOptions = {
  policy?: Partial<Policy>;
  /** USDC sent to the treasury after setup (base units). */
  topUp?: bigint;
  /** Tron withdrawal fee charged by the mock (USDT base units). */
  tronWithdrawFee?: bigint;
  mock?: Partial<MockOptions>;
  extraAccounts?: string[];
  log?: (line: string) => void;
};

export type World = {
  net: Devnet;
  policyId: string;
  view: PolicyView;
  owner: OwnerClient;
  agent: AgentClient;
  executorCalls: ExecutorClient;
  agentAccount: Account;
  executorAccount: Account;
  mock: MockOneClick;
  oneclick: OneClickClient;
  isRegistered(accountId: string): Promise<boolean>;
  /** The treasury's USDC balance (v2 keeps no ledger: this is the token's number). */
  balance(): Promise<bigint>;
  addSupplier(p: { chain: Chain; recipient: string; assetId?: string; register?: boolean }): Promise<number>;
  makeExecutor(
    cfg?: Partial<ExecutorConfig>,
    deps?: { notifier?: Notifier; journal?: Journal; nowMs?: () => number },
  ): { executor: Executor; notifier: MemoryNotifier; journal: Journal };
  stop(): Promise<void>;
};

export async function startWorld(opts: WorldOptions = {}): Promise<World> {
  const log = opts.log ?? (() => {});
  const net = await startDevnet({ extra: ["acme.near", "oneclick.near", "mallory.near", ...(opts.extraAccounts ?? [])] });
  try {
    const ids = defaultRoleIds(net.owner.id);
    const agentKey = KeyPair.fromRandom("ed25519");
    const executorKey = KeyPair.fromRandom("ed25519");
    const { policy: wasm } = ensureWasm();
    const plan = {
      ownerId: net.owner.id,
      policyId: ids.policyId,
      // The mainnet amounts (scripts/src/setup.ts defaults), so the tests run on the same budget.
      agent: { accountId: ids.agentId, publicKey: agentKey.getPublicKey().toString(), balance: near("0.15"), allowance: near("0.5") },
      executor: {
        accountId: ids.executorId,
        publicKey: executorKey.getPublicKey().toString(),
        balance: near("0.2"),
        allowance: near("1"),
      },
      treasuryToken: net.token.id,
      treasuryDecimals: 6,
      policy: worldPolicy(opts.policy),
      wasm,
      policyBalance: suggestedPolicyBalance(wasm.length),
    };
    const ownerAccount = net.owner.account;
    await createRoleAccount(ownerAccount, plan.policyId, plan.agent, AGENT_METHODS);
    await createRoleAccount(ownerAccount, plan.policyId, plan.executor, EXECUTOR_METHODS);
    await deployPolicy(ownerAccount, plan);
    await registerTreasury(ownerAccount, plan);
    await topUp(ownerAccount, plan, opts.topUp ?? 500n * USDC);
    log(`deployed ${plan.policyId} (agent ${ids.agentId}, executor ${ids.executorId})`);

    const view = new PolicyView(net.rpc, plan.policyId);
    const owner = new OwnerClient(ownerAccount, plan.policyId);

    const agentAccount = net.as(ids.agentId, agentKey.toString());
    const executorAccount = net.as(ids.executorId, executorKey.toString());
    const solver = net.accounts["oneclick.near"]!;
    const mock = new MockOneClick({
      rpcUrl: net.rpcUrl,
      token: net.token.id,
      solver: { accountId: solver.id, privateKey: solver.privateKey },
      destinations: [
        {
          assetId: TRON_USDT,
          symbol: "USDT",
          blockchain: "tron",
          decimals: 6,
          withdrawFee: opts.tronWithdrawFee ?? 200_000n,
          contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        },
      ],
      processingMs: 1_000,
      pollMs: 300,
      log,
      ...opts.mock,
    });
    await mock.start();
    const oneclick = new OneClickClient({ baseUrl: mock.url });
    const executorCalls = new ExecutorClient(executorAccount, plan.policyId);

    const isRegistered = async (accountId: string) =>
      (await net.rpc.callFunction({
        contractId: net.token.id,
        method: "storage_balance_of",
        args: { account_id: accountId },
      })) != null;

    const world: World = {
      net,
      policyId: plan.policyId,
      view,
      owner,
      agent: new AgentClient(agentAccount, plan.policyId),
      executorCalls,
      agentAccount,
      executorAccount,
      mock,
      oneclick,
      isRegistered,
      balance: () => net.ftBalance(plan.policyId),
      addSupplier: async (p) => {
        // A native payout reaches only an account registered on the token; the owner pays that.
        if (p.register && p.chain === "NEAR" && !(await isRegistered(p.recipient))) {
          await registerOnToken(ownerAccount, net.token.id, p.recipient);
        }
        const out = await owner.addSupplier({
          chain: p.chain,
          asset_id: p.assetId ?? (p.chain === "NEAR" ? `nep141:${net.token.id}` : TRON_USDT),
          recipient: p.recipient,
          decimals: 6,
        });
        return out.value;
      },
      makeExecutor: (cfg = {}, deps = {}) => {
        const notifier = deps.notifier instanceof MemoryNotifier ? deps.notifier : new MemoryNotifier();
        const journal = deps.journal ?? new Journal(null);
        const executor = new Executor(
          { policyId: plan.policyId, originAsset: `nep141:${net.token.id}`, dashboardUrl: "http://dashboard.test", ...cfg },
          {
            view,
            calls: executorCalls,
            oneclick,
            notifier: deps.notifier ?? notifier,
            journal,
            ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
            log,
          },
        );
        return { executor, notifier, journal };
      },
      stop: async () => {
        await mock.stop();
        await net.stop();
      },
    };
    return world;
  } catch (error) {
    await net.stop();
    throw error;
  }
}
