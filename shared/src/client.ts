/**
 * Typed access to the v2 policy contract (docs/decisions.md D-28), split by role so each service
 * holds only the methods its key can call: `PolicyView` (anyone), `AgentClient`,
 * `ExecutorClient`, `OwnerClient`.
 *
 * Views and the agent/executor calls are Borsh (decoded strictly in `types.ts`); owner calls are
 * flat JSON that the owner's wallet shows as signed. Calls return the parsed transaction outcome
 * and throw `ContractCallError` (with the contract's panic code) when its final status fails.
 */
import { Account, actions, type Provider } from "near-api-js";

import { ContractCallError, parseOutcome, type TxOutcome } from "./outcome.ts";
import {
  decodeIntents,
  decodeProposeResult,
  decodeState,
  decodeSuppliers,
  decodeU32,
  encodeCreateAttempt,
  encodeId,
  encodeIds,
  encodePropose,
  encodeRange,
  type Chain,
  type Intent,
  type OwnerAction,
  type Policy,
  type ProposeResult,
  type ReviewFlag,
  type StateView,
  type Supplier,
} from "./types.ts";
import { ONE_YOCTO, tgas } from "./units.ts";

/** Ids per view page (the contract's MAX_BATCH). */
export const PAGE = 50;

// ── Views ────────────────────────────────────────────────────────────────────────────────────

export class PolicyView {
  constructor(
    readonly provider: Provider,
    readonly contractId: string,
  ) {}

  private async raw(method: string, args: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const { result } = await this.provider.callFunctionRaw({ contractId: this.contractId, method, args });
    return Uint8Array.from(result);
  }

  private async decode<T>(method: string, args: Uint8Array | undefined, decode: (b: Uint8Array) => T): Promise<T> {
    const bytes = await this.raw(method, args);
    try {
      return decode(bytes);
    } catch (error) {
      throw new Error(`${this.contractId}.${method} returned an unexpected layout: ${(error as Error).message}`);
    }
  }

  state(): Promise<StateView> {
    return this.decode("get_state", undefined, decodeState);
  }

  /** Every supplier (ids are dense from 1). */
  async suppliers(): Promise<Supplier[]> {
    const { next_supplier_id } = await this.state();
    const all: Supplier[] = [];
    for (let from = 1; from < next_supplier_id; from += PAGE) {
      all.push(...(await this.decode("get_suppliers", encodeRange(from, PAGE, false), decodeSuppliers)));
    }
    return all;
  }

  async supplier(id: number): Promise<Supplier | null> {
    const [s] = await this.decode("get_suppliers", encodeRange(id, 1, false), decodeSuppliers);
    return s?.id === id ? s : null;
  }

  /** Stored intents with ids in `[from, from + limit)` (forgotten ids are skipped). */
  intents(from: number, limit = PAGE): Promise<Intent[]> {
    return this.decode("get_intents", encodeRange(from, Math.min(limit, PAGE), true), decodeIntents);
  }

  async intent(id: number): Promise<Intent | null> {
    const [i] = await this.intents(id, 1);
    return i?.id === id ? i : null;
  }

  /** Stored intents with ids from `from` up to the newest (several pages if needed). */
  async intentsSince(from: number, next?: number): Promise<Intent[]> {
    const end = next ?? (await this.state()).next_intent_id;
    const all: Intent[] = [];
    for (let id = Math.max(1, from); id < end; id += PAGE) all.push(...(await this.intents(id, PAGE)));
    return all;
  }

