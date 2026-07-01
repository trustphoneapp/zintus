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
    // @zintus/media has a browser/node split; its node entry imports
    // node:fs/promises, which webpack can't resolve for the CLIENT bundle
    // (desktop renders in a Tauri webview — a browser context that never takes
    // the node path). Ignore the node-only scheme on the client so the build
    // resolves the browser build instead of erroring on an unhandled scheme.
    if (!isServer) {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /^node:fs\/promises$/ }),
      );
    }
    return config;
  },
};

export default nextConfig;
