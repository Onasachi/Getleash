/**
 * Reading transaction outcomes: the decoded return value, every receipt failure, logs and NEP-297
 * events. A transaction's final status alone is not enough: for `fund_*` it is the callback's
 * result, and the `ft_transfer` it guards can fail inside an otherwise "successful" transaction.
 */

export type NepEvent = { standard: string; version: string; event: string; data: unknown[] };

export type ReceiptFailure = { receiptId: string; executorId: string; message: string; panic: string | null };

export type TxOutcome<T = unknown> = {
  txHash: string;
  /** The final status succeeded (for promise chains this is the last receipt's result). */
  finalOk: boolean;
  /** Every receipt succeeded. */
  ok: boolean;
  /** The return value decoded as JSON (or text); null for none. */
  value: T;
  /** The raw return bytes (Borsh results, D-28); null for none. */
  bytes: Uint8Array | null;
  logs: string[];
  events: NepEvent[];
  failures: ReceiptFailure[];
};

type RawOutcome = { status: unknown; logs?: string[]; executor_id?: string };
type RawTx = {
  status: unknown;
  transaction_outcome: { id: string; outcome: RawOutcome };
  receipts_outcome?: Array<{ id: string; outcome: RawOutcome }>;
};

/** Raised when a call's final status is a failure. `code` is the contract's panic message. */
export class ContractCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly txHash: string | null,
    readonly outcome: TxOutcome | null,
  ) {
    super(`${method} failed: ${code}${txHash ? ` (tx ${txHash})` : ""}`);
    this.name = "ContractCallError";
  }
}

const PANIC_PREFIX = "Smart contract panicked: ";

/** Finds the human-readable message inside a NEAR failure object. */
export function failureMessage(failure: unknown): string {
  const found = findExecutionError(failure);
  if (found !== null) return found;
  try {
    return JSON.stringify(failure);
  } catch {
    return String(failure);
  }
}

function findExecutionError(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "ExecutionError" && typeof inner === "string") return inner;
    const nested = findExecutionError(inner);
    if (nested !== null) return nested;
  }
  return null;
}

/** "Smart contract panicked: ONLY_EXECUTOR" → "ONLY_EXECUTOR"; other messages → null. */
export function panicCode(message: string): string | null {
  return message.startsWith(PANIC_PREFIX) ? message.slice(PANIC_PREFIX.length) : null;
}

function statusFailure(status: unknown): unknown {
  if (status && typeof status === "object" && "Failure" in status) return (status as { Failure: unknown }).Failure;
  return undefined;
}

function successBytes(status: unknown): Uint8Array | null {
  if (status && typeof status === "object" && "SuccessValue" in status) {
    const b64 = (status as { SuccessValue: unknown }).SuccessValue;
    if (typeof b64 !== "string" || b64.length === 0) return null;
    // atob works in Node and in the browser (the dashboard parses outcomes too).
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  return null;
}

function decodeSuccess(bytes: Uint8Array | null): unknown {
  if (bytes === null) return null;
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseEvents(logs: string[]): NepEvent[] {
  const events: NepEvent[] = [];
  for (const log of logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    try {
      const parsed = JSON.parse(log.slice("EVENT_JSON:".length)) as NepEvent;
      if (typeof parsed.event === "string") events.push({ ...parsed, data: parsed.data ?? [] });
    } catch {
      // A malformed log is not an event.
    }
  }
  return events;
}

export function parseOutcome<T = unknown>(raw: unknown): TxOutcome<T> {
  const tx = raw as RawTx;
  const outcomes = [
    { id: tx.transaction_outcome.id, outcome: tx.transaction_outcome.outcome },
    ...(tx.receipts_outcome ?? []),
  ];
  const logs = outcomes.flatMap((o) => o.outcome.logs ?? []);
  const failures: ReceiptFailure[] = [];
  for (const o of outcomes) {
    const failure = statusFailure(o.outcome.status);
    if (failure === undefined) continue;
    const message = failureMessage(failure);
    failures.push({ receiptId: o.id, executorId: o.outcome.executor_id ?? "", message, panic: panicCode(message) });
  }
  const finalFailure = statusFailure(tx.status);
  const bytes = successBytes(tx.status);
  return {
    txHash: tx.transaction_outcome.id,
    finalOk: finalFailure === undefined,
    ok: finalFailure === undefined && failures.length === 0,
    value: decodeSuccess(bytes) as T,
    bytes,
    logs,
    events: parseEvents(logs),
    failures,
  };
}

/** The `getleash` events of an outcome, by name. */
export function contractEvents(outcome: TxOutcome, name?: string): Array<Record<string, unknown>> {
  return outcome.events
    .filter((e) => e.standard === "getleash" && (name === undefined || e.event === name))
    .flatMap((e) => e.data as Array<Record<string, unknown>>);
}
