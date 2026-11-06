import { describe, expect, it } from "vitest";

import { LimitError, LIMITS, pdfText } from "../src/index.ts";

/** A small valid PDF with one line of Helvetica text per page (ASCII only, so offsets are string lengths). */
function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("pdfText (pdf.js in a child process)", () => {
  it("reads the text layer, one line per page", async () => {
    const pdf = makePdf(["INVOICE INV-7 from Acme Packaging Ltd", "Total due: USD 18.00, pay to acme.near"]);
    await expect(pdfText(pdf)).resolves.toEqual({
      pages: 2,
      text: "INVOICE INV-7 from Acme Packaging Ltd\nTotal due: USD 18.00, pay to acme.near",
    });
  });

  it(`refuses more than ${LIMITS.maxPdfPages} pages`, async () => {
    const pdf = makePdf(Array.from({ length: LIMITS.maxPdfPages + 1 }, (_, i) => `page ${i + 1}`));
    const error = await pdfText(pdf).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LimitError);
    expect((error as LimitError).code).toBe("TOO_MANY_PAGES");
  });

  it("reports a broken PDF as an error, without stopping the caller", async () => {
    await expect(pdfText(new TextEncoder().encode("%PDF-1.7 not really a PDF"))).rejects.toThrow(/the PDF could not be read/);
  });

  it("stops the reader at the time limit", async () => {
    const error = await pdfText(makePdf(["slow"]), { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LimitError);
    expect((error as LimitError).code).toBe("TIMEOUT");
  });

  it("reads one PDF at a time, and every caller gets its own text", async () => {
    const texts = ["first invoice", "second invoice", "third invoice"];
    const results = await Promise.all(texts.map((t) => pdfText(makePdf([t]))));
    expect(results.map((r) => r.text)).toEqual(texts);
  });
});
