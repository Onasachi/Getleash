import { describe, expect, it } from "vitest";

import { normaliseInvoiceNumber, obligationId } from "../src/obligation.ts";
import { checkFile, LimitError } from "../src/limits.ts";
import { UpdateLog } from "../src/dedupe.ts";

const secret = new Uint8Array(32).fill(7);

describe("obligation ids (§9 row: same invoice, different hash or edited fields)", () => {
  it("normalises the printed forms of one invoice number to one value", () => {
    for (const form of ["INV-00042", "inv 42", "Invoice No. 0042", "INV/042", "inv#42", "ＩＮＶ－４２"]) {
      expect(normaliseInvoiceNumber(form), form).toBe("42");
    }
    expect(normaliseInvoiceNumber("SP-2207")).toBe("SP2207");
    expect(normaliseInvoiceNumber("sp 02207")).toBe("SP2207");
  });

  it("refuses numbers without digits", () => {
    for (const bad of ["", "   ", "INVOICE", "N/A", "—"]) expect(normaliseInvoiceNumber(bad), bad).toBeNull();
  });

  it("is stable per supplier and number, and keyed by the tenant secret", () => {
    const a = obligationId(secret, 1, normaliseInvoiceNumber("INV-1001")!);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(obligationId(secret, 1, normaliseInvoiceNumber("inv 01001")!)).toBe(a);
    expect(obligationId(secret, 2, "1001")).not.toBe(a);
    expect(obligationId(new Uint8Array(32).fill(8), 1, "1001")).not.toBe(a);
  });
});

describe("limits and dedupe", () => {
  it("accepts PDFs and small images by content, refuses everything else", () => {
    expect(checkFile(new TextEncoder().encode("%PDF-1.7\n…"))).toBe("pdf");
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 800);
    new DataView(png.buffer).setUint32(20, 600);
    expect(checkFile(png)).toBe("png");
    new DataView(png.buffer).setUint32(16, 5000);
    expect(() => checkFile(png)).toThrow(LimitError);
    expect(() => checkFile(new TextEncoder().encode("MZ executable"))).toThrow(LimitError);
    expect(() => checkFile(new Uint8Array(11 * 1024 * 1024))).toThrow(/FILE_TOO_LARGE|10 MB/);
  });

  it("claims each update once", () => {
    const log = new UpdateLog(null);
    expect(log.claim("telegram-1")).toBe(true);
    expect(log.claim("telegram-1")).toBe(false);
    expect(() => log.claim("../etc/passwd")).toThrow();
  });
});
