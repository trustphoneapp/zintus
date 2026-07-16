import { afterEach, describe, expect, it } from "bun:test";
import { downloadBlob } from "./download.js";

const originalDocument = globalThis.document;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

describe("downloadBlob", () => {
  it("clicks an attached temporary link, removes it, and defers URL revocation", async () => {
    const lifecycle: string[] = [];
    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: () => lifecycle.push("click"),
      remove: () => lifecycle.push("remove"),
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => anchor,
        body: { appendChild: () => lifecycle.push("append") },
      },
    });
    URL.createObjectURL = (() => "blob:zintus-evidence") as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => lifecycle.push(`revoke:${url}`)) as typeof URL.revokeObjectURL;

    downloadBlob("evidence.ndjson", new Blob(["evidence"]));
    expect(anchor.href).toBe("blob:zintus-evidence");
    expect(anchor.download).toBe("evidence.ndjson");
    expect(lifecycle).toEqual(["append", "click", "remove"]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lifecycle).toEqual(["append", "click", "remove", "revoke:blob:zintus-evidence"]);
  });
});
