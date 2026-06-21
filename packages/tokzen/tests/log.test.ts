import { describe, it, expect } from "bun:test";
import { compressLog } from "../src/compressors/log";

const SAMPLE_LOG = `
2024-01-15T10:00:00Z [INFO] Application started
2024-01-15T10:00:01Z [INFO] Loading configuration
2024-01-15T10:00:02Z [DEBUG] Connection pool initialized: 10 connections
2024-01-15T10:00:03Z [DEBUG] Connection pool initialized: 10 connections
2024-01-15T10:00:04Z [DEBUG] Connection pool initialized: 10 connections
2024-01-15T10:00:05Z [ERROR] Failed to connect to database: timeout
Error: Connection timeout
    at PostgresClient.connect (node_modules/pg/lib/client.js:45:8)
    at ConnectionPool.acquire (src/db/pool.ts:120:3)
    at handleRequest (src/handler.ts:55:12)
2024-01-15T10:00:06Z [WARN] Retrying connection
2024-01-15T10:00:07Z [INFO] Connection restored
`.trim();

describe("compressLog", () => {
  it("strips ANSI codes", () => {
    const logWithAnsi = "\x1B[31mERROR\x1B[0m Something failed";
    const result = compressLog(logWithAnsi);
    expect(result.content).not.toContain("\x1B");
    expect(result.transforms).toContain("ansi-strip");
  });

  it("compresses repeated lines", () => {
    const log = Array.from({ length: 10 }, () => "2024-01-01T00:00:00Z [DEBUG] same line").join("\n");
    const result = compressLog(log);
    expect(result.ratio).toBeLessThan(0.5);
  });

  it("always keeps ERROR lines", () => {
    const result = compressLog(SAMPLE_LOG);
    expect(result.content).toContain("Failed to connect");
  });

  it("always keeps WARN lines", () => {
    const result = compressLog(SAMPLE_LOG);
    expect(result.content).toContain("Retrying");
  });

  it("stores original in CCR and adds marker", () => {
    const result = compressLog(SAMPLE_LOG);
    expect(result.ccrHashes).toHaveLength(1);
    expect(result.content).toContain("retrieve(");
  });

  it("never throws on empty or malformed input", () => {
    expect(() => compressLog("")).not.toThrow();
    expect(() => compressLog("not a log at all")).not.toThrow();
    expect(() => compressLog("\x1B[999m")).not.toThrow();
  });

  it("compresses stack traces", () => {
    const log = `ERROR: Something failed
    at fn1 (src/app.ts:1:1)
    at fn2 (src/router.ts:2:2)
    at fn3 (node_modules/express/lib/router.js:3:3)
    at fn4 (node_modules/express/lib/router.js:4:4)
    at fn5 (node_modules/express/lib/router.js:5:5)
    at fn6 (node_modules/express/lib/router.js:6:6)`;
    const result = compressLog(log);
    expect(result.content).toContain("frames omitted");
  });
});
