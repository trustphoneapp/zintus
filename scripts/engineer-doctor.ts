import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  NO_LOCKFILE_HASH,
  OfflineDependencyBundle,
  gitCommitLockfileHash,
  runProcessAsync,
  type AsyncProcessResult,
} from "../packages/engineer/src/index.js";
import { inspectEngineerPromptCacheAuthority } from "../apps/gateway/src/engineer-prompt-cache-authority.js";

export type EngineerDoctorCheck = { name: string; ok: boolean; detail: string };
export type EngineerDoctorResult = { ok: boolean; checks: EngineerDoctorCheck[] };
type Runner = (executable: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number; cwd?: string }) => Promise<AsyncProcessResult>;

const required = [
  "ZINTUS_ENGINEER_REPOSITORY_ROOT", "ZINTUS_ENGINEER_REPOSITORY_ID", "ZINTUS_ENGINEER_REPOSITORY_PROVIDER",
  "ZINTUS_ENGINEER_REPOSITORY_OWNER", "ZINTUS_ENGINEER_REPOSITORY_NAME", "ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL",
  "ZINTUS_ENGINEER_BASE_BRANCH", "ZINTUS_ENGINEER_BASE_COMMIT_SHA", "ZINTUS_ENGINEER_IMAGE", "ZINTUS_ENGINEER_IMAGE_DIGEST",
] as const;

