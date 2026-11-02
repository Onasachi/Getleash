/**
 * The agent pipeline (PLAN §4.3): InvoiceInput → extraction (model, untrusted) → deterministic
 * checks → obligation id (ingestion HMAC) → `propose_payment` → stored record and owner notice.
 *
 * What reaches the chain: the obligation id (keyed HMAC), the supplier id (directory match), the
 * amount (cross-checked total, in the supplier's asset units) and at most one enum review flag.
 * The contract then decides; a refusal is a normal, recorded outcome.
 */
import { obligationId, type InvoiceInput, pdfText } from "@getleash/ingestion";
import {
  type AgentClient,
  ContractCallError,
  type Directory,
  type PolicyView,
  type ProposeResult,
  routeReason,
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
  log?: (line: string) => void;
};

export class InvoiceAgent {
  constructor(private readonly deps: AgentDeps) {}

  private link(path: string) {
    return this.deps.dashboardUrl ? `${this.deps.dashboardUrl.replace(/\/$/, "")}${path}` : undefined;
  }

  async process(input: InvoiceInput): Promise<AgentOutcome> {
    let extracted: ExtractResult | null = null;
    let decision: Decision | null = null;
    let outcome: AgentOutcome;
    try {
      extracted = await this.extract(input);
      const [suppliers, assets] = await Promise.all([this.deps.view.suppliers(), this.deps.view.assets()]);
      decision = decide(extracted, {
        directory: this.deps.directory().suppliers,
        suppliers,
        assets: new Map(assets),
      });
      outcome = await this.act(input, extracted, decision);
    } catch (error) {
      const code = error instanceof ContractCallError ? error.code : (error as Error).message;
      outcome = {
        key: input.key,
        status: "failed",
        decision,
        result: null,
        obligationId: null,
        badge: extracted ? BADGE_LABEL[extracted.verification.badge] : BADGE_LABEL.VERIFICATION_UNAVAILABLE,
        model: extracted?.model ?? null,
        summary: `could not process the invoice: ${code}`,
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
      outcome: { status: outcome.status, result: outcome.result, obligationId: outcome.obligationId, summary: outcome.summary },
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

  private async act(input: InvoiceInput, extracted: ExtractResult, decision: Decision): Promise<AgentOutcome> {
    const base = {
      key: input.key,
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
    const reason = result.route ? routeReason(result.route) : null;
    const summary =
      result.status === "APPROVED"
        ? `intent ${result.intent_id} approved automatically (within the autonomous budget)`
        : `intent ${result.intent_id} waits for the owner (${reason})`;
    return {
      ...base,
      status: "proposed",
      result,
      obligationId: id,
      summary,
      notices:
        decision.flags.length > 0
          ? [
              {
                key: `flags-${input.key}`,
                text: `Intent ${result.intent_id} raised ${decision.flags.join(", ")}.${notes}`,
                link: this.link(`/approve/${result.intent_id}`),
              },
            ]
          : [],
    };
  }
}
