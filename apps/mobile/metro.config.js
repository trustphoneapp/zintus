const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Monorepo: watch the whole workspace and resolve hoisted deps from the root.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// The shared `@zintus/*` packages are authored in TypeScript and use ESM
// `.js` import specifiers (NodeNext style). Metro does not map `.js` → `.ts`,
// so resolve those relative imports to their TS source, falling back to the
// real module when no TS file exists.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
    moduleName.endsWith(".js")
  ) {
    for (const ext of [".ts", ".tsx"]) {
      try {
        const candidate = moduleName.replace(/\.js$/, ext);
        return context.resolveRequest(context, candidate, platform);
      } catch {
        // try the next extension, then fall through to the default resolver
      }
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

// Anchor NativeWind's input + tailwind config to the app dir with absolute
// paths. NativeWind does `path.resolve()` on both, which is cwd-relative — and
// in a Bun monorepo tools (expo-doctor, metro) often evaluate this config from
// the workspace root, where "./global.css" / "tailwind.config" resolve against
// the repo root and fail ("Cannot find .../zintus/tailwind.config"). Absolute
// paths make resolution cwd-independent.
module.exports = withNativeWind(config, {
  input: path.resolve(projectRoot, "global.css"),
  configPath: path.resolve(projectRoot, "tailwind.config.js"),
});
