import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  hashDependencyTree,
  OFFLINE_DEPENDENCY_MANIFEST,
  OfflineDependencyBundle,
  workspaceLockfileHash,
} from "../packages/engineer/src/index.js";

const repositoryRoot = resolve(process.cwd());
const sourceBundleRoot = process.env.ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT?.trim();
const toolchainHash = process.env.ZINTUS_ENGINEER_TOOLCHAIN_HASH?.trim();

function gitHead(): string {
  const result = Bun.spawnSync(["git", "-C", repositoryRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || "unable to resolve repository HEAD");
  const commit = new TextDecoder().decode(result.stdout).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commit)) throw new Error("repository HEAD is not a full commit SHA");
  return commit;
}

function packageDestination(nodeModulesRoot: string, packageName: string): string {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error(`unsafe workspace package name: ${packageName}`);
  const destination = resolve(nodeModulesRoot, ...packageName.split("/"));
  if (!destination.startsWith(`${nodeModulesRoot}${sep}`)) throw new Error(`workspace package escaped bundle root: ${packageName}`);
  return destination;
}

function overlayWorkspacePackages(nodeModulesRoot: string): number {
  let count = 0;
  for (const parent of ["packages", "apps", "workers"]) {
    const parentRoot = join(repositoryRoot, parent);
    if (!existsSync(parentRoot)) continue;
    for (const entry of readdirSync(parentRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = join(parentRoot, entry.name);
      const packageJson = join(workspaceRoot, "package.json");
      if (!existsSync(packageJson)) continue;
      const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
      if (typeof parsed.name !== "string") throw new Error(`workspace package has no name: ${relative(repositoryRoot, packageJson)}`);
      const destination = packageDestination(nodeModulesRoot, parsed.name);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      cpSync(workspaceRoot, destination, {
        recursive: true,
        dereference: true,
        filter: (source) => {
          const path = relative(workspaceRoot, source);
          if (!path) return true;
          const segments = path.split(sep);
          return !segments.some((segment) => segment === "node_modules" || segment === ".git" || segment === ".next" || segment === "coverage");
        },
      });
      count += 1;
    }
  }
  return count;
}

async function main(): Promise<void> {
  if (!sourceBundleRoot) throw new Error("ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT must point to the last verified bundle");
  if (!toolchainHash || !/^sha256:[a-f0-9]{64}$/.test(toolchainHash)) throw new Error("ZINTUS_ENGINEER_TOOLCHAIN_HASH must be a sha256 digest");
  const commit = gitHead();
  const lockfileHash = workspaceLockfileHash(repositoryRoot);
  const outputRoot = resolve(process.env.ZINTUS_ENGINEER_NEW_DEPENDENCY_BUNDLE_ROOT?.trim() || join(
    homedir(), ".zintus", "engineer", "dependency-bundles", `${lockfileHash.slice(7, 23)}-${commit.slice(0, 12)}`,
  ));
  if (resolve(sourceBundleRoot) === outputRoot) throw new Error("new bundle path must differ from the source bundle");
  if (existsSync(outputRoot)) {
    const existing = new OfflineDependencyBundle({
      root: outputRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: commit,
    });
    await existing.verify();
    process.stdout.write(`${outputRoot}\n`);
    return;
  }

  const temporaryRoot = `${outputRoot}.tmp-${crypto.randomUUID()}`;
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    const sourceNodeModules = join(resolve(sourceBundleRoot), "node_modules");
    if (!existsSync(sourceNodeModules)) throw new Error("source dependency bundle has no node_modules directory");
    const nodeModulesRoot = join(temporaryRoot, "node_modules");
    // Preserve package-manager-internal links such as .bin/tsc -> ../typescript/bin/tsc.
    // Dereferencing those links changes their relative base and produces a bundle
    // that hashes correctly but cannot execute its binaries inside the sandbox.
    cpSync(sourceNodeModules, nodeModulesRoot, { recursive: true });
    const workspacePackageCount = overlayWorkspacePackages(nodeModulesRoot);
    if (workspacePackageCount === 0) throw new Error("no workspace packages were overlaid into the dependency bundle");
    const contentHash = await hashDependencyTree(nodeModulesRoot);
    writeFileSync(join(temporaryRoot, OFFLINE_DEPENDENCY_MANIFEST), `${JSON.stringify({
      schemaVersion: 2,
      lockfileHash,
      toolchainHash,
      repositoryCommit: commit,
      contentHash,
      nodeModulesPath: "node_modules",
    }, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(dirname(outputRoot), { recursive: true, mode: 0o700 });
    renameSync(temporaryRoot, outputRoot);
    process.stdout.write(`${outputRoot}\n`);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

await main();
