import { afterEach, describe, expect, test } from "bun:test";
import {
  createMemory,
  deleteMemory,
  listMemory,
  updateMemory,
  type MemoryFact,
} from "./memory-api";

const realFetch = globalThis.fetch;

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "f1",
    threadId: null,
    key: "name",
    value: "Alice",
    scope: "global",
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("memory-api client", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("listMemory maps scope/thread/project to query params and returns memory[]", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ memory: [fact()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await listMemory({ scope: "global", threadId: "t1" });
    expect(out).toEqual([fact()]);
    expect(calledUrl).toContain("/v1/memory?");
    expect(calledUrl).toContain("scope=global");
    expect(calledUrl).toContain("thread_id=t1");
  });

  test("createMemory POSTs snake_case body and returns the fact", async () => {
    let method = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method ?? "GET";
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ memory: fact({ value: "Bob" }) }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const created = await createMemory({
      scope: "global",
      key: "name",
      value: "Bob",
      threadId: "t9",
    });
    expect(method).toBe("POST");
    expect(body.thread_id).toBe("t9"); // camelCase → snake_case on the wire
    expect(body.key).toBe("name");
    expect(created.value).toBe("Bob");
  });

  test("updateMemory PATCHes /v1/memory/:id and returns the fact", async () => {
    let url = "";
    let method = "";
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      url = String(i);
      method = init?.method ?? "GET";
      return new Response(JSON.stringify({ memory: fact({ pinned: true }) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const updated = await updateMemory("f1", { pinned: true });
    expect(method).toBe("PATCH");
    expect(url).toContain("/v1/memory/f1");
    expect(updated.pinned).toBe(true);
  });

  test("deleteMemory DELETEs and resolves on 200", async () => {
    let method = "";
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method ?? "GET";
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(deleteMemory("f1")).resolves.toBeUndefined();
    expect(method).toBe("DELETE");
  });

  test("a non-OK response throws", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(listMemory({ scope: "global" })).rejects.toThrow();
  });
});
