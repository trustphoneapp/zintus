"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCorrectedEngineerRun,
  createEngineerRun,
  engineerDecision,
  resolveHumanEngineerReview,
  extendEngineerApproval,
  freezeEngineerPlan,
  getEngineerEvidenceExport,
  getEngineerData,
  getEngineerBudget,
  getEngineerPlan,
  getEngineerRepository,
  getGithubConnector,
  getGithubBranchCommit,
  listGithubConnectorRepositories,
  startGithubConnector,
  disconnectGithubConnector,
  getEngineerRunStatus,
  listEngineerRuns,
  planEngineerRun,
  recoverEngineerStaleBase,
  resumeEngineerBudget,
  resolveEngineerDecision,
  startEngineerRun,
  streamEngineerEvents,
  topUpEngineerBudget,
  type EngineerBudgetLimits,
  type EngineerBudgetSnapshot,
  type EngineerRepository,
  type EngineerRun,
  type PlanProposal,
  type RunEvent,
  type GithubConnectorRepository,
} from "@/lib/engineer";
import type { EngineerDecisionItem } from "@/lib/engineer-decisions";
import { DecisionPresentation, DeferredHumanTaskSummary } from "./DecisionPresentation";
import { clearEphemeralGatewayToken, fetchGatewayConnection, setEphemeralGatewayToken } from "@/lib/gateway";
import { estimateEngineerCost, formatUsd } from "@/lib/engineer-cost";

