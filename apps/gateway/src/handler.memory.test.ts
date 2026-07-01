import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngine } from "@zintus/engine";
import { createGatewayHandler } from "./handler.js";
import type { GatewayConfig } from "./auth.js";

/**
 * /v1/memory + /v1/threads/:id/memory governance routes, exercised end-to-end
 * (route → engine → real MemoryStore). Facts are user-owned: listable by scope,
 * editable, deletable.
 */

describe("/v1/memory governance routes", () => {
  let dir: string;
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-mem-routes-"));
    const engine = createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      memoryPath: join(dir, "memory.db"),
      getApiKey: async () => null,
    });
    const config: GatewayConfig = {
      port: 8788,
      host: "127.0.0.1",
      token: "",
      corsOrigins: "*",
    };
    handler = createGatewayHandler({ engine, config });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function req(method: string, path: string, body?: unknown): Request {
    return new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function jsonOf(res: Response): Promise<{ memory: unknown }> {
    return (await res.json()) as { memory: unknown };
  }

  test("POST creates a global fact; GET lists it by scope", async () => {
    const post = await handler(
      req("POST", "/v1/memory", { scope: "global", key: "name", value: "Alice" }),
    );
    expect(post.status).toBe(201);
    const created = (await jsonOf(post)).memory as Record<string, unknown>;
    expect(created.scope).toBe("global");
    expect(created.value).toBe("Alice");
    expect(created.threadId).toBeNull();

    const get = await handler(req("GET", "/v1/memory?scope=global"));
    expect(get.status).toBe(200);
    const list = (await jsonOf(get)).memory as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe("name");
  });

  test("POST without key/value → 400", async () => {
    const res = await handler(
      req("POST", "/v1/memory", { scope: "global", key: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("GET with an invalid scope → 400", async () => {
    const res = await handler(req("GET", "/v1/memory?scope=bogus"));
    expect(res.status).toBe(400);
  });

  test("PATCH edits value + pin; unknown id → 404", async () => {
    const created = (
      await jsonOf(
        await handler(
          req("POST", "/v1/memory", { scope: "global", key: "k", value: "old" }),
        ),
      )
    ).memory as Record<string, unknown>;

    const patch = await handler(
      req("PATCH", `/v1/memory/${created.id}`, { value: "new", pinned: true }),
    );
    expect(patch.status).toBe(200);
    const updated = (await jsonOf(patch)).memory as Record<string, unknown>;
    expect(updated.value).toBe("new");
    expect(updated.pinned).toBe(true);

    expect(
      (await handler(req("PATCH", "/v1/memory/nope", { value: "x" }))).status,
    ).toBe(404);
    // An empty patch is a 400 (nothing to edit).
    expect(
      (await handler(req("PATCH", `/v1/memory/${created.id}`, {}))).status,
    ).toBe(400);
  });

  test("DELETE removes a fact; a second DELETE → 404", async () => {
    const created = (
      await jsonOf(
        await handler(
          req("POST", "/v1/memory", { scope: "global", key: "k", value: "v" }),
        ),
      )
    ).memory as Record<string, unknown>;

    expect(
      (await handler(req("DELETE", `/v1/memory/${created.id}`))).status,
    ).toBe(200);
    expect(
      (await handler(req("DELETE", `/v1/memory/${created.id}`))).status,
    ).toBe(404);

    const list = (
      await jsonOf(await handler(req("GET", "/v1/memory?scope=global")))
    ).memory as unknown[];
    expect(list).toHaveLength(0);
  });

  test("GET /v1/threads/:id/memory returns only that thread's facts", async () => {
    await handler(
      req("POST", "/v1/memory", {
        scope: "thread",
        thread_id: "t1",
        key: "goal",
        value: "ship",
      }),
    );
    await handler(
      req("POST", "/v1/memory", {
        scope: "thread",
        thread_id: "t2",
        key: "goal",
        value: "other",
      }),
    );

    const res = await handler(req("GET", "/v1/threads/t1/memory"));
    expect(res.status).toBe(200);
    const list = (await jsonOf(res)).memory as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.value).toBe("ship");
  });
});
