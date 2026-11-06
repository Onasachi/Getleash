/**
 * Reads one PDF's text layer (no rendering, no OCR) in a process of its own, started by pdf.ts under plain
 * Node: never through tsx, which makes pdf.js alone take about 380 MB (see pdf.ts). Plain JavaScript for
 * that reason.
 *
 *   node pdf-worker.mjs <max pages> <max characters>   < invoice.pdf
 *
 * Writes one JSON line to stdout: { "pages": n, "text": "…" } or { "error": { "code": "…", "message": "…" } }.
 * The text is each page's text items joined by spaces, one line per page, cut to <max characters>.
 */
const maxPages = Number(process.argv[2]);
const maxChars = Number(process.argv[3]);
const answer = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const data = new Uint8Array(Buffer.concat(chunks));

try {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // No scripting, no font loading: only the text layer is read.
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages > maxPages) {
      answer({ error: { code: "TOO_MANY_PAGES", message: `PDF has ${doc.numPages} pages (max ${maxPages})` } });
    } else {
      const parts = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      }
      answer({ pages: doc.numPages, text: parts.join("\n").slice(0, maxChars) });
    }
  } finally {
    await task.destroy();
  }
} catch (error) {
  answer({ error: { code: "UNREADABLE", message: String(error?.message ?? error).slice(0, 200) } });
}
