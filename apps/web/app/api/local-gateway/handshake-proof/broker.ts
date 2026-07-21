import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SECRET_FILE = join(homedir(), ".zintus", "gateway-session.json");
const CHALLENGE_PATTERN = /^[a-f0-9]{64}$/;

export interface ProofBrokerOptions {
  secretFile?: string;
  injectedSecret?: string;
  currentUid?: number;
  processAlive?: (pid: number) => boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Origin",
    },
  });
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local-only proof broker for the browser handshake. It returns HMAC(challenge)
 * and never returns the bootstrap secret. Same-origin + loopback checks prevent
 * a remote page from using the local Next server as an HMAC oracle; the gateway
 * still burns each challenge after one redemption and origin-binds the token.
 */
export async function issueLocalGatewayHandshakeProof(
  request: Request,
  options: ProofBrokerOptions = {},
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originHeader = request.headers.get("origin");
  let origin: URL;
  try {
    if (!originHeader) throw new Error("missing origin");
    origin = new URL(originHeader);
  } catch {
    return json({ error: "Local same-origin request required" }, 403);
  }
  const effectiveHost = (request.headers.get("host") ?? requestUrl.host).toLowerCase();
  let effectiveHostUrl: URL;
  try { effectiveHostUrl = new URL(`http://${effectiveHost}`); }
  catch { return json({ error: "Local same-origin request required" }, 403); }
  if (requestUrl.protocol !== "http:" || origin.protocol !== "http:" ||
      !isLoopbackHostname(effectiveHostUrl.hostname) || !isLoopbackHostname(origin.hostname) ||
      origin.host.toLowerCase() !== effectiveHost || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "Local same-origin request required" }, 403);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON request required" }, 415);
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid request" }, 400); }
  const challenge = typeof (body as { challenge?: unknown })?.challenge === "string"
    ? (body as { challenge: string }).challenge
    : "";
  if (!CHALLENGE_PATTERN.test(challenge)) return json({ error: "Invalid challenge" }, 400);

  let secret = options.injectedSecret?.trim() ?? process.env.GATEWAY_HANDSHAKE_SECRET?.trim() ?? "";
  if (!secret) {
    try {
      const secretFile = options.secretFile ?? DEFAULT_SECRET_FILE;
      const stat = lstatSync(secretFile);
      const uid = options.currentUid ?? process.getuid?.();
      if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
        return json({ error: "Local handshake authority is not owner-controlled" }, 503);
      }
      const parsed = JSON.parse(readFileSync(secretFile, "utf8")) as { handshakeSecret?: unknown; pid?: unknown };
      const pid = typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 0;
      const alive = options.processAlive ?? defaultProcessAlive;
      if (typeof parsed.handshakeSecret !== "string" || parsed.handshakeSecret.length < 32 || !pid || !alive(pid)) {
        return json({ error: "Local handshake authority is stale" }, 503);
      }
      secret = parsed.handshakeSecret;
    } catch {
      return json({ error: "Local handshake authority is unavailable" }, 503);
    }
  }
  if (secret.length < 32) return json({ error: "Local handshake authority is unavailable" }, 503);

  return json({ proof: createHmac("sha256", secret).update(challenge).digest("hex") }, 200);
}
