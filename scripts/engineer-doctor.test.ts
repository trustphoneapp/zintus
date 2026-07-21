import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  gitCommitLockfileHash,
  hashDependencyTree,
  migrateEngineerDatabase,
  OFFLINE_DEPENDENCY_MANIFEST,
  sha256,
} from "../packages/engineer/src/index.js";
import { runEngineerDoctor } from "./engineer-doctor.js";
import { Database } from "bun:sqlite";

const roots: string[] = [];
const DEPLOYED_V18_SQL = readFileSync(new URL(
  "../docs/zintus-engineer/release-15h/archive/historical-fixtures/deployed-v18-review-classification.sql",
  import.meta.url,
), "utf8");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "zintus-engineer-doctor-")));
  roots.push(path);
  return path;
}

describe("Phase 2 activation doctor", () => {
  test("fails closed when Docker and canonical configuration are absent", async () => {
    const uninitialized=join(root(),"missing-engineer.db");
    const result = await runEngineerDoctor({
      env: {},
      engineerDbPath:uninitialized,
      runner: async () => ({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error("docker missing"), { code: "ENOENT" }) }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "Docker daemon")).toMatchObject({ ok: false, detail: "docker missing" });
    expect(result.checks.find((check) => check.name === "live hardened offline container")?.ok).toBe(false);
    expect(result.checks.find((check)=>check.name==="Engineer database integrity"))
      .toEqual({name:"Engineer database integrity",ok:true,detail:`not initialized: ${uninitialized}`});
  });

  test("inspects the Engineer database read-only and reports exact foreign-key corruption",async()=>{
    const directory=root(),dbPath=join(directory,"engineer.db");
    const db=new Database(dbPath);
    db.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE parent(id TEXT PRIMARY KEY);
      CREATE TABLE child(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parent(id));
      INSERT INTO child(id,parent_id) VALUES('child-1','missing-parent');`);
    db.close();
    const before=readFileSync(dbPath);
    const result=await runEngineerDoctor({env:{},engineerDbPath:dbPath,
      runner:async()=>({status:null,signal:null,stdout:"",stderr:"",error:new Error("unavailable")})});
    const check=result.checks.find((item)=>item.name==="Engineer database integrity");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("DATABASE_INTEGRITY_CORRUPTION");
    expect(check?.detail).toContain("foreign_key_check found 1 violation");
    expect(readFileSync(dbPath)).toEqual(before);
    const verify=new Database(dbPath,{readonly:true});
    expect(verify.query("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()).toBeNull();
    verify.close();
  });

  test("migrates an exact installed-v18 copy through gateway ledger construction without touching the source",async()=>{
    const directory=root(),dbPath=join(directory,"engineer.db");
    const db=new Database(dbPath);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)")
      .run("2026-07-20T00:00:00.000Z");
    migrateEngineerDatabase(db,"2026-07-20T00:00:00.000Z",17);
    db.exec(DEPLOYED_V18_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (18, ?)")
      .run("2026-07-20T00:00:00.000Z");
    db.close();
    const before=readFileSync(dbPath);

    const result=await runEngineerDoctor({env:{},engineerDbPath:dbPath,
      promptCacheSecretPath:join(directory,"prompt-cache.secret"),
      runner:async()=>({status:null,signal:null,stdout:"",stderr:"",error:new Error("unavailable")})});

    expect(result.checks.find((item)=>item.name==="Engineer database integrity"))
      .toMatchObject({ok:true});
    expect(result.checks.find((item)=>item.name==="Engineer database gateway construction"))
      .toMatchObject({ok:true,detail:expect.stringContaining("schema 39")});
    expect(readFileSync(dbPath)).toEqual(before);
    const source=new Database(dbPath,{readonly:true});
    expect(source.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:18});
    expect(source.query("SELECT name FROM sqlite_master WHERE type='table' AND name='engineer_compatibility_migrations'").get())
      .toBeNull();
    source.close();
  });

  test("reports an unsafe prompt-cache authority directory without mutating it",async()=>{
    const directory=root(),secretPath=join(directory,"prompt-cache.secret"),dbPath=join(directory,"engineer.db");
    chmodSync(directory,0o755);
    const result=await runEngineerDoctor({env:{},engineerDbPath:dbPath,promptCacheSecretPath:secretPath,
      runner:async()=>({status:null,signal:null,stdout:"",stderr:"",error:new Error("unavailable")})});
    expect(result.checks.find((item)=>item.name==="Hardening prompt-cache authority")).toMatchObject({
      ok:false,detail:expect.stringContaining("chmod 700"),
    });
    expect(()=>readFileSync(secretPath)).toThrow();
  });

  test("requires a real hardened container probe and verified offline dependency bytes", async () => {
    const repositoryRoot = root();
    writeFileSync(join(repositoryRoot, "bun.lock"), '{"lockfileVersion":1}\n');
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.name", "Zintus Test"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.email", "test@zintus.local"], { cwd: repositoryRoot });
    execFileSync("git", ["add", "bun.lock"], { cwd: repositoryRoot });
    execFileSync("git", ["commit", "-m", "exact base"], { cwd: repositoryRoot });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const bundleRoot = join(repositoryRoot, "bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    mkdirSync(join(bundleRoot, "node_modules", ".vite-temp"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = gitCommitLockfileHash(repositoryRoot, base);
    const toolchainHash = sha256("toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 2, lockfileHash, toolchainHash, repositoryCommit: base,
      contentHash: await hashDependencyTree(join(bundleRoot, "node_modules")), nodeModulesPath: "node_modules",
    }));
    // A local install or security pin may legitimately dirty the checkout after
    // the run's exact base was selected. Doctor must verify the immutable base,
    // matching the sandbox, rather than this mutable file.
    writeFileSync(join(repositoryRoot, "bun.lock"), '{"lockfileVersion":2,"dirty":true}\n');
    const digest = `sha256:${"b".repeat(64)}`;
    const image = `example.invalid/zintus-engineer@${digest}`;
    const calls: Array<{ executable: string; args: string[] }> = [];
    const result = await runEngineerDoctor({
      engineerDbPath:join(repositoryRoot,"not-initialized-engineer.db"),
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
