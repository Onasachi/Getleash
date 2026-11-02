/**
 * What the model may say about an invoice, and nothing more. The output is parsed with this strict
 * schema; it is untrusted input to deterministic code. No model output goes on-chain: the supplier
 * id comes from the directory match, the amount from a cross-checked total, the obligation id from
 * the ingestion HMAC, and the only model-influenced on-chain byte is the enum review flag.
 */
import { z } from "zod";

export const PaymentDetail = z.object({
  kind: z.enum(["near_account", "tron_address", "evm_address", "bank_account", "other"]),
  value: z.string().min(1).max(200),
});
export type PaymentDetail = z.infer<typeof PaymentDetail>;

export const Extraction = z
  .object({
    is_invoice: z.boolean(),
    supplier_name: z.string().max(200).nullable(),
    invoice_number: z.string().max(64).nullable(),
    /** Currency as written on the invoice ("USD", "USDT", "$", "NGN", "₦"…). */
    currency: z.string().max(16).nullable(),
    /** The total due, digits and an optional decimal point only (thousands separators removed). */
    total_amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).nullable(),
    due_date: z.string().max(32).nullable(),
    payment_details: z.array(PaymentDetail).max(10),
  })
  .strict();
export type Extraction = z.infer<typeof Extraction>;

/** JSON Schema sent to the model as the structured-output contract (mirrors `Extraction`). */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_invoice", "supplier_name", "invoice_number", "currency", "total_amount", "due_date", "payment_details"],
  properties: {
    is_invoice: { type: "boolean" },
    supplier_name: { type: ["string", "null"], maxLength: 200 },
    invoice_number: { type: ["string", "null"], maxLength: 64 },
    currency: { type: ["string", "null"], maxLength: 16 },
    total_amount: { type: ["string", "null"], pattern: "^\\d{1,12}(\\.\\d{1,6})?$" },
    due_date: { type: ["string", "null"], maxLength: 32 },
    payment_details: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["near_account", "tron_address", "evm_address", "bank_account", "other"] },
          value: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const;

/** TEE verification badge states (PLAN §4.3), computed only by verification code. */
export type Badge =
  | "MODEL_RESPONSE_VERIFIED"
  | "GATEWAY_EVIDENCE_VERIFIED"
  | "VERIFICATION_UNAVAILABLE"
  | "VERIFICATION_FAILED";

export const BADGE_LABEL: Record<Badge, string> = {
  MODEL_RESPONSE_VERIFIED: "Model response verified",
  GATEWAY_EVIDENCE_VERIFIED: "Gateway evidence verified",
  VERIFICATION_UNAVAILABLE: "Verification unavailable",
  VERIFICATION_FAILED: "Verification failed",
};

export type Verification = { badge: Badge; checks: Array<{ name: string; ok: boolean; detail: string }>; evidence: unknown };

export type ExtractInput = {
  /** Text layer, caption or pasted text (null for a photo). */
  text: string | null;
  images: Array<{ mime: string; base64: string }>;
};

export type ExtractResult = {
  extraction: Extraction;
  /** Text the checks compare against: the input text, or the model's transcription of a photo. */
  sourceText: string;
  /** True when `sourceText` came from the model (a photo), so the cross-checks are weaker. */
  sourceIsModelTranscript: boolean;
  model: string;
  verification: Verification;
};

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<ExtractResult>;
}
