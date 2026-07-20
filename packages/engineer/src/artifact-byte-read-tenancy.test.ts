import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineerNotFoundError } from "./errors.js";
import { sha256 } from "./hash.js";
import { TEST_BASELINE_POLICY_VERSION } from "./test-integrity.js";
import { ContextManifestContentSchema } from "./context-contracts.js";
import { createTwoOrgFixture, type TwoOrgFixture } from "./test-support/two-org-fixture.js";
import type { ArtifactByteReader } from "./ledger.js";

/**
 * R8-5 BK3 (contract §2/§8) — ARTIFACT BYTE-READ tenancy. The breach these tests
 * fence: an artifact byte read does `readFileSync(storage_reference)` keyed by an
 * id/(id,run_id) pair with NO org predicate, so an org-B principal passing an
 * org-A artifactId would fetch the row and READ ANOTHER ORG'S FILE BYTES. The two
 * public methods below fetch + read the artifact BEFORE any run-ownership
 * (`getRun`) gate, so they are the genuinely reachable byte-read breaches.
 *
 * The security property: a cross-org artifactId is byte-indistinguishable from an
 * absent id (IDENTICAL EngineerNotFoundError) and the foreign bytes are NEVER
 * reached. RED (predicate stripped): the foreign case reads the secret bytes
 * (spy fires / integrity Error) — an observable oracle. GREEN: both collapse to
 * the identical not-found and no foreign byte read occurs.
 */
const NOW = "2026-07-20T00:00:00.000Z";

let fixture: TwoOrgFixture;
afterEach(() => { fixture?.cleanup(); });

describe("§8 recordTestIntegrityAttestation — cross-org artifactId never reaches the foreign byte read", () => {
  test("org B passing org A's integrity artifactId throws the IDENTICAL not-found as an absent id and NEVER calls the byte reader", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgAArtifactId = "integrity-artifact-owned-by-org-a";
    const orgARunId = "run-owned-by-org-a";
    const secretPath = join(fixture.root, "org-a-secret-integrity.json");
    const secretBytes = Buffer.from(JSON.stringify({ secret: "ORG-A-PRIVATE-INTEGRITY-BYTES" }), "utf8");
    writeFileSync(secretPath, secretBytes);

    // Construct org B's ledger BEFORE planting the dangling org-A row.
    const orgB = fixture.ledgerB();

    // Plant a TEST_INTEGRITY_COMPARISON artifact OWNED BY ORG A whose authority
    // fields (trusted SYSTEM supervisor) satisfy the pre-byte-read gate, so a
    // PRE-FIX foreign fetch would proceed to the byte reader.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO artifacts(id, run_id, type, sha256, producer_type, producer_id, storage_reference," +
        " size_bytes, trusted, created_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      orgAArtifactId, orgARunId, "TEST_INTEGRITY_COMPARISON", `sha256:${"0".repeat(64)}`, "SYSTEM",
      "engineer-supervisor-test-integrity", secretPath, secretBytes.byteLength, 1, NOW, fixture.orgAId,
    );
    seed.close();

    // A valid comparison (correct hash) so the schema parse clears and control
    // reaches the artifact fetch. runId targets org A's planted run/artifact.
    const comparisonContent = {
      policyVersion: TEST_BASELINE_POLICY_VERSION, runId: orgARunId, baselineHash: `sha256:${"1".repeat(64)}`,
      stage: "PRE_REVIEW", immutableChanges: [] as string[], authorizedChanges: [] as string[],
      builderAuthoredTests: [] as string[], commandMutationChecks: 0, passed: true, comparedAt: NOW,
    };
    const comparison = { ...comparisonContent, comparisonHash: sha256(comparisonContent) };

    // A byte reader that records whether it was EVER invoked. If org B reaches the
    // foreign byte read, this fires — the breach.
    let byteReaderCalls = 0;
    const spyReader: ArtifactByteReader = () => { byteReaderCalls += 1; return Buffer.from("spy"); };

    let foreignError: unknown;
    try { orgB.recordTestIntegrityAttestation(orgAArtifactId, comparison, undefined, spyReader); }
    catch (error) { foreignError = error; }
    const foreignCalls = byteReaderCalls;

    byteReaderCalls = 0;
    let absentError: unknown;
    try { orgB.recordTestIntegrityAttestation("no-such-artifact", comparison, undefined, spyReader); }
    catch (error) { absentError = error; }
    const absentCalls = byteReaderCalls;

    // The foreign byte read must never happen (the security property).
    expect(foreignCalls).toBe(0);
    expect(absentCalls).toBe(0);
    // Anti-oracle: cross-org id === absent id === IDENTICAL EngineerNotFoundError.
    expect(absentError).toBeInstanceOf(EngineerNotFoundError);
    expect(foreignError).toBeInstanceOf(EngineerNotFoundError);
    expect((foreignError as Error).name).toBe((absentError as Error).name);
    expect((foreignError as EngineerNotFoundError).message.replace(orgAArtifactId, "<id>"))
      .toBe((absentError as EngineerNotFoundError).message.replace("no-such-artifact", "<id>"));
  });
});

