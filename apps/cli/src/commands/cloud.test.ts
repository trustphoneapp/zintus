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

// Capture EVERYTHING the commands print (stdout via console.log for --json,
// stderr via console.error for human output) so tests can assert on it AND
// guarantee the gateway_secret is never leaked to any stream.
let output: string[] = [];
const realLog = console.log;
const realError = console.error;
const SECRET = "secret-abc"; // the gateway_secret used across these tests

beforeEach(() => {
  calls = [];
  openedUrls.length = 0;
  output = [];
  process.exitCode = 0;
  console.log = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void output.push(args.map(String).join(" "));
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
  console.log = realLog;
  console.error = realError;
  // A test that exercised a failure path leaves exitCode=1; don't let that leak
  // into the runner's own exit status.
  process.exitCode = 0;
});

/** The combined stdout+stderr the command printed during a test. */
function printed(): string {
  return output.join("\n");
}

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

describe("runCloudStatus — honest state from the relay's real response", () => {
  async function withConfig() {
    await cloud.saveCloudConfig({
      session_id: "sess-123",
      gateway_secret: SECRET,
      relay_url: RELAY,
    });
  }
  const STATUS_URL = `${RELAY}/api/sessions/sess-123/status`;

  it("sends GET with the gateway_secret as a Bearer token (the credential the relay validates)", async () => {
    await withConfig();
    route = (url) =>
      url === STATUS_URL
        ? new Response(JSON.stringify({ online: true }), { status: 200 })
        : (() => {
            throw new Error(`unexpected fetch: ${url}`);
          })();

    await cloud.runCloudStatus();

    const req = calls.find((c) => c.url === STATUS_URL);
    expect(req).toBeDefined();
    expect(req!.method).toBe("GET");
    // The relay accepts THIS exact header on the status route (session-scoped
    // gateway_secret Bearer — workers/relay/tests/cloud-auth-bearer.test.ts).
    expect(req!.headers["Authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("200 online:true → reports online, exit 0, never prints the secret", async () => {
    await withConfig();
    route = () =>
      new Response(JSON.stringify({ online: true, last_seen: 1 }), { status: 200 });

    await cloud.runCloudStatus();

    expect(printed().toLowerCase()).toContain("online");
    expect(process.exitCode).toBe(0);
    expect(printed()).not.toContain(SECRET);
  });

  it("200 online:false → reports offline, exit 0", async () => {
    await withConfig();
    route = () => new Response(JSON.stringify({ online: false }), { status: 200 });

    await cloud.runCloudStatus();

    expect(printed().toLowerCase()).toContain("offline");
    expect(printed().toLowerCase()).not.toContain("cannot verify");
    expect(process.exitCode).toBe(0);
  });

  it("401 → honest 'unknown (cannot verify)', NOT a false 'offline', exit 1", async () => {
    await withConfig();
    route = () => new Response("Unauthorized", { status: 401 });

    await cloud.runCloudStatus();

    expect(printed().toLowerCase()).toContain("unknown");
    expect(printed().toLowerCase()).toContain("cannot verify");
    expect(printed().toLowerCase()).not.toContain("offline");
    expect(process.exitCode).toBe(1);
    expect(printed()).not.toContain(SECRET);
  });

  it("relay unreachable (fetch throws) → 'unknown (cannot verify — could not reach relay)', exit 1", async () => {
    await withConfig();
    route = () => {
      throw new Error("ECONNREFUSED");
    };

    await cloud.runCloudStatus();

    expect(printed().toLowerCase()).toContain("could not reach relay");
    expect(printed().toLowerCase()).not.toContain("offline");
    expect(process.exitCode).toBe(1);
  });

  it("--json 200 → machine-readable {status:'online'} on stdout, no secret", async () => {
    await withConfig();
    route = () =>
      new Response(JSON.stringify({ online: true, last_seen: 42 }), { status: 200 });

    await cloud.runCloudStatus({ json: true });

    const parsed = JSON.parse(printed()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      logged_in: true,
      session_id: "sess-123",
      relay: RELAY,
      status: "online",
      online: true,
      last_seen: 42,
    });
    expect(process.exitCode).toBe(0);
    expect(printed()).not.toContain(SECRET);
  });

  it("--json 401 → {status:'unknown', online:null, reason}, exit 1", async () => {
    await withConfig();
    route = () => new Response("Unauthorized", { status: 401 });

    await cloud.runCloudStatus({ json: true });

    const parsed = JSON.parse(printed()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: "unknown", online: null });
    expect(typeof parsed.reason).toBe("string");
    expect(process.exitCode).toBe(1);
  });

  it("not logged in → reports it (json {logged_in:false}), exit 0, no relay call", async () => {
    await cloud.clearCloudConfig();
    route = () => {
      throw new Error("should not fetch when logged out");
    };

    await cloud.runCloudStatus({ json: true });

    expect(JSON.parse(printed())).toEqual({ logged_in: false });
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });
});

