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
  runHealthTotal: number;
  runHealthTruncated: boolean;
  runHealth: Array<{ runId: string; state: string; riskTier: string; ageInStateSeconds: number; stuck: boolean; retryAttempts: number; failureCount: number }>;
}

/** Aggregates durable ledger truth only; it does not infer health from model text. */
export function engineerObservabilitySnapshot(supervisor: EngineerSupervisor, now = new Date(), ownerId?: string): EngineerObservabilitySnapshot {
  const projections = supervisor.listRunObservability(ownerId);
  const runs = projections.map((projection) => projection.run);
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
  let approvalLatencySecondsTotal = 0;
  let approvalLatencyCount = 0;
  const runHealth: EngineerObservabilitySnapshot["runHealth"] = [];
  for (const projection of projections) {
    const { run } = projection;
    runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;
    runsByRisk[run.riskTier] = (runsByRisk[run.riskTier] ?? 0) + 1;
    pendingApprovals += projection.pendingApprovals;
    retryAttempts += projection.retryAttempts;
    totalInputTokens += projection.totalInputTokens;
    totalOutputTokens += projection.totalOutputTokens;
    cachedInputTokens += projection.cachedInputTokens;
    cacheWriteInputTokens += projection.cacheWriteInputTokens;
    estimatedCostUsd += projection.estimatedCostUsd;
    approvalLatencySecondsTotal += projection.approvalLatencySecondsTotal;
    approvalLatencyCount += projection.approvalLatencyCount;
    if (projection.evidenceComplete) evidenceCompleteRuns += 1;
    const ageInStateSeconds = Math.max(0, Math.floor((now.getTime() - new Date(run.updatedAt).getTime()) / 1_000));
    const policy = STATE_RUNTIME_POLICIES[run.state];
    const stuck = !isTerminalState(run.state) && policy.maxDurationSeconds > 0 && ageInStateSeconds > policy.maxDurationSeconds;
    runHealth.push({ runId: run.runId, state: run.state, riskTier: run.riskTier, ageInStateSeconds, stuck, retryAttempts: projection.retryAttempts, failureCount: projection.failureCount });
  }
  for (const failure of supervisor.listFailureClassObservability(ownerId)) failuresByClass[failure.failureClass] = failure.count;
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
    estimatedCostUsd, averageApprovalLatencySeconds: approvalLatencyCount > 0 ? approvalLatencySecondsTotal / approvalLatencyCount : null,
    evidenceCompleteRuns,
    runHealthTotal: runHealth.length,
    runHealthTruncated: runHealth.length > 100,
    runHealth: runHealth.slice(-100).reverse(),
  };
}
