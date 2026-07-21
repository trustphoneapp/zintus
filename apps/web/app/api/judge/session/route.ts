import { JUDGE_SESSION_COOKIE, judgeAccessCodeIsValid, judgeSameOrigin, judgeSessionCookie, issueJudgeSession, loadJudgeDemoConfig, parseCookie, readJudgeSession } from "@/lib/judge-demo-server";

export const runtime = "nodejs";

function projection(config: NonNullable<ReturnType<typeof loadJudgeDemoConfig>>, expiresAt: number) {
  return { session: { expiresAt: new Date(expiresAt).toISOString(), fixtureRepositoryId: config.fixtureRepositoryId,
    limits: { costUsd: config.runBudget.costBudgetUsd, tokens: config.runBudget.tokenBudget, timeSeconds: config.runBudget.timeBudgetSeconds } } };
}

export async function GET(request: Request): Promise<Response> {
  const config = loadJudgeDemoConfig();
  if (!config) return Response.json({ error: "Judge live mode is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const session = readJudgeSession(config, parseCookie(request.headers.get("cookie"), JUDGE_SESSION_COOKIE));
  if (!session && config.premiumEnabled) {
    const issued = issueJudgeSession(config);
    return Response.json(projection(config, issued.session.expiresAt), { headers: { "Cache-Control": "no-store", "Set-Cookie": judgeSessionCookie(issued.token, config.sessionTtlSeconds) } });
  }
  if (!session) return Response.json({ error: "No active judge live session." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json(projection(config, session.expiresAt), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const config = loadJudgeDemoConfig();
  if (!config) return Response.json({ error: "Judge live mode is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!judgeSameOrigin(request)) return Response.json({ error: "Cross-site judge session requests are not allowed." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const body = await request.json().catch(() => null) as { accessCode?: unknown } | null;
  if (!config.premiumEnabled && (!body || typeof body.accessCode !== "string" || body.accessCode.length > 256 || !judgeAccessCodeIsValid(config, body.accessCode))) {
    return Response.json({ error: "The live-demo access code is invalid." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const { token, session } = issueJudgeSession(config);
  return Response.json(projection(config, session.expiresAt), { headers: { "Cache-Control": "no-store", "Set-Cookie": judgeSessionCookie(token, config.sessionTtlSeconds) } });
}
