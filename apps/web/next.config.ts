import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@multipleai/providers",
    "@multipleai/types",
    "@multipleai/ui",
  ],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
