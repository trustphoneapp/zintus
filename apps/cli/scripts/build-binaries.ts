#!/usr/bin/env bun
/**
 * Build self-contained per-platform `zintus` binaries with `bun build
 * --compile` — the Bun runtime is embedded, so end users need NOTHING
 * installed (no bun, no node, no node_modules).
 *
 * The one native dependency that must survive compilation is the OS-keychain
 * addon (@napi-rs/keyring). Its normal loader resolves from node_modules at
 * runtime, which doesn't exist inside a compiled binary — so for each target
 * this script:
 *   1. vendors the platform's prebuilt `.node` addon (from the local install
 *      for the host, else the npm registry tarball, pinned to the same
 *      version the workspace uses);
 *   2. generates an entry file that `require()`s that addon by literal path
 *      (statically analyzable → Bun EMBEDS it) and registers its `Entry` on
 *      `globalThis.__ZINTUS_KEYRING_ENTRY__` BEFORE importing the CLI
 *      (packages/keychain checks the injection first);
 *   3. compiles `bun build --compile --target=<t>`.
 *
 * Known, accepted gap: sqlite-vec's loadable extension is NOT embedded —
 * semantic cache / memory / code index fall back to their honest linear-scan
 * paths inside compiled binaries (same results, slower on big sets).
 *
 * Usage:
 *   bun scripts/build-binaries.ts             # all targets
 *   bun scripts/build-binaries.ts --host      # host target only
 *   bun scripts/build-binaries.ts --smoke     # host target + smoke tests
 */
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Bun's resolveSync returns a plain path; Node-style resolvers return file: URLs. */
function toPath(resolved: string): string {
  return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}
const VENDOR = join(CLI_DIR, "vendor", "keyring");
const GEN = join(CLI_DIR, "gen");
const OUT = join(CLI_DIR, "dist-bin");

interface Target {
  /** bun build --compile target triple. */
  bunTarget: string;
  /** npm platform package that ships the prebuilt keyring addon. */
  napiPkg: string;
  /** The .node filename inside that package. */
  nodeFile: string;
  /** Output binary name (also the npm platform-package binary name). */
  out: string;
  /** node `process.platform`/`process.arch` (for the npm os/cpu fields). */
  platform: NodeJS.Platform;
  arch: string;
}

export const TARGETS: Target[] = [
  {
    bunTarget: "bun-darwin-arm64",
    napiPkg: "@napi-rs/keyring-darwin-arm64",
    nodeFile: "keyring.darwin-arm64.node",
    out: "zintus-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
  },
  {
    bunTarget: "bun-darwin-x64",
    napiPkg: "@napi-rs/keyring-darwin-x64",
    nodeFile: "keyring.darwin-x64.node",
    out: "zintus-darwin-x64",
    platform: "darwin",
    arch: "x64",
  },
  {
    bunTarget: "bun-linux-x64",
    napiPkg: "@napi-rs/keyring-linux-x64-gnu",
    nodeFile: "keyring.linux-x64-gnu.node",
    out: "zintus-linux-x64",
    platform: "linux",
    arch: "x64",
  },
  {
    bunTarget: "bun-linux-arm64",
    napiPkg: "@napi-rs/keyring-linux-arm64-gnu",
    nodeFile: "keyring.linux-arm64-gnu.node",
    out: "zintus-linux-arm64",
    platform: "linux",
    arch: "arm64",
  },
  {
    bunTarget: "bun-windows-x64",
    napiPkg: "@napi-rs/keyring-win32-x64-msvc",
    nodeFile: "keyring.win32-x64-msvc.node",
    out: "zintus-win32-x64.exe",
    platform: "win32",
    arch: "x64",
  },
];

/** The exact @napi-rs/keyring version the workspace has installed — platform
 *  tarballs are pinned to it so the vendored addon matches the JS contract. */
function keyringVersion(): string {
  const resolved = toPath(
    import.meta.resolveSync("@napi-rs/keyring/package.json", join(CLI_DIR, "src", "index.ts")),
  );
  return (JSON.parse(readFileSync(resolved, "utf8")) as { version: string }).version;
}