type EvidenceData = Awaited<ReturnType<typeof getEngineerData>>;
const TERMINAL = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
const RUN_STORAGE_KEY = "zintus-engineer-active-run";
const cursorKey = (runId: string) => `zintus-engineer-event-cursor:${runId}`;
const STATE_PROGRESS: Record<string, number> = { REQUEST_RECEIVED: 2, REQUEST_NORMALIZED: 5, PLANNING: 7, PLAN_READY: 10, PLAN_FROZEN: 12, QUEUED: 15, SANDBOX_WARM_CLAIMING: 18, SANDBOX_COLD_PROVISIONING: 18, SANDBOX_PREFLIGHT: 22, SANDBOX_READY: 25, CONTEXT_BUILDING: 30, IMPLEMENTING: 42, FAST_CHECKS: 50, UNIT_TESTING: 58, INTEGRATION_TESTING: 66, E2E_TESTING: 72, SECURITY_REVIEW: 78, REVIEWING: 86, REVIEW_APPROVED: 90, HUMAN_APPROVAL_PENDING: 94, HUMAN_APPROVED: 96, PR_PREFLIGHT: 97, PR_CREATING: 98, PR_CREATED: 99 };
const DEFAULT_BUDGET: EngineerBudgetLimits = { costBudgetUsd: 5, tokenBudget: 100_000, timeBudgetSeconds: 3_600 };
const TOP_UP_DEFAULTS = { addCostBudgetUsd: 2, addTokenBudget: 50_000, addTimeBudgetSeconds: 900 };
const CORRECTABLE_TERMINAL_STATES = new Set(["SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "REJECTED", "FAILED"]);

function recommendedBudget(request: string): EngineerBudgetLimits {
  const riskTerms = /\b(auth|security|crypt|migration|database|distributed|architecture|payment|permission|webhook)\b/gi;
  const riskMatches = request.match(riskTerms)?.length ?? 0;
  if (request.length > 2_000 || riskMatches >= 3) return { costBudgetUsd: 10, tokenBudget: 200_000, timeBudgetSeconds: 7_200 };
  if (request.length < 500 && riskMatches === 0) return { costBudgetUsd: 2, tokenBudget: 50_000, timeBudgetSeconds: 1_800 };
  return DEFAULT_BUDGET;
}

function BudgetHud({ budget, manifest }: { budget: EngineerBudgetSnapshot | null; manifest: PlanProposal["manifest"] | null }) {
  const limits = budget?.limits ?? (manifest ? { costUsd: manifest.costBudgetUsd, tokens: manifest.tokenBudget, timeSeconds: manifest.timeBudgetSeconds } : null);
  if (!limits) return null;
  if (!budget) return <section className="engineer-budget-hud engineer-budget-hud--pending"><div><span className="engineer-kicker">Run budget</span><strong>${limits.costUsd} · {limits.tokens.toLocaleString()} tokens · {Math.round(limits.timeSeconds / 60)} min</strong></div><small>Live spend appears when execution begins.</small></section>;
  const rows = [
    { label: "Cost", value: budget.used.costUsd + budget.reserved.costUsd, max: limits.costUsd, display: `$${budget.used.costUsd.toFixed(2)} used + $${budget.reserved.costUsd.toFixed(2)} reserved` },
    { label: "Tokens", value: budget.used.tokens + budget.reserved.tokens, max: limits.tokens, display: `${budget.used.tokens.toLocaleString()} used + ${budget.reserved.tokens.toLocaleString()} reserved` },
    { label: "Time", value: budget.used.timeSeconds, max: limits.timeSeconds, display: `${Math.round(budget.used.timeSeconds / 60)} min elapsed` },
  ];
  return <section className={`engineer-budget-hud engineer-budget-hud--${budget.status.toLowerCase()}`} aria-label="Live run budget">
    <div className="engineer-budget-hud-title"><div><span className="engineer-kicker">Live autonomy budget</span><strong>{budget.status === "PAUSED" ? "Paused at the hard ceiling" : budget.status === "WARNING" ? "Approaching a limit" : "Within limits"}</strong></div><small>Actual + reserved · updated {new Date(budget.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>
    <div className="engineer-budget-bars">{rows.map((row) => { const percent = row.max > 0 ? Math.min(100, (row.value / row.max) * 100) : 100; return <div key={row.label} className="engineer-budget-row"><div><span>{row.label}</span><strong>{row.display}</strong><small>{Math.max(0, 100 - percent).toFixed(0)}% remaining</small></div><progress max="100" value={percent} /></div>; })}</div>
  </section>;
}

function BudgetTopUp({ value, onChange, disabled }: { value: typeof TOP_UP_DEFAULTS; onChange: (value: typeof TOP_UP_DEFAULTS) => void; disabled: boolean }) {
  return <div className="engineer-budget-topup">
    <label>Add cost allowance (USD)<input disabled={disabled} type="number" min="0" max="100" step="0.5" value={value.addCostBudgetUsd} onChange={(event) => onChange({ ...value, addCostBudgetUsd: Math.max(0, Number(event.target.value) || 0) })} /></label>
    <label>Add token allowance<input disabled={disabled} type="number" min="0" max="1000000" step="10000" value={value.addTokenBudget} onChange={(event) => onChange({ ...value, addTokenBudget: Math.max(0, Number(event.target.value) || 0) })} /></label>
    <label>Add time (minutes)<input disabled={disabled} type="number" min="0" max="480" step="5" value={Math.round(value.addTimeBudgetSeconds / 60)} onChange={(event) => onChange({ ...value, addTimeBudgetSeconds: Math.max(0, (Number(event.target.value) || 0) * 60) })} /></label>
  </div>;
}

function isGatewayAuthorizationError(reason: unknown): boolean {
  return reason instanceof Error && /unauthorized|forbidden/i.test(reason.message);
}

export default function EngineerPage() {
  const [request, setRequest] = useState("");
  const [repository, setRepository] = useState<EngineerRepository>({ repositoryId: "local-repository", provider: "local", owner: "local", name: "zintus", baseBranch: "main", baseCommitSha: "" });
  const [run, setRun] = useState<EngineerRun | null>(null);
  const [plan, setPlan] = useState<PlanProposal | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [data, setData] = useState<EvidenceData | null>(null);
  const [tab, setTab] = useState<"timeline" | "diff" | "evidence">("timeline");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerError, setManagerError] = useState<string | null>(null);
  const [gatewayToken, setGatewayToken] = useState("");
  const [gatewayAuthenticated, setGatewayAuthenticated] = useState(false);
  const [gatewayState, setGatewayState] = useState<"connected" | "authentication-required" | "offline">("offline");
  const [showAdvancedGateway, setShowAdvancedGateway] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [githubRepos, setGithubRepos] = useState<GithubConnectorRepository[]>([]);
  const [recentRuns, setRecentRuns] = useState<EngineerRun[]>([]);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [folderSnapshot, setFolderSnapshot] = useState<{ name: string; files: number; bytes: number; readOnly: boolean } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [budget, setBudget] = useState<EngineerBudgetSnapshot | null>(null);
  const [budgetMode, setBudgetMode] = useState<"recommended" | "custom">("recommended");
  const [customBudget, setCustomBudget] = useState<EngineerBudgetLimits>(DEFAULT_BUDGET);
  const [topUp, setTopUp] = useState(TOP_UP_DEFAULTS);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (runId: string) => {
    const [status, nextData, nextBudget] = await Promise.all([getEngineerRunStatus(runId), getEngineerData(runId), getEngineerBudget(runId).catch(() => null)]);
    setRun((current) => !current || status.run.runId !== current.runId || status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    setData(nextData);
    setBudget(nextBudget);
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const watch = useCallback((runId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void streamEngineerEvents(runId, (event) => {
      setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event]);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; void refresh(runId); }, 100);
    }, controller.signal, {
      // Rebuild the visible timeline after reload; reconnects within the stream still resume from its live cursor.
      afterSequence: 0,
      onCursor: (sequence) => window.localStorage.setItem(cursorKey(runId), String(sequence)),
    }).then(() => refresh(runId)).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Timeline disconnected");
    });
  }, [refresh]);

  const loadDashboard = useCallback(async (reportAuthorizationError = false) => {
    const connection = await fetchGatewayConnection();
    setGatewayState(connection.state);
    if (connection.state === "connected") setGatewayAuthenticated(true);
    const [canonical, history, connector] = await Promise.allSettled([getEngineerRepository(), listEngineerRuns(), getGithubConnector()]);
    if (canonical.status === "fulfilled") setRepository(canonical.value);
    if (history.status === "fulfilled") setRecentRuns(history.value);
    if (connector.status === "fulfilled") { setGithubConfigured(connector.value.configured); setGithubConnected(connector.value.connected); }
    if (canonical.status === "fulfilled" || history.status === "fulfilled") setError(null);
    if (canonical.status === "rejected" && history.status === "rejected") {
      if (isGatewayAuthorizationError(canonical.reason) || isGatewayAuthorizationError(history.reason)) {
        setGatewayAuthenticated(false);
        setError(
          reportAuthorizationError
            ? "The operator token was rejected. Check the complete token and try again."
            : null,
        );
      } else {
        setError(canonical.reason instanceof Error ? canonical.reason.message : "Engineer gateway is unavailable");
      }
    }
  }, []);

  const connectGithub = async () => {
    setBusy(true); setError(null);
    try { window.location.href = await startGithubConnector(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to connect GitHub"); setBusy(false); }
  };
  const loadGithubRepos = async () => {
    setBusy(true); setError(null);
    try { setGithubRepos(await listGithubConnectorRepositories()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load GitHub repositories"); }
    finally { setBusy(false); }
  };
  const disconnectGithub = async () => { setBusy(true); try { await disconnectGithubConnector(); setGithubConnected(false); setGithubRepos([]); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to disconnect GitHub"); } finally { setBusy(false); } };

  // Browser-only inspection is intentionally read-only. The selected directory
  // never leaves this tab; the local gateway remains the execution/editing
  // surface. Write access is requested only after an explicit user action.
  const chooseLocalFolder = async () => {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<unknown> }).showDirectoryPicker;
    if (!picker) { setError("Folder access is unavailable in this browser. Use Chrome or the local gateway."); return; }
    setFolderBusy(true); setError(null);
    try {
      const root = await picker({ mode: "read" }) as { name: string; values?: () => AsyncIterable<unknown> };
      let files = 0; let bytes = 0;
      const visit = async (directory: { values?: () => AsyncIterable<unknown> }) => {
        if (!directory.values) return;
        for await (const entry of directory.values()) {
          const item = entry as { kind?: string; values?: () => AsyncIterable<unknown>; getFile?: () => Promise<{ size: number }> };
          if (item.kind === "directory") await visit(item);
          else if (item.kind === "file" && item.getFile) { const file = await item.getFile(); files += 1; bytes += file.size; }
        }
      };
      await visit(root);
      setFolderSnapshot({ name: root.name, files, bytes, readOnly: true });
    } catch (cause) {
      if ((cause as { name?: string })?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Unable to read the selected folder");
    } finally { setFolderBusy(false); }
  };
  const requestFolderWriteAccess = async () => {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<unknown> }).showDirectoryPicker;
    if (!picker) return;
    setFolderBusy(true); setError(null);
    try {
      const root = await picker({ mode: "readwrite" }) as { name: string; requestPermission?: (options: { mode: "readwrite" }) => Promise<string> };
      const permission = root.requestPermission ? await root.requestPermission({ mode: "readwrite" }) : "granted";
      if (permission !== "granted") throw new Error("Write access was not granted");
      setFolderSnapshot((current) => current ? { ...current, name: root.name, readOnly: false } : current);
    } catch (cause) {
      if ((cause as { name?: string })?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Unable to grant folder write access");
    } finally { setFolderBusy(false); }
  };

  const openRun = useCallback(async (runId: string) => {
    setError(null);
    const [status, storedPlan, storedData, storedBudget] = await Promise.all([
      getEngineerRunStatus(runId), getEngineerPlan(runId).catch(() => null), getEngineerData(runId), getEngineerBudget(runId).catch(() => null),
    ]);
    setRun(status.run); setPlan(storedPlan); setData(storedData); setBudget(storedBudget); setEvents([]); setManagerError(status.lastError);
    window.localStorage.setItem(RUN_STORAGE_KEY, runId);
    // The stream replays durable history from sequence zero and closes after a
    // terminal ledger is drained, so reopened completed runs get a full timeline.
    if (status.run.state !== "PAUSED_BUDGET") watch(runId);
  }, [watch]);

  const returnToRuns = useCallback(() => {
    abortRef.current?.abort();
    window.localStorage.removeItem(RUN_STORAGE_KEY);
    setRun(null); setPlan(null); setData(null); setBudget(null); setEvents([]); setManagerError(null); setError(null);
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run") ?? window.localStorage.getItem(RUN_STORAGE_KEY);
    if (!runId) { void loadDashboard(); return; }
    let active = true;
    void openRun(runId).catch(() => {
      if (!active) return;
      window.localStorage.removeItem(RUN_STORAGE_KEY);
      void loadDashboard();
    });
    return () => { active = false; };
  }, [loadDashboard, openRun]);

  const submit = async () => {
    if (!request.trim() || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(repository.baseCommitSha)) return;
    setBusy(true); setError(null);
    try {
      const selectedBudget = budgetMode === "recommended" ? recommendedBudget(request) : customBudget;
      const created = await createEngineerRun({ repository, request: request.trim(), budget: selectedBudget });
      setRun(created); window.localStorage.setItem(RUN_STORAGE_KEY, created.runId);
      const proposal = await planEngineerRun(created.runId);
      setPlan(proposal);
      const [status, nextData, createdBudget] = await Promise.all([getEngineerRunStatus(created.runId), getEngineerData(created.runId), getEngineerBudget(created.runId).catch(() => null)]); setRun(status.run); setData(nextData); setBudget(createdBudget); setManagerError(status.lastError);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create Engineer run"); }
    finally { setBusy(false); }
  };

  const retryPlanning = async () => {
    if (!run) return;
    setBusy(true); setError(null); setManagerError(null);
    try { const proposal = await planEngineerRun(run.runId); setPlan(proposal); const [status, nextData] = await Promise.all([getEngineerRunStatus(run.runId), getEngineerData(run.runId)]); setRun(status.run); setData(nextData); setManagerError(status.lastError); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to plan Engineer run"); }
    finally { setBusy(false); }
  };

  const downloadEvidence = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const aggregate = await getEngineerEvidenceExport(run.runId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(aggregate, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `zintus-engineer-${run.runId}-evidence.json`; link.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to export evidence"); }
    finally { setBusy(false); }
  };

  const resolveDecision = useCallback(async (decisionId: string, optionId: string) => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const result = await resolveEngineerDecision(run, decisionId, optionId, "Selected through the Zintus decision inbox.");
      if (result.plan) setPlan(result.plan);
      if (result.planningError) setError(result.planningError);
      await refresh(run.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to resolve decision");
    } finally {
      setBusy(false);
    }
  }, [refresh, run]);

  const freezeAndStart = async () => {
    if (!run || !plan) return;
    setBusy(true); setError(null);
    try {
      const frozen = await freezeEngineerPlan(run, plan.manifest);
      setRun(frozen);
      const queued = await startEngineerRun(frozen.runId);
      setRun(queued); setEvents([]); watch(queued.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start Engineer run"); }
    finally { setBusy(false); }
  };

  const startFrozen = async () => {
    if (!run || run.state !== "PLAN_FROZEN") return;
    setBusy(true); setError(null);
    try { const queued = await startEngineerRun(run.runId); setRun(queued); setEvents([]); watch(queued.runId); }
    catch (cause) { const status = await getEngineerRunStatus(run.runId).catch(() => null); if (status) { setRun(status.run); setManagerError(status.lastError); } setError(cause instanceof Error ? cause.message : "Unable to start Engineer run"); }
    finally { setBusy(false); }
  };

  const recoverStaleBase = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const replacement = await recoverEngineerStaleBase(run.runId);
      await openRun(replacement.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to recover the stale base"); }
    finally { setBusy(false); }
  };

  const createCorrectedRun = async () => {
    if (!run || !CORRECTABLE_TERMINAL_STATES.has(run.state)) return;
    setBusy(true); setError(null);
    try {
      const corrected = await createCorrectedEngineerRun(run.runId);
      await openRun(corrected.replacementRun.runId);
      setPlan(corrected.plan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create a corrected run"); }
    finally { setBusy(false); }
  };

  const decide = async (action: "approve" | "request-changes" | "reject" | "cancel") => {
    if (!run) return;
    setBusy(true); setError(null);
    try { await engineerDecision(run.runId, action, reason.trim() || `${action} from Zintus Engineer`); setReason(""); await refresh(run.runId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Decision failed"); }
    finally { setBusy(false); }
  };

  const extendApproval = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try { await extendEngineerApproval(run.runId, reason.trim() || "More time required for human review."); setReason(""); await refresh(run.runId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to extend approval"); }
    finally { setBusy(false); }
  };

  const resolveHumanReview = async (decision: "approve" | "reject") => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      await resolveHumanEngineerReview(run.runId, decision, reason.trim() || `${decision} human review from Zintus Engineer`);
      setReason(""); await refresh(run.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Human review decision failed"); }
    finally { setBusy(false); }
  };

  const applyTopUp = async (resume: boolean) => {
    if (!run || !budget) return;
    setBusy(true); setError(null);
    try {
      const updated = await topUpEngineerBudget(run.runId, { expectedRevision: budget.revision, ...topUp });
      setBudget(updated);
      if (resume) {
        const resumed = await resumeEngineerBudget(run.runId, { expectedStateVersion: run.stateVersion, expectedBudgetRevision: updated.revision });
        setRun(resumed); setEvents([]); watch(resumed.runId);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the run budget"); }
    finally { setBusy(false); }
  };

  const latestState = run?.state ?? "NEW";
  const claims = (data?.claims ?? []) as Array<{ claimId?: string; claim?: string; status?: string; notes?: string }>;
  const tests = (data?.tests ?? []) as Array<{ testExecutionId?: string; type?: string; status?: string }>;
  const findings = (data?.securityFindings ?? []) as Array<{ securityFindingId?: string; severity?: string; category?: string; description?: string }>;
  const failures = (data?.failures ?? []) as Array<{ failureId?: string; reasonCode?: string; failureClass?: string }>;
  const gitOperations = (data?.gitOperations ?? []) as Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }>;
  const decisions = (data?.decisions ?? []) as EngineerDecisionItem[];
  const approval = data?.approval as { status?: string; riskTier?: string; deadlineAt?: string; manifestHash?: string; diffHash?: string; evidenceBundleHash?: string } | null | undefined;
  const progress = useMemo(() => TERMINAL.has(latestState) ? 100 : STATE_PROGRESS[latestState] ?? 35, [latestState]);
  const costEstimate = useMemo(() => estimateEngineerCost(request, repository.name), [request, repository.name]);
  const selectedBudget = budgetMode === "recommended" ? recommendedBudget(request) : customBudget;
  const budgetUsage = budget ? Math.max(
    budget.limits.costUsd > 0 ? (budget.used.costUsd + budget.reserved.costUsd) / budget.limits.costUsd : 0,
    budget.limits.tokens > 0 ? (budget.used.tokens + budget.reserved.tokens) / budget.limits.tokens : 0,
    budget.limits.timeSeconds > 0 ? budget.used.timeSeconds / budget.limits.timeSeconds : 0,
  ) : 0;
  const approachingBudget = budget?.status === "WARNING" || budgetUsage >= (budget?.warningThreshold ?? 0.8);

  if (!run) return (
    <main className="engineer-screen">
      <header className="engineer-hero"><span className="engineer-kicker">Zintus Engineer</span><h1>AI writes the code. Zintus proves whether it works.</h1><p>Define the exact repository snapshot and the outcome. Zintus plans, isolates, verifies, reviews, and waits for you before risky publication.</p><a href="/engineer/operations">Open operations and cost health →</a></header>
      <section className="engineer-card" id="gateway-access">
        <div className="engineer-section-title"><span>00</span><div><h2>Gateway</h2><p>{gatewayState === "connected" ? "Connected locally. No token is required on a loopback gateway." : gatewayState === "authentication-required" ? "This gateway requires an operator token." : "Start the local gateway to connect automatically."}</p></div></div>
        <div className="engineer-actions"><span className={`engineer-status engineer-status--${gatewayState}`}>{gatewayState.replaceAll("-", " ")}</span><button onClick={() => setShowAdvancedGateway((value) => !value)}>{showAdvancedGateway ? "Hide advanced security" : "Advanced security"}</button></div>
        {showAdvancedGateway ? <div className="engineer-actions"><label>Operator token<input type="password" value={gatewayToken} autoComplete="off" onChange={(event) => setGatewayToken(event.target.value)} placeholder="Paste GATEWAY_TOKEN" /></label><button disabled={!gatewayToken.trim()} onClick={() => { setEphemeralGatewayToken(gatewayToken); setGatewayToken(""); setGatewayAuthenticated(true); void loadDashboard(true); }}>Use token for this tab</button>{gatewayAuthenticated ? <button onClick={() => { clearEphemeralGatewayToken(); setGatewayAuthenticated(false); void loadDashboard(); }}>Clear token</button> : null}</div> : null}
      </section>
      <section className="engineer-card" id="repository-connector">
        <div className="engineer-section-title"><span>01</span><div><h2>Repository connector</h2><p>Local is the default. GitHub access is scoped to repositories you authorize.</p></div></div>
        <div className="engineer-actions"><span className="engineer-chip">{githubConnected ? "GitHub connected" : "Local repository"}</span>{githubConfigured && !githubConnected ? <button onClick={() => void connectGithub()} disabled={busy}>Connect GitHub</button> : null}{githubConnected ? <><button onClick={() => void loadGithubRepos()} disabled={busy}>Choose GitHub repository</button><button onClick={() => void disconnectGithub()} disabled={busy}>Disconnect</button></> : null}</div>
        {githubRepos.length ? <div className="engineer-list">{githubRepos.map((repo) => <button key={repo.id} onClick={() => void (async () => { const [owner, name] = repo.fullName.split("/"); try { setBusy(true); const sha = await getGithubBranchCommit(owner ?? "", name ?? "", repo.defaultBranch); setRepository({ repositoryId: repo.id, provider: "github", owner: owner ?? "", name: name ?? "", baseBranch: repo.defaultBranch, baseCommitSha: sha }); setGithubRepos([]); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to inspect GitHub branch"); } finally { setBusy(false); } })()}><strong>{repo.fullName}</strong><span>{repo.private ? "Private" : "Public"} · {repo.defaultBranch}</span></button>)}</div> : null}
        {!githubConfigured ? <p className="engineer-muted">GitHub is not configured on this gateway. Local repositories remain available.</p> : null}
        <div className="engineer-folder-picker">
          <div><strong>Inspect a local folder in this browser</strong><p className="engineer-muted">Read-only by default. The folder stays in this tab; no files are uploaded or changed.</p></div>
          <div className="engineer-actions"><button onClick={() => void chooseLocalFolder()} disabled={folderBusy}>{folderBusy ? "Reading folder…" : "Add folder"}</button>{folderSnapshot ? <button onClick={() => void requestFolderWriteAccess()} disabled={folderBusy || !folderSnapshot.readOnly}>Allow changes to this folder</button> : null}</div>
          {folderSnapshot ? <p className="engineer-muted"><strong>{folderSnapshot.name}</strong> · {folderSnapshot.files.toLocaleString()} files · {(folderSnapshot.bytes / 1024 / 1024).toFixed(1)} MB · {folderSnapshot.readOnly ? "read-only inspection" : "write access granted"}</p> : null}
        </div>
      </section>
      {recentRuns.length ? <section className="engineer-card" id="recent-runs">
        <div className="engineer-section-title"><span>02</span><div><h2>Recent durable runs</h2><p>Reopen any run from the gateway ledger, including after a browser restart.</p></div></div>
        <div className="engineer-list">{(showAllRuns ? recentRuns : recentRuns.slice(0, 2)).map((item) => <button key={item.runId} onClick={() => void openRun(item.runId)}>
          <span className={`engineer-status engineer-status--${item.state.toLowerCase()}`}>{item.state.replaceAll("_", " ")}</span>
          <div><strong>{item.requestNormalized || item.requestOriginal}</strong><code>{item.runId}</code></div>
        </button>)}</div>
        {recentRuns.length > 2 ? <button className="engineer-secondary" onClick={() => setShowAllRuns((value) => !value)}>{showAllRuns ? "Show fewer runs" : `Show ${recentRuns.length - 2} more runs`}</button> : null}
      </section> : null}
      <section className="engineer-card engineer-new-run">
        <div className="engineer-section-title"><span>01</span><div><h2>New engineering run</h2><p>No chat transcript. One evidence-driven workflow.</p></div></div>
        <label>Feature or bug<textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={5} placeholder="Add a bounded feature with measurable acceptance criteria…" /></label>
        <div className="engineer-form-grid">
          <label>Provider<select value={repository.provider} onChange={(event) => setRepository({ ...repository, provider: event.target.value as "github" | "local" })}><option value="local">Local repository</option><option value="github">GitHub</option></select></label>
          <label>Repository ID<input value={repository.repositoryId} onChange={(event) => setRepository({ ...repository, repositoryId: event.target.value })} /></label>
          <label>Owner<input value={repository.owner} onChange={(event) => setRepository({ ...repository, owner: event.target.value })} /></label>
          <label>Name<input value={repository.name} onChange={(event) => setRepository({ ...repository, name: event.target.value })} /></label>
          <label>Base branch<input value={repository.baseBranch} onChange={(event) => setRepository({ ...repository, baseBranch: event.target.value })} /></label>
          <label>Exact base commit SHA<input className="engineer-mono" value={repository.baseCommitSha} onChange={(event) => setRepository({ ...repository, baseCommitSha: event.target.value.trim() })} placeholder="40 or 64 hexadecimal characters" /></label>
        </div>
        <aside className="engineer-cost-card" aria-live="polite">
          <div><span className="engineer-kicker">Preflight cost estimate</span><strong>{formatUsd(costEstimate.lowerUsd)}–{formatUsd(costEstimate.upperUsd)}</strong></div>
          <span className="engineer-chip">{costEstimate.complexity} scope</span>
          <p>Estimate only; actual provider billing depends on context and retries. No model call is made until you create the evidence plan.</p>
          <ul>{costEstimate.checks.map((check) => <li key={check}>{check}</li>)}</ul>
        </aside>
        <section className="engineer-budget-picker" aria-labelledby="engineer-budget-title">
          <div className="engineer-card-heading"><div><h3 id="engineer-budget-title">Run budget</h3><p>Choose a hard ceiling before planning makes its first model call.</p></div><span className="engineer-chip">No overages</span></div>
          <div className="engineer-budget-options">
            <button type="button" className={budgetMode === "recommended" ? "selected" : ""} onClick={() => setBudgetMode("recommended")} aria-pressed={budgetMode === "recommended"}>
              <span><strong>Recommended</strong><small>Adjusted locally from task size and risk signals</small></span>
              <b>${recommendedBudget(request).costBudgetUsd} · {(recommendedBudget(request).tokenBudget / 1_000).toLocaleString()}k tokens</b>
            </button>
            <button type="button" className={budgetMode === "custom" ? "selected" : ""} onClick={() => setBudgetMode("custom")} aria-pressed={budgetMode === "custom"}>
              <span><strong>Custom</strong><small>Set your own cost, token, and time ceilings</small></span>
              <b>${customBudget.costBudgetUsd} · {(customBudget.tokenBudget / 1_000).toLocaleString()}k tokens</b>
            </button>
          </div>
          {budgetMode === "custom" ? <div className="engineer-budget-custom">
            <label>Maximum cost (USD)<input type="number" min="0.5" max="100" step="0.5" value={customBudget.costBudgetUsd} onChange={(event) => setCustomBudget({ ...customBudget, costBudgetUsd: Math.max(0.5, Number(event.target.value) || 0.5) })} /></label>
            <label>Maximum tokens<input type="number" min="10000" max="1000000" step="10000" value={customBudget.tokenBudget} onChange={(event) => setCustomBudget({ ...customBudget, tokenBudget: Math.min(1_000_000, Math.max(10_000, Number(event.target.value) || 10_000)) })} /></label>
            <label>Maximum minutes<input type="number" min="10" max="480" step="10" value={Math.round(customBudget.timeBudgetSeconds / 60)} onChange={(event) => setCustomBudget({ ...customBudget, timeBudgetSeconds: Math.max(600, (Number(event.target.value) || 10) * 60) })} /></label>
          </div> : null}
          <p className="engineer-budget-note">The run pauses at ${selectedBudget.costBudgetUsd}, {selectedBudget.tokenBudget.toLocaleString()} tokens, or {Math.round(selectedBudget.timeBudgetSeconds / 60)} minutes—whichever comes first. You can inspect partial work and explicitly top up later.</p>
        </section>
        {error ? <p className="engineer-error">{error}</p> : null}
        <button className="engineer-primary" onClick={() => void submit()} disabled={busy || !request.trim() || !repository.baseCommitSha}>{busy ? "Planning…" : "Create evidence plan"}</button>
      </section>
    </main>
  );

  if (plan && run.state === "PLAN_READY") return (
    <main className="engineer-screen">
      <RunHeader run={run} progress={10} onBack={returnToRuns} />
      <section className="engineer-plan-grid">
        <div className="engineer-card">
          <div className="engineer-section-title"><span>02</span><div><h2>Review the frozen contract</h2><p>This scope controls every file, command, test, and retry.</p></div></div>
          <h3>Acceptance criteria</h3>
          <ol className="engineer-criteria">{plan.manifest.acceptanceCriteria.map((item) => <li key={item.criterionId}><strong>{item.statement}</strong><small>{item.verificationMethod}</small></li>)}</ol>
          <h3>Verification plan</h3>
          <div className="engineer-list">{plan.manifest.testPlan.map((item) => <div key={item.testId}><span className="engineer-chip">{item.type}</span><div><strong>{item.description}</strong><code>{item.command ?? "No command"}</code></div></div>)}</div>
        </div>
        <aside className="engineer-card engineer-scope">
          <div><span>Risk</span><strong className={`engineer-risk engineer-risk--${plan.manifest.riskTier.toLowerCase()}`}>{plan.manifest.riskTier}</strong></div>
          <div><span>Human gate</span><strong>{plan.manifest.humanGateRequired ? "Required" : "Policy dependent"}</strong></div>
          <div><span>Allowed paths</span>{plan.manifest.allowedPaths.map((path) => <code key={path}>{path}</code>)}</div>
          <div><span>Commands</span>{plan.manifest.allowedCommands.map((command) => <code key={command}>{command}</code>)}</div>
          <div><span>Hard budget</span><strong>${plan.manifest.costBudgetUsd} · {plan.manifest.tokenBudget.toLocaleString()} tokens</strong><small>{Math.round(plan.manifest.timeBudgetSeconds / 60)} minutes · pauses at the first limit</small></div>
          <div><span>Architecture</span><p>{plan.planningAnalysis.architectureSummary}</p></div>
          <div><span>Assumptions</span>{plan.planningAnalysis.assumptions.length ? plan.planningAnalysis.assumptions.map((item) => <p key={item.assumptionId}>{item.statement} · {Math.round(item.confidence * 100)}% confidence</p>) : <p>None recorded.</p>}</div>
          <div><span>Estimated files</span>{plan.planningAnalysis.touchedFileEstimates.map((item) => <code key={item.path}>{item.path}</code>)}</div>
          {error ? <p className="engineer-error">{error}</p> : null}
          {managerError ? <p className="engineer-error">{managerError}</p> : null}
          <button className="engineer-primary" onClick={() => void freezeAndStart()} disabled={busy}>{busy ? "Starting…" : "Freeze plan and start"}</button>
        </aside>
      </section>
      <DecisionPresentation decisions={decisions} onResolve={busy ? undefined : resolveDecision} />
    </main>
  );

  return (
    <main className="engineer-screen">
      <RunHeader run={run} progress={TERMINAL.has(latestState) ? 100 : progress} onBack={returnToRuns} />
      <BudgetHud budget={budget} manifest={plan?.manifest ?? null} />
      {approachingBudget && latestState !== "PAUSED_BUDGET" ? <section className="engineer-budget-warning" role="status">
        <div><strong>Approaching the run budget</strong><p>Zintus has reserved or used {Math.min(100, Math.round(budgetUsage * 100))}% of at least one limit. It will pause safely before spending beyond your ceiling.</p></div>
        <button disabled={busy || !budget} onClick={() => void applyTopUp(false)}>Add ${topUp.addCostBudgetUsd} / {(topUp.addTokenBudget / 1_000).toLocaleString()}k tokens</button>
      </section> : null}
      {latestState === "PAUSED_BUDGET" ? <section className="engineer-card engineer-budget-paused">
        <div className="engineer-budget-paused-header"><div><span className="engineer-kicker">Run paused · budget exhausted</span><h2>Your work is checkpointed</h2><p>No new model call can start until you explicitly raise the budget. Current code is available to inspect, but publication remains disabled.</p></div><span className="engineer-unverified">Unverified partial work</span></div>
        <BudgetTopUp value={topUp} onChange={setTopUp} disabled={busy} />
        <div className="engineer-actions"><button className="engineer-primary" disabled={busy || !budget} onClick={() => void applyTopUp(true)}>{busy ? "Resuming…" : "Top up and resume checkpoint"}</button><button disabled={busy} onClick={() => setTab("diff")}>View partial diff</button></div>
      </section> : null}
      {data?.errors.length ? <section className="engineer-card"><p className="engineer-error">Some evidence sections are unavailable: {data.errors.map((item) => item.section).join(", ")}. Empty values below are not treated as successful checks.</p></section> : null}
      <nav className="engineer-tabs" aria-label="Engineer run views">{(["timeline", "diff", "evidence"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
      {(["REQUEST_RECEIVED", "PLANNING", "REPLANNING"].includes(latestState) && (latestState !== "REQUEST_RECEIVED" || !plan)) ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Planning interrupted</span><h2>Retry the evidence plan</h2><p>The durable run and prior human answers are intact. Planning can be retried without creating a duplicate run.</p></div><button className="engineer-primary" disabled={busy} onClick={() => void retryPlanning()}>{busy ? "Planning…" : "Retry planning"}</button></section> : null}
      {latestState === "PLAN_FROZEN" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Frozen contract</span><h2>Resume execution</h2><p>The plan is already immutable. Starting again will enqueue this exact manifest without re-freezing it.</p></div><button className="engineer-primary" disabled={busy} onClick={() => void startFrozen()}>{busy ? "Starting…" : "Start frozen plan"}</button></section> : null}
      {latestState === "BASE_BRANCH_STALE" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Base branch changed</span><h2>Recreate and verify on the current base</h2><p>The reviewed candidate will not be published. A new immutable run will plan, execute, test, and obtain fresh review and approval.</p></div><button className="engineer-primary" disabled={busy} onClick={() => void recoverStaleBase()}>{busy ? "Recovering…" : "Start controlled recovery"}</button></section> : null}
      <DecisionPresentation decisions={decisions} onResolve={busy ? undefined : resolveDecision} />
      {tab === "timeline" ? <section className="engineer-run-grid">
        <div className="engineer-card"><h2>Live timeline</h2><div className="engineer-timeline">{events.length ? events.map((event) => <div key={event.eventId} className="engineer-event"><span /><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.nextState.replaceAll("_", " ")}</strong><small>{event.reasonCode.replaceAll("_", " ")}</small></div></div>) : <p className="engineer-muted">Waiting for the first durable event…</p>}</div></div>
        <aside className="engineer-card engineer-verification"><h2>Verification</h2><Metric label="Tests" value={tests.length ? `${tests.filter((item) => item.status === "PASSED").length}/${tests.length} passed` : "Pending"} /><Metric label="Security" value={findings.length ? `${findings.length} findings` : "No findings"} /><Metric label="Claims" value={claims.length ? `${claims.filter((item) => item.status === "VERIFIED").length}/${claims.length} verified` : "Pending"} /><Metric label="Failures" value={String(failures.length)} /></aside>
      </section> : null}
      {tab === "diff" ? <section className="engineer-card"><div className="engineer-card-heading"><div><h2>{latestState === "PAUSED_BUDGET" ? "Partial diff" : "Reviewed diff"}</h2>{latestState === "PAUSED_BUDGET" ? <p>This checkpoint has not completed verification and cannot be published.</p> : null}</div><span className={latestState === "PAUSED_BUDGET" ? "engineer-unverified" : "engineer-chip"}>{latestState === "PAUSED_BUDGET" ? "Unverified partial work" : "hash-bound"}</span></div><pre className="engineer-diff">{data?.diff || "The exact diff appears after implementation begins."}</pre></section> : null}
      {tab === "evidence" ? <section className="engineer-evidence-grid"><div className="engineer-card"><div className="engineer-card-heading"><h2>Acceptance evidence</h2><button disabled={busy} onClick={() => void downloadEvidence()}>Export checksummed JSON</button></div>{claims.length ? claims.map((claim) => <article className="engineer-claim" key={claim.claimId}><span className={`engineer-status engineer-status--${(claim.status ?? "").toLowerCase()}`}>{claim.status}</span><strong>{claim.claim}</strong><p>{claim.notes}</p></article>) : <p className="engineer-muted">Claims are synthesized only after independent review.</p>}<p className="engineer-muted">Bundles: {(data?.evidenceBundles ?? []).length}</p></div><div className="engineer-card"><h2>Security findings</h2>{findings.length ? findings.map((finding) => <article className="engineer-finding" key={finding.securityFindingId}><span>{finding.severity}</span><strong>{finding.category}</strong><p>{finding.description}</p></article>) : <p className="engineer-muted">No recorded findings.</p>}</div><PublicationOperations operations={gitOperations} /></section> : null}
      {latestState === "HUMAN_APPROVAL_PENDING" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human gate</span><h2>Approve the exact reviewed result</h2><p>Risk: {approval?.riskTier ?? run.riskTier} · Deadline: {approval?.deadlineAt ? new Date(approval.deadlineAt).toLocaleString() : "policy controlled"}</p><code>Manifest {approval?.manifestHash}</code><code>Diff {approval?.diffHash}</code><code>Evidence {approval?.evidenceBundleHash}</code></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void decide("approve")}>Approve and publish</button><button disabled={busy} onClick={() => void decide("request-changes")}>Request changes</button><button disabled={busy} onClick={() => void extendApproval()}>Give me 24 hours</button><button className="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</button></div></section> : null}
      {latestState === "HUMAN_REVIEW_REQUIRED" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human review</span><h2>Review the verified candidate</h2><p>The isolated Reviewer escalated this result for a human decision. Inspect the Diff and Evidence tabs, then either continue to the approval gate or reject the candidate.</p></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void resolveHumanReview("approve")}>Continue to approval</button><button className="danger" disabled={busy} onClick={() => void resolveHumanReview("reject")}>Reject candidate</button></div></section> : null}
      {latestState === "REVIEW_APPROVED" && !approval ? <section className="engineer-card engineer-gate"><span className="engineer-kicker">Review approved</span><h2>Publication is not configured locally</h2><p>The candidate passed human review and is safe to inspect locally. Configure the GitHub publication credentials before enabling merge or pull-request creation.</p></section> : null}
      {CORRECTABLE_TERMINAL_STATES.has(latestState) ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Correctable terminal result</span><h2>Create a corrected run</h2><p>Zintus will preserve this immutable audit record, carry forward its request and acceptance criteria, add a bounded correction from the recorded failure evidence, and require fresh verification.</p></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void createCorrectedRun()}>{busy ? "Creating…" : "Create corrected run"}</button></div></section> : null}
      {TERMINAL.has(latestState) ? <section className={`engineer-card engineer-final engineer-final--${latestState === "COMPLETED" ? "success" : "blocked"}`}><span className="engineer-kicker">Final result</span><h2>{latestState === "COMPLETED" ? "Verified and published" : latestState.replaceAll("_", " ")}</h2><p>{latestState === "COMPLETED" ? "The Supervisor completed the evidence gates and publication workflow." : "The workflow stopped safely. Inspect failures and evidence before taking another action."}</p></section> : null}
      {TERMINAL.has(latestState) ? <DeferredHumanTaskSummary decisions={decisions} /> : null}
      {!TERMINAL.has(latestState) && latestState !== "HUMAN_APPROVAL_PENDING" && latestState !== "PAUSED_BUDGET" ? <button className="engineer-cancel" disabled={busy} onClick={() => void decide("cancel")}>Cancel run</button> : null}
      {error ? <p className="engineer-error">{error}</p> : null}
      {managerError ? <p className="engineer-error">{managerError}</p> : null}
    </main>
  );
}

function RunHeader({ run, progress, onBack }: { run: EngineerRun; progress: number; onBack: () => void }) { return <header className="engineer-run-header"><div><button className="engineer-kicker" onClick={onBack}>← All runs</button><span className="engineer-kicker">Zintus Engineer · {run.repository.name}</span><h1>{run.requestNormalized || run.requestOriginal}</h1><div className="engineer-run-meta"><span className={`engineer-risk engineer-risk--${run.riskTier.toLowerCase()}`}>{run.riskTier}</span><code>{run.runId}</code></div></div><div className="engineer-progress"><div><span>{run.state.replaceAll("_", " ")}</span><strong>{progress}%</strong></div><progress max="100" value={progress} /></div></header>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>; }
function PublicationOperations({ operations }: { operations: Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }> }) { return <div className="engineer-card"><h2>Publication operations</h2>{operations.length ? operations.map((operation) => <article className="engineer-claim" key={operation.gitOperationId}><span className={`engineer-status engineer-status--${(operation.status ?? "").toLowerCase()}`}>{operation.status}</span><strong>{operation.operationType?.replaceAll("_", " ")}</strong>{operation.remoteReference?.startsWith("https://") ? <a href={operation.remoteReference} target="_blank" rel="noreferrer">Open published result</a> : <code>{operation.remoteReference ?? operation.errorCode ?? operation.gitOperationId}</code>}</article>) : <p className="engineer-muted">No credentialed Git operation has started.</p>}</div>; }
