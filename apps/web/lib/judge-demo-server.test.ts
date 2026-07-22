import { describe, expect, test } from "bun:test";
import { issueJudgeSession, judgeAccessCodeIsValid, loadJudgeDemoConfig, parseCookie, readJudgeSession, JUDGE_SESSION_COOKIE } from "./judge-demo-server";
import { proxyJudgeGatewayRequest } from "./judge-gateway-proxy";

const config = {
  accessCodeHash: "d".repeat(64), allowedOrigins: [], premiumEnabled: false, premiumExpiresAt: null, fixtureRepositoryId: "judge-fixture", gatewayToken: "gateway-secret", gatewayUrl: "https://gateway.example",
  maxRequestChars: 6_000, runBudget: { costBudgetUsd: 10, tokenBudget: 700_000, timeBudgetSeconds: 1_500 }, sessionSecret: "s".repeat(40), sessionTtlSeconds: 1_200,
} as const;

function request(path: string, init: RequestInit = {}, cookie?: string, url = `https://judge.example/api/judge/gateway${path}`): Request {
  return new Request(url, {
    ...init,
    headers: { Origin: "https://judge.example", ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
}

describe("hosted Judge Live Mode", () => {
  test("stays disabled until every server-only authority is explicitly configured", () => {
    expect(loadJudgeDemoConfig({ ZINTUS_JUDGE_DEMO_ENABLED: "1" })).toBeNull();
    const live = loadJudgeDemoConfig({
      ZINTUS_JUDGE_DEMO_ENABLED: "1", ZINTUS_JUDGE_GATEWAY_URL: "https://gateway.example", ZINTUS_JUDGE_GATEWAY_TOKEN: "token",
      ZINTUS_JUDGE_SESSION_SECRET: "s".repeat(32), ZINTUS_JUDGE_ACCESS_CODE_HASH: "a".repeat(64), ZINTUS_JUDGE_FIXTURE_REPOSITORY_ID: "fixture",
    });
    expect(live?.runBudget).toEqual({ costBudgetUsd: 10, tokenBudget: 700_000, timeBudgetSeconds: 1_500 });
  });

  test("derives the official apex/www origins from the configured public site URL", () => {
    const live = loadJudgeDemoConfig({
      ZINTUS_ENGINEER_PREMIUM_ENABLED: "1", NEXT_PUBLIC_SITE_URL: "https://www.zintus.ai",
      ZINTUS_JUDGE_GATEWAY_URL: "https://gateway.example", ZINTUS_JUDGE_GATEWAY_TOKEN: "token",
      ZINTUS_JUDGE_SESSION_SECRET: "s".repeat(32), ZINTUS_JUDGE_FIXTURE_REPOSITORY_ID: "fixture",
    });
    expect(live?.allowedOrigins).toContain("https://www.zintus.ai");
    expect(live?.allowedOrigins).toContain("https://zintus.ai");
  });

  test("allows an Engineer-only Premium deployment without an invitation-code hash", () => {
    const live = loadJudgeDemoConfig({
      ZINTUS_ENGINEER_PREMIUM_ENABLED: "1", ZINTUS_JUDGE_GATEWAY_URL: "https://gateway.example", ZINTUS_JUDGE_GATEWAY_TOKEN: "token",
      ZINTUS_JUDGE_SESSION_SECRET: "s".repeat(32), ZINTUS_JUDGE_FIXTURE_REPOSITORY_ID: "fixture",
    });
    expect(live?.premiumEnabled).toBe(true);
    expect(live?.accessCodeHash).toBe("");
  });

  test("signs short-lived session cookies and rejects tampering", () => {
    const { token } = issueJudgeSession(config, 10_000);
    expect(readJudgeSession(config, token, 10_001)?.runIds).toEqual([]);
    expect(readJudgeSession(config, `${token}x`, 10_001)).toBeNull();
    expect(readJudgeSession(config, token, 1_220_001)).toBeNull();
  });

  test("compares the access-code digest without retaining the submitted code", () => {
    const code = "judge-only-code";
    const configWithHash = { ...config, accessCodeHash: new Bun.CryptoHasher("sha256").update(code).digest("hex") };
    expect(judgeAccessCodeIsValid(configWithHash, code)).toBe(true);
    expect(judgeAccessCodeIsValid(configWithHash, "wrong")).toBe(false);
  });

  test("allows exactly one fixture-bound run, clamps its budget server-side, and fences other run ids", async () => {
    const { token } = issueJudgeSession(config, 10_000);
    const cookie = `${JUDGE_SESSION_COOKIE}=${token}`;
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ run: { runId: "run-1" } }, { status: 201 });
    };
    const response = await proxyJudgeGatewayRequest(request("/v1/engineer/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: { repositoryId: "judge-fixture" }, request: "Implement the fixture", budget: { costBudgetUsd: 99 } }),
    }, cookie), ["v1", "engineer", "runs"], { config, fetchImpl, now: 10_001 });
    expect(response.status).toBe(201);
    expect(calls[0]).toEqual({ url: "https://gateway.example/v1/engineer/runs", authorization: "Bearer gateway-secret", body: expect.objectContaining({ budget: {
      costBudgetUsd: 10, tokenBudget: 700_000, timeBudgetSeconds: 1_500, lifetimeCostBudgetUsd: 10, lifetimeTokenBudget: 700_000, lifetimeTimeBudgetSeconds: 1_500,
    } }) });
    const nextCookie = parseCookie(response.headers.get("set-cookie"), JUDGE_SESSION_COOKIE);
    expect(readJudgeSession(config, nextCookie, 10_002)?.runIds).toEqual(["run-1"]);
    expect((await proxyJudgeGatewayRequest(request("/v1/engineer/runs/run-other", {}, `${JUDGE_SESSION_COOKIE}=${nextCookie}`), ["v1", "engineer", "runs", "run-other"], { config, fetchImpl, now: 10_002 })).status).toBe(403);
    expect((await proxyJudgeGatewayRequest(request("/v1/engineer/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }, `${JUDGE_SESSION_COOKIE}=${nextCookie}`), ["v1", "engineer", "runs"], { config, fetchImpl, now: 10_002 })).status).toBe(409);
  });

  test("allows an official custom-domain origin even when the route URL is an internal deployment host", async () => {
    const publicConfig = { ...config, allowedOrigins: ["https://www.zintus.ai", "https://zintus.ai"] };
    const { token } = issueJudgeSession(publicConfig, 10_000);
    const calls: string[] = [];
    const response = await proxyJudgeGatewayRequest(request("/v1/engineer/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://zintus.ai" },
      body: JSON.stringify({ repository: { repositoryId: "judge-fixture" }, request: "Implement the fixture" }),
    }, `${JUDGE_SESSION_COOKIE}=${token}`, "https://zintus-web-git-main-ys-ventures.vercel.app/api/judge/gateway/v1/engineer/runs"), ["v1", "engineer", "runs"], {
      config: publicConfig,
      fetchImpl: async (input) => { calls.push(String(input)); return Response.json({ run: { runId: "run-1" } }, { status: 201 }); },
      now: 10_001,
    });
    expect(response.status).toBe(201);
    expect(calls).toEqual(["https://gateway.example/v1/engineer/runs"]);
  });

  test("accepts a browser same-origin GET that has Sec-Fetch-Site but no Origin header", async () => {
    const { token } = issueJudgeSession(config, 10_000);
    const calls: string[] = [];
    const response = await proxyJudgeGatewayRequest(new Request("https://judge.example/api/judge/gateway/v1/status", {
      headers: { "Sec-Fetch-Site": "same-origin", Cookie: `${JUDGE_SESSION_COOKIE}=${token}` },
    }), ["v1", "status"], {
      config, fetchImpl: async (input) => { calls.push(String(input)); return Response.json({ ok: true }); }, now: 10_001,
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://gateway.example/v1/status"]);
  });

  test("rejects Origin-less requests that are not browser-attested same-origin", async () => {
    const { token } = issueJudgeSession(config, 10_000);
    const headerVariants: Record<string, string>[] = [{}, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "none" }];
    for (const headers of headerVariants) {
      const response = await proxyJudgeGatewayRequest(new Request("https://judge.example/api/judge/gateway/v1/status", {
        headers: { ...headers, Cookie: `${JUDGE_SESSION_COOKIE}=${token}` },
      }), ["v1", "status"], {
        config, fetchImpl: async () => Response.json({ ok: true }), now: 10_001,
      });
      expect(response.status).toBe(403);
    }
  });

  test("rejects publication and cross-site routes before they reach the private gateway", async () => {
    const { token } = issueJudgeSession(config, 10_000);
    const calls: unknown[] = [];
    const forbidden = await proxyJudgeGatewayRequest(request("/v1/engineer/runs/run-1/publication-candidates", {}, `${JUDGE_SESSION_COOKIE}=${token}`), ["v1", "engineer", "runs", "run-1", "publication-candidates"], {
      config, fetchImpl: async () => { calls.push("called"); return Response.json({}); }, now: 10_001,
    });
    expect(forbidden.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
