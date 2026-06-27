import type { NextConfig } from "next";

// Security headers applied on EVERY host, not just Vercel — these used to live
// ONLY in vercel.json, so a non-Vercel / self-hosted deploy shipped with none.
// Next's headers() runs on `next start` and any platform. (CSP still carries
// 'unsafe-inline' — moving to a nonce is a separate, browser-verified change.)
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
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* http://127.0.0.1:* https://relay.zintus.ai https://*.zintus.ai; worker-src 'self' blob:; frame-src 'none'; upgrade-insecure-requests",
  },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@zintus/providers", "@zintus/types", "@zintus/ui"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
