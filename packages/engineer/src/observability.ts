import { isTerminalState, STATE_RUNTIME_POLICIES } from "./state-machine.js";
import type { EngineerSupervisor } from "./supervisor.js";

export interface EngineerObservabilitySnapshot {
  generatedAt: string;
  totalRuns: number;
  activeRuns: number;
  terminalRuns: number;
  pendingApprovals: number;
  runsByState: Record<string, number>;
  runsByRisk: Record<string, number>;
  failuresByClass: Record<string, number>;
  completedRuns: number;
  failedRuns: number;
  successRate: number | null;
  stuckRuns: number;
  retryAttempts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  estimatedCostUsd: number;
  averageApprovalLatencySeconds: number | null;
  evidenceCompleteRuns: number;
  runHealth: Array<{ runId: string; state: string; riskTier: string; ageInStateSeconds: number; stuck: boolean; retryAttempts: number; failureCount: number }>;
}

/** Aggregates durable ledger truth only; it does not infer health from model text. */
export function engineerObservabilitySnapshot(supervisor: EngineerSupervisor, now = new Date(), ownerId?: string): EngineerObservabilitySnapshot {
  const runs = supervisor.listRuns().filter((run) => ownerId === undefined || run.userId === ownerId);
  const runsByState: Record<string, number> = {};
  const runsByRisk: Record<string, number> = {};
  const failuresByClass: Record<string, number> = {};
  let pendingApprovals = 0;
  let retryAttempts = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let estimatedCostUsd = 0;
  let evidenceCompleteRuns = 0;
  const approvalLatencies: number[] = [];
  const runHealth: EngineerObservabilitySnapshot["runHealth"] = [];
  for (const run of runs) {
    runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;
    runsByRisk[run.riskTier] = (runsByRisk[run.riskTier] ?? 0) + 1;
    if (supervisor.latestApprovalRequest(run.runId)?.status === "PENDING") pendingApprovals += 1;
    const failures = supervisor.listFailures(run.runId);
    for (const failure of failures) {
      failuresByClass[failure.failureClass] = (failuresByClass[failure.failureClass] ?? 0) + 1;
    }
    const records = supervisor.exportRunRecords(run.runId);
    retryAttempts += records.retry_attempts?.length ?? 0;
    for (const call of records.model_calls ?? []) {
      totalInputTokens += Number(call.input_tokens ?? 0);
      totalOutputTokens += Number(call.output_tokens ?? 0);
      cachedInputTokens += Number(call.cached_input_tokens ?? 0);
      cacheWriteInputTokens += Number(call.cache_write_input_tokens ?? 0);
    }
    for (const cost of records.cost_records ?? []) {
      if (cost.source_type === "MODEL_CALL") estimatedCostUsd += Number(cost.estimated_cost_usd ?? 0);
    }
    for (const decision of records.approval_decisions ?? []) {
      const request = (records.approval_requests ?? []).find((item) => item.id === decision.approval_request_id);
      if (request?.requested_at && decision.decided_at) {
        const latency = (new Date(String(decision.decided_at)).getTime() - new Date(String(request.requested_at)).getTime()) / 1_000;
        if (Number.isFinite(latency) && latency >= 0) approvalLatencies.push(latency);
      }
    }
    if (supervisor.listEvidenceBundles(run.runId).length > 0) evidenceCompleteRuns += 1;
    const ageInStateSeconds = Math.max(0, Math.floor((now.getTime() - new Date(run.updatedAt).getTime()) / 1_000));
    const policy = STATE_RUNTIME_POLICIES[run.state];
    const stuck = !isTerminalState(run.state) && policy.maxDurationSeconds > 0 && ageInStateSeconds > policy.maxDurationSeconds;
    runHealth.push({ runId: run.runId, state: run.state, riskTier: run.riskTier, ageInStateSeconds, stuck, retryAttempts: records.retry_attempts?.length ?? 0, failureCount: failures.length });
  }
  const terminalRuns = runs.filter((run) => isTerminalState(run.state)).length;
  const completedRuns = runs.filter((run) => run.state === "COMPLETED").length;
  const failedRuns = runs.filter((run) => isTerminalState(run.state) && !["COMPLETED", "CANCELLED", "REJECTED"].includes(run.state)).length;
  const decidedRuns = completedRuns + failedRuns;
  return {
    generatedAt: now.toISOString(), totalRuns: runs.length,
    activeRuns: runs.length - terminalRuns, terminalRuns, pendingApprovals,
    runsByState, runsByRisk, failuresByClass, completedRuns, failedRuns,
    successRate: decidedRuns > 0 ? completedRuns / decidedRuns : null,
    stuckRuns: runHealth.filter((run) => run.stuck).length,
    retryAttempts, totalInputTokens, totalOutputTokens, cachedInputTokens, cacheWriteInputTokens,
    estimatedCostUsd, averageApprovalLatencySeconds: approvalLatencies.length > 0 ? approvalLatencies.reduce((sum, value) => sum + value, 0) / approvalLatencies.length : null,
    evidenceCompleteRuns, runHealth,
  };
}
