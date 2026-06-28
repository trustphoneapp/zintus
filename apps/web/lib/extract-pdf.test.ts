import { describe, test, expect } from "bun:test";
import { extractPdfText } from "./extract-pdf";

// Build a minimal, valid, TEXT-based PDF (one page, one text-showing operator)
// with a correct xref table. This is a real fixture pdf.js parses the same way
// the browser would — no mock of the parser.
function buildTextPdf(text: string): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    body += `${offsets[i]!.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(body);
}

/** Minimal File shim — extractPdfText only reads `.size` and `.arrayBuffer()`. */
function fileFrom(bytes: Uint8Array, name = "doc.pdf"): File {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    name,
    size: bytes.byteLength,
    type: "application/pdf",
    arrayBuffer: async () => buf,
  } as unknown as File;
}

describe("extractPdfText — text-based PDF", () => {
  test("extracts the text and reports one page", async () => {
    const file = fileFrom(buildTextPdf("Hello Zintus PDF"));
    const result = await extractPdfText(file);

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.text).toContain("Hello Zintus PDF");
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
  });
});

describe("extractPdfText — failure modes never throw", () => {
  test("malformed bytes return { error } (no throw)", async () => {
    const file = fileFrom(new TextEncoder().encode("not a pdf at all"));
    const result = await extractPdfText(file);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.length).toBeGreaterThan(0);
  });

  test("an empty buffer returns { error } (no throw)", async () => {
    const file = fileFrom(new Uint8Array(0));
    const result = await extractPdfText(file);
    expect("error" in result).toBe(true);
  });

  test("an oversize file is rejected before parsing", async () => {
    // Report a size over the cap without allocating it.
    const file = {
      name: "huge.pdf",
      size: 50 * 1024 * 1024,
      type: "application/pdf",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    const result = await extractPdfText(file);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("too large");
  });
});
