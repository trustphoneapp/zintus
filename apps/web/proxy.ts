import { type NextRequest, NextResponse } from "next/server";

// Next 16 renamed the `middleware` file convention to `proxy` (middleware is
// deprecated as of v16.0.0). Same request-interception behaviour, same
// `config.matcher` contract — only the file/function name changed.
//
// This proxy owns the per-request Content-Security-Policy. A CSP nonce MUST be
// generated per request, so it cannot live in the static next.config.ts
// headers() (those serve one frozen value to every visitor). Next's App Router
// reads the nonce from the *request* CSP header (see app-render's
// parseRequestHeaders / getScriptNonceFromHeader) and stamps it onto the
// framework's own <script> tags during render — which is why we forward the CSP
// on the request as well as setting it on the response.
//
// The other static security headers (HSTS, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, Permissions-Policy) stay in
// next.config.ts headers(): they need no nonce and apply to every route
// (including /api and static assets that this proxy's matcher excludes), so
// keeping them there avoids losing or duplicating them here (single source of
// truth per header).

// Fail-CLOSED: only the explicit "development" value enables the dev-only
// 'unsafe-eval' carve-out below. A `!== "production"` form would leak
// 'unsafe-eval' whenever NODE_ENV is unset or "test" (a non-standard build
// invocation); requiring the exact "development" string means anything other
// than a real `next dev` build omits it.
const IS_DEV = process.env.NODE_ENV === "development";

// Roll out safely: setting CSP_REPORT_ONLY=true emits
// `Content-Security-Policy-Report-Only` instead of the enforcing header so the
// strict policy can be observed against real traffic before it can break
// anything. Default (unset) ENFORCES in production. Rollback/promotion is a
// single env flip, not a code revert.
const REPORT_ONLY = process.env.CSP_REPORT_ONLY === "true";

function buildCsp(nonce: string): string {
  // All directives are identical to the previous static CSP EXCEPT script-src.
  //
  // script-src: dropped 'unsafe-inline' (the whole point — it neutered XSS
  // protection) in favour of a per-request 'nonce-…'. 'strict-dynamic' makes
  // CSP3 browsers trust only nonce'd scripts plus whatever those scripts load,
  // ignoring 'self'/host-allowlist sources for <script>. The trailing
  // 'self' https:' is a LEGACY fallback: CSP1/2 browsers ignore
  // 'strict-dynamic' and fall back to it so the app still loads (degraded XSS
  // posture, but not broken).
  //
  // 'unsafe-eval' is added in DEVELOPMENT ONLY: `next dev --webpack` uses
  // eval() for HMR / React Fast Refresh, which 'strict-dynamic' (no
  // 'unsafe-eval') blocks — flooding the console with violations and making the
  // app look broken on localhost. Production MUST NOT include it. (Verify the
  // real policy against `next build && next start`, never `next dev`.)
  //
  // style-src: KEEPS 'unsafe-inline'. Next/React inject framework inline STYLES
  // (styled-jsx, next/font CSS variables, etc.) that cannot be reliably nonced
  // or hashed per request without breaking styling. The meaningful XSS win is
  // in script-src; an injected <style> is far lower risk than an injected
  // <script>, so we deliberately do not chase a perfect style-src here.
  const scriptSrc = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    "https:",
    IS_DEV ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "connect-src 'self' http://localhost:* http://127.0.0.1:* https://relay.zintus.ai https://*.zintus.ai",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Fresh nonce for every request. base64 of a v4 UUID matches Next's nonce
  // grammar (/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/) and uses only Web-standard
  // globals available in the proxy runtime (no Buffer dependency).
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const cspHeaderName = REPORT_ONLY
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  // Dashboard routes require a session cookie. The relay worker owns session
  // verification — here we do a lightweight presence check to avoid the
  // unauthenticated flash. The client-side /dashboard page re-verifies with
  // /api/auth/me and redirects on failure.
  if (pathname.startsWith("/dashboard")) {
    const sessionCookie = request.cookies.get("zintus_session");
    if (!sessionCookie?.value) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Forward the nonce + CSP on the *request* so the App Router can read the
  // nonce and apply it to framework scripts during render. `x-nonce` lets server
  // components (e.g. the root layout passing it to next-themes) read the same
  // value via headers(). Forward the ENFORCING CSP name on the request even in
  // report-only mode — Next reads the nonce from `content-security-policy`, and
  // forwarding it does not enforce anything (only the response header does).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Set the CSP on the *response* so the browser actually enforces it (or
  // merely reports it, in REPORT_ONLY mode).
  response.headers.set(cspHeaderName, csp);
  return response;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and API routes
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
