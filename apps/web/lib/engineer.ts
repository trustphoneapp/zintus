import { GATEWAY_URL, gatewayAuthHeaders } from "./gateway";
import type { EngineerDecisionItem } from "./engineer-decisions";
import { acceptEngineerEvent, parseEngineerSse } from "./engineer-sse";

export type EngineerState = string;
export interface EngineerRun { runId: string; state: EngineerState; stateVersion: number; manifestHash: string | null; riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; humanGateRequired: boolean; requestOriginal: string; requestNormalized: string; repository: EngineerRepository; terminalAt: string | null; }
export interface EngineerRepository { repositoryId: string; provider: "github" | "local"; owner: string; name: string; url?: string; baseBranch: string; baseCommitSha: string; }
export interface EngineerManifest { manifestVersion: number; runId: string; repository: EngineerRepository; request: { original: string; normalized: string }; acceptanceCriteria: Array<{ criterionId: string; statement: string; verificationMethod: string; priority: string }>; testPlan: Array<{ testId: string; criterionIds: string[]; type: string; description: string; command?: string }>; allowedPaths: string[]; deniedPaths: string[]; allowedCommands: string[]; prohibitedCommands: string[]; riskTier: EngineerRun["riskTier"]; humanGateRequired: boolean; retryBudgets: Record<string, number>; timeBudgetSeconds: number; tokenBudget: number; costBudgetUsd: number; createdAt: string; }
export interface PlanProposal { planProposalId: string; runId: string; manifest: EngineerManifest; planningAnalysis: { architectureSummary: string; assumptions: Array<{ assumptionId: string; statement: string; confidence: number; reversible: boolean; sourceRefs: string[] }>; unresolvedQuestions: Array<{ questionId: string; question: string; impact: string }>; touchedFileEstimates: Array<{ path: string; expectedChange: string; confidence: number }> }; proposalHash: string; artifactId: string; createdAt: string; }
export interface RunEvent { eventId: string; sequence: number; previousState: string; nextState: string; reasonCode: string; timestamp: string; evidenceIds: string[]; }
export interface EngineerRunStatus { run: EngineerRun; lastError: string | null; }
export interface EngineerData {
  claims: unknown[];
  evidenceBundles: unknown[];
  tests: unknown[];
  securityFindings: unknown[];
  failures: unknown[];
  gitOperations: unknown[];
  diff: string;
  approval: unknown | null;
  decisions: EngineerDecisionItem[];
  errors: Array<{ section: string; message: string }>;
}
export interface EngineerObservability {
  generatedAt: string; totalRuns: number; activeRuns: number; terminalRuns: number; pendingApprovals: number;
  completedRuns: number; failedRuns: number; successRate: number | null; stuckRuns: number; retryAttempts: number;
  totalInputTokens: number; totalOutputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  estimatedCostUsd: number; averageApprovalLatencySeconds: number | null; evidenceCompleteRuns: number;
  runsByState: Record<string, number>; runsByRisk: Record<string, number>; failuresByClass: Record<string, number>;
  runHealth: Array<{ runId: string; state: string; riskTier: string; ageInStateSeconds: number; stuck: boolean; retryAttempts: number; failureCount: number }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...gatewayAuthHeaders(), ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message ?? `Engineer request failed (${response.status})`);
  return body as T;
}

