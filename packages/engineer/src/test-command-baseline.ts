import { z } from "zod";
import type { LocalArtifactStore } from "./artifact-store.js";
import type { TaskManifest } from "./contracts.js";
import type { CommandExecutionRecord } from "./execution-contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import type { EngineerSupervisor } from "./supervisor.js";
import type { TrustedCommandExecutor } from "./trusted-executor.js";

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const BaselineEntrySchema = z.object({
  testId: z.string().min(1).max(200),
  command: z.string().min(1).max(1_000),
  status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "SPAWN_FAILED"]),
  failureLabels: z.array(z.string().min(1).max(4_000)).max(20_000),
  outputFingerprint: HashSchema,
}).strict();

const BaselineContentSchema = z.object({
  policyVersion: z.literal("engineer-command-baseline-v1"),
  runId: z.string().min(1).max(200),
  manifestHash: HashSchema,
  entries: z.array(BaselineEntrySchema).max(200),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const TestCommandBaselineSchema = BaselineContentSchema.extend({ baselineHash: HashSchema }).strict()
  .superRefine((value, context) => {
    const { baselineHash, ...content } = value;
    if (sha256(content) !== baselineHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "command baseline hash mismatch", path: ["baselineHash"] });
    const ids = value.entries.map((entry) => entry.testId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "command baseline test IDs must be unique", path: ["entries"] });
  });

export type TestCommandBaseline = z.infer<typeof TestCommandBaselineSchema>;

function outputFor(record: CommandExecutionRecord, store: LocalArtifactStore): string {
  return `${store.read(record.stdoutArtifact).toString("utf8")}\n${store.read(record.stderrArtifact).toString("utf8")}`;
}

/** Stable test-name extraction, deliberately conservative for unrecognised runners. */
export function failureLabels(output: string): string[] {
  const labels = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const bun = line.match(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/);
    if (bun?.[1]) labels.add(bun[1].trim());
    const jest = line.match(/^\s*[✕✖]\s+(.+?)\s*$/);
    if (jest?.[1]) labels.add(jest[1].trim());
  }
  return [...labels].sort();
}

function entry(testId: string, command: string, record: CommandExecutionRecord, store: LocalArtifactStore) {
  const output = outputFor(record, store);
  return BaselineEntrySchema.parse({
    testId, command, status: record.status,
    failureLabels: failureLabels(output),
    outputFingerprint: sha256(output.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[\d+(?:\.\d+)?(?:ms|s)\]/g, "[duration]")),
  });
}

/** Run every frozen command at the pristine base before the first paid Builder dispatch. */
export async function captureTestCommandBaseline(input: {
  supervisor: EngineerSupervisor; artifactStore: LocalArtifactStore; manifest: TaskManifest; executor: TrustedCommandExecutor;
  beforeCommand?: (command: string) => string | Promise<string>; afterCommand?: (command: string, snapshot: string) => void | Promise<void>;
  now?: () => Date;
}): Promise<TestCommandBaseline> {
  const entries = [] as z.infer<typeof BaselineEntrySchema>[];
  for (const item of input.manifest.testPlan) {
    if (!item.command) continue;
    const snapshot = await input.beforeCommand?.(item.command);
    let record: CommandExecutionRecord;
    try {
      record = await input.executor.executeAsync(item.command, `baseline:${input.manifest.manifestHash}:${item.testId}:${sha256(item.command).slice(7, 23)}`);
    } finally {
      if (snapshot !== undefined) await input.afterCommand?.(item.command, snapshot);
    }
    entries.push(entry(item.testId, item.command, record!, input.artifactStore));
  }
  const content = BaselineContentSchema.parse({
    policyVersion: "engineer-command-baseline-v1", runId: input.manifest.runId, manifestHash: input.manifest.manifestHash,
    entries, createdAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const baseline = TestCommandBaselineSchema.parse({ ...content, baselineHash: sha256(content) });
  input.supervisor.recordArtifact(input.artifactStore.put({
    runId: input.manifest.runId, type: "TEST_COMMAND_BASELINE", bytes: canonicalJson(baseline),
    producerType: "SYSTEM", producerId: "verification-command-baseline", trusted: true,
  }));
  return baseline;
}

export function loadTestCommandBaseline(input: { supervisor: EngineerSupervisor; artifactStore: LocalArtifactStore; manifest: TaskManifest }): TestCommandBaseline | null {
  const artifact = input.supervisor.listArtifacts(input.manifest.runId)
    .filter((value) => value.type === "TEST_COMMAND_BASELINE" && value.trusted && value.producerType === "SYSTEM" && value.producerId === "verification-command-baseline").at(-1);
  if (!artifact) return null;
  const baseline = TestCommandBaselineSchema.parse(JSON.parse(input.artifactStore.read(artifact).toString("utf8")));
  if (baseline.runId !== input.manifest.runId || baseline.manifestHash !== input.manifest.manifestHash) throw new Error("command baseline is not bound to the frozen manifest");
  return baseline;
}

/** A failed candidate is inherited only if it introduces no new parseable failure labels. */
export function isInheritedBaselineFailure(input: { baseline?: TestCommandBaseline | null; testId: string; record: CommandExecutionRecord; artifactStore: LocalArtifactStore }): boolean {
  if (input.record.status !== "FAILED" || !input.baseline) return false;
  const base = input.baseline.entries.find((value) => value.testId === input.testId);
  if (!base || base.status !== "FAILED") return false;
  const candidateOutput = outputFor(input.record, input.artifactStore);
  const candidateLabels = failureLabels(candidateOutput);
  if (base.failureLabels.length > 0 && candidateLabels.length > 0) {
    const known = new Set(base.failureLabels);
    return candidateLabels.every((label) => known.has(label));
  }
  const candidateFingerprint = sha256(candidateOutput.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[\d+(?:\.\d+)?(?:ms|s)\]/g, "[duration]"));
  return candidateFingerprint === base.outputFingerprint;
}
