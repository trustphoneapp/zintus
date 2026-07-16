import { z } from "zod";
import type { TaskManifest, TrustedEvidence } from "./contracts.js";
import { countResponseInputTokens, type ResponsesTransport } from "./codex-builder.js";
import { providerPromptCacheKey, sha256 } from "./hash.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";

export const TERRA_ADVISOR_POLICY_VERSION = "engineer-terra-advisors-v2";

export const AdversarialTestGapSchema = z.object({
  gapId: z.string().min(1).max(200),
  criterionIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  invariant: z.string().min(1).max(500),
  counterexample: z.string().min(1).max(1_000),
  expectedObservation: z.string().min(1).max(500),
  recommendedTest: z.string().min(1).max(1_000),
}).strict();

export const TestAdvisorySchema = z.object({
  uncoveredCriterionIds: z.array(z.string().min(1).max(200)).max(20),
  warnings: z.array(z.string().min(1).max(10_000)).max(20),
  adversarialGaps: z.array(AdversarialTestGapSchema).max(4),
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
  type: "object", additionalProperties: false, required: ["uncoveredCriterionIds", "warnings", "adversarialGaps"],
  properties: {
    uncoveredCriterionIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 } },
    warnings: { type: "array", maxItems: 20, items: { type: "string", maxLength: 10_000 } },
    adversarialGaps: {
      type: "array", maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["gapId", "criterionIds", "invariant", "counterexample", "expectedObservation", "recommendedTest"],
        properties: {
          gapId: { type: "string", maxLength: 200 },
          criterionIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 200 } },
          invariant: { type: "string", maxLength: 500 },
          counterexample: { type: "string", maxLength: 1_000 },
          expectedObservation: { type: "string", maxLength: 500 },
          recommendedTest: { type: "string", maxLength: 1_000 },
        },
      },
    },
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
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reservationId?: string;
    retryCount: number;
  }) => void;
  safetyIdentifier?: string;
  reserveModelCall?: (input: { role: "TESTER" | "SECURITY"; model: string; inputTokenUpperBound: number; maxOutputTokens: number; attempt: number }) => string;
  authorizeModelRetry?: (input: {
    role: "TESTER" | "SECURITY";
    attempt: number;
    failedAttempt: number;
    error: unknown;
    inputHash: string;
    cacheKey: string;
    reservationId?: string;
    latencyMs: number;
  }) => boolean;
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
    }, [
      "Identify uncovered acceptance criteria and missing adversarial verification.",
      "Return a bounded adversarialGaps entry for every concrete behavioral risk that the supplied executor evidence does not distinguish.",
      "Each gap must state an invariant, a minimal counterexample, the expected observable result, and a regression test recommendation.",
      "Pay special attention to cooperative cancellation, executors that ignore abort signals, late settlement, timeouts, concurrency-slot accounting, dependency failure propagation, boundary values, and races when those concepts appear in the contract or diff.",
      "Do not invent criterion IDs, propose scope outside the frozen manifest, include executable code, or decide workflow state.",
    ].join(" "));
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
    const instructions = `Zintus Engineer ${role} advisory (${TERRA_ADVISOR_POLICY_VERSION}). ${task}`;
    const maxOutputTokens = 4_000;
    const transport = await this.options.transportForRole(role);
    const request = {
      model: route.model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(dynamicInput) }] }],
      tools: [{ type: "function", name: toolName, description: task, strict: true, parameters }],
      tool_choice: { type: "function", name: toolName },
      parallel_tool_calls: false,
      reasoning: { effort: "medium", summary: "auto" },
      max_output_tokens: maxOutputTokens,
      store: false,
      prompt_cache_key: providerPromptCacheKey(cacheKey),
      safety_identifier: this.options.safetyIdentifier ?? sha256((dynamicInput as { manifest: TaskManifest }).manifest.runId),
      metadata: { role: role.toLowerCase(), policy_version: TERRA_ADVISOR_POLICY_VERSION },
    };
    const inputTokenCount = await countResponseInputTokens(transport, request);
    let attempt = 0;
    let reservationId: string | undefined;
    let response: Awaited<ReturnType<typeof transport.create>>;
    while (true) {
      reservationId = this.options.reserveModelCall?.({
        role, model: route.model,
        inputTokenUpperBound: inputTokenCount,
        maxOutputTokens, attempt,
      });
      const attemptStarted = Date.now();
      try {
        response = await transport.create(request);
        break;
      } catch (error) {
        if (!this.options.authorizeModelRetry?.({
          role, attempt: attempt + 1, failedAttempt: attempt, error, inputHash, cacheKey, reservationId,
          latencyMs: Math.max(0, Date.now() - attemptStarted),
        })) throw error;
        attempt += 1;
      }
    }
    this.options.onModelCall?.({
      role,
      responseId: response.id,
      inputHash,
      cacheKey,
      latencyMs: Math.max(0, Date.now() - started),
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteInputTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
      reservationId,
      retryCount: attempt,
    });
    const rawCalls = response.output.filter((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "function_call");
    if (rawCalls.length !== 1) throw new Error(`${role} must submit exactly one structured advisory call`);
    const call = FunctionCallSchema.parse(rawCalls[0]);
    if (call.name !== toolName) throw new Error(`${role} submitted an unexpected advisory tool`);
    return outputSchema.parse(JSON.parse(call.arguments));
  }
}
