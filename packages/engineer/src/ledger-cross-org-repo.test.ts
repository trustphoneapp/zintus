import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { EngineerLedger } from "./ledger.js";
import { EngineerNotFoundError } from "./errors.js";
import { ENGINEER_DEFAULT_ORG_ID } from "./database-schema.js";

/**
 * B3 (R4) — the ledger's `RUN_SELECT` / `REPOSITORY_ADMISSION_SELECT` JOIN
 * `repository_connections rc ON rc.id = <driver>.repository_id` with NO org_id
 * constraint. A run/admission owned by the ledger's org (the default org today)
 * whose `repository_id` points at a repository row stamped to a FOREIGN org would
 * leak that foreign org's provider/owner/name/url. This is defense-in-depth: latent
 * under single-tenant, real once multi-tenant is enabled. The fix pins the join with
 * `AND rc.org_id = <driver>.org_id` so a cross-org repository row can never be
 * folded into the driver row's metadata.
 */
const NOW = "2026-07-19T00:00:00.000Z";
const ORG_A = ENGINEER_DEFAULT_ORG_ID; // the ledger's fixed single-tenant org today
const ORG_B = "org-b-foreign";
const USER = "owner-user";
const REPO_B = "repo-owned-by-b";
const RUN = "run-in-org-a";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture(): { ledger: EngineerLedger } {
  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-b3-"));
  const dbPath = join(root, "engineer.sqlite");
  const ledger = new EngineerLedger(dbPath, () => new Date(NOW));
  cleanups.push(() => { try { ledger.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });

  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  // A FOREIGN org and a repository_connections row stamped to it, with secret
  // cross-org identity fields the caller in ORG_A must never observe.
  seed.query("INSERT INTO orgs(id,display_name,default_retention_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(ORG_B, "Foreign Org B", "STANDARD", "ACTIVE", NOW, NOW);
  seed.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(USER, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,url,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(REPO_B, USER, "github", "SECRET-ORG-B-OWNER", "secret-org-b-repo", "https://secret-b/repo", NOW, NOW, ORG_B);
  // A run owned by ORG_A whose repository_id points at ORG_B's connection row.
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(RUN, USER, REPO_B, "main", "a".repeat(40), "req", "req", "CREATED", 0, "LOW", 0, NOW, NOW, ORG_A);
  // An admission owned by ORG_A pointing at the same ORG_B connection row.
  seed.query(
    "INSERT INTO repository_admissions(admission_id,repository_id,owner_user_id,base_branch,base_commit_sha,source," +
      "authorization_subject,authorization_evidence_hash,authorization_generation,status,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("adm-a", REPO_B, USER, "main", "a".repeat(40), "CONFIGURED_CANONICAL", "subject",
    `sha256:${"0".repeat(64)}`, 1, "ACTIVE", NOW, NOW, ORG_A);
  seed.close();
  return { ledger };
}

describe("B3 — ledger repository JOIN is org-scoped (no cross-org repo metadata leak)", () => {
  test("getRun does NOT fold a foreign-org repository's provider/owner/name/url into an ORG_A run", () => {
    const { ledger } = fixture();
    // With the org-pinned join, a run whose repo belongs to a foreign org cannot be
    // completed, so it collapses to the same not-found as any missing run — the
    // foreign metadata never leaves the ledger. Before the fix, getRun returned the
    // run WITH ORG_B's owner "SECRET-ORG-B-OWNER" (RED: no throw).
    expect(() => ledger.getRun(RUN)).toThrow(EngineerNotFoundError);
  });

  test("getRepositoryAdmission does NOT return a foreign-org repository's metadata", () => {
    const { ledger } = fixture();
    // Before the fix this returned the admission joined to ORG_B's connection row
    // (leaking the foreign provider/owner/name/url). The org-pinned join yields no
    // row => null.
    expect(ledger.getRepositoryAdmission(USER, REPO_B)).toBeNull();
  });

  test("listRepositoryAdmissions excludes an admission bound to a foreign-org repository", () => {
    const { ledger } = fixture();
    const admissions = ledger.listRepositoryAdmissions(USER);
    expect(admissions.some((a) => a.repository.repositoryId === REPO_B)).toBe(false);
  });
});