/** Vendor the platform addon: local install when present, else registry tarball. */
async function vendorAddon(t: Target, version: string): Promise<string> {
  const dest = join(VENDOR, `${t.nodeFile}`);
  if (existsSync(dest)) return dest;
  mkdirSync(VENDOR, { recursive: true });

  // Host fast-path: the addon is already installed locally.
  try {
    const local = toPath(
      import.meta.resolveSync(`${t.napiPkg}/${t.nodeFile}`, join(CLI_DIR, "src", "index.ts")),
    );
    copyFileSync(local, dest);
    console.log(`  vendored (local) ${t.nodeFile}`);
    return dest;
  } catch {
    // fall through to registry fetch
  }

  const bare = t.napiPkg.split("/")[1]!;
  const url = `https://registry.npmjs.org/${t.napiPkg}/-/${bare}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const tgz = join(VENDOR, `${bare}.tgz`);
  writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
  const tar = spawnSync("tar", ["-xzf", tgz, "-C", VENDOR, `package/${t.nodeFile}`]);
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr.toString()}`);
  copyFileSync(join(VENDOR, "package", t.nodeFile), dest);
  console.log(`  vendored (registry) ${t.nodeFile}`);
  return dest;
}

function generateEntry(t: Target, addonPath: string): string {
  mkdirSync(GEN, { recursive: true });
  const entry = join(GEN, `entry-${t.bunTarget}.ts`);
  writeFileSync(
    entry,
    `// AUTO-GENERATED by scripts/build-binaries.ts — do not edit.
// Embeds the ${t.napiPkg} addon (literal require → bun --compile embeds the
// .node) and registers it for packages/keychain BEFORE the CLI loads.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require(${JSON.stringify(addonPath)}) as { Entry: unknown };
(globalThis as Record<string, unknown>).__ZINTUS_KEYRING_ENTRY__ = native.Entry;
await import("../src/index.ts");
`,
  );
  return entry;
}

function compile(t: Target, entry: string): string {
  const outfile = join(OUT, t.out);
  const args = [
    "build",
    "--compile",
    `--target=${t.bunTarget}`,
    "--minify",
    entry,
    "--outfile",
    outfile,
  ];
  const r = spawnSync("bun", args, { cwd: CLI_DIR, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`bun build --compile failed for ${t.bunTarget}`);
  return outfile;
}

/** Host-only smoke: the binary must run OUTSIDE the repo with no node_modules. */
function smoke(binary: string): void {
  const run = (args: string[]) =>
    spawnSync(binary, args, { cwd: "/", encoding: "utf8", timeout: 60_000 });

  const help = run(["--help"]);
  if (help.status !== 0 || !help.stdout.includes("Multi-provider AI CLI")) {
    throw new Error(`smoke --help failed: ${help.stderr}`);
  }

  const doctor = run(["doctor", "--json"]);
  // doctor exits 1 when gating checks fail (e.g. no keys on a fresh machine) —
  // the smoke asserts the CONTRACT (parseable JSON + keychain check passes),
  // not a healthy install.
  const parsed = JSON.parse(doctor.stdout) as {
    checks: Array<{ id: string; status: string }>;
  };
  const keychain = parsed.checks.find((c) => c.id === "keychain");
  if (keychain?.status !== "pass") {
    throw new Error(
      `smoke: embedded keychain addon did not load (doctor keychain=${keychain?.status})`,
    );
  }

  const status = run(["status", "--json"]);
  const snap = JSON.parse(status.stdout) as { providers: unknown[] };
  if (!Array.isArray(snap.providers) || snap.providers.length === 0) {
    throw new Error("smoke: status --json returned no providers");
  }
  console.log(`  smoke OK (--help, doctor keychain=pass, status providers=${snap.providers.length})`);
}

async function main(): Promise<void> {
  const hostOnly = process.argv.includes("--host") || process.argv.includes("--smoke");
  const doSmoke = process.argv.includes("--smoke");
  const version = keyringVersion();
  mkdirSync(OUT, { recursive: true });

  const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const targets = hostOnly ? TARGETS.filter((t) => t.bunTarget === hostTarget) : TARGETS;
  if (targets.length === 0) throw new Error(`no target matches host ${hostTarget}`);

  for (const t of targets) {
    console.log(`\n▸ ${t.bunTarget}`);
    const addon = await vendorAddon(t, version);
    const entry = generateEntry(t, addon);
    const bin = compile(t, entry);
    if (doSmoke && t.bunTarget === hostTarget) smoke(bin);
  }
  console.log(`\nDone → ${OUT}`);
}

if (import.meta.main) {
  await main();
}
