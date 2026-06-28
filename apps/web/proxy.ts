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
// keeping them there avoids losing or duplicating them here.

function buildCsp(nonce: string): string {
  // All directives are identical to the previous static CSP EXCEPT script-src.
  //
  // script-src: dropped 'unsafe-inline' (the whole point — it neutered XSS
  // protection) in favour of a per-request 'nonce-…'. 'strict-dynamic' makes
  // browsers trust only nonce'd scripts plus whatever those scripts load,
  // ignoring 'self'/host-allowlist sources for <script>.
  //
  // style-src: KEEPS 'unsafe-inline'. Next/React inject framework inline STYLES
  // (styled-jsx, next/font CSS variables, etc.) that cannot be reliably nonced
  // or hashed per request without breaking styling. The meaningful XSS win is
  // in script-src; an injected <style> is far lower risk than an injected
  // <script>, so we deliberately do not chase a perfect style-src here.
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
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
  // value via headers().
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Set the CSP on the *response* so the browser actually enforces it.
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and API routes
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
