import { z } from "zod";
import type { FailureRecord } from "./control-contracts.js";
import { countResponseInputTokens, type ResponsesTransport } from "./codex-builder.js";
import { providerPromptCacheKey, sha256 } from "./hash.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";

export const LUNA_FAILURE_ADVISOR_POLICY_VERSION = "engineer-luna-failure-advisor-v1";

export const LunaFailureAdvisorySchema = z.object({
  humanSummary: z.string().min(1).max(2_000),
  suspectedCause: z.string().min(1).max(2_000),
  recommendedAction: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
}).strict();

const FunctionCallSchema = z.object({
  type: z.literal("function_call"),
  name: z.literal("submit_failure_advisory"),
  arguments: z.string(),
}).passthrough();

const ADVISORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["humanSummary", "suspectedCause", "recommendedAction", "confidence"],
  properties: {
    humanSummary: { type: "string" },
    suspectedCause: { type: "string" },
    recommendedAction: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export interface LunaFailureAdvisorOptions {
  transport: ResponsesTransport;
  modelConfiguration?: EngineerModelConfiguration;
  safetyIdentifier?: string;
  reserveModelCall?: (input: { model: string; inputTokenUpperBound: number; maxOutputTokens: number }) => string;
  onModelCall?: (input: {
    responseId: string;
    inputHash: string;
    cacheKey: string;
    reservationId?: string;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
  }) => void;
}

/** Cheap, bounded, non-authoritative triage after deterministic classification. */
export class LunaFailureAdvisor {
  constructor(private readonly options: LunaFailureAdvisorOptions) {}

  async advise(input: {
    runId: string;
    manifestHash: string;
    failureClass: FailureRecord["failureClass"];
    reasonCode: string;
    evidenceIds: string[];
    details: Record<string, unknown>;
  }) {
    const route = resolveEngineerModel("FAILURE_CLASSIFIER", this.options.modelConfiguration);
    const inputHash = sha256(input);
    const cacheKey = sha256({
      role: "FAILURE_CLASSIFIER",
      model: route.model,
      policyVersion: LUNA_FAILURE_ADVISOR_POLICY_VERSION,
      manifestHash: input.manifestHash,
      reasonCode: input.reasonCode,
    });
    const maxOutputTokens = 1_500;
    const request = {
      model: route.model,
      instructions: [
        `Zintus failure triage advisor (${LUNA_FAILURE_ADVISOR_POLICY_VERSION}).`,
        "The supplied deterministic classification is final. Summarize likely cause and the smallest safe next action.",
        "Do not claim verification, change workflow state, or recommend weakening/removing a test or security gate.",
      ].join("\n"),
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
      tools: [{
        type: "function", name: "submit_failure_advisory", strict: true,
        description: "Submit bounded human-readable failure triage.", parameters: ADVISORY_SCHEMA,
      }],
      tool_choice: { type: "function", name: "submit_failure_advisory" },
      parallel_tool_calls: false,
      reasoning: { effort: "low", summary: "auto" },
      max_output_tokens: maxOutputTokens,
      store: false,
      prompt_cache_key: providerPromptCacheKey(cacheKey),
      safety_identifier: this.options.safetyIdentifier ?? sha256(input.runId),
      metadata: { run_id: input.runId, role: "failure_classifier", policy_version: LUNA_FAILURE_ADVISOR_POLICY_VERSION },
    };
    const inputTokenCount = await countResponseInputTokens(this.options.transport, request);
    const reservationId = this.options.reserveModelCall?.({
      model: route.model,
      inputTokenUpperBound: inputTokenCount,
      maxOutputTokens,
    });
    const started = Date.now();
    const response = await this.options.transport.create(request);
    this.options.onModelCall?.({
      responseId: response.id,
      inputHash,
      cacheKey,
      reservationId,
      latencyMs: Math.max(0, Date.now() - started),
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteInputTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    });
    const calls = response.output.filter((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "function_call");
    if (calls.length !== 1) throw new Error("LUNA failure advisor must submit exactly one structured advisory");
    const call = FunctionCallSchema.parse(calls[0]);
    return LunaFailureAdvisorySchema.parse(JSON.parse(call.arguments));
  }
}
