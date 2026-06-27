import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@zintus/media",
    "@zintus/providers",
    "@zintus/types",
    "@zintus/ui",
  ],
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
