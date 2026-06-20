import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@zintus/providers", "@zintus/types", "@zintus/ui"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
