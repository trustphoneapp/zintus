import { JUDGE_SESSION_COOKIE, issueJudgeSession, judgeSameOrigin, judgeSessionCookie, loadJudgeDemoConfig, parseCookie, readJudgeSession, type JudgeDemoConfig, type JudgeSession } from "./judge-demo-server";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message, code: "JUDGE_DEMO_FORBIDDEN" } }, { status, headers: { "Cache-Control": "no-store" } });
}

function runIdFromPath(path: string): string | null {
  return path.match(/^\/v1\/engineer\/runs\/([A-Za-z0-9_-]{1,200})(?:\/|$)/)?.[1] ?? null;
}

function isAllowedJudgeRoute(method: string, path: string): boolean {
  if (method === "GET") {
    if (path === "/v1/status" || path === "/v1/engineer/readiness" || path === "/v1/engineer/repository" || path === "/v1/engineer/publication-readiness") return true;
    if (!path.startsWith("/v1/engineer/runs")) return false;
    // A public judge session never receives publication, GitHub connector, or
    // Resolution Desk authority—even if a future gateway accidentally enables it.
    return !/(?:\/publication|\/git-|\/resolution|\/github|\/operations)/.test(path);
  }
  if (method !== "POST") return false;
  if (path === "/v1/engineer/runs") return true;
  return /^\/v1\/engineer\/runs\/[A-Za-z0-9_-]{1,200}\/(?:plan|freeze-plan|start|replan-explicit-contract|retry-provider-timeout|cancel|answers)$/.test(path) ||
    /^\/v1\/engineer\/runs\/[A-Za-z0-9_-]{1,200}\/decisions\/[A-Za-z0-9_-]{1,200}\/resolve$/.test(path);
}

function ownedBySession(path: string, session: JudgeSession): boolean {
  const runId = runIdFromPath(path);
  return runId == null || session.runIds.includes(runId);
}

function filteredResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const header of ["content-type", "content-length", "last-event-id"]) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }
  return headers;
}

function boundedCreateBody(config: JudgeDemoConfig, body: unknown): { body: string } | { error: Response } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: jsonError("Judge runs require a structured request.", 400) };
  const input = body as { repository?: { repositoryId?: unknown }; request?: unknown };
  if (input.repository?.repositoryId !== config.fixtureRepositoryId) return { error: jsonError("This judge session can run only the prepared fixture repository.", 403) };
  if (typeof input.request !== "string" || input.request.trim().length < 1 || input.request.length > config.maxRequestChars) {
    return { error: jsonError(`The judge task must be between 1 and ${config.maxRequestChars} characters.`, 400) };
  }
  const budget = {
    costBudgetUsd: config.runBudget.costBudgetUsd,
    tokenBudget: config.runBudget.tokenBudget,
    timeBudgetSeconds: config.runBudget.timeBudgetSeconds,
    lifetimeCostBudgetUsd: config.runBudget.costBudgetUsd,
    lifetimeTokenBudget: config.runBudget.tokenBudget,
    lifetimeTimeBudgetSeconds: config.runBudget.timeBudgetSeconds,
  };
  return { body: JSON.stringify({ ...body, budget }) };
}

/** Server-only BFF. The browser gets a signed short-lived session cookie, never a gateway token. */
export async function proxyJudgeGatewayRequest(request: Request, pathSegments: string[], options: { config?: JudgeDemoConfig | null; fetchImpl?: FetchLike; now?: number } = {}): Promise<Response> {
  const config = options.config ?? loadJudgeDemoConfig();
  if (!config) return jsonError("Judge live mode is not configured.", 503);
  if (!judgeSameOrigin(request, config)) return jsonError("Cross-site gateway requests are not allowed.", 403);
  const path = `/${pathSegments.join("/")}`;
  if (!path.startsWith("/v1/") || path.includes("..") || !isAllowedJudgeRoute(request.method, path)) return jsonError("This operation is not available in judge live mode.", 403);
  const session = readJudgeSession(config, parseCookie(request.headers.get("cookie"), JUDGE_SESSION_COOKIE), options.now);
  if (!session) return jsonError("Start a judge live session before using Engineer.", 401);
  if (!ownedBySession(path, session)) return jsonError("This run is not part of the current judge session.", 403);
  if (path === "/v1/engineer/runs" && request.method === "GET") {
    // The private gateway lists the owner-wide ledger. The online browser is
    // entitled only to run ids carried by its signed session, so filter on the
    // server and never expose a cursor that could enumerate other runs.
    const upstreamUrl = new URL(path, `${config.gatewayUrl}/`);
    const upstream = await (options.fetchImpl ?? fetch)(upstreamUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.gatewayToken}`, Accept: request.headers.get("accept") ?? "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: filteredResponseHeaders(upstream) });
    const payload = await upstream.json().catch(() => null) as { runs?: unknown } | null;
    const ownedRunIds = new Set(session.runIds);
    const runs = Array.isArray(payload?.runs) ? payload.runs.filter((run) => {
      const runId = typeof run === "object" && run !== null ? (run as { runId?: unknown }).runId : null;
      return typeof runId === "string" && ownedRunIds.has(runId);
    }) : [];
    return Response.json({ runs, nextCursor: null }, { headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/v1/engineer/runs" && request.method === "POST" && session.runIds.length > 0) return jsonError("Each judge session is limited to one live run.", 409);

  let body: string | undefined;
  if (request.method === "POST") {
    const parsed = await request.json().catch(() => null);
    if (path === "/v1/engineer/runs") {
      const bounded = boundedCreateBody(config, parsed);
      if ("error" in bounded) return bounded.error;
      body = bounded.body;
    } else {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError("Judge actions require a structured request.", 400);
      body = JSON.stringify(parsed);
    }
  }

  const upstreamUrl = new URL(path, `${config.gatewayUrl}/`);
  upstreamUrl.search = new URL(request.url).search;
  const headers = new Headers({ Authorization: `Bearer ${config.gatewayToken}`, Accept: request.headers.get("accept") ?? "application/json" });
  if (body) headers.set("Content-Type", "application/json");
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers.set("Last-Event-ID", lastEventId);
  const upstream = await (options.fetchImpl ?? fetch)(upstreamUrl, { method: request.method, headers, body, cache: "no-store", redirect: "error" });

  if (path !== "/v1/engineer/runs" || request.method !== "POST" || !upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: filteredResponseHeaders(upstream) });
  }
  const result = await upstream.json().catch(() => null) as { run?: { runId?: unknown } } | null;
  const runId = result?.run?.runId;
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) return jsonError("The gateway returned an invalid judge run identity.", 502);
  const { token } = issueJudgeSession(config, options.now, [runId]);
  const headersForClient = filteredResponseHeaders(upstream);
  headersForClient.set("Set-Cookie", judgeSessionCookie(token, config.sessionTtlSeconds));
  return new Response(JSON.stringify(result), { status: upstream.status, headers: headersForClient });
}
