import type { NextConfig } from "next";

// Static security headers applied on EVERY host, not just Vercel — these used
// to live ONLY in vercel.json, so a non-Vercel / self-hosted deploy shipped
// with none. Next's headers() runs on `next start` and any platform, and these
// apply to every route (including /api and static assets).
//
// The Content-Security-Policy is intentionally NOT here: it now carries a
// per-request nonce for script-src (dropping 'unsafe-inline'), which a frozen
// static header cannot do, so it lives in proxy.ts instead. None of the headers
// below need a nonce, so they stay static here to avoid duplicating them in the
// proxy.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@zintus/media",
    "@zintus/providers",
    "@zintus/types",
    "@zintus/ui",
  ],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  webpack: (config, { isServer, webpack }) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    // @zintus/media's index statically imports its Node path (node.ts) for the
    // server runtime. In the browser the canvas path runs instead, and node.ts's
    // `node:fs/promises` import is gated behind a `{ path }` input that the web
    // app never passes — so it is unreachable client-side. Stub that Node-only
    // scheme so the client bundle compiles (webpack can't resolve `node:` URIs).
    if (!isServer) {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /^node:fs\/promises$/ }),
      );
    }
    return config;
  },
};

export default nextConfig;
