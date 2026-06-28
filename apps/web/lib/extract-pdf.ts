// CSP-safe, client-side PDF text extraction.
//
// The web app ships a strict, fail-closed Content-Security-Policy (see
// apps/web/proxy.ts): script-src has NO 'unsafe-eval' and NO 'wasm-unsafe-eval'
// in production, and we never want a PDF parse to need a network-loaded worker.
// pdf.js is configured here so it can run under that policy:
//
//   1. No eval — pdfjs-dist v6 is already eval-free (no `eval(`/`new Function(`
//      in either build), and we ALSO pass `isEvalSupported: false` as
//      defence-in-depth so any future build that re-introduces font-compilation
//      eval stays disabled. A scanned PDF simply yields no text — never a CSP
//      violation.
//   2. No worker — we register the worker module on `globalThis.pdfjsWorker`,
//      which makes pdf.js run the parser on the MAIN THREAD (its "fake worker"
//      path) instead of spawning `new Worker(...)`. That sidesteps the
//      worker-src directive and any bundler/worker-URL fragility entirely.
//   3. No WASM — `useWasm: false` (plus disabling the image decoder/offscreen
//      canvas) avoids `WebAssembly.instantiate`, which the CSP would block. Text
//      extraction needs none of it.
//
// The file's bytes NEVER leave the browser: extraction is fully local and only
// the resulting text is folded into the prompt by the caller. Everything is
// wrapped so a malformed/oversized/scanned PDF returns `{ error }` (an honest
// inline notice) and NEVER throws — the composer must not break.

/** Cap so a giant PDF can't hang the tab or balloon the prompt. */
const MAX_BYTES = 8 * 1024 * 1024; // ~8 MB
const MAX_PAGES = 20;

export interface PdfExtractOk {
  text: string;
  /** Pages whose text we actually read (≤ MAX_PAGES). */
  pages: number;
  /** True when the document had more than MAX_PAGES and we stopped early. */
  truncated: boolean;
}
export interface PdfExtractErr {
  error: string;
}
export type PdfExtractResult = PdfExtractOk | PdfExtractErr;

/** Human-readable MB, used only in the size-cap notice (no byte counts logged). */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lazily load pdf.js + register its worker on the main thread. Dynamic import
 * keeps pdf.js out of the main bundle until a PDF is actually attached, and the
 * `globalThis.pdfjsWorker` hook is what forces the no-`new Worker()` path.
 */
async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) {
    g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  }
  return pdfjs;
}

/**
 * Extract text from a (text-based) PDF entirely in the browser.
 *
 * Returns `{ text, pages, truncated }` on success, or `{ error }` with an
 * honest, user-facing message on any failure — oversize, corrupt, unsupported,
 * or scanned/image-only (no extractable text). Never throws.
 */
export async function extractPdfText(file: File): Promise<PdfExtractResult> {
  if (file.size > MAX_BYTES) {
    return {
      error: `This PDF is too large to read in the browser (${mb(file.size)} — max ${mb(MAX_BYTES)}).`,
    };
  }

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await loadPdfjs();

    // Build params as a plain object so the (no-op-in-v6) `isEvalSupported`
    // defence stays even though it's not in the public type. None of these
    // options touch the network or need a worker/WASM/canvas.
    const params = {
      data,
      isEvalSupported: false,
      useWasm: false,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Quietest log level — no parser chatter in the console.
      verbosity: 0,
    };

    const loadingTask = pdfjs.getDocument(params);
    const doc = await loadingTask.promise;
    try {
      const total = doc.numPages;
      const pagesToRead = Math.min(total, MAX_PAGES);
      const truncated = total > MAX_PAGES;
      const chunks: string[] = [];

      for (let pageNum = 1; pageNum <= pagesToRead; pageNum += 1) {
        const page = await doc.getPage(pageNum);
        try {
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
            .replace(/[ \t]+/g, " ")
            .trim();
          if (pageText) chunks.push(pageText);
        } finally {
          // Release page resources promptly.
          page.cleanup();
        }
      }

      const text = chunks.join("\n\n").trim();
      if (!text) {
        return {
          error:
            "Couldn't extract text from this PDF (it may be scanned or image-only).",
        };
      }
      return { text, pages: pagesToRead, truncated };
    } finally {
      // Tear down the document + (fake) worker transport.
      await loadingTask.destroy();
    }
  } catch {
    // Message is generic — no file bytes or stack detail surfaced.
    return {
      error: "Couldn't read this PDF — the file may be corrupted or unsupported.",
    };
  }
}
