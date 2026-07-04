#!/usr/bin/env bun
/**
 * Stage the gateway sidecar for Tauri: copy the compiled `zintus` CLI binary
 * (which contains `zintus serve`) into src-tauri/binaries/ under the
 * target-triple name Tauri's `externalBin` expects. This is what lets the
 * desktop app start the gateway itself — no terminal, ever.
 *
 * Host-only by default (tauri dev/build compile for the host). Builds the
 * binary first via apps/cli/scripts/build-binaries.ts when it's missing.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_DIR = join(dirname(dirname(DESKTOP_DIR)), "apps", "cli");
const BIN_DIR = join(DESKTOP_DIR, "src-tauri", "binaries");

/** dist-bin name + Rust target triple for the host platform. */
function hostTarget(): { source: string; triple: string; ext: string } {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return {
        source: `zintus-darwin-${arch}`,
        triple: arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
        ext: "",
      };
    case "linux":
      return {
        source: `zintus-linux-${arch}`,
        triple: arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
        ext: "",
      };
    case "win32":
      return {
        source: "zintus-win32-x64.exe",
        triple: "x86_64-pc-windows-msvc",
        ext: ".exe",
      };
    default:
      throw new Error(`unsupported host platform: ${process.platform}`);
  }
}

const { source, triple, ext } = hostTarget();
const sourcePath = join(CLI_DIR, "dist-bin", source);

if (!existsSync(sourcePath)) {
  console.log(`sidecar source missing — building the host CLI binary first…`);
  const r = spawnSync("bun", ["scripts/build-binaries.ts", "--host"], {
    cwd: CLI_DIR,
    stdio: "inherit",
  });
  if (r.status !== 0 || !existsSync(sourcePath)) {
    throw new Error(`could not produce ${sourcePath}`);
  }
}

mkdirSync(BIN_DIR, { recursive: true });
const dest = join(BIN_DIR, `zintus-${triple}${ext}`);
copyFileSync(sourcePath, dest);
console.log(`staged sidecar → ${dest}`);

// macOS universal builds (`tauri build --target universal-apple-darwin`, the
// CI release target) resolve externalBin as zintus-universal-apple-darwin —
// the host triple alone fails the release build. Stage it too whenever both
// darwin slices exist (bun cross-compiles them; build the missing one here).
if (process.platform === "darwin") {
  const armSrc = join(CLI_DIR, "dist-bin", "zintus-darwin-arm64");
  const x64Src = join(CLI_DIR, "dist-bin", "zintus-darwin-x64");
  if (!existsSync(armSrc) || !existsSync(x64Src)) {
    const r = spawnSync(
      "bun",
      ["scripts/build-binaries.ts", "--targets", "darwin-arm64,darwin-x64"],
      { cwd: CLI_DIR, stdio: "inherit" },
    );
    if (r.status !== 0) {
      throw new Error("could not build both darwin CLI slices for the universal sidecar");
    }
  }
  // A universal build compiles each slice separately and each pass resolves
  // its own per-arch triple, so stage BOTH arch binaries alongside the fat one.
  copyFileSync(armSrc, join(BIN_DIR, "zintus-aarch64-apple-darwin"));
  copyFileSync(x64Src, join(BIN_DIR, "zintus-x86_64-apple-darwin"));
  const universalDest = join(BIN_DIR, "zintus-universal-apple-darwin");
  const lipo = spawnSync("lipo", ["-create", armSrc, x64Src, "-output", universalDest], {
    stdio: "inherit",
  });
  if (lipo.status !== 0) {
    throw new Error("lipo failed to produce the universal sidecar");
  }
  console.log(`staged darwin sidecars → aarch64 + x86_64 + universal`);
}
