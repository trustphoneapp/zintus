#!/usr/bin/env bun
/**
 * Stage the npm distribution for the compiled CLI (esbuild/Biome pattern):
 *
 *   npm-dist/zintus/            ← main package: plain-Node launcher (no bun,
 *                                  no build step) + optionalDependencies on
 *                                  the platform packages; npm installs ONLY
 *                                  the one matching os/cpu.
 *   npm-dist/cli-<platform>/    ← @zintus/cli-<platform>: just the compiled
 *                                  binary, gated by package.json os/cpu.
 *
 * Run `bun scripts/build-binaries.ts` first (binaries must exist in
 * dist-bin/). Publishing (HUMAN, needs npm auth) is then:
 *
 *   for d in npm-dist/cli-*; do (cd "$d" && npm publish --access public); done
 *   (cd npm-dist/zintus && npm publish --access public)
 *
 * Publish the platform packages FIRST so the main package's
 * optionalDependencies resolve.
 */
import {
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./build-binaries.js";

const CLI_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_BIN = join(CLI_DIR, "dist-bin");
const NPM_DIST = join(CLI_DIR, "npm-dist");

const cliPkg = (await import(join(CLI_DIR, "package.json"))) as {
  version: string;
  description: string;
  license: string;
  homepage: string;
  keywords: string[];
};

/** npm package name for a platform (e.g. @zintus/cli-darwin-arm64). */
function platformPkgName(platform: string, arch: string): string {
  return `@zintus/cli-${platform}-${arch}`;
}

function stagePlatformPackages(): Record<string, string> {
  const optionalDeps: Record<string, string> = {};
  for (const t of TARGETS) {
    const bin = join(DIST_BIN, t.out);
    if (!existsSync(bin)) {
      throw new Error(`missing ${bin} — run: bun scripts/build-binaries.ts`);
    }
    const name = platformPkgName(t.platform, t.arch);
    const dir = join(NPM_DIST, `cli-${t.platform}-${t.arch}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    const binName = t.platform === "win32" ? "zintus.exe" : "zintus";
    copyFileSync(bin, join(dir, "bin", binName));
    if (t.platform !== "win32") chmodSync(join(dir, "bin", binName), 0o755);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name,
          version: cliPkg.version,
          description: `Zintus CLI — prebuilt binary for ${t.platform}-${t.arch}. Install \`zintus\` instead of this package.`,
          license: cliPkg.license,
          homepage: cliPkg.homepage,
          // npm skips this package entirely on a non-matching machine — that's
          // the whole mechanism that makes optionalDependencies platform-select.
          os: [t.platform],
          cpu: [t.arch],
          files: ["bin"],
          publishConfig: { access: "public" },
        },
        null,
        2,
      ) + "\n",
    );
    optionalDeps[name] = cliPkg.version;
  }
  return optionalDeps;
}

/** Plain-Node CJS launcher — must run on stock Node ≥ 18 with zero deps. */
const LAUNCHER = `#!/usr/bin/env node
"use strict";
// Launcher for the zintus CLI. The real program is a self-contained compiled
// binary (Bun runtime embedded) shipped in a platform-specific optional
// dependency; this shim only locates it and hands over.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const pkg = "@zintus/cli-" + process.platform + "-" + process.arch;
const binName = process.platform === "win32" ? "zintus.exe" : "zintus";

let binary;
try {
  binary = path.join(path.dirname(require.resolve(pkg + "/package.json")), "bin", binName);
} catch {
  console.error(
    "zintus: no prebuilt binary for " + process.platform + "-" + process.arch + ".\\n" +
      "  - If this platform IS supported, your install skipped optional dependencies;\\n" +
      "    reinstall without --no-optional / --omit=optional.\\n" +
      "  - Otherwise install from source: https://github.com/trustphoneapp/zintus",
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error("zintus: failed to launch " + binary + ": " + result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;

function stageMainPackage(optionalDeps: Record<string, string>): void {
  const dir = join(NPM_DIST, "zintus");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "zintus.js"), LAUNCHER);
  chmodSync(join(dir, "bin", "zintus.js"), 0o755);
  for (const f of ["README.md", "LICENSE"]) {
    if (existsSync(join(CLI_DIR, f))) copyFileSync(join(CLI_DIR, f), join(dir, f));
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "zintus",
        version: cliPkg.version,
        description: cliPkg.description,
        license: cliPkg.license,
        homepage: cliPkg.homepage,
        keywords: cliPkg.keywords,
        bin: { zintus: "bin/zintus.js" },
        files: ["bin/zintus.js", "README.md", "LICENSE"],
        // Stock Node is all the launcher needs — the binary brings its own runtime.
        engines: { node: ">=18" },
        optionalDependencies: optionalDeps,
        publishConfig: { access: "public", provenance: true },
      },
      null,
      2,
    ) + "\n",
  );
}

rmSync(NPM_DIST, { recursive: true, force: true });
const deps = stagePlatformPackages();
stageMainPackage(deps);
console.log(`Staged ${Object.keys(deps).length} platform packages + zintus → ${NPM_DIST}`);
