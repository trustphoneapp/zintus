import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

// Build-tooling only: `ANALYZE=true bun run build` emits treemap reports under
// .next/analyze/. A no-op wrapper in every other build, so it stays out of the
// runtime path entirely.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

// Static security headers applied on EVERY host, not just Vercel — these used
// to live ONLY in vercel.json, so a non-Vercel / self-hosted deploy shipped
// with none. Next's headers() runs on `next start` and any platform, and these
// apply to every route (including /api and static assets).
//
// The Content-Security-Policy is intentionally NOT here: it now carries a
// per-request nonce for script-src (dropping 'unsafe-inline'), which a frozen
// static header cannot do, so it lives in proxy.ts instead. Emitting CSP from
// both layers would make the browser enforce the INTERSECTION of the two
// policies and silently break the nonced scripts — so CSP has exactly one home
// (proxy.ts). None of the headers below need a nonce, so they stay static here.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    // microphone=(self): voice dictation (Web Speech API) needs mic on OUR
    // origin. microphone=() disabled it for everyone — the browser then blocks
    // it with NO permission prompt. camera/geolocation stay fully disabled.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=()",
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
  experimental: {
    // Barrel-import tree-shaking. lucide-react is on Next's default
    // optimizePackageImports list, but that default only applies to the
    // Turbopack builds — this app builds with `--webpack`, where the list is NOT
    // applied automatically, so we set it explicitly. Each `import { Icon } from
    // "lucide-react"` is rewritten to a direct per-icon module import, so only
    // the handful of icons actually used ship, never the ~1k-icon barrel.
    // @radix-ui/react-tooltip is a namespace re-export with the same shape.
    optimizePackageImports: ["lucide-react", "@radix-ui/react-tooltip"],
  },
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

export default withBundleAnalyzer(nextConfig);
