/**
 * mock-1click: a local stand-in for the NEAR Intents 1Click API (PLAN §4.2 step 7), mirroring the
 * live schema recorded in docs/verified-facts.md. It runs against a local NEAR node and moves real
 * (mock) tokens, so the executor, the contract and the owner's reconciliation are exercised end to
 * end without mainnet:
 *
 * - `POST /v0/quote` signs quotes (ed25519) and, for non-dry quotes, creates a deposit address: a
 *   fresh 64-hex implicit account, unregistered on the token (as on mainnet).
 * - A settlement loop watches each deposit address's token balance and plays a scenario:
 *   `success` (deposit goes to the solver, a fake Tron tx is reported), `change` (success, and the
 *   part of the deposit above `minAmountIn` comes back to `refundTo`), `refund` (the swap fails and
 *   everything comes back), `slow` (long processing) and `outage` (`/v0/status` answers 503).
 *   Deposits below `minAmountIn` end as `INCOMPLETE_DEPOSIT` and are refunded.
 * - Returned funds arrive at the policy contract with a plain `ft_transfer`, so they show up as
 *   unreconciled inflow until the owner attributes them.
 *
 * Control endpoints (mock only): `POST /v0/mock/scenario {scenario, count?}`, `GET /v0/mock/signer`,
 * `POST /v0/mock/outage {on}`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Account,
  actions,
  baseEncode,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  keyToImplicitAddress,
  type KeyPairString,
} from "near-api-js";

import {
  near,
  parseOutcome,
  QuoteRequest,
  tgas,
  type ExecutionStatus,
  type QuoteResponse,
  type StatusResponse,
} from "@getleash/shared";

export type Scenario = "success" | "change" | "refund" | "slow" | "outage";

export type MockAsset = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  /** Fixed withdrawal fee, in this asset's base units. */
  withdrawFee: bigint;
  contractAddress?: string;
};

export type MockOptions = {
  rpcUrl: string;
  /** The origin token contract on the local node (the treasury token). */
  token: string;
  /** Account that receives swapped deposits and pays gas for deposit accounts. */
  solver: { accountId: string; privateKey: string };
  destinations: MockAsset[];
  port?: number;
  /** Percentage route fee, in basis points. */
  feeBps?: number;
  processingMs?: number;
  pollMs?: number;
  /** If set, quotes without this X-API-Key are refused (mirrors authenticated use). */
  requireJwt?: string;
  /** NEAR the solver sends to create a deposit account before moving its tokens (default 1; testnet: 0.05). */
  depositAccountNear?: string;
  log?: (line: string) => void;
};

type Deposit = {
  address: string;
  key: KeyPair;
  response: QuoteResponse;
  scenario: Scenario;
  status: ExecutionStatus;
  updatedAt: string;
  submittedTx: string | null;
  deposited: bigint | null;
  refunded: bigint;
  amountInUsed: bigint | null;
  destTx: string | null;
  refundReason: string | null;
  processingSince: number | null;
  busy: boolean;
  /** Settlement transfers already made, so a retried step never pays twice. */
  paid: Set<string>;
};

