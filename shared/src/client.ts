/**
 * Typed access to the policy contract, split by role so each service holds only the methods its key
 * can call: `PolicyView` (anyone), `AgentClient`, `ExecutorClient`, `OwnerClient`.
 *
 * Every view result is validated with the schemas in `types.ts`. Calls return the parsed
 * transaction outcome and throw `ContractCallError` (with the contract's panic code) when the
 * transaction's final status is a failure.
 */
import { Account, actions, type Provider } from "near-api-js";
import { z } from "zod";

import { ContractCallError, parseOutcome, type TxOutcome } from "./outcome.ts";
import {
  AssetEntry,
  Attempt,
  BudgetsView,
  ConfigView,
  Intent,
  Ledger,
  OpenWorkItem,
  Policy,
  ProposeResult,
  Rejection,
  Supplier,
  SweepResult,
  type Chain,
  type InflowEntry,
  type ReconcileOutcome,
  type ReviewFlag,
} from "./types.ts";
import { ONE_YOCTO, tgas } from "./units.ts";

type Schema<T> = z.ZodType<T>;

const NumberId = z.number().int().nonnegative();
const OpenIntentIdSchema = NumberId.nullable();

// ── Views ────────────────────────────────────────────────────────────────────────────────────

export class PolicyView {
  constructor(
    readonly provider: Provider,
    readonly contractId: string,
  ) {}

