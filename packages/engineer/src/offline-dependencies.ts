import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const OFFLINE_DEPENDENCY_MANIFEST = "zintus-engineer-dependencies.json";
const VITE_TMPFS_MOUNTPOINT = ".vite-temp";
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);

const OfflineDependencyManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  lockfileHash: HashSchema,
  toolchainHash: HashSchema,
  contentHash: HashSchema,
  nodeModulesPath: z.string().min(1).max(500).default("node_modules"),
}).strict();

const OfflineDependencyManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  lockfileHash: HashSchema,
  toolchainHash: HashSchema,
  repositoryCommit: CommitSchema,
  contentHash: HashSchema,
  nodeModulesPath: z.string().min(1).max(500).default("node_modules"),
}).strict();

export const OfflineDependencyManifestSchema = z.discriminatedUnion("schemaVersion", [
  OfflineDependencyManifestV1Schema,
  OfflineDependencyManifestV2Schema,
]);

export type OfflineDependencyManifest = z.infer<typeof OfflineDependencyManifestSchema>;

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/** Deterministic Merkle-like digest of a dependency tree, including link targets and file bytes. */
export async function hashDependencyTree(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      const path = join(directory, name);
      const logicalPath = relative(canonicalRoot, path).replaceAll(sep, "/");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = await realpath(path);
        if (!inside(canonicalRoot, resolvedTarget)) throw new Error(`offline dependency symlink escapes bundle: ${logicalPath}`);
        hash.update(`L\0${logicalPath}\0${target}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D\0${logicalPath}\0${stat.mode & 0o777}\0`);
        await visit(path);
      } else if (stat.isFile()) {
        hash.update(`F\0${logicalPath}\0${stat.mode & 0o777}\0${stat.size}\0`);
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
        hash.update("\0");
      } else {
        throw new Error(`offline dependency bundle contains a special file: ${logicalPath}`);
      }
    }
  };
  await visit(canonicalRoot);
  return `sha256:${hash.digest("hex")}`;
}

/** Immutable, lockfile- and toolchain-bound dependency tree mounted read-only into Docker. */
export class OfflineDependencyBundle {
  readonly root: string;
  readonly nodeModulesRoot: string;
  readonly manifest: OfflineDependencyManifest;

  constructor(input: { root: string; expectedLockfileHash: string; expectedToolchainHash: string; expectedRepositoryCommit?: string }) {
    this.root = realpathSync(resolve(input.root));
    this.manifest = OfflineDependencyManifestSchema.parse(JSON.parse(
      readFileSync(join(this.root, OFFLINE_DEPENDENCY_MANIFEST), "utf8"),
    ));
    if (this.manifest.lockfileHash !== input.expectedLockfileHash) throw new Error("offline dependency lockfile hash mismatch");
    if (this.manifest.toolchainHash !== input.expectedToolchainHash) throw new Error("offline dependency toolchain hash mismatch");
    if (input.expectedRepositoryCommit) {
      if (this.manifest.schemaVersion !== 2) throw new Error("offline dependency bundle is not bound to a repository commit");
      if (this.manifest.repositoryCommit.toLowerCase() !== input.expectedRepositoryCommit.toLowerCase()) {
        throw new Error("offline dependency repository commit mismatch");
      }
    }
    const configured = resolve(this.root, this.manifest.nodeModulesPath);
    if (!inside(this.root, configured)) throw new Error("offline dependency path escapes bundle root");
    const stat = lstatSync(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("offline dependency node_modules path must be a real directory");
    this.nodeModulesRoot = realpathSync(configured);
    if (!inside(this.root, this.nodeModulesRoot)) throw new Error("offline dependency node_modules resolves outside bundle root");
  }

  async verify(): Promise<void> {
    const actualRoot = await realpath(this.nodeModulesRoot);
    if (actualRoot !== this.nodeModulesRoot || !inside(this.root, actualRoot)) throw new Error("offline dependency bundle path changed after admission");
    // Docker can only overlay the writable Vite tmpfs onto an existing path
    // beneath the read-only dependency bind. Without this preflight invariant,
    // every authorized test command fails after Builder spend with an OCI mount
    // error rather than before planning.
    const viteTemp = await lstat(join(actualRoot, VITE_TMPFS_MOUNTPOINT)).catch(() => undefined);
    if (!viteTemp?.isDirectory() || viteTemp.isSymbolicLink()) {
      throw new Error("offline dependency bundle lacks required node_modules/.vite-temp mountpoint");
    }
    if ((await hashDependencyTree(actualRoot)) !== this.manifest.contentHash) {
      throw new Error("offline dependency content hash mismatch");
    }
  }
}
