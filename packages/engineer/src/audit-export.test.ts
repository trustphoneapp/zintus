import { describe, expect, test } from "bun:test";
import {
  AUDIT_EXPORT_SCHEMA_VERSION,
  REDACTED_PATH,
  REDACTED_SECRET,
  REDACTED_STORAGE_REFERENCE,
  exportAuditChain,
  serializeAuditExport,
  type AuditEntry,
} from "./audit-export.js";

const TENANT = "tenant-1";
const RUN = "run-1";

function entry(overrides: Partial<AuditEntry> & Pick<AuditEntry, "id" | "sequence">): AuditEntry {
  return {
    kind: "EVENT",
    tenantId: TENANT,
    runId: RUN,
    recordedAt: "2026-07-18T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function chain(count: number): AuditEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    entry({ id: `evt-${String(index).padStart(3, "0")}`, sequence: index, payload: { index } }));
}

describe("P11 audit export - determinism and checksums", () => {
  test("export is deterministic for identical input", () => {
    const request = { tenantId: TENANT, runId: RUN, entries: chain(10), pageSize: 3 };
    expect(serializeAuditExport(exportAuditChain(request))).toBe(serializeAuditExport(exportAuditChain(request)));
  });

  test("ordering is stable regardless of input order", () => {
    const forward = exportAuditChain({ tenantId: TENANT, runId: RUN, entries: chain(6), pageSize: 2 });
    const reversed = exportAuditChain({ tenantId: TENANT, runId: RUN, entries: [...chain(6)].reverse(), pageSize: 2 });
    expect(reversed.contentDigest).toBe(forward.contentDigest);
    expect(serializeAuditExport(reversed)).toBe(serializeAuditExport(forward));
  });

  test("contentDigest is stable across page-size changes", () => {
    const entries = chain(12);
    const digests = [1, 2, 3, 5, 12, 50].map((pageSize) =>
      exportAuditChain({ tenantId: TENANT, runId: RUN, entries, pageSize }).contentDigest);
    expect(new Set(digests).size).toBe(1);
  });

  test("re-paged entries recombine identically across page sizes", () => {
    const entries = chain(12);
    const flatten = (pageSize: number): unknown[] =>
      exportAuditChain({ tenantId: TENANT, runId: RUN, entries, pageSize }).pages.flatMap((page) => page.entries);
    expect(flatten(5)).toEqual(flatten(3));
    expect(flatten(5)).toEqual(flatten(100));
  });

  test("page checksums chain via previousPageChecksum", () => {
    const result = exportAuditChain({ tenantId: TENANT, runId: RUN, entries: chain(7), pageSize: 2 });
    expect(result.pageCount).toBe(4);
    expect(result.pages[0]!.previousPageChecksum).toBeNull();
    for (let index = 1; index < result.pages.length; index += 1) {
      expect(result.pages[index]!.previousPageChecksum).toBe(result.pages[index - 1]!.pageChecksum);
    }
  });

  test("an empty chain still yields one deterministic page", () => {
    const result = exportAuditChain({ tenantId: TENANT, runId: RUN, entries: [], pageSize: 5 });
    expect(result.entryCount).toBe(0);
    expect(result.pageCount).toBe(1);
    expect(result.pages[0]!.entries).toEqual([]);
    expect(result.schemaVersion).toBe(AUDIT_EXPORT_SCHEMA_VERSION);
  });
});

describe("P11 audit export - scope safety", () => {
  test("rejects a cross-tenant entry rather than dropping it", () => {
    const entries = [entry({ id: "a", sequence: 0 }), entry({ id: "b", sequence: 1, tenantId: "tenant-2" })];
    expect(() => exportAuditChain({ tenantId: TENANT, runId: RUN, entries, pageSize: 5 })).toThrow(/tenant scope/);
  });

  test("rejects a cross-run entry", () => {
    const entries = [entry({ id: "a", sequence: 0, runId: "run-2" })];
    expect(() => exportAuditChain({ tenantId: TENANT, runId: RUN, entries, pageSize: 5 })).toThrow(/run scope/);
  });

  test("rejects a non-positive page size", () => {
    expect(() => exportAuditChain({ tenantId: TENANT, runId: RUN, entries: [], pageSize: 0 })).toThrow(/pageSize/);
  });

  test("rejects duplicate entry keys", () => {
    const entries = [entry({ id: "dup", sequence: 1 }), entry({ id: "dup", sequence: 1 })];
    expect(() => exportAuditChain({ tenantId: TENANT, runId: RUN, entries, pageSize: 5 })).toThrow(/duplicate entry key/);
  });
});

describe("P11 audit export - redaction", () => {
  function exportSingle(payload: Record<string, unknown>): string {
    const result = exportAuditChain({
      tenantId: TENANT, runId: RUN,
      entries: [entry({ id: "e", sequence: 0, kind: "EVIDENCE", payload })],
      pageSize: 5,
    });
    return serializeAuditExport(result);
  }

  test("collapses storageReference keys to a marker", () => {
    const serialized = exportSingle({ storageReference: "/var/lib/zintus/artifacts/abcd.bin", size: 12 });
    expect(serialized).not.toContain("/var/lib/zintus");
    expect(serialized).toContain(REDACTED_STORAGE_REFERENCE);
    expect(serialized).toContain("\"size\":12");
  });

  test("redacts secret/token-bearing keys anywhere in the payload", () => {
    const serialized = exportSingle({ nested: { apiKey: "sk-live-0123456789abcdef", token: "ghp_verysecrettoken0000000000" } });
    expect(serialized).not.toContain("sk-live-0123456789abcdef");
    expect(serialized).not.toContain("ghp_verysecrettoken0000000000");
    expect(serialized).toContain(REDACTED_SECRET);
  });

  test("scrubs a filesystem path smuggled into an innocent-looking field", () => {
    const serialized = exportSingle({ note: "wrote result to /Users/yash/secret/key.pem then cleaned up" });
    expect(serialized).not.toContain("/Users/yash/secret/key.pem");
    expect(serialized).toContain(REDACTED_PATH);
  });

  test("scrubs a Windows path and a file:// URI", () => {
    const win = exportSingle({ path: "C:\\Users\\yash\\creds.txt" });
    expect(win).not.toContain("C:\\Users\\yash");
    const uri = exportSingle({ ref: "file:///etc/shadow" });
    expect(uri).not.toContain("file:///etc/shadow");
  });

  test("scrubs a token shape hidden in a free-text value", () => {
    const serialized = exportSingle({ log: "authorized with AKIAIOSFODNN7EXAMPLE earlier" });
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).toContain(REDACTED_SECRET);
  });

  test("leaves benign content untouched", () => {
    const serialized = exportSingle({ message: "verification passed", count: 3, ok: true });
    expect(serialized).toContain("verification passed");
    expect(serialized).toContain("\"count\":3");
  });
});
