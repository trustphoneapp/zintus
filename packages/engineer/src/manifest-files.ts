import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskManifest } from "./contracts.js";

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function normalizeRepositoryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || isAbsolute(path)) throw new Error("path must be repository-relative");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("path contains unsafe segments");
  if (parts[0] === ".git") throw new Error("the .git directory is never Builder-accessible");
  return normalized;
}

export function isManifestPathAllowed(path: string, manifest: TaskManifest): boolean {
  const normalized = normalizeRepositoryPath(path);
  const allowed = manifest.allowedPaths.some((pattern) => globRegex(pattern).test(normalized));
  const denied = manifest.deniedPaths.some((pattern) => globRegex(pattern).test(normalized));
  return allowed && !denied;
}

export function resolveManifestPath(
  workspaceRoot: string,
  path: string,
  manifest: TaskManifest,
  forWrite = false,
): string {
  const normalized = normalizeRepositoryPath(path);
  if (!isManifestPathAllowed(normalized, manifest)) throw new Error(`path is outside the frozen manifest scope: ${normalized}`);
  const root = realpathSync(workspaceRoot);
  const target = resolve(root, normalized);
  if (relative(root, target).startsWith("..") || target === root) throw new Error("path escaped workspace root");
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error("Builder access through symlinks is blocked");
    const canonical = realpathSync(target);
    if (!canonical.startsWith(`${root}${sep}`)) throw new Error("path resolved outside workspace root");
  } else if (forWrite) {
    let ancestor = dirname(target);
    while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor);
    if (lstatSync(ancestor).isSymbolicLink() || !realpathSync(ancestor).startsWith(root)) {
      throw new Error("write parent resolved outside workspace root");
    }
  }
  return target;
}
