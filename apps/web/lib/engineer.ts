import { GATEWAY_URL, gatewayAuthHeaders } from "./gateway";
import type { EngineerDecisionItem } from "./engineer-decisions";
import { acceptEngineerEvent, parseEngineerSse } from "./engineer-sse";

export type EngineerState = string;
export interface EngineerRun { runId: string; state: EngineerState; stateVersion: number; manifestHash: string | null; riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; humanGateRequired: boolean; requestOriginal: string; requestNormalized: string; repository: EngineerRepository; terminalAt: string | null; }
export interface EngineerRepository { repositoryId: string; provider: "github" | "local"; owner: string; name: string; url?: string; baseBranch: string; baseCommitSha: string; }
export interface GithubConnectorRepository { id: string; fullName: string; defaultBranch: string; private: boolean; cloneUrl: string; }
export interface EngineerManifest { manifestVersion: number; runId: string; repository: EngineerRepository; request: { original: string; normalized: string }; acceptanceCriteria: Array<{ criterionId: string; statement: string; verificationMethod: string; priority: string }>; testPlan: Array<{ testId: string; criterionIds: string[]; type: string; description: string; command?: string }>; allowedPaths: string[]; deniedPaths: string[]; allowedCommands: string[]; prohibitedCommands: string[]; riskTier: EngineerRun["riskTier"]; humanGateRequired: boolean; retryBudgets: Record<string, number>; timeBudgetSeconds: number; tokenBudget: number; costBudgetUsd: number; createdAt: string; }
export interface PlanProposal { planProposalId: string; runId: string; manifest: EngineerManifest; planningAnalysis: { architectureSummary: string; assumptions: Array<{ assumptionId: string; statement: string; confidence: number; reversible: boolean; sourceRefs: string[] }>; unresolvedQuestions: Array<{ questionId: string; question: string; impact: string }>; touchedFileEstimates: Array<{ path: string; expectedChange: string; confidence: number }> }; proposalHash: string; artifactId: string; createdAt: string; }
export interface RunEvent { eventId: string; sequence: number; previousState: string; nextState: string; reasonCode: string; timestamp: string; evidenceIds: string[]; }
export interface EngineerRunStatus {
  run: EngineerRun;
  lastError: string | null;
  activity: { active: boolean; role: "PLANNER" | "BUILDER" | "VERIFIER" | null; detail: string };
}
export interface EngineerBudgetAmounts { costUsd: number; tokens: number; timeSeconds: number; }
export interface EngineerBudgetLimits { costBudgetUsd: number; tokenBudget: number; timeBudgetSeconds: number; }
export interface EngineerBudgetSnapshot {
  runId: string;
  status: "ACTIVE" | "WARNING" | "PAUSED";
  limits: EngineerBudgetAmounts;
  lifetimeLimits: EngineerBudgetAmounts;
  used: EngineerBudgetAmounts;
  reserved: Omit<EngineerBudgetAmounts, "timeSeconds">;
  remaining: EngineerBudgetAmounts;
  warningThreshold: number;
  pauseReason: "COST_LIMIT_REACHED" | "TOKEN_LIMIT_REACHED" | "TIME_LIMIT_REACHED" | "MODEL_USAGE_UNKNOWN" | null;
  resumeState: string | null;
  revision: number;
  updatedAt: string;
}
export interface EngineerArtifact {
  artifactId: string;
  runId: string;
  type: string;
  sha256: string;
  producerType: "EXECUTOR" | "SYSTEM";
  producerId: string;
  sizeBytes: number;
  trusted: boolean;
  createdAt: string;
}
export interface EngineerArtifactPreview {
  artifact: EngineerArtifact;
  encoding: "utf8" | "unavailable";
  content: string | null;
  truncated: boolean;
  previewBytes: number;
}
export interface EngineerData {
  artifacts: EngineerArtifact[];
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
const RELAY_URL = (process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:8787").replace(/\/$/, "");
async function relayRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${RELAY_URL}${path}`, { ...init, credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Connector request failed (${response.status})`);
  return body as T;
}
export async function getGithubConnector(): Promise<{ configured: boolean; connected: boolean }> { return relayRequest("/api/connectors/github"); }
export async function startGithubConnector(): Promise<string> { return (await relayRequest<{ authorizationUrl: string }>("/api/connectors/github/start", { method: "POST" })).authorizationUrl; }
export async function listGithubConnectorRepositories(): Promise<GithubConnectorRepository[]> { return (await relayRequest<{ repositories: GithubConnectorRepository[] }>("/api/connectors/github/repos")).repositories; }
export async function getGithubBranchCommit(owner: string, repo: string, branch: string): Promise<string> { return (await relayRequest<{ sha: string }>(`/api/connectors/github/commit?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`)).sha; }
export async function disconnectGithubConnector(): Promise<void> { await relayRequest("/api/connectors/github", { method: "DELETE" }); }

