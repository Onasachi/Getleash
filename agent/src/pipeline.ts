/**
 * The agent pipeline (PLAN §4.3): InvoiceInput → extraction (model, untrusted) → deterministic
 * checks → obligation id (ingestion HMAC) → `propose` → stored record and owner notice.
 *
 * What reaches the chain: the obligation id (keyed HMAC), the supplier id (directory match), the
 * amount (cross-checked total, in the supplier's asset units) and at most one enum review flag.
 * The contract then decides; a refusal is a normal, recorded outcome. Within the agent's limits a
 * native payment is sent in that same call (D-28), so the outcome reports whether it was paid.
 */
import { obligationId, type InvoiceInput, pdfText } from "@getleash/ingestion";
import {
  type AgentClient,
  ContractCallError,
  dashboardLink,
  type Directory,
  isRateLimited,
  type IntentStatus,
  type PolicyView,
  type ProposeResult,
  type Supplier,
} from "@getleash/shared";

import { BADGE_LABEL, type Extractor, type ExtractResult } from "./extract.ts";
import { decide, type Decision } from "./rules.ts";
import type { InvoiceStore } from "./store.ts";

export type AgentNotice = { key: string; text: string; link?: string | undefined };

export type AgentOutcome = {
  key: string;
  status: "proposed" | "rejected_onchain" | "needs_owner" | "ignored" | "failed";
  decision: Decision | null;
  result: ProposeResult | null;
  /** The intent's status after the call (a native payment within limits is PAID already). */
  intentStatus: IntentStatus | null;
  /** The intent's `since` when it was read back after the call (native payments), else null. */
  intentSince: string | null;
  /** The on-chain record of the supplier the invoice was matched to (for wording replies), else null. */
  supplier: Supplier | null;
  obligationId: string | null;
  badge: string;
  model: string | null;
  summary: string;
  notices: AgentNotice[];
};

export type AgentDeps = {
  extractor: Extractor;
  view: PolicyView;
  agent: AgentClient;
  tenantSecret: Uint8Array;
  directory: () => Directory;
  store?: InvoiceStore | null;
  dashboardUrl?: string | null;
  /** A hosted business's contract (D-30), named in its dashboard links; null for the dashboard's own. */
  dashboardContract?: string | null;
  log?: (line: string) => void;
};

export class InvoiceAgent {
  constructor(private readonly deps: AgentDeps) {}

  private link(path: string) {
    return dashboardLink(this.deps.dashboardUrl, path, this.deps.dashboardContract) ?? undefined;
  }

