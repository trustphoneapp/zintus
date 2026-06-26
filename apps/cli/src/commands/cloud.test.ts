import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Isolate the on-disk config from the real ~/.zintus ──────────────────────
// cloud.ts reads ZINTUS_CONFIG_DIR (falling back to ~/.zintus). Point it at a
// throwaway dir so the test can never read or clobber the developer's real
// ~/.zintus/cloud.json. (HOME can't be used: Bun caches os.homedir() at startup.)
const TEST_DIR = await mkdtemp(join(tmpdir(), "zintus-cloud-test-"));
process.env.ZINTUS_CONFIG_DIR = TEST_DIR;
// loadCloudConfig() prefers these env vars over the file — clear them so the
// file path (the thing under test) is exercised.
delete process.env.ZINTUS_SESSION_ID;
delete process.env.ZINTUS_GATEWAY_SECRET;
delete process.env.ZINTUS_RELAY_URL;
delete process.env.ZINTUS_WEB_URL;

// Don't actually launch a browser during `cloud login`.
const openedUrls: string[] = [];
mock.module("../lib/open-url.js", () => ({
  openUrl: async (url: string) => {
    openedUrls.push(url);
  },
}));

const cloud = await import("./cloud.js");

const RELAY = "https://relay.test";
const WEB = "https://web.test";
const CONFIG_PATH = join(TEST_DIR, "cloud.json");

// ── fetch double ────────────────────────────────────────────────────────────
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
let calls: RecordedCall[] = [];
let route: (url: string, init?: RequestInit) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  openedUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k] = String(v);
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return route(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.restore();
});

describe("runCloudLogin — relay cli-login/cli-status contract", () => {
  it("registers a state token, opens the WEB login page, polls cli-status, and stores the credentials the relay returns", async () => {
    // Relay contract (workers/relay/src/index.ts):
    //   POST /api/auth/cli-login   { state }            -> { ok: true }
    //   GET  /api/auth/cli-status?state=<state>         -> 200 { status:"complete", session_id, gateway_secret }
    route = (url) => {
      if (url === `${RELAY}/api/auth/cli-login`) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith(`${RELAY}/api/auth/cli-status?`)) {
        return new Response(
          JSON.stringify({
            status: "complete",
            session_id: "sess-123",
            gateway_secret: "secret-abc",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await cloud.runCloudLogin({ relayUrl: RELAY, webUrl: WEB });

    // 1. Registration POST carries a `state` token in the JSON body.
    const reg = calls.find((c) => c.url === `${RELAY}/api/auth/cli-login`);
    expect(reg).toBeDefined();
    expect(reg!.method).toBe("POST");
    expect(reg!.headers["Content-Type"]).toBe("application/json");
    const state = (JSON.parse(reg!.body ?? "{}") as { state?: string }).state;
    expect(typeof state).toBe("string");
    expect(state!.length).toBeGreaterThan(0);

    // 2. The browser is sent to the WEB app's /login page (NOT a relay API
    //    route) with the SAME state and cli=true — the params login/page.tsx reads.
    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toBe(`${WEB}/login?cli=true&state=${state}`);

    // 3. Polling hits cli-status with the same state.
    const poll = calls.find((c) =>
      c.url.startsWith(`${RELAY}/api/auth/cli-status?`),
    );
    expect(poll).toBeDefined();
    expect(poll!.url).toBe(`${RELAY}/api/auth/cli-status?state=${state}`);

    // 4. The exact relay response fields are persisted to ~/.zintus/cloud.json.
    const saved = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as {
      session_id: string;
      gateway_secret: string;
      relay_url: string;
    };
    expect(saved).toEqual({
      session_id: "sess-123",
      gateway_secret: "secret-abc",
      relay_url: RELAY,
    });
  }, 15000);
});

describe("runCloudStatus — sessions status request shape", () => {
  it("queries /api/sessions/:id/status with the gateway_secret as a Bearer token", async () => {
    await cloud.saveCloudConfig({
      session_id: "sess-123",
      gateway_secret: "secret-abc",
      relay_url: RELAY,
    });

    route = (url) => {
      if (url === `${RELAY}/api/sessions/sess-123/status`) {
        return new Response(
          JSON.stringify({ online: true, last_seen: Date.now() }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await cloud.runCloudStatus();

    const req = calls.find(
      (c) => c.url === `${RELAY}/api/sessions/sess-123/status`,
    );
    expect(req).toBeDefined();
    expect(req!.method).toBe("GET");
    // The CLI presents the gateway_secret as a Bearer token. NOTE: the relay
    // route is currently COOKIE-authenticated and ignores this header (known
    // relay-side gap — see cloud.ts). This test pins the request the CLI emits so
    // the contract is detectable if either side changes.
    expect(req!.headers["Authorization"]).toBe("Bearer secret-abc");
  });
});

describe("runCloudLogout — session delete request + local clear", () => {
  it("sends DELETE /api/sessions/:id with the Bearer token and removes the local config", async () => {
    await cloud.saveCloudConfig({
      session_id: "sess-123",
      gateway_secret: "secret-abc",
      relay_url: RELAY,
    });

    route = (url) => {
      if (url === `${RELAY}/api/sessions/sess-123`) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await cloud.runCloudLogout();

    const req = calls.find((c) => c.url === `${RELAY}/api/sessions/sess-123`);
    expect(req).toBeDefined();
    expect(req!.method).toBe("DELETE");
    expect(req!.headers["Authorization"]).toBe("Bearer secret-abc");

    // Local credentials are always cleared, regardless of the server response.
    expect(await cloud.loadCloudConfig()).toBeNull();
  });
});
