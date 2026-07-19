import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import type { RepositoryReference } from "./contracts.js";
import type {
  BaseBranchStatus,
  BranchProtectionEvidence,
  GitService,
  PublicationOperationReconciliation,
} from "./git-service.js";
import {
  PublicationAuthorityService,
  PreflightMismatchError,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  type ApproverAuthContext,
} from "./publication-authority.js";
import {
  BranchProtectionInsufficientError,
  GitPublicationMechanics,
  PublicationRepositoryUnavailableError,
  evaluateBranchProtection,
  synthesizePublicationPrBody,
  type GitPublicationContext,
  type PublicationNarrative,
} from "./git-publication-mechanics.js";

const AT = "2026-07-19T12:00:00.000Z";
const CK_ID = `sha256:${"a".repeat(64)}`;
const CK_HASH = `sha256:${"b".repeat(64)}`;
const EVID = `sha256:${"c".repeat(64)}`;
const RESULT_COMMIT = "1".repeat(40);
const BASE_COMMIT = "0".repeat(40);
const ADVANCED_COMMIT = "9".repeat(40);
const RUN_ID = "run-1";
const REPO_ID = "repo-1";
const USER_ID = "owner-1";
const APPROVER = "human-approver";

const CTX: ApproverAuthContext = {
  approverActorId: APPROVER,
  implementationActorId: "engineer-agent",
  evidenceRoot: EVID,
  expiresAt: "2026-07-20T12:00:00.000Z",
};

const REPO: RepositoryReference = {
  repositoryId: REPO_ID,
  provider: "github",
  owner: "acme",
  name: "svc",
  baseBranch: "main",
  baseCommitSha: BASE_COMMIT,
};

const FULL_PROTECTION: BranchProtectionEvidence = {
  protected: true,
  requiresPullRequestReviews: true,
  requiredApprovingReviewCount: 1,
  invalidatesStaleApproval: true,
  requiresStatusChecks: true,
  requiresStrictStatusChecks: true,
  enforcesAdmins: true,
  blocksForcePushes: true,
  blocksDeletions: true,
};

const NARRATIVE: PublicationNarrative = {
  requestNormalized: "Harden the auth token refresh path",
  requestOriginal: "fix auth",
  riskTier: "HIGH",
  evidenceBundleHash: `sha256:${"d".repeat(64)}`,
  acceptanceCriteria: [{ statement: "refresh retries at most once" }, { statement: "no secret is logged" }],
  diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@\n-old\n+refreshed = true\n",
  claims: [{ status: "VERIFIED", claim: "token refresh is bounded" }],
};

const CONTEXT: GitPublicationContext = { repository: REPO, title: "Harden the auth token refresh path", narrative: NARRATIVE };

const ACTUATOR_INPUT = {
  runId: RUN_ID,
  publicationId: "pub-1",
  repositoryId: REPO_ID,
  baseCommitSha: BASE_COMMIT,
  resultCommitSha: RESULT_COMMIT,
  idempotencyKey: "idem-1",
};
const CREDS = { token: "ghp_secret" };

// A drivable fake GitService. Each seam is overridable; call names are recorded.
interface FakeConfig {
  calls: string[];
  currentCommitSha?: string;
  protection?: BranchProtectionEvidence;
  createPr?: () => Promise<{ id: string; number: number; url: string }>;
  capturePrBody?: (body: string) => void;
  reconcile?: () => Promise<PublicationOperationReconciliation>;
  inspectThrows?: boolean;
}

function fakeGit(config: FakeConfig): GitService {
  const service: GitService = {
    async inspectBaseBranch(): Promise<BaseBranchStatus> {
      config.calls.push("inspect");
      if (config.inspectThrows) throw new Error("remote base unreachable");
      const currentCommitSha = config.currentCommitSha ?? BASE_COMMIT;
      const protection = config.protection ?? FULL_PROTECTION;
      return {
        currentCommitSha,
        matchesExpected: currentCommitSha.toLowerCase() === BASE_COMMIT.toLowerCase(),
        protectionEnforced: evaluateBranchProtection(protection).enforced,
        protection,
      };
    },
    async createRunBranch() {
      config.calls.push("branch");
      return { branchName: "zintus/engineer/run-1-1", remoteReference: "refs/heads/zintus/engineer/run-1-1" };
    },
    async pushVerifiedCommit() {
      config.calls.push("push");
      return { remoteReference: "refs/heads/zintus/engineer/run-1-1" };
    },
    async createPullRequest(input) {
      config.calls.push("pr");
      config.capturePrBody?.(input.body);
      if (config.createPr) return config.createPr();
      return { id: "pr-1", number: 7, url: "https://github.com/acme/svc/pull/7" };
    },
  };
  if (config.reconcile) {
    service.reconcilePublicationOperation = async () => {
      config.calls.push("reconcile");
      return config.reconcile!();
    };
  }
  return service;
}