  async process(input: InvoiceInput): Promise<AgentOutcome> {
    let extracted: ExtractResult | null = null;
    let decision: Decision | null = null;
    let outcome: AgentOutcome;
    try {
      extracted = await this.extract(input);
      const suppliers = await this.deps.view.suppliers();
      decision = decide(extracted, { directory: this.deps.directory().suppliers, suppliers });
      const matched = decision.action === "propose" ? decision.supplierId : null;
      outcome = await this.act(input, extracted, decision, suppliers.find((s) => s.id === matched) ?? null);
    } catch (error) {
      const busy = isRateLimited(error);
      const code = error instanceof ContractCallError ? error.code : busy ? "RPC_RATE_LIMITED" : (error as Error).message;
      outcome = {
        key: input.key,
        status: "failed",
        decision,
        result: null,
        intentStatus: null,
        intentSince: null,
        supplier: null,
        obligationId: null,
        badge: extracted ? BADGE_LABEL[extracted.verification.badge] : BADGE_LABEL.VERIFICATION_UNAVAILABLE,
        model: extracted?.model ?? null,
        summary: busy
          ? "The NEAR network connection was busy (rate-limited), even after retrying, so nothing was proposed or paid. Send the invoice again in a minute."
          : `could not process the invoice: ${code}`,
        notices: [{ key: `failed-${input.key}`, text: `Invoice ${input.key} could not be processed (${code}).` }],
      };
    }
    this.deps.store?.put({
      key: input.key,
      receivedAt: input.receivedAt,
      source: input.source,
      model: outcome.model ?? "",
      badge: outcome.badge,
      extraction: extracted?.extraction ?? null,
      decision: decision ? JSON.parse(JSON.stringify(decision, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) : null,
      outcome: { status: outcome.status, result: outcome.result, intentStatus: outcome.intentStatus, obligationId: outcome.obligationId, summary: outcome.summary },
      verification: extracted?.verification ?? null,
      files: input.files.map((f) => ({ kind: f.kind, name: f.name, base64: Buffer.from(f.bytes).toString("base64") })),
      text: input.text ?? null,
    });
    this.deps.log?.(`[agent] ${input.key}: ${outcome.summary}`);
    return outcome;
  }

  private async extract(input: InvoiceInput): Promise<ExtractResult> {
    let text = input.text ?? null;
    const images: Array<{ mime: string; base64: string }> = [];
    for (const file of input.files) {
      if (file.kind === "pdf") {
        const pdf = await pdfText(file.bytes);
        text = [text, pdf.text].filter(Boolean).join("\n");
      } else {
        images.push({ mime: `image/${file.kind}`, base64: Buffer.from(file.bytes).toString("base64") });
      }
    }
    return this.deps.extractor.extract({ text: text && text.trim() ? text : null, images });
  }

  private async act(input: InvoiceInput, extracted: ExtractResult, decision: Decision, supplier: Supplier | null): Promise<AgentOutcome> {
    const base = {
      key: input.key,
      intentStatus: null as IntentStatus | null,
      intentSince: null as string | null,
      supplier,
      decision,
      badge: BADGE_LABEL[extracted.verification.badge],
      model: extracted.model,
    };
    if (decision.action === "ignore") {
      return {
        ...base,
        status: "ignored",
        result: null,
        obligationId: null,
        summary: `not proposed: ${decision.reason} (${decision.notes.join("; ")})`,
        notices: [{ key: `ignored-${input.key}`, text: `Invoice not proposed: ${decision.reason}. ${decision.notes.join("; ")}` }],
      };
    }
    if (decision.action === "needs_owner") {
      return {
        ...base,
        status: "needs_owner",
        result: null,
        obligationId: null,
        summary: `needs the owner: ${decision.reason} (${decision.notes.join("; ")})`,
        notices: [
          {
            key: `owner-${input.key}`,
            text: `Invoice needs your confirmation before anything is proposed: ${decision.reason}. ${decision.notes.join("; ")}`,
          },
        ],
      };
    }

    const id = obligationId(this.deps.tenantSecret, decision.supplierId, decision.invoiceNumber);
    const out = await this.deps.agent.propose({
      obligationId: id,
      supplierId: decision.supplierId,
      amountOut: decision.amountOut,
      reviewFlag: decision.reviewFlag,
    });
    const result = out.value;
    const notes = decision.notes.length ? ` Notes: ${decision.notes.join("; ")}.` : "";
    if (!result.accepted) {
      return {
        ...base,
        status: "rejected_onchain",
        result,
        obligationId: id,
        summary: `refused by the contract: ${result.reason}`,
        notices: [
          {
            key: `rejected-${input.key}`,
            text: `The contract refused a payment of ${decision.amountOut} to supplier ${decision.supplierId}: ${result.reason}.${notes}`,
            link: this.link("/"),
          },
        ],
      };
    }
    // A native payment within the limits was sent in the same call: report how it ended.
    const after = result.status === "PAYING" ? await this.deps.view.intent(result.intent_id!) : null;
    const intentStatus = result.status === "PAYING" ? (after?.status ?? "PAYING") : result.status;
    const summary =
      intentStatus === "PAID"
        ? `intent ${result.intent_id} paid automatically (within the autonomous budget)`
        : intentStatus === "FAILED"
          ? `intent ${result.intent_id} approved, but the token refused the transfer; the owner can retry it`
          : intentStatus === "PAYING"
            ? `intent ${result.intent_id} approved; the payment is being sent`
            : intentStatus === "APPROVED"
              ? `intent ${result.intent_id} approved automatically; the executor pays it cross-chain`
              : `intent ${result.intent_id} waits for the owner (${result.route})`;
    return {
      ...base,
      status: "proposed",
      result,
      intentStatus,
      intentSince: after?.since ?? null,
      obligationId: id,
      summary,
      notices:
        decision.flags.length > 0
          ? [
              {
                key: `flags-${input.key}`,
                text: `Intent ${result.intent_id} raised ${decision.flags.join(", ")}.${notes}`,
                link: this.link(`/intent/${result.intent_id}`),
              },
            ]
          : [],
    };
  }
}
