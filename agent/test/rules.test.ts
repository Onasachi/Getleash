/**
 * Matching an invoice to a supplier (rules.ts): the directory first, then, for a supplier on-chain
 * without a name yet (added from the dashboard, or its name never saved), its exact address.
 */
import { describe, expect, it } from "vitest";

import type { Supplier } from "@getleash/shared";

import { decide, type Extraction, type ExtractResult, UNMATCHED_SUPPLIER_ID } from "../src/index.ts";

const supplier = (id: number, recipient: string): Supplier => ({
  id,
  chain: "NEAR",
  asset_id: "nep141:usdc.near",
  recipient,
  decimals: 6,
  active: true,
  revision: 1,
  changed_at: "0",
});

function read(sourceText: string, fields: Partial<Extraction>): ExtractResult {
  return {
    extraction: {
      is_invoice: true,
      supplier_name: "Chisolu",
      invoice_number: "CH-0003",
      currency: "USD",
      total_amount: "0.50",
      due_date: null,
      payment_details: [],
      ...fields,
    },
    sourceText,
    sourceIsModelTranscript: false,
    model: "test",
    verification: { badge: "VERIFICATION_UNAVAILABLE", checks: [], evidence: null },
  };
}

const INVOICE = "INVOICE\nFrom: Chisolu\nInvoice No: CH-0003\nTotal: USD 0.50\nPay to (NEAR): chisolu.near";

describe("supplier match", () => {
  it("a supplier on-chain without a name is found by its exact address, and stays unnamed in the reply", () => {
    const decision = decide(read(INVOICE, { payment_details: [{ kind: "near_account", value: "chisolu.near" }] }), {
      directory: [],
      suppliers: [supplier(2, "chisolu.near")],
    });
    expect(decision).toMatchObject({ action: "propose", supplierId: 2, supplierName: null, amountOut: 500_000n, reviewFlag: null });
  });

  it("the address must be printed on the invoice, not only in the model's reading", () => {
    const decision = decide(read(INVOICE.replace("chisolu.near", "see attachment"), { payment_details: [{ kind: "near_account", value: "chisolu.near" }] }), {
      directory: [],
      suppliers: [supplier(2, "chisolu.near")],
    });
    expect(decision).toMatchObject({ action: "propose", supplierId: UNMATCHED_SUPPLIER_ID });
  });

  it("an unknown address is still an unknown supplier, and a named supplier still matches by name", () => {
    const unknown = decide(read(INVOICE.replace("chisolu.near", "evil.near"), { payment_details: [{ kind: "near_account", value: "evil.near" }] }), {
      directory: [],
      suppliers: [supplier(2, "chisolu.near")],
    });
    expect(unknown).toMatchObject({ action: "propose", supplierId: UNMATCHED_SUPPLIER_ID });
    const named = decide(read(INVOICE, { payment_details: [{ kind: "near_account", value: "chisolu.near" }] }), {
      directory: [{ supplier_id: 1, name: "Chisolu", aliases: [], payment_details: ["chisolu.near"], currency: "USDC" }],
      suppliers: [supplier(1, "chisolu.near")],
    });
    expect(named).toMatchObject({ action: "propose", supplierId: 1, supplierName: "Chisolu" });
  });
});
