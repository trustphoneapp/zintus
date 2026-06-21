import { type NextRequest, NextResponse } from "next/server";

const SECURITY_HEADERS: [string, string][] = [
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

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

  const response = NextResponse.next();
  for (const [key, value] of SECURITY_HEADERS) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and API routes
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
