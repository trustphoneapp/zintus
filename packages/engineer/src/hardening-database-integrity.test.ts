import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDENING_DATABASE_INTEGRITY_GUIDANCE,
  HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE,
  HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE,
  canonicalHardeningDatabaseIntegrityFailure,
  canonicalHardeningDatabaseIntegrityConflictFailure,
  hardeningDatabaseIntegrityConflictFailureId,
} from "./hardening-database-integrity.js";
import { sha256 } from "./hash.js";
import { EngineerSupervisor } from "./supervisor.js";
import type { FailureRecord } from "./control-contracts.js";

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

function fixture(tag:string){
  const root=mkdtempSync(join(tmpdir(),`zintus-hardening-fatal-${tag}-`));roots.push(root);
  const dbPath=join(root,"engineer.db"),at="2026-07-18T16:00:00.000Z";
  const supervisor=new EngineerSupervisor({dbPath,now:()=>new Date(at),idFactory:()=>`id-${tag}`});
  const create=(runId:string)=>supervisor.receiveRequest({runId,userId:"owner",request:"test",
    repository:{repositoryId:"repository",provider:"local",owner:"local",name:"repo",baseBranch:"main",
      baseCommitSha:"a".repeat(40)},budget:{costBudgetUsd:1,tokenBudget:1_000,timeBudgetSeconds:60}});
  create(`run-${tag}`);
  return {root,dbPath,at,supervisor,runId:`run-${tag}`,create};
}

