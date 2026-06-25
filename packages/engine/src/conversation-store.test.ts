import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore } from "./conversation-store.js";

// The SQLite store behind /v1/threads, /v1/threads/:id/messages and /v1/traces.

describe("ConversationStore", () => {
  let dir: string;
  let store: ConversationStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-conv-"));
    store = new ConversationStore(join(dir, "conv.db"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("createThread then listThreads returns it", () => {
    const t = store.createThread("My chat");
    const threads = store.listThreads();
    expect(threads.map((x) => x.id)).toContain(t.id);
    expect(threads.find((x) => x.id === t.id)?.title).toBe("My chat");
  });

  test("appendMessage stores messages in order, scoped to the thread, with meta", () => {
    const t = store.createThread();
    store.appendMessage(t.id, { role: "user", content: "hi" });
    store.appendMessage(t.id, { role: "assistant", content: "hello" }, { providerId: "groq", model: "llama" });
    const other = store.createThread();
    store.appendMessage(other.id, { role: "user", content: "elsewhere" });

    const msgs = store.getThreadMessages(t.id);
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(msgs[1]!.providerId).toBe("groq");
    expect(msgs[1]!.model).toBe("llama");
    expect(store.getThreadMessages(other.id).map((m) => m.content)).toEqual(["elsewhere"]);
  });

  test("listThreads orders by most-recently-updated (appendMessage bumps updatedAt)", async () => {
    const a = store.createThread("A");
    await new Promise((r) => setTimeout(r, 2));
    const b = store.createThread("B");
    // b is newest now; touch a so it jumps ahead.
    await new Promise((r) => setTimeout(r, 2));
    store.appendMessage(a.id, { role: "user", content: "touch" });
    expect(store.listThreads().map((t) => t.id).slice(0, 2)).toEqual([a.id, b.id]);
  });

  test("full trace lifecycle: start -> attempts -> complete -> getTrace", () => {
    store.startTrace("tr-1");
    store.recordAttempt("tr-1", { providerId: "gemini", model: "g", status: "fail", latencyMs: 12, errorCode: 429 });
    store.recordAttempt("tr-1", { providerId: "groq", model: "llama", status: "success", latencyMs: 30 });
    store.completeTrace("tr-1", { winner: { providerId: "groq", model: "llama" }, totalLatencyMs: 42, startedAt: new Date(), completedAt: new Date() });

    const trace = store.getTrace("tr-1");
    expect(trace).not.toBeNull();
    expect(trace!.attempts.length).toBe(2);
    expect(trace!.attempts[0]!.status).toBe("fail");
    expect(trace!.attempts[0]!.errorCode).toBe(429);
    expect(trace!.winner).toEqual({ providerId: "groq", model: "llama" });
    expect(trace!.totalLatencyMs).toBe(42);
  });

  test("getTrace returns null for an unknown id", () => {
    expect(store.getTrace("nope")).toBeNull();
  });

  test("getLastTrace returns the most recently started trace", async () => {
    store.startTrace("old");
    await new Promise((r) => setTimeout(r, 2));
    store.startTrace("new");
    expect(store.getLastTrace()?.traceId).toBe("new");
  });

  test("listTraces is newest-first and respects the limit", async () => {
    for (const id of ["t1", "t2", "t3"]) {
      store.startTrace(id);
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = store.listTraces(10).map((t) => t.traceId);
    expect(all).toEqual(["t3", "t2", "t1"]);
    expect(store.listTraces(2).map((t) => t.traceId)).toEqual(["t3", "t2"]);
  });
});
