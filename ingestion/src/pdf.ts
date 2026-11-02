/** PDF text layer extraction (no rendering, no OCR), with the page limit enforced. */
import { LIMITS, LimitError, withTimeout } from "./limits.ts";

export async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // No scripting, no font loading: only the text layer is read.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await withTimeout(task.promise, LIMITS.extractTimeoutMs, "opening the PDF");
  try {
    if (doc.numPages > LIMITS.maxPdfPages) {
      throw new LimitError("TOO_MANY_PAGES", `PDF has ${doc.numPages} pages (max ${LIMITS.maxPdfPages})`);
    }
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await withTimeout(page.getTextContent(), LIMITS.extractTimeoutMs, `reading page ${i}`);
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return { pages: doc.numPages, text: parts.join("\n").slice(0, LIMITS.maxTextChars) };
  } finally {
    await task.destroy();
  }
}
