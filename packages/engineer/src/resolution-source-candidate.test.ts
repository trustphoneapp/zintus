import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, sha256Bytes } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import {
  type ArtifactByteReader,
  type SourceCandidateContent,
  signSourceCandidate,
  verifySourceCandidate,
} from "./resolution-source-candidate.js";

const SECRET = "resolution-signing-secret";
const KEY_ID = "engineer-resolution-signing-v1";
const NOW = "2026-07-19T00:00:00.000Z";
const OUT_BYTES = new TextEncoder().encode("builder output result diff");
const SEED_BYTES = new TextEncoder().encode("content addressed seed");
const OUT_ADDR = sha256Bytes(OUT_BYTES);
const SEED_ADDR = sha256Bytes(SEED_BYTES);
const INPUT_HASH = sha256({ builder: "input" });

interface Fixture { root: string; db: Database }
let fixture: Fixture;

function content(overrides: Partial<SourceCandidateContent> = {}): SourceCandidateContent {
  return {
    sourceRunId: "run-1", ownerUserId: "user-1", repositoryId: "repo-1",
    builderDispatch: { agentExecutionId: "agent-1", inputHash: INPUT_HASH, modelTier: "GPT-5.6_TERRA" },
    output: { artifactId: "art-out", contentAddress: OUT_ADDR, executionStatus: "SUCCEEDED" },
    seed: { artifactId: "art-seed", contentAddress: SEED_ADDR },
    runEventHead: { sequence: 4, eventId: "event-4" },
    manifestHash: sha256({ m: 1 }), requiredLaneContractHash: sha256({ contract: 1 }), baseCommitSha: "a".repeat(40),
    testPlanHash: sha256({ testPlan: 1 }), transientProof: { reasonCode: "PROVIDER_REQUEST_TIMEOUT", fingerprint: sha256({ fp: 1 }) },
    createdAt: NOW, ...overrides,
  };
}

const byteReader: ArtifactByteReader = {
  read: ({ artifactId }) => (artifactId === "art-out" ? OUT_BYTES : artifactId === "art-seed" ? SEED_BYTES : null),
};

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "zintus-source-candidate-"));
  const dbPath = join(root, "engineer.db");
  new EngineerLedger(dbPath).close();
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1',NULL,?,?)").run(NOW, NOW);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1','user-1','local','local','repo',?,?)").run(NOW, NOW);
  db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
    VALUES ('run-1','user-1','repo-1','main',?,'req','req','VERIFICATION_INCOMPLETE',4,?,'MEDIUM',1,?,?)`).run("a".repeat(40), sha256({ m: 1 }), NOW, NOW);
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,'{}',?)").run(sha256({ m: 1 }), NOW);
  // The dispatch claim trigger requires a RUNNING builder with a null output;
  // claim it while running, then transition to the succeeded terminal the record binds.
  db.query(`INSERT INTO agent_executions(id,run_id,role,model_tier,status,input_hash,output_artifact_id,started_at,completed_at)
    VALUES ('agent-1','run-1','BUILDER','GPT-5.6_TERRA','RUNNING',?,NULL,?,NULL)`).run(INPUT_HASH, NOW);
  db.query("INSERT INTO builder_dispatch_claims(run_id,input_hash,agent_execution_id,model_tier,claimed_at) VALUES ('run-1',?,'agent-1','GPT-5.6_TERRA',?)").run(INPUT_HASH, NOW);
  db.query("UPDATE agent_executions SET status='SUCCEEDED', output_artifact_id='art-out', completed_at=? WHERE id='agent-1'").run(NOW);
  const insertArtifact = (id: string, hash: string) => db.query(`INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at)
    VALUES (?,'run-1','BUILDER_OUTPUT',?,'AGENT','agent-1',?,10,1,?)`).run(id, hash, `store://${id}`, NOW);
  insertArtifact("art-out", OUT_ADDR);
  insertArtifact("art-seed", SEED_ADDR);
  for (let seq = 1; seq <= 4; seq += 1) {
    db.query(`INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type,actor_id,timestamp,evidence_ids_json,state_version,idempotency_key)
      VALUES (?,'run-1',?,'PREV','NEXT','R','SYSTEM','s',?,'[]',?,?)`).run(`event-${seq}`, seq, NOW, seq, `k-${seq}`);
  }
  fixture = { root, db };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

describe("B-prime signed pre-verification source candidate", () => {
  test("accepts the good record via durable-row re-read", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: true });
  });

  test("accepts the good record with a true byte re-read of output and seed", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET, byteReader)).toEqual({ ok: true });
  });

  test("rejects a record signed under a different secret", () => {
    const signed = signSourceCandidate(content(), "other-secret", KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  test("rejects a record whose signed bytes were altered", () => {
    const signed = { ...signSourceCandidate(content(), SECRET, KEY_ID), baseCommitSha: "b".repeat(40) };
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "RECORD_TAMPERED" });
  });

  test("rejects when the source base commit drifted", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    fixture.db.query("UPDATE engineer_runs SET base_commit_sha=? WHERE id='run-1'").run("f".repeat(40));
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "BASE_COMMIT_DRIFT" });
  });

  test("rejects when the manifest freeze is not present", () => {
    const signed = signSourceCandidate(content({ manifestHash: sha256({ m: 2 }) }), SECRET, KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "MANIFEST_DRIFT" });
  });

  test("rejects when the Builder dispatch identity drifted", () => {
    // Dispatch claims are immutable/undeletable; a record binding an input hash
    // with no matching claim proves the identity-mismatch rejection.
    const signed = signSourceCandidate(content({ builderDispatch: { agentExecutionId: "agent-1", inputHash: sha256({ builder: "other" }), modelTier: "GPT-5.6_TERRA" } }), SECRET, KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "BUILDER_DISPATCH_DRIFT" });
  });

  test("rejects when the Builder execution output linkage drifted", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    fixture.db.query("UPDATE agent_executions SET status='FAILED' WHERE id='agent-1'").run();
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "BUILDER_EXECUTION_DRIFT" });
  });

  test("rejects when the output artifact content address drifted", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    fixture.db.query("UPDATE artifacts SET sha256=? WHERE id='art-out'").run(sha256({ tampered: 1 }));
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "OUTPUT_ARTIFACT_DRIFT" });
  });

  test("rejects when the actual output bytes no longer match the content address", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    const driftReader: ArtifactByteReader = { read: ({ artifactId }) => (artifactId === "art-out" ? new TextEncoder().encode("swapped bytes") : SEED_BYTES) };
    expect(verifySourceCandidate(fixture.db, signed, SECRET, driftReader)).toEqual({ ok: false, reason: "OUTPUT_BYTES_DRIFT" });
  });

  test("rejects when the seed artifact is gone", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    fixture.db.query("DELETE FROM artifacts WHERE id='art-seed'").run();
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "SEED_ARTIFACT_DRIFT" });
  });

  test("rejects when the source run event head advanced (quiescence broken)", () => {
    const signed = signSourceCandidate(content(), SECRET, KEY_ID);
    fixture.db.query(`INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type,actor_id,timestamp,evidence_ids_json,state_version,idempotency_key)
      VALUES ('event-5','run-1',5,'NEXT','OTHER','R','SYSTEM','s',?,'[]',5,'k-5')`).run(NOW);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "EVENT_HEAD_DRIFT" });
  });

  test("rejects when the source run does not exist", () => {
    const signed = signSourceCandidate(content({ sourceRunId: "ghost" }), SECRET, KEY_ID);
    expect(verifySourceCandidate(fixture.db, signed, SECRET)).toEqual({ ok: false, reason: "SOURCE_RUN_MISSING" });
  });
});