export async function createEngineerRun(input: { repository: EngineerRepository; request: string; budget?: EngineerBudgetLimits }): Promise<EngineerRun> {
  return (await request<{ run: EngineerRun }>("/v1/engineer/runs", { method: "POST", body: JSON.stringify(input) })).run;
}
export async function getEngineerRepository(): Promise<EngineerRepository> { return (await request<{ repository: EngineerRepository }>("/v1/engineer/repository")).repository; }
export async function getEngineerObservability(): Promise<EngineerObservability> { return (await request<{ snapshot: EngineerObservability }>("/v1/engineer/observability")).snapshot; }
export async function planEngineerRun(runId: string, signal?: AbortSignal): Promise<PlanProposal> { return (await request<{ plan: PlanProposal }>(`/v1/engineer/runs/${runId}/plan`, { method: "POST", signal })).plan; }
export async function getEngineerPlan(runId: string): Promise<PlanProposal | null> { return (await request<{ plan: PlanProposal | null }>(`/v1/engineer/runs/${runId}/plan`)).plan; }
export async function freezeEngineerPlan(run: EngineerRun, manifest: EngineerManifest): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${run.runId}/freeze-plan`, { method: "POST", body: JSON.stringify({ expectedStateVersion: run.stateVersion, manifest, idempotencyKey: `ui:freeze:${run.runId}:${manifest.manifestVersion}` }) })).run; }
export async function startEngineerRun(runId: string): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${runId}/start`, { method: "POST" })).run; }
export async function retryEngineerProviderTimeout(runId: string): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${runId}/retry-provider-timeout`, { method: "POST" })).run; }
export async function recoverEngineerStaleBase(runId: string): Promise<EngineerRun> { return (await request<{ replacementRun: EngineerRun }>(`/v1/engineer/runs/${runId}/recover-stale-base`, { method: "POST" })).replacementRun; }
export async function createCorrectedEngineerRun(runId: string): Promise<{ replacementRun: EngineerRun; plan: PlanProposal }> {
  return request<{ replacementRun: EngineerRun; plan: PlanProposal }>(`/v1/engineer/runs/${runId}/corrected-run`, { method: "POST" });
}
export async function getEngineerRunStatus(runId: string): Promise<EngineerRunStatus> { return request<EngineerRunStatus>(`/v1/engineer/runs/${runId}`); }
/** Lightweight live projection used between durable SSE events. */
export async function getEngineerLiveSummary(runId: string): Promise<{ status: EngineerRunStatus; budget: EngineerBudgetSnapshot | null }> {
  const [status, budget] = await Promise.all([
    getEngineerRunStatus(runId),
    getEngineerBudget(runId).catch(() => null),
  ]);
  return { status, budget };
}
export async function getEngineerSnapshot(runId: string): Promise<{ status: EngineerRunStatus & { budget: EngineerBudgetSnapshot }; data: EngineerData; events: RunEvent[]; latestEventSequence: number; snapshotFence: { stateVersion: number; eventSequence: number } }> {
  return request(`/v1/engineer/runs/${runId}/snapshot`);
}
export async function getEngineerBudget(runId: string): Promise<EngineerBudgetSnapshot> { return (await request<{ budget: EngineerBudgetSnapshot }>(`/v1/engineer/runs/${runId}/budget`)).budget; }
export async function getEngineerDiff(runId: string): Promise<string> { return (await request<{ diff: string }>(`/v1/engineer/runs/${runId}/diff`)).diff; }
export async function topUpEngineerBudget(runId: string, input: { expectedRevision: number; addCostBudgetUsd: number; addTokenBudget: number; addTimeBudgetSeconds: number }): Promise<EngineerBudgetSnapshot> {
  const idempotencyKey = `ui:budget-top-up:${runId}:${input.expectedRevision}:${input.addCostBudgetUsd}:${input.addTokenBudget}:${input.addTimeBudgetSeconds}`;
  return (await request<{ budget: EngineerBudgetSnapshot }>(`/v1/engineer/runs/${runId}/budget/top-up`, { method: "POST", body: JSON.stringify({ ...input, idempotencyKey }) })).budget;
}
export async function resumeEngineerBudget(runId: string, input: { expectedStateVersion: number; expectedBudgetRevision: number }): Promise<EngineerRun> {
  const idempotencyKey = `ui:budget-resume:${runId}:${input.expectedStateVersion}:${input.expectedBudgetRevision}`;
  return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${runId}/resume-budget`, { method: "POST", body: JSON.stringify({ ...input, idempotencyKey }) })).run;
}
export async function getEngineerRun(runId: string): Promise<EngineerRun> { return (await getEngineerRunStatus(runId)).run; }
export async function listEngineerRunsPage(limit = 20, cursor?: string): Promise<{ runs: EngineerRun[]; nextCursor: string | null }> {
  return request(`/v1/engineer/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
}
/** Compatibility helper: returns the complete owner-scoped run history. */
export async function listEngineerRuns(): Promise<EngineerRun[]> { return (await request<{ runs: EngineerRun[] }>("/v1/engineer/runs")).runs; }
export async function getEngineerEvidenceExport(runId: string): Promise<Record<string, unknown>> { return request<Record<string, unknown>>(`/v1/engineer/runs/${runId}/evidence-export`); }
export async function getEngineerEvidenceStream(runId: string): Promise<Response> {
  const response = await fetch(`${GATEWAY_URL}/v1/engineer/runs/${runId}/evidence-stream`, { cache: "no-store", headers: gatewayAuthHeaders() });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
    throw new Error(typeof body.error === "string" ? body.error : body.error?.message ?? `Evidence stream failed (${response.status})`);
  }
  return response;
}
export async function getEngineerArtifactPreview(runId: string, artifactId: string): Promise<EngineerArtifactPreview> {
  return request<EngineerArtifactPreview>(`/v1/engineer/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`);
}
export async function getEngineerData(runId: string): Promise<EngineerData> {
  const load = async <T>(section: string, promise: Promise<T>, fallback: T) => {
    try { return { data: await promise, error: null }; }
    catch (error) { return { data: fallback, error: { section, message: error instanceof Error ? error.message : String(error) } }; }
  };
  const results = await Promise.all([
    load("artifacts", request<{ artifacts: EngineerArtifact[] }>(`/v1/engineer/runs/${runId}/artifacts`), { artifacts: [] }),
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
    ...results[0].data, ...results[1].data, ...results[2].data, ...results[3].data, ...results[4].data,
    ...results[5].data, ...results[6].data, ...results[7].data, ...results[8].data, ...results[9].data,
    errors: results.flatMap((result) => result.error ? [result.error] : []),
  };
}
export async function engineerDecision(runId: string, action: "approve" | "request-changes" | "reject" | "cancel", reason: string): Promise<void> { await request(`/v1/engineer/runs/${runId}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }); }
export async function resolveHumanEngineerReview(runId: string, decision: "approve" | "reject", reason: string): Promise<void> { await request(`/v1/engineer/runs/${runId}/human-review`, { method: "POST", body: JSON.stringify({ decision, reason }) }); }
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
  const terminalStates = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "PAUSED_BUDGET", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
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