export async function createEngineerRun(input: { repository: EngineerRepository; request: string }): Promise<EngineerRun> {
  return (await request<{ run: EngineerRun }>("/v1/engineer/runs", { method: "POST", body: JSON.stringify(input) })).run;
}
export async function getEngineerRepository(): Promise<EngineerRepository> { return (await request<{ repository: EngineerRepository }>("/v1/engineer/repository")).repository; }
export async function getEngineerObservability(): Promise<EngineerObservability> { return (await request<{ snapshot: EngineerObservability }>("/v1/engineer/observability")).snapshot; }
export async function planEngineerRun(runId: string): Promise<PlanProposal> { return (await request<{ plan: PlanProposal }>(`/v1/engineer/runs/${runId}/plan`, { method: "POST" })).plan; }
export async function getEngineerPlan(runId: string): Promise<PlanProposal | null> { return (await request<{ plan: PlanProposal | null }>(`/v1/engineer/runs/${runId}/plan`)).plan; }
export async function freezeEngineerPlan(run: EngineerRun, manifest: EngineerManifest): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${run.runId}/freeze-plan`, { method: "POST", body: JSON.stringify({ expectedStateVersion: run.stateVersion, manifest, idempotencyKey: `ui:freeze:${run.runId}:${manifest.manifestVersion}` }) })).run; }
export async function startEngineerRun(runId: string): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${runId}/start`, { method: "POST" })).run; }
export async function recoverEngineerStaleBase(runId: string): Promise<EngineerRun> { return (await request<{ replacementRun: EngineerRun }>(`/v1/engineer/runs/${runId}/recover-stale-base`, { method: "POST" })).replacementRun; }
export async function getEngineerRunStatus(runId: string): Promise<EngineerRunStatus> { return request<EngineerRunStatus>(`/v1/engineer/runs/${runId}`); }
export async function getEngineerRun(runId: string): Promise<EngineerRun> { return (await getEngineerRunStatus(runId)).run; }
export async function listEngineerRuns(): Promise<EngineerRun[]> { return (await request<{ runs: EngineerRun[] }>("/v1/engineer/runs")).runs; }
export async function getEngineerEvidenceExport(runId: string): Promise<Record<string, unknown>> { return request<Record<string, unknown>>(`/v1/engineer/runs/${runId}/evidence-export`); }
export async function getEngineerData(runId: string): Promise<EngineerData> {
  const load = async <T>(section: string, promise: Promise<T>, fallback: T) => {
    try { return { data: await promise, error: null }; }
    catch (error) { return { data: fallback, error: { section, message: error instanceof Error ? error.message : String(error) } }; }
  };
  const results = await Promise.all([
    load("claims", request<{ claims: unknown[] }>(`/v1/engineer/runs/${runId}/claims`), { claims: [] }),
    load("evidence", request<{ evidenceBundles: unknown[] }>(`/v1/engineer/runs/${runId}/evidence`), { evidenceBundles: [] }),
    load("tests", request<{ tests: unknown[] }>(`/v1/engineer/runs/${runId}/tests`), { tests: [] }),
    load("security", request<{ securityFindings: unknown[] }>(`/v1/engineer/runs/${runId}/security`), { securityFindings: [] }),
    load("failures", request<{ failures: unknown[] }>(`/v1/engineer/runs/${runId}/failures`), { failures: [] }),
    load("publication", request<{ gitOperations: unknown[] }>(`/v1/engineer/runs/${runId}/git-operations`), { gitOperations: [] }),
    load("diff", request<{ diff: string }>(`/v1/engineer/runs/${runId}/diff`), { diff: "" }),
    load("approval", request<{ approval: unknown | null }>(`/v1/engineer/runs/${runId}/approval`), { approval: null }),
    load("decisions", request<{ decisions: EngineerDecisionItem[] }>(`/v1/engineer/runs/${runId}/decisions`), { decisions: [] }),
  ]);
  return {
    ...results[0].data, ...results[1].data, ...results[2].data, ...results[3].data,
    ...results[4].data, ...results[5].data, ...results[6].data, ...results[7].data, ...results[8].data,
    errors: results.flatMap((result) => result.error ? [result.error] : []),
  };
}
export async function engineerDecision(runId: string, action: "approve" | "request-changes" | "reject" | "cancel", reason: string): Promise<void> { await request(`/v1/engineer/runs/${runId}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }); }
export async function extendEngineerApproval(runId: string, reason: string, extensionSeconds = 86_400): Promise<void> { await request(`/v1/engineer/runs/${runId}/extend-approval`, { method: "POST", body: JSON.stringify({ reason, extensionSeconds }) }); }
export async function resolveEngineerDecision(run: EngineerRun, decisionId: string, selectedOptionId: string, rationale: string): Promise<{ plan: PlanProposal | null; planningError: string | null }> {
  return request(`/v1/engineer/runs/${run.runId}/decisions/${decisionId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      expectedStateVersion: run.stateVersion,
      selectedOptionId,
      rationale,
      idempotencyKey: `ui:decision:${decisionId}:${run.stateVersion}`,
    }),
  });
}

export async function streamEngineerEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
  options: { afterSequence?: number; onCursor?: (sequence: number) => void; maxReconnects?: number; reconnectDelayMs?: number } = {},
): Promise<void> {
  let cursor = options.afterSequence ?? 0;
  let reconnects = 0;
  let retryMs = options.reconnectDelayMs ?? 1_000;
  const maximum = options.maxReconnects ?? 5;
  const terminalStates = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "HUMAN_REVIEW_REQUIRED", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
  while (!signal.aborted) {
    let receivedEvent = false;
    try {
      const response = await fetch(`${GATEWAY_URL}/v1/engineer/runs/${runId}/events?afterSequence=${cursor}`, { headers: { ...gatewayAuthHeaders(), ...(cursor ? { "Last-Event-ID": String(cursor) } : {}) }, signal });
      if (!response.ok || !response.body) throw new Error("Engineer event stream is unavailable");
      const reviewApprovedIsTerminal = response.headers.get("X-Zintus-Engineer-Review-Approved-Terminal") === "true";
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEngineerSse(buffer); buffer = parsed.remainder;
        if (parsed.retryMs !== null) retryMs = parsed.retryMs;
        for (const item of parsed.events) {
          const disposition = acceptEngineerEvent(cursor, item.id);
          if (disposition === "DUPLICATE") continue;
          if (disposition === "GAP") throw new Error(`Engineer event sequence gap after ${cursor}`);
          cursor = item.id; options.onCursor?.(cursor); onEvent(item.event);
          receivedEvent = true;
        }
      }
      } finally { reader.releaseLock(); }
      if (receivedEvent) reconnects = 0;
      const status = await getEngineerRunStatus(runId).catch(() => null);
      if (status && (terminalStates.has(status.run.state) || (reviewApprovedIsTerminal && status.run.state === "REVIEW_APPROVED"))) return;
    } catch (error) {
      if (signal.aborted) return;
      if (reconnects >= maximum) throw error;
    }
    if (signal.aborted) return;
    if (reconnects >= maximum) throw new Error("Engineer event stream reconnect budget exhausted");
    reconnects += 1;
    await new Promise<void>((resolve, reject) => {
      const delay = Math.min(10_000, retryMs * 2 ** (reconnects - 1));
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