  /** The newest `count` intent ids that are still stored. */
  async recentIntents(count = PAGE): Promise<Intent[]> {
    const { next_intent_id } = await this.state();
    return this.intentsSince(Math.max(1, next_intent_id - count), next_intent_id);
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────────

export type CallOptions = { gas?: bigint; deposit?: bigint };

/** Gas per method. A payout needs at least 60 TGas (the contract checks; 60 is proven on a real
 *  node). Attach no more than needed: NEAR checks the signer's balance against the attached gas
 *  at a worst-case price (≈0.001 NEAR per TGas, docs/verified-facts.md), so a role account must
 *  hold about 0.07 NEAR spendable to send a 70 TGas call, although it burns far less. */
export const GAS = {
  propose: tgas(70),
  createAttempt: tgas(30),
  fund: tgas(80),
  forget: tgas(80),
  owner: tgas(30),
  ownerPayout: tgas(80),
  upgrade: tgas(300),
} as const;

class Caller {
  constructor(
    readonly account: Account,
    readonly contractId: string,
  ) {}

  /** Signs and sends one function call; throws ContractCallError if the final status failed. */
  async call<T = unknown>(method: string, args: Record<string, unknown> | Uint8Array, opts: Required<CallOptions>): Promise<TxOutcome<T>> {
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

function borshValue<T>(outcome: TxOutcome, decode: (b: Uint8Array) => T, method: string): TxOutcome<T> {
  if (!outcome.bytes) throw new Error(`${method} returned nothing`);
  return { ...outcome, value: decode(outcome.bytes) };
}

/** The agent's only power: propose. No model output becomes anything on-chain but the flag. */
export class AgentClient extends Caller {
  async propose(p: { obligationId: string; supplierId: number; amountOut: bigint; reviewFlag: ReviewFlag | null }): Promise<TxOutcome<ProposeResult>> {
    const outcome = await this.call("propose", encodePropose(p), { gas: GAS.propose, deposit: 0n });
    return borshValue(outcome, decodeProposeResult, "propose");
  }
}

/** The executor: cross-chain attempts, funding by id only, and housekeeping. */
export class ExecutorClient extends Caller {
  createAttempt(p: { intentId: number; depositAddress: string; amountIn: bigint; deadlineNs: bigint }) {
    return this.call("create_attempt", encodeCreateAttempt({ intentId: p.intentId, deposit: p.depositAddress, amountIn: p.amountIn, deadlineNs: p.deadlineNs }), {
      gas: GAS.createAttempt,
      deposit: 0n,
    });
  }

  fund(intentId: number) {
    return this.call("fund", encodeId(intentId), { gas: GAS.fund, deposit: 0n });
  }

  async forget(intentIds: number[]): Promise<TxOutcome<number>> {
    const outcome = await this.call("forget", encodeIds(intentIds), { gas: GAS.forget, deposit: 0n });
    return borshValue(outcome, decodeU32, "forget");
  }
}

/** Owner calls: flat JSON with exactly 1 yoctoNEAR (needs a full-access key). */
export class OwnerClient extends Caller {
  private owner(method: string, args: Record<string, unknown>, gas: bigint = GAS.owner) {
    return this.call(method, args, { gas, deposit: ONE_YOCTO });
  }

  /** The decision names the intent's terms, as the wallet will show them. */
  decide(intent: Pick<Intent, "id" | "amount_out" | "supplier_id">, action: OwnerAction) {
    const payout = action === "APPROVE" || action === "RETRY";
    return this.owner(
      "decide",
      { intent_id: intent.id, action, amount_out: intent.amount_out, supplier_id: intent.supplier_id },
      payout ? GAS.ownerPayout : GAS.owner,
    );
  }

  /** Signs for exactly this deposit and amount (as shown by 1Click to the owner). */
  authorize(intentId: number, deposit: string, amountIn: string) {
    return this.owner("authorize", { intent_id: intentId, deposit, amount_in: amountIn });
  }

  async addSupplier(p: { chain: Chain; asset_id: string; recipient: string; decimals: number }): Promise<TxOutcome<number>> {
    const outcome = await this.owner("add_supplier", p);
    return borshValue(outcome, decodeU32, "add_supplier");
  }

  updateSupplier(p: { supplier_id: number; chain: Chain; asset_id: string; recipient: string; decimals: number }) {
    return this.owner("update_supplier", p);
  }

  setSupplierActive(supplierId: number, active: boolean) {
    return this.owner("set_supplier_active", { supplier_id: supplierId, active });
  }

  setPolicy(policy: Policy) {
    return this.owner("set_policy", policy);
  }

  setPaused(paused: boolean) {
    return this.owner("set_paused", { paused });
  }

  setRoles(agentId: string, executorId: string) {
    return this.owner("set_roles", { agent_id: agentId, executor_id: executorId });
  }

  withdraw(amount: bigint) {
    return this.owner("withdraw", { amount: amount.toString() }, GAS.ownerPayout);
  }

  withdrawNear(amountYocto: bigint) {
    return this.owner("withdraw_near", { amount: amountYocto.toString() });
  }

  forget(intentIds: number[]) {
    return this.call("forget", encodeIds(intentIds), { gas: GAS.forget, deposit: ONE_YOCTO });
  }

  upgrade(wasm: Uint8Array) {
    return this.call("upgrade", wasm, { gas: GAS.upgrade, deposit: ONE_YOCTO });
  }
}