export async function runEngineerDoctor(options: { env?: NodeJS.ProcessEnv; runner?: Runner; engineerDbPath?:string;
  promptCacheSecretPath?:string } = {}): Promise<EngineerDoctorResult> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? ((executable, args, processOptions) => runProcessAsync(executable, args, {
    timeoutMs: processOptions.timeoutMs, maxOutputBytes: processOptions.maxOutputBytes, cwd: processOptions.cwd,
  }));
  const checks: EngineerDoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  for (const name of required) add(name, Boolean(env[name]?.trim()), env[name] ? "configured" : "missing");

  const digest = env.ZINTUS_ENGINEER_IMAGE_DIGEST ?? "";
  const image = env.ZINTUS_ENGINEER_IMAGE ?? "";
  const immutableImage = /^sha256:[a-f0-9]{64}$/i.test(digest) && image.endsWith(`@${digest}`);
  add("immutable image digest", immutableImage, "requires repository@sha256 plus matching digest");

  const docker = await runner("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
  add("Docker daemon", docker.status === 0, docker.status === 0 ? docker.stdout.trim() || "available" : docker.error?.message ?? (docker.stderr.trim() || "unavailable"));
  if (docker.status === 0 && immutableImage) {
    const inspect = await runner("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    add("pinned image present", inspect.status === 0 && inspect.stdout.includes(digest), inspect.status === 0 ? "digest inspected" : inspect.error?.message ?? "unavailable");
    const smoke = await runner("docker", [
      "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000", "--cpus", "1", "--memory", "512m", "--pids-limit", "64",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", image, "bun", "--version",
    ], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    add("live hardened offline container", smoke.status === 0, smoke.status === 0 ? smoke.stdout.trim() : smoke.error?.message ?? (smoke.stderr.trim() || "failed"));
  } else {
    add("pinned image present", false, "Docker and immutable image configuration are required");
    add("live hardened offline container", false, "Docker and immutable image configuration are required");
  }

  const root = env.ZINTUS_ENGINEER_REPOSITORY_ROOT;
  const base = env.ZINTUS_ENGINEER_BASE_COMMIT_SHA;
  const branch = env.ZINTUS_ENGINEER_BASE_BRANCH;
  if (root && base && branch) {
    try {
      const repositoryRoot = realpathSync(root);
      const git = (args: string[]) => runner("git", ["-C", repositoryRoot, ...args], { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
      const [object, ref, origin] = await Promise.all([
        git(["rev-parse", "--verify", `${base}^{commit}`]),
        git(["rev-parse", "--verify", `${branch}^{commit}`]),
        git(["remote", "get-url", "origin"]),
      ]);
      const exact = object.status === 0 && ref.status === 0 && object.stdout.trim().toLowerCase() === base.toLowerCase() && ref.stdout.trim().toLowerCase() === base.toLowerCase();
      add("exact base branch", exact, exact ? base : "branch/base mismatch");
      add("repository origin", origin.status === 0 && Boolean(origin.stdout.trim()), origin.status === 0 ? origin.stdout.trim() : "unavailable");

      const lockfileHash = gitCommitLockfileHash(repositoryRoot, base);
      if (lockfileHash === NO_LOCKFILE_HASH) {
        add("offline dependencies", true, "repository has no supported lockfile");
      } else {
        const bundleRoot = env.ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT;
        const toolchainHash = env.ZINTUS_ENGINEER_TOOLCHAIN_HASH;
        if (!bundleRoot || !toolchainHash) {
          add("offline dependencies", false, "dependency-bearing repository requires bundle root and toolchain hash");
        } else {
          try {
            const bundle = new OfflineDependencyBundle({ root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: base });
            await bundle.verify();
            add("offline dependencies", true, bundle.manifest.contentHash);
          } catch (error) {
            add("offline dependencies", false, error instanceof Error ? error.message : String(error));
          }
        }
      }
    } catch (error) {
      add("exact base branch", false, error instanceof Error ? error.message : String(error));
      add("repository origin", false, "repository unavailable");
      add("offline dependencies", false, "repository unavailable");
    }
  } else {
    add("exact base branch", false, "repository/base configuration missing");
    add("repository origin", false, "repository/base configuration missing");
    add("offline dependencies", false, "repository/base configuration missing");
  }

  const engineerDbPath=options.engineerDbPath??env.ZINTUS_ENGINEER_DB_PATH??join(homedir(),".zintus","engineer","engineer.db");
  if(!existsSync(engineerDbPath)){
    add("Engineer database integrity",true,`not initialized: ${engineerDbPath}`);
  }else{
    let db:Database|null=null;
    try{
      db=new Database(engineerDbPath,{readonly:true});
      const quick=db.query("PRAGMA quick_check").all() as Array<Record<string,unknown>>;
      const quickOk=quick.length===1&&Object.values(quick[0]??{})[0]==="ok";
      const foreignKeyViolations=db.query("PRAGMA foreign_key_check").all() as Array<Record<string,unknown>>;
      const ok=quickOk&&foreignKeyViolations.length===0;
      add("Engineer database integrity",ok,ok?"read-only quick_check passed; foreign_key_check found 0 violations":
        `DATABASE_INTEGRITY_CORRUPTION: ${quickOk?"quick_check passed":"quick_check failed"}; foreign_key_check found ${foreignKeyViolations.length} violation(s). Restore the Engineer database and artifact store from the same backup before retrying.`);
    }catch(error){
      add("Engineer database integrity",false,`DATABASE_INTEGRITY_CORRUPTION: read-only database inspection failed: ${error instanceof Error?error.message:String(error)}. Restore the Engineer database and artifact store from the same backup before retrying.`);
    }finally{try{db?.close();}catch{/* retain the original integrity result */}}
  }
  const promptCacheSecretPath=options.promptCacheSecretPath??env.ZINTUS_ENGINEER_PROMPT_CACHE_SECRET_PATH??
    join(dirname(engineerDbPath),"prompt-cache.secret");
  const promptCache=inspectEngineerPromptCacheAuthority({secretPath:promptCacheSecretPath,dbPath:engineerDbPath});
  add("Hardening prompt-cache authority",promptCache.ok,`${promptCache.state}: ${promptCache.detail}; durable reservations: ${promptCache.reservationCount}`);

  return { ok: checks.every((check) => check.ok), checks };
}

if (import.meta.main) {
  const result = await runEngineerDoctor();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
