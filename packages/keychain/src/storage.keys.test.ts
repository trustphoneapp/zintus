// Force the in-memory backend BEFORE importing storage (see storage.test.ts).
process.env.CI_KEYCHAIN = "memory";

import { afterEach, describe, expect, test } from "bun:test";
import {
  setKey,
  getKey,
  getKeys,
  setKeys,
  deleteKey,
  deleteKeyAt,
} from "./storage.js";
import { PROVIDER_IDS } from "@zintus/types";

afterEach(async () => {
  for (const id of PROVIDER_IDS) {
    await deleteKey(id);
  }
});

describe("keychain ordered keys (BYOK priority + fallback)", () => {
  test("getKeys/setKeys round-trip preserves order, primary first", async () => {
    expect(await getKeys("groq")).toEqual([]);
    await setKeys("groq", ["primary", "fallback-1", "fallback-2"]);
    expect(await getKeys("groq")).toEqual(["primary", "fallback-1", "fallback-2"]);
    // The primary stays readable via the single-key getKey (back-compat).
    expect(await getKey("groq")).toBe("primary");
  });

  test("a single key set via setKey reads back as a 1-element array", async () => {
    await setKey("gemini", "AIza_solo");
    expect(await getKeys("gemini")).toEqual(["AIza_solo"]);
  });

  test("getKey === getKeys()[0] (back-compat after setKeys)", async () => {
    await setKeys("cerebras", ["a", "b"]);
    const keys = await getKeys("cerebras");
    expect(await getKey("cerebras")).toBe(keys[0] ?? null);
  });

  test("setKey clears any existing fallback tail (sole/primary contract)", async () => {
    await setKeys("groq", ["k1", "k2", "k3"]);
    await setKey("groq", "only");
    expect(await getKeys("groq")).toEqual(["only"]);
  });

  test("setKeys dedupes and drops blanks, order preserved", async () => {
    await setKeys("groq", ["a", " a ", "", "b", "a"]);
    expect(await getKeys("groq")).toEqual(["a", "b"]);
  });

  test("setKeys with an empty list deletes the provider", async () => {
    await setKeys("groq", ["a", "b"]);
    await setKeys("groq", []);
    expect(await getKeys("groq")).toEqual([]);
    expect(await getKey("groq")).toBeNull();
  });

  test("deleteKeyAt removes a key and re-promotes the next as primary", async () => {
    await setKeys("groq", ["p", "f1", "f2"]);
    await deleteKeyAt("groq", 0);
    expect(await getKeys("groq")).toEqual(["f1", "f2"]);
    expect(await getKey("groq")).toBe("f1");
    await deleteKeyAt("groq", 1);
    expect(await getKeys("groq")).toEqual(["f1"]);
  });

  test("deleteKeyAt out of range is a no-op", async () => {
    await setKeys("groq", ["a", "b"]);
    await deleteKeyAt("groq", 9);
    expect(await getKeys("groq")).toEqual(["a", "b"]);
  });

  test("deleteKey clears the fallback tail too (no orphaned keys)", async () => {
    await setKeys("groq", ["a", "b", "c"]);
    await deleteKey("groq");
    expect(await getKeys("groq")).toEqual([]);
  });

  test("setKeys rejects an unknown provider", async () => {
    await expect(setKeys("nope" as never, ["x"])).rejects.toThrow(/Unknown provider/);
  });
});
