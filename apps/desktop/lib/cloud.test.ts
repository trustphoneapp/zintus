import { afterEach, describe, expect, test } from "bun:test";
import {
  clearSessionToken,
  getMe,
  getSessionToken,
  setSessionToken,
  startDeviceLogin,
  RELAY_URL,
  WEB_URL,
} from "./cloud";

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await clearSessionToken();
});

describe("session token store (non-Tauri: in-memory)", () => {
  test("set → get → clear round-trip", async () => {
    expect(await getSessionToken()).toBeNull();
    await setSessionToken("tok-123");
    expect(await getSessionToken()).toBe("tok-123");
    await clearSessionToken();
    expect(await getSessionToken()).toBeNull();
  });
});

describe("startDeviceLogin", () => {
  test("returns null when state registration fails", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    expect(await startDeviceLogin()).toBeNull();
  });

  test("hands back the web login URL with the registered state", async () => {
    let registeredState = "";
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/auth/cli-login")) {
        registeredState = (JSON.parse(String(init?.body)) as { state: string }).state;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
    }) as unknown as typeof fetch;

    const login = await startDeviceLogin();
    expect(login).not.toBeNull();
    expect(login!.loginUrl).toBe(`${WEB_URL}/login?cli=true&state=${registeredState}`);
    // Cancel immediately — completion resolves null without a long poll.
    login!.cancel();
    expect(await login!.completion).toBeNull();
  });
});

describe("getMe", () => {
  test("no token → unauthenticated without a network call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await getMe()).toEqual({ authenticated: false });
    expect(called).toBe(false);
  });

  test("token is presented as a bearer to the relay", async () => {
    await setSessionToken("tok-abc");
    let auth = "";
    let url = "";
    globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      url = String(u);
      auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return new Response(
        JSON.stringify({ authenticated: true, email: "y@test.dev" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const me = await getMe();
    expect(me).toEqual({ authenticated: true, email: "y@test.dev" });
    expect(url).toBe(`${RELAY_URL}/api/auth/me`);
    expect(auth).toBe("Bearer tok-abc");
  });
});
