import { z } from "zod";
import type { TaskManifest } from "./contracts.js";
import { sha256 } from "./hash.js";
import { isManifestPathAllowed } from "./manifest-files.js";
import { extractChangedPaths } from "./post-verification-risk.js";

export const FINAL_CHANGE_SCOPE_POLICY_VERSION = "final-change-scope-v1" as const;

export const FinalChangeScopeAttestationSchema = z.object({
  policyVersion: z.literal(FINAL_CHANGE_SCOPE_POLICY_VERSION),
  runId: z.string().min(1).max(200),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  diffHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resultCommitSha: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
  changedPaths: z.array(z.string().min(1).max(2_000)),
  allowedPaths: z.array(z.string().min(1).max(2_000)),
  deniedPaths: z.array(z.string().min(1).max(2_000)),
  criterionIds: z.array(z.string().min(1).max(200)),
  credentialedGitOperationCount: z.number().int().nonnegative(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  violations: z.array(z.string().min(1).max(2_000)),
}).strict();

export type FinalChangeScopeAttestation = z.infer<typeof FinalChangeScopeAttestationSchema>;

export function scopeCriterionIds(manifest: TaskManifest): string[] {
  return manifest.acceptanceCriteria
    .filter((criterion) => {
      const text = `${criterion.statement}\n${criterion.verificationMethod}`.toLowerCase();
      return /\b(?:only|allowed|authorized|approved|scope)\b/.test(text)
        && /\b(?:path|file|change|diff|lockfile|dependency|config(?:uration)?|publication|commit|push|deploy(?:ment)?)\b/.test(text);
    })
    .map((criterion) => criterion.criterionId);
}

/**
 * Scope criteria that the final change-scope attestation can prove on its own.
 *
 * `scopeCriterionIds` deliberately remains broad because an attestation should
 * record every acceptance criterion it may help inform. Coverage is stricter:
 * a requirement replaces an executable test only when its verification method
 * explicitly inspects the final diff or changed-file list. This prevents a
 * functional requirement that merely mentions "scope" from bypassing tests.
 */
export function deterministicScopeCriterionIds(manifest: TaskManifest): string[] {
  return manifest.acceptanceCriteria
    .filter((criterion) => {
      const verificationMethod = criterion.verificationMethod.toLowerCase();
      const checksFinalArtifact = /\bfinal\b/.test(verificationMethod)
        && /\b(?:diff|change set|changed[- ]file(?:s)?|changed paths?|file list|path list)\b/.test(verificationMethod);
      // Authority wording may be in the criterion statement ("Only X may
      // change") while the verification method names the final artifact to
      // inspect. Require the latter, then accept equivalent frozen-scope terms
      // from either field. In particular, planners commonly say "permitted
      // paths" rather than "approved paths".
      const authorityText = `${criterion.statement}\n${verificationMethod}`;
      const checksAuthority = /\b(?:only|exactly|allowed|authorized|approved|permitted|scope)\b/.test(authorityText);
      return checksFinalArtifact && checksAuthority;
    })
    .map((criterion) => criterion.criterionId);
}

export function buildFinalChangeScopeAttestation(input: {
  manifest: TaskManifest;
  diff: string;
  resultCommitSha: string;
  credentialedGitOperationCount: number;
}): FinalChangeScopeAttestation {
  const { paths, unresolved } = extractChangedPaths(input.diff);
  // Fail closed on indeterminate scope: an unparseable `diff --git` header (e.g.
  // an unquoted path with spaces and no body markers) means we cannot prove the
  // touched paths, so the run is a scope violation regardless of the manifest —
  // even a permissive `**` allowlist cannot promote past an unparseable diff.
  const unparseableViolations = unresolved.map((header) => `unparseable diff header (scope indeterminate): ${header}`);
  const scopeViolations = paths.filter((path) => !isManifestPathAllowed(path, input.manifest));
  const violations = [...unparseableViolations, ...scopeViolations];
  const changedPaths = [...new Set([...paths, ...unresolved])].sort();
  return FinalChangeScopeAttestationSchema.parse({
    policyVersion: FINAL_CHANGE_SCOPE_POLICY_VERSION,
    runId: input.manifest.runId,
    manifestHash: input.manifest.manifestHash,
    diffHash: sha256(input.diff),
    resultCommitSha: input.resultCommitSha,
    changedPaths,
    allowedPaths: [...input.manifest.allowedPaths],
    deniedPaths: [...input.manifest.deniedPaths],
    criterionIds: scopeCriterionIds(input.manifest),
    credentialedGitOperationCount: input.credentialedGitOperationCount,
    status: violations.length === 0 ? "SUCCEEDED" : "FAILED",
    violations,
  });
}
