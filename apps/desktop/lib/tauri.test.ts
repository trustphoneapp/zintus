import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stable spy with a swappable implementation so the mocked module survives
// bun's dynamic-import cache (the consumer lazy-imports core inside each call).
let invokeImpl: (command: string, args?: Record<string, unknown>) => unknown;
const invoke = mock(
  (command: string, args?: Record<string, unknown>): unknown =>
    invokeImpl(command, args),
);
mock.module("@tauri-apps/api/core", () => ({ invoke }));

// Imported after the module mock is registered. `./tauri` only lazy-imports
// `@tauri-apps/api/core` inside its functions, so the mock is in place by the
// time any test calls one.
import { deleteKey, getKey, hasKey, isTauri, setKey } from "./tauri";

type GlobalWithWindow = { window?: unknown };
const g = globalThis as GlobalWithWindow;
const originalWindow = g.window;

function setTauri(present: boolean): void {
  g.window = present ? { __TAURI_INTERNALS__: {} } : {};
}

beforeEach(() => {
  invoke.mockClear();
  invokeImpl = () => undefined;
  setTauri(true);
});

afterEach(() => {
  g.window = originalWindow;
});

describe("desktop keyring -> real invoke(keyring_*) commands", () => {
  test("isTauri reflects the __TAURI_INTERNALS__ marker", () => {
    setTauri(true);
    expect(isTauri()).toBe(true);
    setTauri(false);
    expect(isTauri()).toBe(false);
  });

  test("getKey invokes keyring_get with the camelCase providerId arg", async () => {
    invokeImpl = () => "sk-live-123";
    const result = await getKey("groq");

    expect(result).toBe("sk-live-123");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("keyring_get", { providerId: "groq" });
  });

  test("getKey returns null (not throw) when the command rejects", async () => {
    invokeImpl = () => {
      throw new Error("keychain locked");
    };
    expect(await getKey("gemini")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("getKey is a no-op returning null outside Tauri", async () => {
    setTauri(false);
    expect(await getKey("groq")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("setKey invokes keyring_set with providerId + key", async () => {
    await setKey("gemini", "sk-secret");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("keyring_set", {
      providerId: "gemini",
      key: "sk-secret",
    });
  });

  test("setKey throws outside Tauri and never invokes", async () => {
    setTauri(false);
    await expect(setKey("gemini", "sk-secret")).rejects.toThrow(
      "only available in the desktop app",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test("deleteKey invokes keyring_delete with the providerId arg", async () => {
    await deleteKey("mistral");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("keyring_delete", {
      providerId: "mistral",
    });
  });

  test("deleteKey swallows command errors", async () => {
    invokeImpl = () => {
      throw new Error("missing entry");
    };
    await expect(deleteKey("mistral")).resolves.toBeUndefined();
  });

  test("deleteKey is a no-op outside Tauri", async () => {
    setTauri(false);
    await deleteKey("mistral");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("hasKey short-circuits true for local providers without invoking", async () => {
    expect(await hasKey("ollama")).toBe(true);
    expect(await hasKey("lmstudio")).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("hasKey reflects whether keyring_get returned a key", async () => {
    invokeImpl = () => "sk-present";
    expect(await hasKey("groq")).toBe(true);

    invokeImpl = () => null;
    expect(await hasKey("groq")).toBe(false);
  });
});