function mechanics(config: FakeConfig, contextOverride?: GitPublicationContext | null): GitPublicationMechanics {
  return new GitPublicationMechanics({
    gitService: fakeGit(config),
    resolveRepository: (repositoryId) => (repositoryId === REPO_ID ? REPO : null),
    resolvePublicationContext: () => (contextOverride === undefined ? CONTEXT : contextOverride),
  });
}

// --- Real PublicationAuthorityService seeding (mirrors publication-authority.test.ts) ---

function scratchDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(AT);
  migrateEngineerDatabase(db, AT);
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?,?,?)").run(USER_ID, AT, AT);
  db.query(`INSERT INTO repository_connections(id, user_id, provider, owner, name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(REPO_ID, USER_ID, "local", "acme", "svc", AT, AT);
  db.query(`INSERT INTO engineer_runs(id, user_id, repository_id, base_branch, base_commit_sha,
    request_original, state, risk_tier, human_gate_required, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      RUN_ID, USER_ID, REPO_ID, "main", BASE_COMMIT, "do the thing", "REVIEW_APPROVED", "HIGH", 1, AT, AT);
  return db;
}

let counter = 0;
const nextId = () => `id-${(counter += 1)}`;

/** Seed an approved ORIGINAL candidate so startPublication reaches preflight. */
function seedApproved(db: Database): void {
  const seeding = new PublicationAuthorityService(db, {
    actuator: { async createBranchPr() { return { kind: "FAILED", detail: "unused" }; } },
    preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
    credentialProvider: { getPublicationCredentials: () => CREDS },
    now: () => new Date(AT),
    idFactory: nextId,
  });
  void seeding.selectCandidate({
    runId: RUN_ID, candidateRunId: RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
    checkpointId: CK_ID, checkpointHash: CK_HASH, resultCommitSha: RESULT_COMMIT, lineage: "ORIGINAL", parentSelectionId: null,
  });
  seeding.approve(CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION }, CTX);
}

/** Build a real service whose preflight is the mechanics preflight over a fake git. */
function serviceWithMechanicsPreflight(db: Database, config: FakeConfig): PublicationAuthorityService {
  const mech = mechanics(config);
  return new PublicationAuthorityService(db, {
    actuator: { async createBranchPr() { return { kind: "FAILED", detail: "not dispatched in preflight test" }; } },
    preflight: mech.preflightProbe,
    credentialProvider: { getPublicationCredentials: () => CREDS },
    now: () => new Date(AT),
    idFactory: nextId,
  });
}

async function startWith(db: Database, config: FakeConfig): Promise<ReturnType<PublicationAuthorityService["startPublication"]>> {
  const approvalId = (db.query("SELECT approval_id FROM publication_approvals_v33 WHERE revision=0").get() as { approval_id: string }).approval_id;
  const service = serviceWithMechanicsPreflight(db, config);
  return service.startPublication({ runId: RUN_ID, approvalId, operation: "BRANCH_PR", idempotencyKey: "idem-real" });
}

// ---------------------------------------------------------------------------
// Preflight — DRIVEN through the REAL PublicationAuthorityService
// ---------------------------------------------------------------------------

