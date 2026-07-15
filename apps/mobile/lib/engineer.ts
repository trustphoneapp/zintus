import { gatewayAuthHeaders } from "@/lib/gateway";
import { getGatewayUrl } from "@/lib/gateway-url";

export interface EngineerRepository { repositoryId: string; provider: "github" | "local"; owner: string; name: string; url?: string; baseBranch: string; baseCommitSha: string; }
export interface EngineerRun { runId: string; state: string; stateVersion: number; riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; requestOriginal: string; requestNormalized: string; repository: EngineerRepository; terminalAt: string | null; }
export interface EngineerDecision { decisionId: string; question: string; status: "OPEN" | "RESOLVED"; recommendedOptionId: string; options: Array<{ optionId: string; label: string; description: string }> }
export interface EngineerMobileData { decisions: EngineerDecision[]; tests: unknown[]; claims: unknown[]; failures: unknown[]; gitOperations: unknown[]; approval: { status?: string; deadlineAt?: string } | null; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getGatewayUrl()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...gatewayAuthHeaders(), ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message ?? `Engineer request failed (${response.status})`);
  return body as T;
}

export async function getEngineerRepository(): Promise<EngineerRepository> { return (await request<{ repository: EngineerRepository }>("/v1/engineer/repository")).repository; }
export async function listEngineerRuns(): Promise<EngineerRun[]> { return (await request<{ runs: EngineerRun[] }>("/v1/engineer/runs")).runs; }
export async function getEngineerRun(runId: string): Promise<EngineerRun> { return (await request<{ run: EngineerRun }>(`/v1/engineer/runs/${runId}`)).run; }
export async function createAndPlanEngineerRun(repository: EngineerRepository, task: string): Promise<EngineerRun> {
  const created = (await request<{ run: EngineerRun }>("/v1/engineer/runs", { method: "POST", body: JSON.stringify({ repository, request: task }) })).run;
  await request(`/v1/engineer/runs/${created.runId}/plan`, { method: "POST" });
  return getEngineerRun(created.runId);
}
export async function getEngineerMobileData(runId: string): Promise<EngineerMobileData> {
  const [decisions, tests, claims, failures, gitOperations, approval] = await Promise.all([
    request<{ decisions: EngineerDecision[] }>(`/v1/engineer/runs/${runId}/decisions`),
    request<{ tests: unknown[] }>(`/v1/engineer/runs/${runId}/tests`),
    request<{ claims: unknown[] }>(`/v1/engineer/runs/${runId}/claims`),
    request<{ failures: unknown[] }>(`/v1/engineer/runs/${runId}/failures`),
    request<{ gitOperations: unknown[] }>(`/v1/engineer/runs/${runId}/git-operations`),
    request<{ approval: EngineerMobileData["approval"] }>(`/v1/engineer/runs/${runId}/approval`),
  ]);
  return { ...decisions, ...tests, ...claims, ...failures, ...gitOperations, ...approval };
}
export async function resolveEngineerDecision(run: EngineerRun, decision: EngineerDecision): Promise<void> {
  await request(`/v1/engineer/runs/${run.runId}/decisions/${decision.decisionId}/resolve`, { method: "POST", body: JSON.stringify({ expectedStateVersion: run.stateVersion, selectedOptionId: decision.recommendedOptionId, rationale: "Accepted the recommended option from Zintus mobile.", idempotencyKey: `mobile:${decision.decisionId}:${run.stateVersion}` }) });
}
export async function engineerHumanDecision(runId: string, action: "approve" | "request-changes" | "reject", reason: string): Promise<void> { await request(`/v1/engineer/runs/${runId}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }); }
export async function recoverEngineerStaleBase(runId: string): Promise<EngineerRun> { return (await request<{ replacementRun: EngineerRun }>(`/v1/engineer/runs/${runId}/recover-stale-base`, { method: "POST" })).replacementRun; }
