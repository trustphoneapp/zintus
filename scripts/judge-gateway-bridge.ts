/**
 * Temporary event bridge for a hosted Judge Live web deployment.
 *
 * It keeps the existing Engineer gateway bound to loopback, while a temporary
 * HTTPS tunnel exposes only this bearer-protected bridge. The Vercel BFF holds
 * the bearer; judges never see it. This is deliberately not a general proxy.
 */
import { timingSafeEqual } from "node:crypto";

const bridgeToken = process.env.ZINTUS_JUDGE_BRIDGE_TOKEN?.trim();
const upstream = process.env.ZINTUS_JUDGE_BRIDGE_UPSTREAM?.trim() || "http://127.0.0.1:8788";
const port = Number(process.env.ZINTUS_JUDGE_BRIDGE_PORT ?? "8789");
if (!bridgeToken || bridgeToken.length < 32) throw new Error("ZINTUS_JUDGE_BRIDGE_TOKEN must be a strong server-only value.");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("ZINTUS_JUDGE_BRIDGE_PORT is invalid.");

function authorized(request: Request): boolean {
  const supplied = request.headers.get("authorization");
  const expected = `Bearer ${bridgeToken}`;
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function responseHeaders(upstreamResponse: Response): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "last-event-id"]) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "zintus-judge-bridge" }, { headers: { "Cache-Control": "no-store" } });
    if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    if (!url.pathname.startsWith("/v1/") || request.method === "OPTIONS") return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const target = new URL(`${url.pathname}${url.search}`, upstream);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("host");
    headers.delete("origin");
    const upstreamResponse = await fetch(target, { method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, redirect: "error" });
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders(upstreamResponse) });
  },
});

console.log(`Zintus Judge bridge listening on 127.0.0.1:${port}`);
