import { z } from "zod";
import { sha256 } from "./hash.js";

export const CONTEXT_CONTRACT_VERSION = 1 as const;
export const CONTEXT_MAX_SOURCE_FILES = 2_000 as const;
export const CONTEXT_MAX_RELEVANT_FILES = 20 as const;
export const CONTEXT_MAX_EXCERPT_CHARS = 48_000 as const;
export const CONTEXT_DEFAULT_RELEVANT_FILES = 12 as const;
export const CONTEXT_DEFAULT_EXCERPT_CHARS = 24_000 as const;
export const CONTEXT_MAX_FILE_BYTES = 256 * 1024;
export const CONTEXT_MAX_DETECTION_PATHS = 200 as const;
export const CONTEXT_MAX_DETECTED_COMMANDS = 100 as const;

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);

export const RepositoryContextPathSchema = z.string().min(1).max(4_000).superRefine((path, context) => {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context path must be a portable repository-relative path" });
    return;
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] === ".git") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context path contains an unsafe segment" });
  }
});

export const ContextTrustSchema = z.enum([
  "UNTRUSTED_REPOSITORY_CONTENT",
  "TRUSTED_GIT_METADATA",
]);

export const ContextSourceKindSchema = z.enum([
  "SOURCE",
  "TEST",
  "CONFIG",
  "CI",
  "MANIFEST",
  "LOCKFILE",
  "DOCUMENTATION",
  "OTHER",
]);

export const ContextSignalSchema = z.enum([
  "REQUEST_PATH_MATCH",
  "REQUEST_CONTENT_MATCH",
  "STACK_MANIFEST",
  "SCRIPT_DEFINITION",
  "CONFIGURATION",
  "TEST_FILE",
  "CI_CONFIGURATION",
  "LOCKFILE_DETECTED",
  "PROMPT_INJECTION_SENTINEL",
]);

export const ContextWarningCodeSchema = z.enum([
  "SOURCE_FILE_CAP_REACHED",
  "RELEVANT_FILE_CAP_REACHED",
  "EXCERPT_CAP_REACHED",
  "SYMLINK_SKIPPED",
  "OVERSIZED_FILE_SKIPPED",
  "BINARY_FILE_SKIPPED",
  "UNSAFE_PATH_SKIPPED",
  "PROMPT_INJECTION_SUSPECTED",
  "SCRIPT_CAP_REACHED",
  "DETECTION_CAP_REACHED",
]);

export const contextSourceId = (input: {
  runId: string;
  baseCommitSha: string;
  path: string;
  objectId: string;
  contentHash: string;
}): string => `context-source:${sha256({
  runId: input.runId,
  baseCommitSha: input.baseCommitSha,
  path: input.path,
  objectId: input.objectId,
  contentHash: input.contentHash,
}).slice("sha256:".length)}`;

export const ContextSourceSchema = z.object({
  sourceId: IdentifierSchema,
  runId: IdentifierSchema,
  path: RepositoryContextPathSchema,
  kind: ContextSourceKindSchema,
  trust: z.literal("UNTRUSTED_REPOSITORY_CONTENT"),
  sourceType: z.literal("GIT_OBJECT"),
  baseCommitSha: ShaSchema,
  objectId: ShaSchema,
  byteSize: z.number().int().nonnegative().max(CONTEXT_MAX_FILE_BYTES),
  contentHash: HashSchema,
  excerptHash: HashSchema,
  excerpt: z.string().max(CONTEXT_MAX_EXCERPT_CHARS),
  excerptTruncated: z.boolean(),
  relevanceScore: z.number().int().nonnegative(),
  signals: z.array(ContextSignalSchema).max(ContextSignalSchema.options.length),
}).strict().superRefine((source, context) => {
  const expected = contextSourceId(source);
  if (source.sourceId !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context source identity hash mismatch", path: ["sourceId"] });
  }
  if (sha256(source.excerpt) !== source.contentHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context source content binding mismatch", path: ["contentHash"] });
  }
  if (sha256(source.excerpt) !== source.excerptHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context excerpt hash mismatch", path: ["excerptHash"] });
  }
});

export const ContextWarningSchema = z.object({
  warningId: IdentifierSchema,
  runId: IdentifierSchema,
  code: ContextWarningCodeSchema,
  path: RepositoryContextPathSchema.nullable(),
  sourceId: IdentifierSchema.nullable(),
  trust: ContextTrustSchema,
  message: z.string().min(1).max(1_000),
}).strict();

