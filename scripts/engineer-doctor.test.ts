import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDependencyTree, OFFLINE_DEPENDENCY_MANIFEST, sha256, workspaceLockfileHash } from "../packages/engineer/src/index.js";
import { runEngineerDoctor } from "./engineer-doctor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "zintus-engineer-doctor-")));
  roots.push(path);
  return path;
}

describe("Phase 2 activation doctor", () => {
  test("fails closed when Docker and canonical configuration are absent", async () => {
    const result = await runEngineerDoctor({
      env: {},
      runner: async () => ({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error("docker missing"), { code: "ENOENT" }) }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "Docker daemon")).toMatchObject({ ok: false, detail: "docker missing" });
    expect(result.checks.find((check) => check.name === "live hardened offline container")?.ok).toBe(false);
  });

  test("requires a real hardened container probe and verified offline dependency bytes", async () => {
    const repositoryRoot = root();
    writeFileSync(join(repositoryRoot, "bun.lock"), '{"lockfileVersion":1}\n');
    const bundleRoot = join(repositoryRoot, "bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repositoryRoot);
    const toolchainHash = sha256("toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash,
      contentHash: await hashDependencyTree(join(bundleRoot, "node_modules")), nodeModulesPath: "node_modules",
    }));
    const base = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    const image = `example.invalid/zintus-engineer@${digest}`;
    const calls: Array<{ executable: string; args: string[] }> = [];
    const result = await runEngineerDoctor({
      env: {
        ZINTUS_ENGINEER_REPOSITORY_ROOT: repositoryRoot,
        ZINTUS_ENGINEER_REPOSITORY_ID: "repo-1",
        ZINTUS_ENGINEER_REPOSITORY_PROVIDER: "local",
        ZINTUS_ENGINEER_REPOSITORY_OWNER: "local",
        ZINTUS_ENGINEER_REPOSITORY_NAME: "fixture",
        ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL: "https://example.invalid/repo.git",
        ZINTUS_ENGINEER_BASE_BRANCH: "main",
        ZINTUS_ENGINEER_BASE_COMMIT_SHA: base,
        ZINTUS_ENGINEER_IMAGE: image,
        ZINTUS_ENGINEER_IMAGE_DIGEST: digest,
        ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT: bundleRoot,
        ZINTUS_ENGINEER_TOOLCHAIN_HASH: toolchainHash,
      },
      runner: async (executable, args) => {
        calls.push({ executable, args });
        if (executable === "git" && args.includes("get-url")) return { status: 0, signal: null, stdout: "https://example.invalid/repo.git\n", stderr: "" };
        if (executable === "git") return { status: 0, signal: null, stdout: `${base}\n`, stderr: "" };
        if (args[0] === "version") return { status: 0, signal: null, stdout: "27.0\n", stderr: "" };
        if (args[0] === "image") return { status: 0, signal: null, stdout: JSON.stringify([image]), stderr: "" };
        return { status: 0, signal: null, stdout: "1.3.14\n", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    const smoke = calls.find((call) => call.executable === "docker" && call.args[0] === "run")?.args ?? [];
    expect(smoke).toContain("--network=none");
    expect(smoke).toContain("--read-only");
    expect(smoke).toContain("--cap-drop=ALL");
    expect(result.checks.find((check) => check.name === "offline dependencies")?.detail).toMatch(/^sha256:/);
  });
});
