import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: [
    "@zintus/media",
    "@zintus/providers",
    "@zintus/router",
    "@zintus/types",
    "@zintus/ui",
  ],
  webpack: (config, { isServer, webpack }) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    // Same fix as apps/web: @zintus/media's index statically imports its Node
    // path (node.ts), whose `node:fs/promises` import is gated behind a `{ path }`
    // input the desktop never passes — unreachable in the client/export bundle.
    // Stub the Node-only scheme so webpack (which can't resolve `node:` URIs)
    // compiles the export build.
    if (!isServer) {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /^node:fs\/promises$/ }),
      );
    }
    return config;
  },
};

export default nextConfig;