export const ContextScriptSchema = z.object({
  path: RepositoryContextPathSchema,
  name: z.string().min(1).max(200),
  command: z.string().min(1).max(4_000),
  trust: z.literal("UNTRUSTED_REPOSITORY_CONTENT"),
}).strict();

export const ContextDetectionsSchema = z.object({
  trust: z.literal("UNTRUSTED_REPOSITORY_CONTENT"),
  stacks: z.array(z.string().min(1).max(100)).max(100),
  scripts: z.array(ContextScriptSchema).max(CONTEXT_MAX_DETECTED_COMMANDS),
  ciCommands: z.array(ContextScriptSchema).max(CONTEXT_MAX_DETECTED_COMMANDS),
  configPaths: z.array(RepositoryContextPathSchema).max(CONTEXT_MAX_DETECTION_PATHS),
  lockfilePaths: z.array(RepositoryContextPathSchema).max(CONTEXT_MAX_DETECTION_PATHS),
  testPaths: z.array(RepositoryContextPathSchema).max(CONTEXT_MAX_DETECTION_PATHS),
  ciPaths: z.array(RepositoryContextPathSchema).max(CONTEXT_MAX_DETECTION_PATHS),
}).strict();

export const ContextScanCapsSchema = z.object({
  maxSourceFiles: z.literal(CONTEXT_MAX_SOURCE_FILES),
  maxRelevantFiles: z.number().int().positive().max(CONTEXT_MAX_RELEVANT_FILES),
  maxExcerptChars: z.number().int().positive().max(CONTEXT_MAX_EXCERPT_CHARS),
  maxFileBytes: z.literal(CONTEXT_MAX_FILE_BYTES),
}).strict();

export const ContextManifestContentSchema = z.object({
  contextVersion: z.literal(CONTEXT_CONTRACT_VERSION),
  runId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  baseCommitSha: ShaSchema,
  requestHash: HashSchema,
  caps: ContextScanCapsSchema,
  filesDiscovered: z.number().int().nonnegative(),
  filesConsidered: z.number().int().nonnegative().max(CONTEXT_MAX_SOURCE_FILES),
  symlinksSkipped: z.number().int().nonnegative(),
  oversizedFilesSkipped: z.number().int().nonnegative(),
  binaryFilesSkipped: z.number().int().nonnegative(),
  sources: z.array(ContextSourceSchema).max(CONTEXT_MAX_RELEVANT_FILES),
  detections: ContextDetectionsSchema,
  warnings: z.array(ContextWarningSchema).max(CONTEXT_MAX_SOURCE_FILES + 10),
}).strict().superRefine((manifest, context) => {
  let excerptChars = 0;
  const sourceIds = new Set<string>();
  for (const source of manifest.sources) {
    excerptChars += source.excerpt.length;
    sourceIds.add(source.sourceId);
    if (source.runId !== manifest.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-run context source rejected", path: ["sources"] });
    }
    if (source.baseCommitSha.toLowerCase() !== manifest.baseCommitSha.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "context source base commit mismatch", path: ["sources"] });
    }
  }
  if (excerptChars > CONTEXT_MAX_EXCERPT_CHARS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context excerpt character cap exceeded", path: ["sources"] });
  }
  for (const warning of manifest.warnings) {
    if (warning.runId !== manifest.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-run context warning rejected", path: ["warnings"] });
    }
    if (warning.sourceId && !sourceIds.has(warning.sourceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "context warning references an unknown source", path: ["warnings"] });
    }
  }
});

export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type ContextWarning = z.infer<typeof ContextWarningSchema>;
export type ContextDetections = z.infer<typeof ContextDetectionsSchema>;
export type ContextManifestContent = z.infer<typeof ContextManifestContentSchema>;
export type ContextManifest = ContextManifestContent & { manifestHash: string };

export const ContextManifestSchema: z.ZodType<ContextManifest, z.ZodTypeDef, unknown> = z.object({
  manifestHash: HashSchema,
}).passthrough().superRefine((manifest, context) => {
  const { manifestHash, ...content } = manifest;
  const parsed = ContextManifestContentSchema.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: issue.path });
    return;
  }
  if (sha256(parsed.data) !== manifestHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context manifest hash mismatch", path: ["manifestHash"] });
  }
}).transform((manifest) => {
  const { manifestHash, ...content } = manifest;
  return { ...ContextManifestContentSchema.parse(content), manifestHash };
}) as unknown as z.ZodType<ContextManifest, z.ZodTypeDef, unknown>;

export const StoredContextSnapshotSchema = z.object({
  manifest: ContextManifestSchema,
  artifactId: IdentifierSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type StoredContextSnapshot = z.infer<typeof StoredContextSnapshotSchema>;