  private async view<T>(method: string, args: Record<string, unknown>, schema: Schema<T>): Promise<T> {
    const raw = await this.provider.callFunction({ contractId: this.contractId, method, args });
    const parsed = schema.safeParse(raw === undefined ? null : raw);
    if (!parsed.success) {
      throw new Error(`${this.contractId}.${method} returned an unexpected shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  config() {
    return this.view("get_config", {}, ConfigView);
  }
  policy() {
    return this.view("get_policy", {}, Policy);
  }
  ledger() {
    return this.view("get_ledger", {}, Ledger);
  }
  budgetsToday() {
    return this.view("get_budgets_today", {}, BudgetsView);
  }
  supplier(supplierId: number) {
    return this.view("get_supplier", { supplier_id: supplierId }, Supplier.nullable());
  }
  suppliers(fromIndex = 0, limit = 256) {
    return this.view("list_suppliers", { from_index: fromIndex, limit }, Supplier.array());
  }
  assets() {
    return this.view("list_assets", {}, AssetEntry.array());
  }
  intent(intentId: number) {
    return this.view("get_intent", { intent_id: intentId }, Intent.nullable());
  }
  attempt(attemptId: number) {
    return this.view("get_attempt", { attempt_id: attemptId }, Attempt.nullable());
  }
  obligation(obligationIdHex: string) {
    return this.view("get_obligation", { obligation_id: obligationIdHex }, OpenIntentIdSchema);
  }
  openWork() {
    return this.view("get_open_work", {}, OpenWorkItem.array());
  }
  recentRejections() {
    return this.view("get_recent_rejections", {}, Rejection.array());
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────────

export type CallOptions = { gas?: bigint; deposit?: bigint };

/** Gas per method, sized from the sandbox runs with headroom. FC-key allowances pay for this. */
export const GAS = {
  propose: tgas(50),
  createAttempt: tgas(50),
  register: tgas(50),
  /** The contract requires at least 60 TGas so the transfer and its callback both fit. */
  fund: tgas(100),
  small: tgas(30),
  housekeeping: tgas(150),
  owner: tgas(50),
  ownerTransfer: tgas(100),
  upgrade: tgas(300),
} as const;

class Caller {
  constructor(
    readonly account: Account,
    readonly contractId: string,
  ) {}

  /** Signs and sends one function call; throws ContractCallError if the final status failed. */
  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> | Uint8Array,
    opts: Required<CallOptions>,
  ): Promise<TxOutcome<T>> {
    const raw = await this.account.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(method, args, opts.gas, opts.deposit)],
      throwOnFailure: false,
    });
    const outcome = parseOutcome<T>(raw);
    if (!outcome.finalOk) {
      const last = outcome.failures.at(-1);
      throw new ContractCallError(method, last?.panic ?? last?.message ?? "UNKNOWN_FAILURE", outcome.txHash, outcome);
    }
    return outcome;
  }
}

function parsed<T>(outcome: TxOutcome, schema: Schema<T>, method: string): TxOutcome<T> {
  const result = schema.safeParse(outcome.value);
  if (!result.success) throw new Error(`${method} returned an unexpected shape: ${result.error.message}`);
  return { ...outcome, value: result.data };
}

/** The agent's only power: propose. No amount of model output becomes anything else on-chain. */
export class AgentClient extends Caller {
  async propose(p: {
    obligationId: string;
    supplierId: number;
    amountOut: bigint | string;
    reviewFlag: ReviewFlag | null;
  }) {
    const out = await this.call(
      "propose_payment",
      {
        obligation_id: p.obligationId,
        supplier_id: p.supplierId,
        amount_out: p.amountOut.toString(),
        review_flag: p.reviewFlag,
      },
      { gas: GAS.propose, deposit: 0n },
    );
    return parsed(out, ProposeResult, "propose_payment");
  }
}

/** Executor methods. Funding takes an attempt id only (AGENTS.md hard rule). */
export class ExecutorClient extends Caller {
  async createAttemptNative(intentId: number) {
    const out = await this.call("create_attempt_native", { intent_id: intentId }, { gas: GAS.createAttempt, deposit: 0n });
    return parsed(out, NumberId, "create_attempt_native");
  }

  async createAttemptCrosschain(p: {
    intentId: number;
    depositAddress: string;
    amountIn: bigint | string;
    quoteDeadlineNs: bigint | string;
    quoteRef: string;
  }) {
    const out = await this.call(
      "create_attempt_crosschain",
      {
        intent_id: p.intentId,
        deposit_address: p.depositAddress,
        amount_in: p.amountIn.toString(),
        quote_deadline: p.quoteDeadlineNs.toString(),
        quote_ref: p.quoteRef,
      },
      { gas: GAS.createAttempt, deposit: 0n },
    );
    return parsed(out, NumberId, "create_attempt_crosschain");
  }

  registerRecipient(attemptId: number) {
    return this.call("register_recipient", { attempt_id: attemptId }, { gas: GAS.register, deposit: 0n });
  }

  fundNative(attemptId: number) {
    return this.call("fund_native", { attempt_id: attemptId }, { gas: GAS.fund, deposit: 0n });
  }

  fundCrosschain(attemptId: number) {
    return this.call("fund_crosschain", { attempt_id: attemptId }, { gas: GAS.fund, deposit: 0n });
  }

  reportDelivery(attemptId: number, deliveredAmount: bigint | string, destTx: string) {
    return this.call(
      "report_delivery",
      { attempt_id: attemptId, delivered_amount: deliveredAmount.toString(), dest_tx: destTx },
      { gas: GAS.small, deposit: 0n },
    );
  }

  flagReconciliation(attemptId: number) {
    return this.call("flag_reconciliation", { attempt_id: attemptId }, { gas: GAS.small, deposit: 0n });
  }

  cancelAttempt(attemptId: number) {
    return this.call("cancel_attempt", { attempt_id: attemptId }, { gas: GAS.small, deposit: 0n });
  }

  async sweep(limit = 20) {
    const out = await this.call("sweep", { limit }, { gas: GAS.housekeeping, deposit: 0n });
    return parsed(out, SweepResult, "sweep");
  }

  async prune(limit = 20) {
    const out = await this.call("prune", { limit }, { gas: GAS.housekeeping, deposit: 0n });
    return parsed(out, NumberId, "prune");
  }
}

/** Owner methods: each attaches exactly 1 yoctoNEAR, so a wallet must confirm it. */
export class OwnerClient extends Caller {
  private owner<T = unknown>(method: string, args: Record<string, unknown> | Uint8Array, gas: bigint = GAS.owner) {
    return this.call<T>(method, args, { gas, deposit: ONE_YOCTO });
  }

  approve(intentId: number, expectedIntentHash: string) {
    return this.owner("approve", { intent_id: intentId, expected_intent_hash: expectedIntentHash });
  }
  reject(intentId: number) {
    return this.owner("reject", { intent_id: intentId });
  }
  cancel(intentId: number) {
    return this.owner("cancel", { intent_id: intentId });
  }
  async amendIntent(intentId: number, amountOut: bigint | string) {
    const out = await this.owner("amend_intent", { intent_id: intentId, amount_out: amountOut.toString() });
    return parsed(out, NumberId, "amend_intent");
  }
  authorizeAttempt(attemptId: number, expectedAttemptHash: string) {
    return this.owner("authorize_attempt", { attempt_id: attemptId, expected_attempt_hash: expectedAttemptHash });
  }
  resolveReconciliation(attemptId: number, outcome: ReconcileOutcome) {
    return this.owner("resolve_reconciliation", { attempt_id: attemptId, outcome });
  }
  reconcileInflows(entries: InflowEntry[]) {
    return this.owner("reconcile_inflows", { entries }, GAS.ownerTransfer);
  }
  addAsset(p: { assetId: string; chain: Chain; decimals: number; maxFixedFee: bigint | string }) {
    return this.owner("add_asset", {
      asset_id: p.assetId,
      chain: p.chain,
      decimals: p.decimals,
      max_fixed_fee: p.maxFixedFee.toString(),
    });
  }
  setAsset(assetId: string, maxFixedFee: bigint | string, enabled: boolean) {
    return this.owner("set_asset", { asset_id: assetId, max_fixed_fee: maxFixedFee.toString(), enabled });
  }
  async addSupplier(p: {
    chain: Chain;
    assetId: string;
    recipient: string;
    perPaymentCap: bigint | string;
    monthlyCap: bigint | string;
  }) {
    const out = await this.owner("add_supplier", {
      chain: p.chain,
      asset_id: p.assetId,
      recipient: p.recipient,
      per_payment_cap: p.perPaymentCap.toString(),
      monthly_cap: p.monthlyCap.toString(),
    });
    return parsed(out, NumberId, "add_supplier");
  }
  updateSupplier(supplierId: number, chain: Chain, assetId: string, recipient: string) {
    return this.owner("update_supplier", { supplier_id: supplierId, chain, asset_id: assetId, recipient });
  }
  setSupplierCaps(supplierId: number, perPaymentCap: bigint | string, monthlyCap: bigint | string) {
    return this.owner("set_supplier_caps", {
      supplier_id: supplierId,
      per_payment_cap: perPaymentCap.toString(),
      monthly_cap: monthlyCap.toString(),
    });
  }
  verifySupplier(supplierId: number, revision: number) {
    return this.owner("verify_supplier", { supplier_id: supplierId, revision });
  }
  setSupplierActive(supplierId: number, active: boolean) {
    return this.owner("set_supplier_active", { supplier_id: supplierId, active });
  }
  setPolicy(policy: Policy) {
    return this.owner("set_policy", { policy });
  }
  setHostedMode(hostedMode: boolean) {
    return this.owner("set_hosted_mode", { hosted_mode: hostedMode });
  }
  pause() {
    return this.owner("pause", {});
  }
  unpause() {
    return this.owner("unpause", {});
  }
  rotateAgent(newAgentId: string) {
    return this.owner("rotate_agent", { new_agent_id: newAgentId });
  }
  rotateExecutor(newExecutorId: string) {
    return this.owner("rotate_executor", { new_executor_id: newExecutorId }, GAS.ownerTransfer);
  }
  withdraw(amount: bigint | string) {
    return this.owner("withdraw", { amount: amount.toString() }, GAS.ownerTransfer);
  }
  withdrawNear(amount: bigint | string) {
    return this.owner("withdraw_near", { amount: amount.toString() }, GAS.ownerTransfer);
  }
  sweep(limit = 20) {
    return this.owner("sweep", { limit }, GAS.housekeeping);
  }
  flagReconciliation(attemptId: number) {
    return this.owner("flag_reconciliation", { attempt_id: attemptId });
  }
  cancelAttempt(attemptId: number) {
    return this.owner("cancel_attempt", { attempt_id: attemptId });
  }
  /** The transaction input is the raw wasm; the contract deploys it and runs `migrate`. */
  upgrade(wasm: Uint8Array) {
    return this.owner("upgrade", wasm, GAS.upgrade);
  }
}