describe("§8 recordContextSnapshot — cross-org context artifactId is indistinguishable from absent", () => {
  test("org B referencing org A's CONTEXT_MANIFEST artifact throws the IDENTICAL not-found (never reads the foreign bytes)", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgAArtifactId = "context-artifact-owned-by-org-a";
    const orgARunId = "ctx-run-owned-by-org-a";
    const orgARepositoryId = "repo-owned-by-org-a";
    const orgABaseCommit = "a".repeat(40);
    const secretPath = join(fixture.root, "org-a-secret-context.json");
    const secretBytes = Buffer.from(JSON.stringify({ secret: "ORG-A-PRIVATE-CONTEXT-BYTES" }), "utf8");
    writeFileSync(secretPath, secretBytes);

    const orgB = fixture.ledgerB();

    // Plant a CONTEXT_MANIFEST artifact OWNED BY ORG A with a deliberately-WRONG
    // sha256, pointing at real secret bytes. A PRE-FIX foreign read would
    // readFileSync the secret then throw an integrity Error (bytes reached) —
    // distinguishable from the not-found an absent id yields.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO artifacts(id, run_id, type, sha256, producer_type, producer_id, storage_reference," +
        " size_bytes, trusted, created_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      orgAArtifactId, orgARunId, "CONTEXT_MANIFEST", `sha256:${"0".repeat(64)}`, "SYSTEM",
      "test-context", secretPath, secretBytes.byteLength, 0, NOW, fixture.orgAId,
    );
    seed.close();

    // A valid manifest (correct manifestHash) whose runId targets org A's row, so
    // the schema parse clears and control reaches the org-scoped artifact fetch.
    const content = ContextManifestContentSchema.parse({
      contextVersion: 1, runId: orgARunId, repositoryId: orgARepositoryId, baseCommitSha: orgABaseCommit,
      requestHash: sha256("request"), caps: { maxSourceFiles: 2_000, maxRelevantFiles: 20, maxExcerptChars: 48_000, maxFileBytes: 256 * 1024 },
      filesDiscovered: 0, filesConsidered: 0, symlinksSkipped: 0, oversizedFilesSkipped: 0, binaryFilesSkipped: 0,
      sources: [], detections: { trust: "UNTRUSTED_REPOSITORY_CONTENT", stacks: [], scripts: [], ciCommands: [], configPaths: [], lockfilePaths: [], testPaths: [], ciPaths: [] },
      warnings: [],
    });
    const manifest = { ...content, manifestHash: sha256(content) };
    const foreignSnapshot = { manifest, artifactId: orgAArtifactId, createdAt: NOW };
    const absentSnapshot = { manifest, artifactId: "no-such-artifact", createdAt: NOW };

    let foreignError: unknown;
    try { orgB.recordContextSnapshot(foreignSnapshot, 0); } catch (error) { foreignError = error; }
    let absentError: unknown;
    try { orgB.recordContextSnapshot(absentSnapshot, 0); } catch (error) { absentError = error; }

    expect(absentError).toBeInstanceOf(EngineerNotFoundError);
    expect(foreignError).toBeInstanceOf(EngineerNotFoundError);
    expect((foreignError as Error).name).toBe((absentError as Error).name);
    expect((foreignError as EngineerNotFoundError).message.replace(orgAArtifactId, "<id>"))
      .toBe((absentError as EngineerNotFoundError).message.replace("no-such-artifact", "<id>"));
  });
});
