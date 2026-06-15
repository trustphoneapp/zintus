import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngine } from "./engine.js";

describe("createEngine", () => {
  test("creates threads and traces without routing when no keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multipleai-engine-"));
    const conversationsPath = join(dir, "conversations.db");
    const dbPath = join(dir, "quota.db");

    const engine = createEngine({
      conversationsPath,
      dbPath,
      persistConversations: true,
      persistTraces: true,
    });

    const threadsBefore = engine.listThreads();
    expect(threadsBefore.length).toBe(0);

    await expect(
      engine.routeAndStream({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow();

    const threadsAfter = engine.listThreads();
    expect(threadsAfter.length).toBe(1);
    expect(threadsAfter[0]?.title).toBe("hello");

    const messages = engine.getThreadMessages(threadsAfter[0]!.id);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");

    const trace = engine.getLastTrace();
    expect(trace).not.toBeNull();
    expect(trace?.attempts.length).toBeGreaterThanOrEqual(0);

    rmSync(dir, { recursive: true, force: true });
  });

  test("does not duplicate user messages on continued thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multipleai-engine-"));
    const conversationsPath = join(dir, "conversations.db");
    const dbPath = join(dir, "quota.db");

    const engine = createEngine({
      conversationsPath,
      dbPath,
      persistConversations: true,
      persistTraces: false,
    });

    const thread = engine.createThread("test");
    await expect(
      engine.routeAndStream({
        threadId: thread.id,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    ).rejects.toThrow();

    const messages = engine.getThreadMessages(thread.id);
    expect(messages.filter((message) => message.role === "user").length).toBe(1);
    expect(messages.at(-1)?.content).toBe("second");

    rmSync(dir, { recursive: true, force: true });
  });
});