describe("runCloudLogout — revoke the server session AND clear local state", () => {
  async function withConfig() {
    await cloud.saveCloudConfig({
      session_id: "sess-123",
      gateway_secret: SECRET,
      relay_url: RELAY,
    });
  }
  const DELETE_URL = `${RELAY}/api/sessions/sess-123`;

  it("200 → calls DELETE with the Bearer, reports revoked, clears local, exit 0, no secret", async () => {
    await withConfig();
    route = (url) =>
      url === DELETE_URL
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : (() => {
            throw new Error(`unexpected fetch: ${url}`);
          })();

    await cloud.runCloudLogout();

    const req = calls.find((c) => c.url === DELETE_URL);
    expect(req).toBeDefined();
    expect(req!.method).toBe("DELETE");
    expect(req!.headers["Authorization"]).toBe(`Bearer ${SECRET}`);
    expect(printed().toLowerCase()).toContain("revoked");
    expect(await cloud.loadCloudConfig()).toBeNull();
    expect(process.exitCode).toBe(0);
    expect(printed()).not.toContain(SECRET);
  });

  it("401 → STILL clears local but reports the revoke failure, exit 1", async () => {
    await withConfig();
    route = () => new Response("Unauthorized", { status: 401 });

    await cloud.runCloudLogout();

    // The DELETE was attempted with the Bearer the relay validates.
    const req = calls.find((c) => c.url === DELETE_URL);
    expect(req!.method).toBe("DELETE");
    expect(req!.headers["Authorization"]).toBe(`Bearer ${SECRET}`);
    // Local state cleared regardless...
    expect(await cloud.loadCloudConfig()).toBeNull();
    // ...but the failure is reported, not hidden behind a green checkmark.
    expect(printed().toLowerCase()).toContain("could not revoke");
    expect(process.exitCode).toBe(1);
    expect(printed()).not.toContain(SECRET);
  });

  it("relay unreachable (fetch throws) → clears local, reports failure, exit 1", async () => {
    await withConfig();
    route = () => {
      throw new Error("ECONNREFUSED");
    };

    await cloud.runCloudLogout();

    expect(await cloud.loadCloudConfig()).toBeNull();
    expect(printed().toLowerCase()).toContain("could not reach relay");
    expect(process.exitCode).toBe(1);
  });

  it("--json 200 → {logged_out:true, revoked:true}, exit 0", async () => {
    await withConfig();
    route = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    await cloud.runCloudLogout({ json: true });

    const parsed = JSON.parse(printed()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      logged_out: true,
      revoked: true,
      session_id: "sess-123",
      relay: RELAY,
    });
    expect(parsed.reason).toBeUndefined();
    expect(process.exitCode).toBe(0);
    expect(printed()).not.toContain(SECRET);
  });

  it("--json 401 → {logged_out:true, revoked:false, reason}, exit 1", async () => {
    await withConfig();
    route = () => new Response("Unauthorized", { status: 401 });

    await cloud.runCloudLogout({ json: true });

    const parsed = JSON.parse(printed()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ logged_out: true, revoked: false });
    expect(typeof parsed.reason).toBe("string");
    expect(process.exitCode).toBe(1);
  });

  it("not logged in → no relay call, json {logged_out:false, reason:'not_logged_in'}, exit 0", async () => {
    await cloud.clearCloudConfig();
    route = () => {
      throw new Error("should not fetch when logged out");
    };

    await cloud.runCloudLogout({ json: true });

    expect(calls).toHaveLength(0);
    expect(JSON.parse(printed())).toMatchObject({
      logged_out: false,
      revoked: false,
      reason: "not_logged_in",
    });
    expect(process.exitCode).toBe(0);
  });
});
