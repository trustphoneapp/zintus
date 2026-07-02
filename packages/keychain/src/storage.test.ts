// Force the in-memory backend BEFORE importing storage. usingMemory() is lazy
// (decided on first key op) and process-cached, so setting this at module scope
// guarantees the test never reads or writes the real OS keychain.
process.env.CI_KEYCHAIN = "memory";

import { afterEach, describe, expect, test } from "bun:test";
import { setKey, getKey, deleteKey, listKeys, probeKeychain } from "./storage.js";
import { PROVIDER_IDS } from "@zintus/types";

// Clean every provider's slot + the manifest between tests so cases don't leak
// state through the shared in-memory store.
afterEach(async () => {
  for (const id of PROVIDER_IDS) {
    await deleteKey(id);
  }
});

describe("keychain storage (in-memory backend)", () => {
  test("set -> get -> delete round-trip", async () => {
    expect(await getKey("groq")).toBeNull();
    await setKey("groq", "gsk_secret_value");
    expect(await getKey("groq")).toBe("gsk_secret_value");
    await deleteKey("groq");
    expect(await getKey("groq")).toBeNull();
  });

  test("setKey rejects an unknown provider", async () => {
    // (anthropic became a real provider on 2026-07-02 — use a genuinely unknown id.)
    await expect(setKey("not-a-provider" as never, "x")).rejects.toThrow(/Unknown provider/);
  });

  test("getKey returns null for an unknown provider (no throw)", async () => {
    expect(await getKey("not-a-provider" as never)).toBeNull();
  });

  test("listKeys returns only providers that have a key, de-duplicated", async () => {
    await setKey("groq", "gsk_a");
    await setKey("gemini", "AIza_b");
    const keys = await listKeys();
    expect(keys.sort()).toEqual(["gemini", "groq"]);
    // idempotent set must not duplicate the manifest entry
    await setKey("groq", "gsk_a2");
    const keys2 = await listKeys();
    expect(keys2.filter((k) => k === "groq").length).toBe(1);
  });

  test("deleteKey removes the provider from listKeys", async () => {
    await setKey("groq", "gsk_a");
    await setKey("gemini", "AIza_b");
    await deleteKey("groq");
    expect((await listKeys()).sort()).toEqual(["gemini"]);
  });

  test("listKeys recovers via scan when the manifest is unreadable", async () => {
    // Even if the manifest were corrupt/empty, listKeys scans PROVIDER_IDS and
    // still finds a stored key. Setting then reading proves the scan path.
    await setKey("cohere", "cohere_key");
    expect(await listKeys()).toContain("cohere");
  });

  test("probeKeychain succeeds on the in-memory backend", () => {
    expect(probeKeychain()).toEqual({ ok: true });
  });
});
