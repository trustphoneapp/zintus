/**
 * Bun-only test helpers. Imported ONLY by tests that run under `bun test`
 * (these use `bun:sqlite` and `bun:test`'s `mock.module`, neither of which
 * vitest can resolve). Keep this OUT of the runner-agnostic `index.ts`.
 */
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@zintus/types";

/** A throwaway on-disk SQLite DB in a temp dir, with cleanup. */
export function createTestDb(name = "test"): { db: Database; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `zintus-${name}-`));
  const path = join(dir, `${name}.db`);
  const db = new Database(path);
  return {
    db,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestGatewayOptions {
  /** Mock providers injected via mock.module("@zintus/providers"). */
  providers: Provider[];
  /** API key resolver (default returns "test-key"; return null to simulate a
   *  provider with no key, i.e. ineligible). */
  getApiKey?: (id: string) => Promise<string | null>;
}

/**
 * Build a real gateway handler (real engine + router + Tokzen) with mocked
 * providers. Uses temp SQLite DBs. Returns the handler plus a cleanup that
 * restores mocks and deletes the temp dir.
 *
 * IMPORTANT: call `cleanup()` in afterEach — `mock.restore()` must run or the
 * @zintus/providers mock leaks into later test files (bun mock.module is
 * process-global).
 */
export async function createTestGateway(options: TestGatewayOptions): Promise<{
  handler: (request: Request) => Promise<Response>;
  dir: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "zintus-gateway-"));
  const { ProviderHttpError, estimateUsage } = await import("@zintus/providers");
  mock.module("@zintus/providers", () => ({
    listProviders: () => options.providers,
    ProviderHttpError,
    estimateUsage,
  }));
  const { createEngine } = await import("@zintus/engine");
  const { createGatewayHandler } = await import("@zintus/gateway");
  const engine = createEngine({
    conversationsPath: join(dir, "conversations.db"),
    dbPath: join(dir, "quota.db"),
    cachePath: join(dir, "cache.db"),
    getApiKey: options.getApiKey ?? (async () => "test-key"),
    persistConversations: true,
    persistTraces: true,
  });
  const handler = createGatewayHandler({
    engine,
    config: { port: 8788, host: "127.0.0.1", token: "", corsOrigins: "*" },
  });
  return {
    handler,
    dir,
    cleanup: () => {
      mock.restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