describe("GitPublicationMechanics preflight (driven through real P8 authority)", () => {
  test("the echo stub ACCEPTS an unprotected base (proves the delta the mechanics closes)", async () => {
    const db = scratchDb();
    seedApproved(db);
    const approvalId = (db.query("SELECT approval_id FROM publication_approvals_v33 WHERE revision=0").get() as { approval_id: string }).approval_id;
    // Echo stub = the pre-R5B production preflight. With an UNPROTECTED base it
    // dispatches happily: this is the hole the mechanics preflight closes.
    const echo = new PublicationAuthorityService(db, {
      actuator: { async createBranchPr() { return { kind: "FAILED", detail: "unused" }; } },
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => CREDS },
      now: () => new Date(AT), idFactory: nextId,
    });
    const view = await echo.startPublication({ runId: RUN_ID, approvalId, operation: "BRANCH_PR", idempotencyKey: "idem-echo" });
    expect(view.state).toBe("PREFLIGHT"); // accepted — no protection check at all
  });

  test("REAL preflight REJECTS an unprotected base the echo stub accepted", async () => {
    const db = scratchDb();
    seedApproved(db);
    const config: FakeConfig = {
      calls: [],
      protection: { ...FULL_PROTECTION, protected: false, requiresPullRequestReviews: false, requiredApprovingReviewCount: 0, invalidatesStaleApproval: false, requiresStatusChecks: false, requiresStrictStatusChecks: false, enforcesAdmins: false, blocksForcePushes: false, blocksDeletions: false },
    };
    await expect(startWith(db, config)).rejects.toBeInstanceOf(BranchProtectionInsufficientError);
    const ops = db.query("SELECT COUNT(*) c FROM publication_git_operations_v33").get() as { c: number };
    expect(ops.c).toBe(0); // no publication row was created
  });

  test("REAL preflight REJECTS a base MISSING required reviews (only that control absent)", async () => {
    const db = scratchDb();
    seedApproved(db);
    const config: FakeConfig = {
      calls: [],
      protection: { ...FULL_PROTECTION, requiresPullRequestReviews: false, requiredApprovingReviewCount: 0 },
    };
    let error: unknown;
    await startWith(db, config).catch((caught) => { error = caught; });
    expect(error).toBeInstanceOf(BranchProtectionInsufficientError);
    expect((error as BranchProtectionInsufficientError).reasons).toContain("base branch does not require pull request reviews");
  });

  test("REAL preflight blocks a STALE base (current sha != approval base => PREFLIGHT_MISMATCH)", async () => {
    const db = scratchDb();
    seedApproved(db);
    const config: FakeConfig = { calls: [], currentCommitSha: ADVANCED_COMMIT, protection: FULL_PROTECTION };
    await expect(startWith(db, config)).rejects.toBeInstanceOf(PreflightMismatchError);
    // The approval was invalidated by the stale-base mismatch (fail closed).
    const status = db.query("SELECT status FROM publication_approvals_v33 ORDER BY revision DESC LIMIT 1").get() as { status: string };
    expect(status.status).toBe("INVALIDATED");
  });

  test("REAL preflight ADMITS a fresh, fully-protected base", async () => {
    const db = scratchDb();
    seedApproved(db);
    const view = await startWith(db, { calls: [], currentCommitSha: BASE_COMMIT, protection: FULL_PROTECTION });
    expect(view.state).toBe("PREFLIGHT");
  });

  test("preflight fails closed when the repository cannot be resolved", async () => {
    const mech = new GitPublicationMechanics({
      gitService: fakeGit({ calls: [] }),
      resolveRepository: () => null,
      resolvePublicationContext: () => CONTEXT,
    });
    await expect(mech.preflight({ repositoryId: "missing", baseCommitSha: BASE_COMMIT }))
      .rejects.toBeInstanceOf(PublicationRepositoryUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Rich PR body synthesis
// ---------------------------------------------------------------------------

describe("synthesizePublicationPrBody", () => {
  test("contains criteria, changed files, claims, risk, evidence bundle, and the exact diff", () => {
    const body = synthesizePublicationPrBody(NARRATIVE);
    expect(body).toContain("Risk tier: HIGH");
    expect(body).toContain("Evidence bundle: sha256:dddddddd");
    expect(body).toContain("- refresh retries at most once");
    expect(body).toContain("- no secret is logged");
    expect(body).toContain("- src/auth.ts"); // changed file from the diff
    expect(body).toContain("- [VERIFIED] token refresh is bounded");
    expect(body).toContain("+refreshed = true"); // the exact diff body
    expect(body).toContain("Harden the auth token refresh path");
  });

  test("bounds an enormous diff with an explicit truncation marker", () => {
    const huge = "diff --git a/x b/x\n+++ b/x\n" + "+line\n".repeat(50_000);
    const body = synthesizePublicationPrBody({ ...NARRATIVE, diff: huge }, 1000);
    expect(body).toContain("diff truncated");
    expect(body.length).toBeLessThan(3000);
  });

  test("the actuator publishes the RICH body, not the old simple string", async () => {
    let published: string | null = null;
    const config: FakeConfig = { calls: [], capturePrBody: (body) => { published = body; } };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("RECEIPT");
    expect(published).not.toBeNull();
    // The old actuator body was: `Zintus Engineer verified publication for run ${runId}.`
    expect(published!).not.toBe(`Zintus Engineer verified publication for run ${RUN_ID}.`);
    expect(published!).toContain("### Verified diff");
    expect(published!).toContain("+refreshed = true");
    expect(published!).toContain("Risk tier: HIGH");
  });
});

describe("evaluateBranchProtection", () => {
  test("a fully-protected base is enforced with no reasons", () => {
    expect(evaluateBranchProtection(FULL_PROTECTION)).toEqual({ enforced: true, reasons: [] });
  });
  test("absent evidence fails closed", () => {
    expect(evaluateBranchProtection(undefined).enforced).toBe(false);
  });
  test("names each specific missing control", () => {
    const evaluation = evaluateBranchProtection({ ...FULL_PROTECTION, enforcesAdmins: false, requiresStrictStatusChecks: false });
    expect(evaluation.enforced).toBe(false);
    expect(evaluation.reasons).toContain("base branch protection does not cover administrators");
    expect(evaluation.reasons).toContain("base branch does not require strict (up-to-date) status checks");
  });
});

// ---------------------------------------------------------------------------
// Actuator mechanics: base recheck, existing-PR discovery, reconciliation
// ---------------------------------------------------------------------------

describe("GitPublicationMechanics actuator", () => {
  test("drives branch → push → PR in order and returns a RECEIPT bound to the result commit", async () => {
    const config: FakeConfig = { calls: [] };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(config.calls).toEqual(["inspect", "branch", "push", "pr"]);
    expect(outcome).toEqual({ kind: "RECEIPT", prUrl: "https://github.com/acme/svc/pull/7", commitSha: RESULT_COMMIT });
  });

  test("an unresolvable run context is a definite pre-remote FAILED (no git effect)", async () => {
    const config: FakeConfig = { calls: [] };
    const outcome = await mechanics(config, null).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("FAILED");
    expect(config.calls).toEqual([]);
  });

  test("base-SHA recheck BLOCKS a stale base at mutation time (FAILED, no branch/push/pr)", async () => {
    const config: FakeConfig = { calls: [], currentCommitSha: ADVANCED_COMMIT };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("FAILED");
    if (outcome.kind === "FAILED") expect(outcome.detail).toContain("advanced");
    expect(config.calls).toEqual(["inspect"]); // recheck ran; nothing was written remotely
  });

  test("protection that lapsed by mutation time BLOCKS the effect (FAILED, no branch/push/pr)", async () => {
    const config: FakeConfig = { calls: [], protection: { ...FULL_PROTECTION, enforcesAdmins: false } };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("FAILED");
    expect(config.calls).toEqual(["inspect"]);
  });

  test("existing-PR discovery returns the deterministic PR on re-dispatch (NO duplicate created)", async () => {
    const config: FakeConfig = {
      calls: [],
      reconcile: async () => ({ status: "SUCCEEDED", remoteReference: "https://github.com/acme/svc/pull/7" }),
    };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome).toEqual({ kind: "RECEIPT", prUrl: "https://github.com/acme/svc/pull/7", commitSha: RESULT_COMMIT });
    // reconcile discovered the existing PR before any mutation; branch/push/pr never ran.
    expect(config.calls).toEqual(["inspect", "reconcile"]);
    expect(config.calls).not.toContain("pr");
  });

  test("a throw during PR create RECONCILES to a RECEIPT when the PR actually landed", async () => {
    let reconcileCalls = 0;
    const config: FakeConfig = {
      calls: [],
      createPr: async () => { throw new Error("network partition during PR create"); },
      reconcile: async () => {
        reconcileCalls += 1;
        // First call = pre-create discovery (no PR yet); second = post-throw reconciliation (PR landed).
        return reconcileCalls === 1
          ? { status: "NOT_FOUND", detail: "no PR yet" }
          : { status: "SUCCEEDED", remoteReference: "https://github.com/acme/svc/pull/9" };
      },
    };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome).toEqual({ kind: "RECEIPT", prUrl: "https://github.com/acme/svc/pull/9", commitSha: RESULT_COMMIT });
    expect(reconcileCalls).toBe(2);
  });

  test("a throw with NO reconciled remote PR stays AMBIGUOUS (never auto-redispatch)", async () => {
    const config: FakeConfig = {
      calls: [],
      createPr: async () => { throw new Error("network partition during PR create"); },
      reconcile: async () => ({ status: "NOT_FOUND", detail: "nothing landed" }),
    };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("AMBIGUOUS");
    if (outcome.kind === "AMBIGUOUS") {
      expect(outcome.observedRemoteState).toBe("REMOTE_OUTCOME_UNKNOWN");
      expect(outcome.detail).toContain("network partition");
    }
  });

  test("a throw with no reconcile seam at all stays AMBIGUOUS", async () => {
    const config: FakeConfig = { calls: [], createPr: async () => { throw new Error("boom during PR create"); } };
    const outcome = await mechanics(config).createActuator().createBranchPr(ACTUATOR_INPUT, CREDS);
    expect(outcome.kind).toBe("AMBIGUOUS");
  });
});
