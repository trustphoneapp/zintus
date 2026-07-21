import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const JUDGE_SESSION_COOKIE = "zintus_judge_session";
const encoder = new TextEncoder();

export interface JudgeDemoConfig {
  accessCodeHash: string;
  premiumEnabled: boolean;
  premiumExpiresAt: number | null;
  fixtureRepositoryId: string;
  gatewayToken: string;
  gatewayUrl: string;
  maxRequestChars: number;
  runBudget: {
    costBudgetUsd: number;
    timeBudgetSeconds: number;
    tokenBudget: number;
  };
  sessionSecret: string;
  sessionTtlSeconds: number;
}

export interface JudgeSession {
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  runIds: string[];
}

type Environment = Record<string, string | undefined>;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/** Returns null unless every authority needed for public judge mode is explicit. */
export function loadJudgeDemoConfig(env: Environment = process.env): JudgeDemoConfig | null {
  const premiumEnabled = env.ZINTUS_ENGINEER_PREMIUM_ENABLED === "1";
  const premiumExpiryText = env.ZINTUS_ENGINEER_PREMIUM_EXPIRES_AT?.trim();
  const premiumExpiresAt = premiumExpiryText ? Date.parse(premiumExpiryText) : null;
  if (env.ZINTUS_JUDGE_DEMO_ENABLED !== "1" && !premiumEnabled) return null;
  const gatewayUrl = env.ZINTUS_JUDGE_GATEWAY_URL?.replace(/\/$/, "");
  const gatewayToken = env.ZINTUS_JUDGE_GATEWAY_TOKEN?.trim();
  const accessCodeHash = env.ZINTUS_JUDGE_ACCESS_CODE_HASH?.trim().toLowerCase();
  const sessionSecret = env.ZINTUS_JUDGE_SESSION_SECRET?.trim();
  const fixtureRepositoryId = env.ZINTUS_JUDGE_FIXTURE_REPOSITORY_ID?.trim();
  const tokenBudget = boundedInteger(env.ZINTUS_JUDGE_RUN_TOKEN_BUDGET, 700_000, 8_000, 1_000_000);
  const timeBudgetSeconds = boundedInteger(env.ZINTUS_JUDGE_RUN_TIME_SECONDS, 1_500, 60, 3_600);
  const costBudgetUsd = boundedNumber(env.ZINTUS_JUDGE_RUN_COST_USD, 10, 0.01, 20);
  const sessionTtlSeconds = boundedInteger(env.ZINTUS_JUDGE_SESSION_TTL_SECONDS, 1_200, 300, 3_600);
  const maxRequestChars = boundedInteger(env.ZINTUS_JUDGE_MAX_REQUEST_CHARS, 6_000, 100, 20_000);
  if ((premiumExpiryText && (!Number.isFinite(premiumExpiresAt) || premiumExpiresAt! <= Date.now())) ||
      !gatewayUrl || !/^https:\/\//.test(gatewayUrl) || !gatewayToken || !fixtureRepositoryId ||
      (!premiumEnabled && (!accessCodeHash || !/^[a-f0-9]{64}$/.test(accessCodeHash))) || !sessionSecret || sessionSecret.length < 32 ||
      tokenBudget == null || timeBudgetSeconds == null || costBudgetUsd == null || sessionTtlSeconds == null || maxRequestChars == null) return null;
  return { accessCodeHash: accessCodeHash ?? "", premiumEnabled, premiumExpiresAt, fixtureRepositoryId, gatewayToken, gatewayUrl, maxRequestChars,
    runBudget: { costBudgetUsd, timeBudgetSeconds, tokenBudget }, sessionSecret, sessionTtlSeconds };
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueJudgeSession(config: JudgeDemoConfig, now = Date.now(), runIds: string[] = []): { token: string; session: JudgeSession } {
  const session: JudgeSession = {
    expiresAt: now + config.sessionTtlSeconds * 1_000,
    issuedAt: now,
    nonce: randomBytes(18).toString("base64url"),
    runIds: [...new Set(runIds)].slice(0, 1),
  };
  const payload = base64url(JSON.stringify(session));
  return { session, token: `v1.${payload}.${signature(config.sessionSecret, payload)}` };
}

export function readJudgeSession(config: JudgeDemoConfig, token: string | undefined, now = Date.now()): JudgeSession | null {
  if (!token) return null;
  const [version, payload, signed] = token.split(".");
  if (version !== "v1" || !payload || !signed || !/^[A-Za-z0-9_-]{20,}$/.test(payload) || !/^[A-Za-z0-9_-]{20,}$/.test(signed)) return null;
  const expected = signature(config.sessionSecret, payload);
  const suppliedBytes = Buffer.from(signed);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<JudgeSession>;
    const issuedAt = raw.issuedAt;
    const expiresAt = raw.expiresAt;
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
        expiresAt - issuedAt > config.sessionTtlSeconds * 1_000 + 1_000 ||
        typeof raw.nonce !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(raw.nonce) ||
        !Array.isArray(raw.runIds) || raw.runIds.length > 1 || raw.runIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) return null;
    return { issuedAt, expiresAt, nonce: raw.nonce, runIds: raw.runIds };
  } catch {
    return null;
  }
}

export function judgeSessionCookie(token: string, ttlSeconds: number, secure = process.env.NODE_ENV === "production"): string {
  return `${JUDGE_SESSION_COOKIE}=${token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
}

export function judgeAccessCodeIsValid(config: JudgeDemoConfig, submitted: string): boolean {
  const candidate = createHash("sha256").update(encoder.encode(submitted.trim())).digest("hex");
  const expected = Buffer.from(config.accessCodeHash, "hex");
  const actual = Buffer.from(candidate, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function judgeSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
