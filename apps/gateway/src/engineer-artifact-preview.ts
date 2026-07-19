import { redactSecrets } from "@zintus/router";
import type { ArtifactRecord, LocalArtifactStore } from "@zintus/engineer";

export const ENGINEER_ARTIFACT_PREVIEW_BYTES = 512 * 1024;

const SAFE_TEXT_TYPES = new Set([
  "BUILDER_RESULT",
  "CANCELLATION_REQUEST",
  "COMMAND_STDERR",
  "COMMAND_STDOUT",
  "CONTEXT_MANIFEST",
  "CORRECTED_RUN_DIRECTIVE",
  "FINAL_DIFF",
  "PLAN_PROPOSAL",
  "SANDBOX_RECOVERY_ATTESTATION",
  "SECURITY_REPORT",
  "VERIFICATION_COVERAGE_MATRIX",
]);

export interface EngineerArtifactPreview {
  artifact: Omit<ArtifactRecord, "storageReference">;
  encoding: "utf8" | "unavailable";
  content: string | null;
  truncated: boolean;
  previewBytes: number;
}

/** Integrity-checks first, then returns a bounded, secret-redacted text preview. */
export function previewEngineerArtifact(
  store: LocalArtifactStore,
  artifact: ArtifactRecord,
  maximumBytes = ENGINEER_ARTIFACT_PREVIEW_BYTES,
  exactBytes = false,
): EngineerArtifactPreview {
  const { storageReference: _privateStorageReference, ...publicArtifact } = artifact;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > ENGINEER_ARTIFACT_PREVIEW_BYTES) {
    throw new TypeError("artifact preview size is outside the trusted limit");
  }
  if (!SAFE_TEXT_TYPES.has(artifact.type)) {
    return { artifact: publicArtifact, encoding: "unavailable", content: null, truncated: false, previewBytes: 0 };
  }
  const verified = exactBytes
    ? { bytes: store.readVerifiedExact(artifact), totalBytes: artifact.sizeBytes }
    : store.readVerifiedPrefix(artifact, maximumBytes);
  const preview = verified.bytes.subarray(0, maximumBytes);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(preview); }
  catch { return { artifact: publicArtifact, encoding: "unavailable", content: null, truncated: false, previewBytes: 0 }; }
  if (content.includes("\0")) {
    return { artifact: publicArtifact, encoding: "unavailable", content: null, truncated: false, previewBytes: 0 };
  }
  return {
    artifact: publicArtifact,
    encoding: "utf8",
    content: redactSecrets(content),
    truncated: verified.totalBytes > preview.byteLength,
    previewBytes: preview.byteLength,
  };
}
