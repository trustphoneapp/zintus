"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getEngineerBudget, getEngineerHardeningReadiness, getEngineerRun, type EngineerBudgetSnapshot, type EngineerRun } from "@/lib/engineer";
import { estimateEngineerCost } from "@/lib/engineer-cost";
import { EngineerActionLock } from "@/lib/engineer-action-lock";
import { HardeningReadinessBanner, type EngineerHardeningReadinessState } from "../EngineerHardeningReadiness";
import {
  applyResolutionDirective,
  createResolutionCase,
  createResolutionDirective,
  listResolutionCases,
  type ResolutionCase,
  type ResolutionDirectiveType,
} from "@/lib/engineer-resolution";
import {
  ResolutionActionError,
  ResolutionCaseStopReason,
  ResolutionDecisions,
  ResolutionEmptyState,
  ResolutionErrorState,
  ResolutionSpendingSummary,
  ResolutionTerminalSummary,
  RunBudgetSpendSummary,
  BlockerSections,
  replacementBudgetFrom,
  type FreshBudgetFormValue,
} from "./ResolutionDeskControls";

const TERMINAL_CASE_STATES = new Set<ResolutionCase["state"]>(["RESOLVED_CORRECTED", "RESOLVED_REVERIFIED", "REJECTED_CLOSED"]);

function ResolutionDeskInner() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("run");

  const [run, setRun] = useState<EngineerRun | null>(null);
  const [budget, setBudget] = useState<EngineerBudgetSnapshot | null>(null);
  const [resolutionCase, setResolutionCase] = useState<ResolutionCase | null>(null);
  const [readiness, setReadiness] = useState<EngineerHardeningReadinessState>("READY");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [lastReplacementRunId, setLastReplacementRunId] = useState<string | null>(null);
  const [budgetValue, setBudgetValue] = useState<FreshBudgetFormValue>({ maxCostUsd: 5, maxTokens: 300_000, maxActiveSeconds: 3_600 });

  const actionLockRef = useRef(new EngineerActionLock());

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const [nextRun, cases] = await Promise.all([getEngineerRun(id), listResolutionCases(id)]);
      setRun(nextRun);
      setResolutionCase(cases[0] ?? null);
      await getEngineerBudget(id).then(setBudget).catch(() => setBudget(null));
      await getEngineerHardeningReadiness().then((next) => setReadiness(next.state)).catch(() => setReadiness("UNKNOWN"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Resolution Desk is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (runId) void load(runId); }, [runId, load]);

  const withMutation = useCallback(async (action: string, work: () => Promise<void>) => {
    await actionLockRef.current.run("resolution-desk", async () => {
      setPendingAction(action);
      setActionError(null);
      try { await work(); }
      catch (cause) { setActionError(cause); }
      finally { setPendingAction((current) => current === action ? null : current); }
    });
  }, []);

  const startCase = useCallback(async () => {
    if (!runId) return;
    setStarting(true);
    try {
      const next = await createResolutionCase(runId);
      setResolutionCase(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start a resolution case");
    } finally {
      setStarting(false);
    }
  }, [runId]);

  const issueAndApply = useCallback(async (type: ResolutionDirectiveType, label: string) => {
    if (!resolutionCase || !run) return;
    // Guards the button-disabled precondition by construction: even if this
    // were reached without a digest, replacementBudgetFrom refuses to build
    // a budget with the unavailable sentinel rather than sending one.
    if (type === "CREATE_CORRECTED_RUN" && !resolutionCase.pricingPolicyDigest) return;
    await withMutation(label, async () => {
      const budgetInput = type === "CREATE_CORRECTED_RUN"
        ? replacementBudgetFrom(budgetValue, resolutionCase.pricingPolicyDigest)
        : undefined;
      const directive = await createResolutionDirective(resolutionCase.caseId, {
        type,
        caseVersion: resolutionCase.caseVersion,
        sourceRunVersion: run.stateVersion,
        ...(budgetInput ? { budget: budgetInput } : {}),
      });
      const result = await applyResolutionDirective(directive.directiveId);
      if (result.replacementRunId) setLastReplacementRunId(result.replacementRunId);
      if (runId) await load(runId);
    });
  }, [resolutionCase, run, budgetValue, withMutation, runId, load]);

  const correctedEstimate = useMemo(() => {
    if (!run) return null;
    const estimate = estimateEngineerCost(run.requestNormalized, run.repository.name);
    return { lowerUsd: estimate.lowerUsd, upperUsd: estimate.upperUsd };
  }, [run]);

  const disabled = pendingAction !== null || !resolutionCase || resolutionCase.state !== "OPEN";

  return (
    <main className="engineer-screen">
      <header className="engineer-hero">
        <a href={runId ? `/engineer?run=${encodeURIComponent(runId)}` : "/engineer"} className="engineer-kicker">← Back to run</a>
        <h1>Resolution Desk</h1>
        <p>Every open blocker on this run's canonical case, and the three ways to resolve it. The server derives eligibility, versions, and budgets — this screen only submits your choice.</p>
      </header>

      {!runId ? <ResolutionErrorState message="No run selected. Open the Resolution Desk from a specific run." /> : null}
      {readiness !== "READY" ? <HardeningReadinessBanner state={readiness} /> : null}
      {error ? <ResolutionErrorState message={error} /> : null}
      {actionError ? <ResolutionActionError error={actionError} /> : null}
      {loading && runId ? <section className="engineer-card"><p className="engineer-muted">Loading the resolution case…</p></section> : null}

      {!loading && runId && !error && !resolutionCase
        ? <ResolutionEmptyState onStart={() => void startCase()} starting={starting} />
        : null}

      {!loading && resolutionCase && TERMINAL_CASE_STATES.has(resolutionCase.state)
        ? <ResolutionTerminalSummary resolutionCase={resolutionCase} replacementRunId={lastReplacementRunId} />
        : null}

      {!loading && resolutionCase && !TERMINAL_CASE_STATES.has(resolutionCase.state) ? <>
        <ResolutionCaseStopReason resolutionCase={resolutionCase} />
        <BlockerSections blockers={resolutionCase.blockers} />
        <ResolutionSpendingSummary spending={resolutionCase.spending} />
        {budget ? <RunBudgetSpendSummary budget={budget} /> : null}
        <ResolutionDecisions
          resolutionCase={resolutionCase}
          pendingAction={pendingAction}
          disabled={disabled}
          correctedEstimate={correctedEstimate}
          budgetValue={budgetValue}
          onBudgetChange={setBudgetValue}
          pricingPolicyDigestAvailable={Boolean(resolutionCase.pricingPolicyDigest)}
          onCorrected={() => void issueAndApply("CREATE_CORRECTED_RUN", "resolution:corrected")}
          onReverify={() => void issueAndApply("CREATE_REVERIFY_RUN", "resolution:reverify")}
          onRejectClose={() => void issueAndApply("REJECT_AND_CLOSE", "resolution:reject-close")}
        />
      </> : null}
    </main>
  );
}

export default function ResolutionDeskPage() {
  return <Suspense fallback={<main className="engineer-screen"><section className="engineer-card"><p className="engineer-muted">Loading…</p></section></main>}>
    <ResolutionDeskInner />
  </Suspense>;
}
