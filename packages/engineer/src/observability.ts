import { isTerminalState } from "./state-machine.js";
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
}

/** Aggregates durable ledger truth only; it does not infer health from model text. */
export function engineerObservabilitySnapshot(supervisor: EngineerSupervisor, now = new Date(), ownerId?: string): EngineerObservabilitySnapshot {
  const runs = supervisor.listRuns().filter((run) => ownerId === undefined || run.userId === ownerId);
  const runsByState: Record<string, number> = {};
  const runsByRisk: Record<string, number> = {};
  const failuresByClass: Record<string, number> = {};
  let pendingApprovals = 0;
  for (const run of runs) {
    runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;
    runsByRisk[run.riskTier] = (runsByRisk[run.riskTier] ?? 0) + 1;
    if (supervisor.latestApprovalRequest(run.runId)?.status === "PENDING") pendingApprovals += 1;
    for (const failure of supervisor.listFailures(run.runId)) {
      failuresByClass[failure.failureClass] = (failuresByClass[failure.failureClass] ?? 0) + 1;
    }
  }
  const terminalRuns = runs.filter((run) => isTerminalState(run.state)).length;
  return {
    generatedAt: now.toISOString(), totalRuns: runs.length,
    activeRuns: runs.length - terminalRuns, terminalRuns, pendingApprovals,
    runsByState, runsByRisk, failuresByClass,
  };
}