describe("hardening database-integrity fatal marker",()=>{
  test("atomically inserts, exactly replays, and restores canonical guidance",()=>{
    const item=fixture("replay");
    const first=item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId);
    expect(first).toEqual({status:"APPLIED",failure:canonicalHardeningDatabaseIntegrityFailure({
      runId:item.runId,runCreatedAt:item.at})});
    item.supervisor.setLastError(item.runId,"stale UI error");
    expect(item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId).status).toBe("REPLAYED");
    expect(item.supervisor.getLastError(item.runId)).toBe(HARDENING_DATABASE_INTEGRITY_GUIDANCE);
    expect(item.supervisor.listFailures(item.runId)).toEqual([first.failure]);
  });

  test("two independent supervisors converge on one immutable row",()=>{
    const item=fixture("race");
    const second=new EngineerSupervisor({dbPath:item.dbPath,now:()=>new Date("2026-07-18T17:00:00.000Z")});
    const results=[item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId),
      second.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId)];
    expect(results.map((result)=>result.status).sort()).toEqual(["APPLIED","REPLAYED"]);
    expect(second.listFailures(item.runId)).toHaveLength(1);
    second.close();
  });

  test("rejects deterministic-ID preoccupation and every non-canonical field",()=>{
    const cases:Array<[string,(record:ReturnType<typeof canonicalHardeningDatabaseIntegrityFailure>,otherRun:string)=>FailureRecord]> =[
      ["run",(record,otherRun)=>({...record,runId:otherRun})],
      ["class",(record)=>({...record,failureClass:"MODEL_FAILURE"})],
      ["reason",(record)=>({...record,reasonCode:"DATABASE_INTEGRITY_OTHER"})],
      ["fingerprint",(record)=>({...record,fingerprint:sha256("wrong")})],
      ["evidence",(record)=>({...record,evidenceIds:["unexpected"]})],
      ["retryable",(record)=>({...record,retryable:true})],
      ["time",(record)=>({...record,createdAt:"2026-07-18T16:00:01.000Z"})],
    ];
    for(const [tag,mutate] of cases){
      const item=fixture(`tamper-${tag}`),otherRun=`other-${tag}`;item.create(otherRun);
      const expected=canonicalHardeningDatabaseIntegrityFailure({runId:item.runId,runCreatedAt:item.at});
      item.supervisor.recordFailure(mutate(expected,otherRun));
      expect(()=>item.supervisor.getExactHardeningDatabaseIntegrityFatal(item.runId)).toThrow(expect.objectContaining({
        code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"}));
      expect(()=>item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId)).toThrow(expect.objectContaining({
        code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"}));
      expect(item.supervisor.getLastError(item.runId)).toBe(HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE);
      expect(item.supervisor.getExactHardeningDatabaseIntegrityFatal(item.runId)).toEqual(
        canonicalHardeningDatabaseIntegrityConflictFailure({runId:item.runId,runCreatedAt:item.at}));
    }
  });

  test("malformed evidence at the exact ID conflicts while unrelated malformed rows cannot masquerade",()=>{
    const exact=fixture("malformed-exact"),expected=canonicalHardeningDatabaseIntegrityFailure({
      runId:exact.runId,runCreatedAt:exact.at});
    const exactDb=new Database(exact.dbPath);
    exactDb.query(`INSERT INTO failure_records
      (id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,created_at)
      VALUES(?,?,?,?,?,'{',0,?)`).run(expected.failureId,expected.runId,expected.failureClass,
        expected.reasonCode,expected.fingerprint,expected.createdAt);exactDb.close();
    expect(()=>exact.supervisor.getExactHardeningDatabaseIntegrityFatal(exact.runId)).toThrow(expect.objectContaining({
      code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"}));
    expect(()=>exact.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(exact.runId)).toThrow(expect.objectContaining({
      code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"}));
    expect(exact.supervisor.getExactHardeningDatabaseIntegrityFatal(exact.runId)).toEqual(
      canonicalHardeningDatabaseIntegrityConflictFailure({runId:exact.runId,runCreatedAt:exact.at}));

    const unrelated=fixture("malformed-unrelated"),db=new Database(unrelated.dbPath);
    db.query(`INSERT INTO failure_records
      (id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,created_at)
      VALUES('unrelated-malformed',?,'WORKFLOW_FAILURE','UNRELATED',?,'{',0,?)`)
      .run(unrelated.runId,sha256("unrelated"),unrelated.at);db.close();
    expect(unrelated.supervisor.getExactHardeningDatabaseIntegrityFatal(unrelated.runId)).toBeNull();
    expect(unrelated.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(unrelated.runId).status).toBe("APPLIED");
  });

  test("rolls marker insertion back when the paired last-error write fails",()=>{
    const item=fixture("rollback"),db=new Database(item.dbPath);
    db.exec(`CREATE TRIGGER fail_hardening_fatal_guidance BEFORE UPDATE OF last_error ON engineer_runs
      WHEN NEW.last_error LIKE 'DATABASE_INTEGRITY_CORRUPTION:%'
      BEGIN SELECT RAISE(ABORT,'injected guidance failure'); END`);db.close();
    expect(()=>item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId)).toThrow("injected guidance failure");
    expect(item.supervisor.getExactHardeningDatabaseIntegrityFatal(item.runId)).toBeNull();
    expect(item.supervisor.getLastError(item.runId)).toBeNull();
  });

  test("keeps conflict authority terminal after restart and hostile primary deletion",()=>{
    const item=fixture("conflict-restart"),expected=canonicalHardeningDatabaseIntegrityFailure({
      runId:item.runId,runCreatedAt:item.at});
    item.supervisor.recordFailure({...expected,fingerprint:sha256("hostile-primary")});
    expect(()=>item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId)).toThrow(expect.objectContaining({
      code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"}));
    item.supervisor.close();
    const db=new Database(item.dbPath);db.query("DELETE FROM failure_records WHERE id=?").run(expected.failureId);db.close();
    const reopened=new EngineerSupervisor({dbPath:item.dbPath,now:()=>new Date("2026-07-18T20:00:00.000Z")});
    expect(reopened.getExactHardeningDatabaseIntegrityFatal(item.runId)).toEqual(
      canonicalHardeningDatabaseIntegrityConflictFailure({runId:item.runId,runCreatedAt:item.at}));
    expect(reopened.getLastError(item.runId)).toBe(HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE);
    reopened.close();
  });

  test("bounds a hostile collision at the secondary ID with durable emergency guidance",()=>{
    const item=fixture("secondary-collision"),expected=canonicalHardeningDatabaseIntegrityFailure({
      runId:item.runId,runCreatedAt:item.at}),conflict=canonicalHardeningDatabaseIntegrityConflictFailure({
        runId:item.runId,runCreatedAt:item.at});
    item.supervisor.recordFailure({...expected,fingerprint:sha256("hostile-primary")});
    item.supervisor.recordFailure({...conflict,fingerprint:sha256("hostile-secondary")});
    expect(()=>item.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(item.runId)).toThrow(expect.objectContaining({
      code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT_AUTHORITY_INVALID"}));
    expect(item.supervisor.getLastError(item.runId)).toBe(HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE);
    const db=new Database(item.dbPath,{readonly:true});
    expect(db.query("SELECT fingerprint FROM failure_records WHERE id=?").get(hardeningDatabaseIntegrityConflictFailureId(item.runId)))
      .toEqual({fingerprint:sha256("hostile-secondary")});db.close();
  });
});
