/**
 * Supplier details as owners and suppliers type them in Telegram (/addsupplier, /invite): one payee
 * (a NEAR account or a Tron address with a valid checksum) and a name, read without a model.
 */
import { describe, expect, it } from "vitest";

import {
  distinctName,
  looksLikeEvmAddress,
  mergeDirectories,
  parseSupplierDetails,
  payeeOf,
  supplierTerms,
  USDT_TRON_ASSET,
} from "../src/index.ts";

const TRON = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TOKEN = { token_id: "usdc.near", token_decimals: 6 };

describe("payees", () => {
  it("reads NEAR accounts with a dot, implicit accounts and checksummed Tron addresses", () => {
    expect(payeeOf("acme.near")).toEqual({ chain: "NEAR", recipient: "acme.near" });
    expect(payeeOf("pay.acme.near")).toEqual({ chain: "NEAR", recipient: "pay.acme.near" });
    expect(payeeOf("ab".repeat(32))).toEqual({ chain: "NEAR", recipient: "ab".repeat(32) });
    expect(payeeOf(TRON)).toEqual({ chain: "TRON", recipient: TRON });
    expect(payeeOf(`${TRON.slice(0, -1)}c`)).toBeNull(); // checksum
    expect(payeeOf("acme")).toBeNull(); // top-level names read like words
    expect(payeeOf("Booking.com")).toBeNull();
  });

  it("forgives what phones and sentences add: a capital letter and punctuation around it", () => {
    expect(payeeOf("Chisolu.near")).toEqual({ chain: "NEAR", recipient: "chisolu.near" });
    expect(payeeOf("ACME.TG")).toEqual({ chain: "NEAR", recipient: "acme.tg" });
    expect(payeeOf("(acme.near).")).toEqual({ chain: "NEAR", recipient: "acme.near" });
  });

  it("gives add_supplier's terms: the treasury token for NEAR, USDT on Tron for Tron", () => {
    expect(supplierTerms({ chain: "NEAR", recipient: "acme.near" }, TOKEN)).toEqual({ chain: "NEAR", asset_id: "nep141:usdc.near", recipient: "acme.near", decimals: 6 });
    expect(supplierTerms({ chain: "TRON", recipient: TRON }, TOKEN)).toEqual({ chain: "TRON", asset_id: USDT_TRON_ASSET, recipient: TRON, decimals: 6 });
  });
});

describe("supplier details", () => {
  const parse = (text: string) => parseSupplierDetails(text);

  it("takes the name and the address on two lines, in either order, or on one line", () => {
    expect(parse("Acme Packaging\nacme.near")).toEqual({ details: { name: "Acme Packaging", payee: { chain: "NEAR", recipient: "acme.near" } } });
    expect(parse("acme.near\nAcme Packaging")).toEqual({ details: { name: "Acme Packaging", payee: { chain: "NEAR", recipient: "acme.near" } } });
    expect(parse("Acme Packaging acme.near")).toEqual({ details: { name: "Acme Packaging", payee: { chain: "NEAR", recipient: "acme.near" } } });
    expect(parse("Acme — acme.near")).toEqual({ details: { name: "Acme", payee: { chain: "NEAR", recipient: "acme.near" } } });
  });

  it("drops labels: the address line's, and a name line's", () => {
    expect(parse("Pay to (NEAR): chisolu.near\nChisolu Enterprises")).toEqual({
      details: { name: "Chisolu Enterprises", payee: { chain: "NEAR", recipient: "chisolu.near" } },
    });
    expect(parse(`Name: Shenzhen Parts\nWallet: ${TRON}`)).toEqual({ details: { name: "Shenzhen Parts", payee: { chain: "TRON", recipient: TRON } } });
  });

  it("an address alone has no name; the caller asks for one", () => {
    expect(parse("acme.near")).toEqual({ details: { name: null, payee: { chain: "NEAR", recipient: "acme.near" } } });
  });

  it("refuses no address, two addresses and a long name, and spots Ethereum-style addresses", () => {
    expect(parse("Acme Packaging")).toEqual({ problem: "NO_ADDRESS" });
    expect(parse("Acme a.near b.near")).toEqual({ problem: "TWO_ADDRESSES" });
    expect(parse(`${"x".repeat(101)}\nacme.near`)).toEqual({ problem: "NAME_TOO_LONG" });
    const evm = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(parse(`Acme ${evm}`)).toEqual({ problem: "NO_ADDRESS" });
    expect(looksLikeEvmAddress(`Acme ${evm}`)).toBe(true);
  });
});

describe("directory", () => {
  const entry = (supplier_id: number, name: string) => ({ supplier_id, name, aliases: [], payment_details: [], currency: "USD" as const });

  it("merges two directories, the first winning for a supplier both name", () => {
    const merged = mergeDirectories({ suppliers: [entry(1, "From the variable")] }, { suppliers: [entry(1, "From the file"), entry(2, "Added in Telegram")] });
    expect(merged.suppliers.map((s) => s.name)).toEqual(["From the variable", "Added in Telegram"]);
  });

  it("keeps names distinct as the agent compares them, so invoices stay unambiguous", () => {
    const directory = { suppliers: [entry(1, "Acme Packaging Ltd")] };
    expect(distinctName("acme packaging", 2, directory)).toBe("acme packaging #2");
    expect(distinctName("Acme Packaging Ltd", 1, directory)).toBe("Acme Packaging Ltd"); // its own name
    expect(distinctName("Shenzhen Parts", 2, directory)).toBe("Shenzhen Parts");
  });
});
