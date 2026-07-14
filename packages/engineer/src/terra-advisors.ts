import { z } from "zod";
import type { TaskManifest, TrustedEvidence } from "./contracts.js";
import type { ResponsesTransport } from "./codex-builder.js";
import { sha256 } from "./hash.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";

export const TERRA_ADVISOR_POLICY_VERSION = "engineer-terra-advisors-v1";

export const TestAdvisorySchema = z.object({
  uncoveredCriterionIds: z.array(z.string().min(1).max(200)),
  warnings: z.array(z.string().min(1).max(10_000)),
}).strict();

export const SecurityAdvisorySchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    category: z.string().min(1).max(200),
    description: z.string().min(1).max(10_000),
    file: z.string().max(2_000),
    lineStart: z.number().int().nonnegative(),
    lineEnd: z.number().int().nonnegative(),
    criterionIds: z.array(z.string().min(1).max(200)),
  }).strict()),
}).strict();

export type TestAdvisory = z.infer<typeof TestAdvisorySchema>;
export type SecurityAdvisory = z.infer<typeof SecurityAdvisorySchema>;

const FunctionCallSchema = z.object({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(),
}).passthrough();

const TEST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["uncoveredCriterionIds", "warnings"],
  properties: {
    uncoveredCriterionIds: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

const SECURITY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "category", "description", "file", "lineStart", "lineEnd", "criterionIds"],
        properties: {
          severity: { type: "string", enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          category: { type: "string" }, description: { type: "string" }, file: { type: "string" },
          lineStart: { type: "integer", minimum: 0 }, lineEnd: { type: "integer", minimum: 0 },
          criterionIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface TerraAdvisoryOptions {
  transportForRole: (role: "TESTER" | "SECURITY") => ResponsesTransport | Promise<ResponsesTransport>;
  modelConfiguration?: EngineerModelConfiguration;
  onModelCall?: (observation: {
    role: "TESTER" | "SECURITY";
    responseId: string;
    inputHash: string;
    cacheKey: string;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
  }) => void;
}

/** Terra supplies bounded advisory analysis; objective tools and the Supervisor remain authoritative. */
export class TerraAdvisors {
  private readonly options: TerraAdvisoryOptions;

  constructor(options: TerraAdvisoryOptions) {
    this.options = options;
  }

  testCoverage(manifest: TaskManifest, diff: string, evidence: TrustedEvidence[]): Promise<TestAdvisory> {
    return this.call("TESTER", "submit_test_advisory", TEST_SCHEMA, TestAdvisorySchema, {
      manifest,
      diff,
      trustedVerificationEvidence: evidence.filter((item) => item.eventType === "INDEPENDENT_VERIFICATION"),
    }, "Identify uncovered acceptance criteria and missing adversarial verification. Do not decide workflow state.");
  }

  security(manifest: TaskManifest, diff: string): Promise<SecurityAdvisory> {
    return this.call("SECURITY", "submit_security_advisory", SECURITY_SCHEMA, SecurityAdvisorySchema, {
      manifest,
      diff,
    }, "Review the diff for security and authorization defects. Never quote suspected secret values. Do not decide workflow state.");
  }

  private async call<T>(
    role: "TESTER" | "SECURITY",
    toolName: string,
    parameters: Record<string, unknown>,
    outputSchema: z.ZodType<T>,
    dynamicInput: unknown,
    task: string,
  ): Promise<T> {
    const route = resolveEngineerModel(role, this.options.modelConfiguration);
    const inputHash = sha256(dynamicInput);
    const cacheKey = sha256({
      role,
      tier: route.logicalTier,
      model: route.model,
      policyVersion: TERRA_ADVISOR_POLICY_VERSION,
      manifestHash: (dynamicInput as { manifest: TaskManifest }).manifest.manifestHash,
    });
    const started = Date.now();
    const response = await (await this.options.transportForRole(role)).create({
      model: route.model,
      instructions: `Zintus Engineer ${role} advisory (${TERRA_ADVISOR_POLICY_VERSION}). ${task}`,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(dynamicInput) }] }],
      tools: [{ type: "function", name: toolName, description: task, strict: true, parameters }],
      tool_choice: { type: "function", name: toolName },
      parallel_tool_calls: false,
      reasoning: { effort: "medium", summary: "auto" },
      max_output_tokens: 4_000,
      store: false,
      safety_identifier: sha256((dynamicInput as { manifest: TaskManifest }).manifest.runId),
      metadata: { role: role.toLowerCase(), policy_version: TERRA_ADVISOR_POLICY_VERSION },
    });
    const call = response.output.map((item) => FunctionCallSchema.safeParse(item))
      .find((item) => item.success && item.data.name === toolName);
    if (!call?.success) throw new Error(`${role} did not submit its structured advisory`);
    this.options.onModelCall?.({
      role,
      responseId: response.id,
      inputHash,
      cacheKey,
      latencyMs: Math.max(0, Date.now() - started),
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    });
    return outputSchema.parse(JSON.parse(call.data.arguments));
  }
}
