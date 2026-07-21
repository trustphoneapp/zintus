import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  NO_LOCKFILE_HASH,
  OfflineDependencyBundle,
  gitCommitLockfileHash,
  runProcessAsync,
  sha256,
  type AsyncProcessResult,
} from "../packages/engineer/src/index.js";
import { inspectEngineerPromptCacheAuthority } from "../apps/gateway/src/engineer-prompt-cache-authority.js";
import { EngineerLedger } from "../packages/engineer/src/ledger.js";

export type EngineerDoctorCheck = { name: string; ok: boolean; detail: string };
export type EngineerDoctorResult = { ok: boolean; checks: EngineerDoctorCheck[] };
type Runner = (executable: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number; cwd?: string }) => Promise<AsyncProcessResult>;

const required = [
  "ZINTUS_ENGINEER_REPOSITORY_ROOT", "ZINTUS_ENGINEER_REPOSITORY_ID", "ZINTUS_ENGINEER_REPOSITORY_PROVIDER",
  "ZINTUS_ENGINEER_REPOSITORY_OWNER", "ZINTUS_ENGINEER_REPOSITORY_NAME", "ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL",
  "ZINTUS_ENGINEER_BASE_BRANCH", "ZINTUS_ENGINEER_BASE_COMMIT_SHA", "ZINTUS_ENGINEER_IMAGE", "ZINTUS_ENGINEER_IMAGE_DIGEST",
] as const;

const PRESERVED_AUTHORITY_TABLES = new Set([
  "engineer_runs", "task_manifest_versions", "required_lane_contracts", "reviewer_sessions",
  "review_findings", "review_classification_batches", "artifacts", "audit_events",
]);

type DatabasePreservationSnapshot = Map<string, { count: number; columns: string[]; hash?: string }>;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function preservationSnapshot(db: Database): DatabasePreservationSnapshot {
  const snapshot: DatabasePreservationSnapshot = new Map();
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name).filter((name) => name !== "schema_migrations");
  for (const table of tables) {
    const columns = (db.query(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
    const count = (db.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count;
    let hash: string | undefined;
    if (PRESERVED_AUTHORITY_TABLES.has(table)) {
      const projection = columns.map(quoteIdentifier).join(", ");
      const rows = db.query(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
      const encoded = rows.map((row) => JSON.stringify(columns.map((column) => row[column]), (_key, value) => {
        if (typeof value === "bigint") return { bigint: value.toString() };
        if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
        return value;
      })).sort();
      hash = sha256(encoded.join("\n"));
    }
    snapshot.set(table, { count, columns, hash });
  }
  return snapshot;
}

function assertPreservedSnapshot(before: DatabasePreservationSnapshot, afterDb: Database): number {
  const after = preservationSnapshot(afterDb);
  let hashedTables = 0;
  for (const [table, expected] of before) {
    const actual = after.get(table);
    if (!actual || actual.count !== expected.count) {
      throw new Error(`row-count preservation failed for ${table}`);
    }
    if (expected.hash !== undefined) {
      hashedTables += 1;
      const originalProjection = expected.columns.map(quoteIdentifier).join(", ");
      const rows = afterDb.query(`SELECT ${originalProjection} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
      const encoded = rows.map((row) => JSON.stringify(expected.columns.map((column) => row[column]), (_key, value) => {
        if (typeof value === "bigint") return { bigint: value.toString() };
        if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
        return value;
      })).sort();
      if (sha256(encoded.join("\n")) !== expected.hash) {
        throw new Error(`authority-row hash preservation failed for ${table}`);
      }
    }
  }
  return hashedTables;
}

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

  // Doctor must exercise the same ledger-construction/migration path the
  // gateway uses, but never against the installed database. Database.serialize
  // produces a consistent image (including committed WAL content); all schema
  // repair, migration, and org-authority checks then run on the disposable file.
  let disposableRoot: string | null = null;
  let sourceDb: Database | null = null;
  let migratedDb: Database | null = null;
  let sourceSnapshot: DatabasePreservationSnapshot | null = null;
  try {
    disposableRoot = mkdtempSync(join(tmpdir(), "zintus-engineer-doctor-db-"));
    const disposableDbPath = join(disposableRoot, "engineer.db");
    if (existsSync(engineerDbPath)) {
      sourceDb = new Database(engineerDbPath, { readonly: true });
      sourceSnapshot = preservationSnapshot(sourceDb);
      writeFileSync(disposableDbPath, sourceDb.serialize(), { mode: 0o600 });
      sourceDb.close();
      sourceDb = null;
    }
    const ledger = new EngineerLedger(disposableDbPath);
    ledger.close();
    migratedDb = new Database(disposableDbPath, { readonly: true });
    const version = migratedDb.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    const quick = migratedDb.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const quickOk = quick.length === 1 && Object.values(quick[0] ?? {})[0] === "ok";
    const foreignKeyViolations = migratedDb.query("PRAGMA foreign_key_check").all();
    if (!quickOk || foreignKeyViolations.length > 0 || version.version === null) {
      throw new Error(`post-migration integrity failed at schema ${version.version ?? "unknown"}`);
    }
    const hashedTables = sourceSnapshot ? assertPreservedSnapshot(sourceSnapshot, migratedDb) : 0;
    add("Engineer database gateway construction", true,
      `disposable copy opened through gateway ledger path at schema ${version.version}; all source table counts and ${hashedTables} authority-table hashes preserved; source opened read-only`);
  } catch (error) {
    add("Engineer database gateway construction", false,
      `DATABASE_MIGRATION_NOT_READY: disposable gateway construction failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { sourceDb?.close(); } catch { /* preserve the construction result */ }
    try { migratedDb?.close(); } catch { /* preserve the construction result */ }
    if (disposableRoot) rmSync(disposableRoot, { recursive: true, force: true });
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