/** Deterministic JSON (sorted keys), the shape of the real signature's preimage. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function quotePreimage(r: Pick<QuoteResponse, "quoteRequest" | "quote" | "timestamp">): Uint8Array {
  return createHash("sha256").update(canonicalJson({ ...r.quoteRequest, ...r.quote, timestamp: r.timestamp })).digest();
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function rescale(units: bigint, from: number, to: number): bigint {
  return to >= from ? units * 10n ** BigInt(to - from) : ceilDiv(units, 10n ** BigInt(from - to));
}

function formatUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${units / base}.${frac}` : `${units / base}`;
}

export class MockOneClick {
  readonly signer = KeyPair.fromRandom("ed25519");
  private readonly rpc: JsonRpcProvider;
  private readonly solver: Account;
  private readonly deposits = new Map<string, Deposit>();
  private readonly scenarios: Scenario[] = [];
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private outage = false;
  private originDecimals = 6;
  url = "";

  constructor(private readonly opts: MockOptions) {
    this.rpc = new JsonRpcProvider({ url: opts.rpcUrl });
    this.solver = new Account(
      opts.solver.accountId,
      this.rpc,
      KeyPairSigner.fromSecretKey(opts.solver.privateKey as KeyPairString),
    );
  }

  get originAsset(): string {
    return `nep141:${this.opts.token}`;
  }

  /** Queue scenarios for the next non-dry quotes (default: success). */
  setScenario(scenario: Scenario, count = 1) {
    for (let i = 0; i < count; i++) this.scenarios.push(scenario);
  }

  setOutage(on: boolean) {
    this.outage = on;
  }

  depositInfo(address: string) {
    const d = this.deposits.get(address);
    return d ? { status: d.status, deposited: d.deposited, refunded: d.refunded, destTx: d.destTx } : null;
  }

  async start(): Promise<string> {
    // The solver receives deposits on the token, so it must be registered.
    await this.ensureRegistered(this.opts.solver.accountId);
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error: unknown) => {
        this.log(`error: ${(error as Error).stack ?? error}`);
        send(res, 500, { message: "Internal server error" });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port ?? 0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    this.timer = setInterval(() => void this.settle(), this.opts.pollMs ?? 500);
    this.log(`mock-1click listening on ${this.url} (signer ${this.signer.getPublicKey().toString()})`);
    return this.url;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Like the live API (docs/verified-facts.md), any origin may call it: the attempt page fetches
    // the status straight from the owner's browser.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, X-API-Key, Authorization",
      });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/v0/tokens") return send(res, 200, this.tokens());
    if (req.method === "GET" && url.pathname === "/v0/mock/signer") {
      return send(res, 200, { publicKey: this.signer.getPublicKey().toString() });
    }
    if (req.method === "POST" && url.pathname === "/v0/mock/scenario") {
      const body = (await readJson(req)) as { scenario: Scenario; count?: number };
      this.setScenario(body.scenario, body.count ?? 1);
      return send(res, 200, { queued: this.scenarios });
    }
    if (req.method === "POST" && url.pathname === "/v0/mock/outage") {
      this.setOutage(Boolean(((await readJson(req)) as { on: boolean }).on));
      return send(res, 200, { outage: this.outage });
    }
    if (req.method === "POST" && url.pathname === "/v0/quote") {
      if (this.opts.requireJwt && req.headers["x-api-key"] !== this.opts.requireJwt) {
        return send(res, 401, { message: "Unauthorized" });
      }
      const parsed = QuoteRequest.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { message: parsed.error.message });
      const result = this.quote(parsed.data);
      return "error" in result ? send(res, 400, { message: result.error }) : send(res, 201, result);
    }
    if (req.method === "GET" && url.pathname === "/v0/status") {
      if (this.outage) return send(res, 503, { message: "Service unavailable (mock outage)" });
      const deposit = this.deposits.get(url.searchParams.get("depositAddress") ?? "");
      if (!deposit) return send(res, 404, { message: "Deposit address not found" });
      if (deposit.scenario === "outage" && deposit.status !== "PENDING_DEPOSIT") {
        return send(res, 503, { message: "Service unavailable (mock outage)" });
      }
      return send(res, 200, this.statusOf(deposit));
    }
    if (req.method === "POST" && url.pathname === "/v0/deposit/submit") {
      const body = (await readJson(req)) as { txHash?: string; depositAddress?: string };
      const deposit = this.deposits.get(body.depositAddress ?? "");
      if (!deposit || !body.txHash) return send(res, 400, { message: "Unknown deposit address" });
      deposit.submittedTx = body.txHash;
      if (deposit.status === "PENDING_DEPOSIT") this.setStatus(deposit, "KNOWN_DEPOSIT_TX");
      return send(res, 201, this.statusOf(deposit));
    }
    send(res, 404, { message: "Not found" });
  }

  private tokens() {
    return [
      { assetId: this.originAsset, decimals: this.originDecimals, blockchain: "near", symbol: "USDC", price: 1, contractAddress: this.opts.token },
      ...this.opts.destinations.map((d) => ({
        assetId: d.assetId,
        decimals: d.decimals,
        blockchain: d.blockchain,
        symbol: d.symbol,
        price: 1,
        contractAddress: d.contractAddress,
      })),
    ];
  }

  private quote(request: QuoteRequest): QuoteResponse | { error: string } {
    if (request.originAsset !== this.originAsset) return { error: `unsupported originAsset ${request.originAsset}` };
    const dest = this.opts.destinations.find((d) => d.assetId === request.destinationAsset);
    if (!dest) return { error: `unsupported destinationAsset ${request.destinationAsset}` };
    if (request.swapType !== "EXACT_OUTPUT" && request.swapType !== "EXACT_INPUT") {
      return { error: `mock supports EXACT_OUTPUT and EXACT_INPUT, not ${request.swapType}` };
    }
    if (request.depositType !== "ORIGIN_CHAIN") return { error: "mock supports depositType ORIGIN_CHAIN only" };
    if (Number.isNaN(Date.parse(request.deadline))) return { error: "invalid deadline" };

    const feeBps = BigInt(this.opts.feeBps ?? 1);
    const slip = BigInt(request.slippageTolerance);
    let amountOut: bigint;
    let minAmountIn: bigint;
    let amountIn: bigint;
    if (request.swapType === "EXACT_OUTPUT") {
      amountOut = BigInt(request.amount);
      const gross = rescale(amountOut + dest.withdrawFee, dest.decimals, this.originDecimals);
      minAmountIn = ceilDiv(gross * (10_000n + feeBps), 10_000n);
      amountIn = ceilDiv(minAmountIn * (10_000n + slip), 10_000n);
    } else {
      amountIn = BigInt(request.amount);
      minAmountIn = amountIn;
      const net = (rescale(amountIn, this.originDecimals, dest.decimals) * 10_000n) / (10_000n + feeBps);
      amountOut = net > dest.withdrawFee ? net - dest.withdrawFee : 0n;
    }
    const timestamp = new Date().toISOString();
    const quote: QuoteResponse["quote"] = {
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, this.originDecimals),
      amountInUsd: formatUnits(amountIn, this.originDecimals),
      minAmountIn: minAmountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnits(amountOut, dest.decimals),
      amountOutUsd: formatUnits(amountOut, dest.decimals),
      minAmountOut: request.swapType === "EXACT_OUTPUT" ? amountOut.toString() : ((amountOut * (10_000n - slip)) / 10_000n).toString(),
      timeEstimate: 20,
      refundFee: "0",
      withdrawFee: dest.withdrawFee.toString(),
    };
    let key: KeyPair | null = null;
    if (!request.dry) {
      key = KeyPair.fromRandom("ed25519");
      // As on mainnet: the deposit address stays active 3 days past the requested deadline.
      const inactive = new Date(Date.parse(request.deadline) + 3 * 86_400_000).toISOString();
      Object.assign(quote, {
        depositAddress: keyToImplicitAddress(key.getPublicKey()),
        deadline: inactive,
        timeWhenInactive: inactive,
      });
    }
    const echoed = { ...request, depositMode: request.depositMode ?? "SIMPLE" };
    const unsigned = { quoteRequest: echoed, quote, timestamp };
    const signature = `ed25519:${baseEncode(this.signer.sign(quotePreimage(unsigned)).signature)}`;
    const response: QuoteResponse = { correlationId: randomUUID(), timestamp, signature, quoteRequest: echoed, quote };
    if (key) {
      const address = quote.depositAddress as string;
      this.deposits.set(address, {
        address,
        key,
        response,
        scenario: this.scenarios.shift() ?? "success",
        status: "PENDING_DEPOSIT",
        updatedAt: timestamp,
        submittedTx: null,
        deposited: null,
        refunded: 0n,
        amountInUsed: null,
        destTx: null,
        refundReason: null,
        processingSince: null,
        busy: false,
        paid: new Set(),
      });
      this.log(`quote ${address.slice(0, 8)}… ${quote.amountIn} in → ${quote.amountOut} out (${this.deposits.get(address)!.scenario})`);
    }
    return response;
  }

  private statusOf(d: Deposit): StatusResponse {
    const { correlationId: _drop, ...quoteResponse } = d.response;
    const settled = d.status === "SUCCESS";
    return {
      correlationId: randomUUID(),
      quoteResponse,
      status: d.status,
      updatedAt: d.updatedAt,
      swapDetails: {
        intentHashes: d.deposited ? [createHash("sha256").update(d.address).digest("hex")] : [],
        nearTxHashes: d.submittedTx ? [d.submittedTx] : [],
        amountIn: d.amountInUsed?.toString() ?? null,
        amountOut: settled ? d.response.quote.amountOut : null,
        depositedAmount: d.deposited?.toString() ?? null,
        refundedAmount: d.refunded.toString(),
        refundReason: d.refundReason,
        refundFee: "0",
        withdrawFee: d.response.quote.withdrawFee ?? "0",
        originChainTxHashes: d.submittedTx ? [{ hash: d.submittedTx, explorerUrl: "" }] : [],
        destinationChainTxHashes: d.destTx ? [{ hash: d.destTx, explorerUrl: `https://tronscan.org/#/transaction/${d.destTx}` }] : [],
      },
    };
  }

  // ── Settlement ───────────────────────────────────────────────────────────────────────────

  private setStatus(d: Deposit, status: ExecutionStatus) {
    d.status = status;
    d.updatedAt = new Date().toISOString();
    this.log(`deposit ${d.address.slice(0, 8)}… → ${status}`);
  }

  private async settle() {
    for (const d of this.deposits.values()) {
      if (d.busy || ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(d.status)) continue;
      d.busy = true;
      try {
        await this.advance(d);
      } catch (error) {
        this.log(`settle ${d.address.slice(0, 8)}…: ${(error as Error).message}`);
      } finally {
        d.busy = false;
      }
    }
  }

  private async advance(d: Deposit) {
    if (d.status === "PENDING_DEPOSIT" || d.status === "KNOWN_DEPOSIT_TX") {
      const balance = await this.balanceOf(d.address);
      if (balance === 0n) return;
      d.deposited = balance;
      const minIn = BigInt(d.response.quote.minAmountIn);
      if (balance < minIn) {
        d.refundReason = "DEPOSIT_BELOW_MIN_AMOUNT_IN";
        await this.payOnce(d, "refund", d.response.quoteRequest.refundTo, balance);
        d.refunded = balance;
        return this.setStatus(d, "INCOMPLETE_DEPOSIT");
      }
      d.processingSince = Date.now();
      return this.setStatus(d, "PROCESSING");
    }
    if (d.status !== "PROCESSING" || d.deposited === null || d.processingSince === null) return;
    const wait = (this.opts.processingMs ?? 1_500) * (d.scenario === "slow" ? 20 : 1);
    if (Date.now() - d.processingSince < wait) return;

    const refundTo = d.response.quoteRequest.refundTo;
    if (d.scenario === "refund") {
      d.refundReason = "SWAP_FAILED";
      await this.payOnce(d, "refund", refundTo, d.deposited);
      d.refunded = d.deposited;
      return this.setStatus(d, "REFUNDED");
    }
    const minIn = BigInt(d.response.quote.minAmountIn);
    const used = d.scenario === "change" ? minIn : d.deposited;
    const change = d.deposited - used;
    await this.payOnce(d, "solver", this.opts.solver.accountId, used);
    if (change > 0n) {
      await this.payOnce(d, "change", refundTo, change);
      d.refunded = change;
      d.refundReason = "EXCESS_DEPOSIT";
    }
    d.amountInUsed = used;
    d.destTx = createHash("sha256").update(`tron:${d.address}`).digest("hex");
    this.setStatus(d, "SUCCESS");
  }

  private async balanceOf(accountId: string): Promise<bigint> {
    const value = await this.rpc.callFunction({ contractId: this.opts.token, method: "ft_balance_of", args: { account_id: accountId } });
    return BigInt((value as string | undefined) ?? "0");
  }

  private async ensureRegistered(accountId: string) {
    const registered = await this.rpc.callFunction({
      contractId: this.opts.token,
      method: "storage_balance_of",
      args: { account_id: accountId },
    });
    if (registered) return;
    const out = parseOutcome(
      await this.solver.signAndSendTransaction({
        receiverId: this.opts.token,
        actions: [actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, tgas(30), near("0.00125"))],
        throwOnFailure: false,
      }),
    );
    if (!out.ok) throw new Error(`registering ${accountId}: ${JSON.stringify(out.failures)}`);
  }

  private async payOnce(d: Deposit, step: string, receiverId: string, amount: bigint) {
    if (d.paid.has(step)) return;
    await this.payOut(d, receiverId, amount);
    d.paid.add(step);
  }

  /** Sends tokens out of a deposit account, creating the implicit account (gas money) first. */
  private async payOut(d: Deposit, receiverId: string, amount: bigint) {
    if (amount <= 0n) return;
    try {
      await this.rpc.viewAccount({ accountId: d.address });
    } catch {
      await this.solver.signAndSendTransaction({ receiverId: d.address, actions: [actions.transfer(near(this.opts.depositAccountNear ?? "1"))] });
    }
    const depositAccount = new Account(d.address, this.rpc, new KeyPairSigner(d.key));
    const out = parseOutcome(
      await depositAccount.signAndSendTransaction({
        receiverId: this.opts.token,
        actions: [actions.functionCall("ft_transfer", { receiver_id: receiverId, amount: amount.toString() }, tgas(30), 1n)],
        throwOnFailure: false,
      }),
    );
    if (!out.ok) throw new Error(`ft_transfer to ${receiverId} failed: ${JSON.stringify(out.failures)}`);
    this.log(`moved ${amount} from ${d.address.slice(0, 8)}… to ${receiverId}`);
  }

  private log(line: string) {
    this.opts.log?.(`[mock-1click] ${line}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
