import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalHardeningPromptCacheMaterial } from "@zintus/engineer";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,
  HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,
  inspectEngineerPromptCacheAuthority,
  loadEngineerPromptCacheAuthority,
} from "./engineer-prompt-cache-authority.js";

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function root(tag:string){const value=mkdtempSync(join(tmpdir(),`zintus-cache-authority-${tag}-`));roots.push(value);return value;}
function writeSecret(path:string,value:string){writeFileSync(path,`${value}\n`,{mode:0o600});chmodSync(path,0o600);}
function reservationDb(path:string,secret:string,{tamper=false}:{tamper?:boolean}={}){
  const db=new Database(path);db.exec(`
    CREATE TABLE engineer_runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL);
    CREATE TABLE hardening_child_model_reservations(
      id TEXT PRIMARY KEY,child_run_id TEXT NOT NULL,role TEXT NOT NULL,resolved_model TEXT NOT NULL,
      cache_policy_version TEXT NOT NULL,cache_accounting_version TEXT NOT NULL,static_prefix_hash TEXT NOT NULL,
      tool_schema_hash TEXT NOT NULL,prompt_cache_key_hash TEXT NOT NULL,cache_shard INTEGER NOT NULL,
      cache_ttl_seconds INTEGER NOT NULL,cache_breakpoint_count INTEGER NOT NULL);`);
  const childRunId="child",userId="owner",role="BUILDER" as const,resolvedModel="gpt-5.6-terra";
  const descriptor=canonicalHardeningPromptCacheMaterial({secret,requesterUserId:userId,childRunId,role,resolvedModel}).descriptor;
  db.query("INSERT INTO engineer_runs(id,user_id) VALUES(?,?)").run(childRunId,userId);
  db.query(`INSERT INTO hardening_child_model_reservations
    (id,child_run_id,role,resolved_model,cache_policy_version,cache_accounting_version,static_prefix_hash,
     tool_schema_hash,prompt_cache_key_hash,cache_shard,cache_ttl_seconds,cache_breakpoint_count)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("reservation",childRunId,role,resolvedModel,descriptor.cachePolicyVersion,
      descriptor.cacheAccountingVersion,descriptor.staticPrefixHash,descriptor.toolSchemaHash,
      tamper?`sha256:${"f".repeat(64)}`:descriptor.promptCacheKeyHash,descriptor.cacheShard,
      descriptor.cacheTtlSeconds,descriptor.cacheBreakpointCount);db.close();
}

describe("Engineer prompt-cache machine authority",()=>{
  test("atomically initializes a new machine only when there is no durable reservation history",()=>{
    const dir=root("new"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    const first=loadEngineerPromptCacheAuthority({secretPath,dbPath});
    expect(first.status).toBe("READY");expect(first.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(`${secretPath}.identity`)).toBe(true);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toEqual(first);
  });

  test("validates all legacy descriptors before identity bootstrap and survives delete/rotate/restore",()=>{
    const dir=root("restore"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    const original="1".repeat(64);writeSecret(secretPath,original);reservationDb(dbPath,original);
    const bootstrapped=loadEngineerPromptCacheAuthority({secretPath,dbPath});
    expect(bootstrapped).toMatchObject({status:"READY",secret:original,reservationCount:1});
    const identityBytes=readFileSync(`${secretPath}.identity`);

    rmSync(secretPath);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,reservationCount:1});
    expect(existsSync(secretPath)).toBe(false);

    writeSecret(secretPath,"2".repeat(64));
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined});
    expect(readFileSync(`${secretPath}.identity`)).toEqual(identityBytes);

    writeSecret(secretPath,original);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({status:"READY",secret:original,reservationCount:1});
  });

  test("never blesses a candidate secret that cannot reproduce legacy descriptors",()=>{
    const dir=root("legacy-mismatch"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    const original="3".repeat(64);writeSecret(secretPath,"4".repeat(64));reservationDb(dbPath,original);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined,reservationCount:1});
    expect(existsSync(`${secretPath}.identity`)).toBe(false);
  });

  test("keeps malformed or non-owner-only secret files unavailable without replacing them",()=>{
    const dir=root("invalid"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    writeFileSync(secretPath,"not-a-secret\n",{mode:0o644});
    const bytes=readFileSync(secretPath);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined});
    expect(readFileSync(secretPath)).toEqual(bytes);
  });

  test("does not generate authority when reservations exist but both authority files are missing",()=>{
    const dir=root("missing-history"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    reservationDb(dbPath,"5".repeat(64));
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,reservationCount:1});
    expect(existsSync(secretPath)).toBe(false);expect(existsSync(`${secretPath}.identity`)).toBe(false);
  });

  test("treats orphan reservation rows as mismatch rather than zero history",()=>{
    const dir=root("orphan"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db"),secret="6".repeat(64);
    writeSecret(secretPath,secret);reservationDb(dbPath,secret);
    const db=new Database(dbPath);db.query("DELETE FROM engineer_runs WHERE id='child'").run();db.close();
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined,reservationCount:1});
    expect(existsSync(`${secretPath}.identity`)).toBe(false);
  });

  test("fails closed on a permissive authority directory without creating or replacing files",()=>{
    const dir=root("permissive-dir"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    chmodSync(dir,0o755);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,reservationCount:0});
    expect(inspectEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE});
    expect(existsSync(secretPath)).toBe(false);
    expect(existsSync(`${secretPath}.identity`)).toBe(false);
  });

  test("never overwrites a malformed identity companion",()=>{
    const dir=root("invalid-identity"),secretPath=join(dir,"prompt-cache.secret"),dbPath=join(dir,"engineer.db");
    writeSecret(secretPath,"7".repeat(64));
    writeFileSync(`${secretPath}.identity`,"{malformed\n",{mode:0o600});
    const before=readFileSync(`${secretPath}.identity`);
    expect(loadEngineerPromptCacheAuthority({secretPath,dbPath})).toMatchObject({
      status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined});
    expect(readFileSync(`${secretPath}.identity`)).toEqual(before);
  });
});
