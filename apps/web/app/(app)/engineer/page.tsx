"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCorrectedEngineerRun,
  createEngineerRun,
  engineerDecision,
  resolveHumanEngineerReview,
  extendEngineerApproval,
  freezeEngineerPlan,
  getEngineerEvidenceStream,
  getEngineerArtifactPreview,
  getEngineerLiveSummary,
  getEngineerPlan,
  getEngineerRepository,
  getGithubConnector,
  startGithubConnector,
  disconnectGithubConnector,
  getEngineerRunStatus,
  getEngineerSnapshot,
  listEngineerRunsPage,
  planEngineerRun,
  recoverEngineerStaleBase,
  resumeEngineerBudget,
  resolveEngineerDecision,
  startEngineerRun,
  streamEngineerEvents,
  topUpEngineerBudget,
  type EngineerBudgetLimits,
  type EngineerBudgetSnapshot,
  type EngineerArtifact,
  type EngineerRepository,
  type EngineerRun,
  type PlanProposal,
  type RunEvent,
} from "@/lib/engineer";
import type { EngineerDecisionItem } from "@/lib/engineer-decisions";
import { DecisionPresentation, DeferredHumanTaskSummary } from "./DecisionPresentation";
import { clearEphemeralGatewayToken, fetchGatewayConnection, setEphemeralGatewayToken } from "@/lib/gateway";
import { estimateEngineerCost, formatUsd } from "@/lib/engineer-cost";
import { downloadBlob } from "@/lib/download";

type EvidenceData = Awaited<ReturnType<typeof getEngineerSnapshot>>["data"];
const TERMINAL = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
const RUN_STORAGE_KEY = "zintus-engineer-active-run";
const NON_CANCELLABLE_PUBLICATION_STATES = new Set(["PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "PR_CREATION_FAILED", "BASE_BRANCH_STALE"]);
const WORKFLOW_STAGES = [
  { label: "Request", states: /^(REQUEST_|CLARIFICATION)/ },
  { label: "Plan", states: /^(PLANNING|PLAN_|REPLANNING)/ },
  { label: "Sandbox", states: /^(QUEUED|SANDBOX_|CONTEXT_)/ },
  { label: "Build", states: /^(IMPLEMENTING|FAST_CHECKS|UNIT_TESTING|INTEGRATION_TESTING|E2E_TESTING|FLAKE_|VERIFICATION_|REVERIFYING)/ },
  { label: "Review", states: /^(SECURITY_|CODE_REVIEW|EVIDENCE_|REVIEW)/ },
  { label: "Human decision", states: /^(HUMAN_|FIX_REQUESTED|PAUSED_BUDGET)/ },
  { label: "Publication", states: /^(PR_|BASE_BRANCH|COMPLETED)/ },
] as const;
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
    <label>Add token allowance<input disabled={disabled} type="number" min="0" max="1000000" step="10000" value={value.addTokenBudget} onChange={(event) => onChange({ ...value, addTokenBudget: Math.min(1_000_000, Math.max(0, Number(event.target.value) || 0)) })} /></label>
    <label>Add time (minutes)<input disabled={disabled} type="number" min="0" max="480" step="5" value={Math.round(value.addTimeBudgetSeconds / 60)} onChange={(event) => onChange({ ...value, addTimeBudgetSeconds: Math.max(0, (Number(event.target.value) || 0) * 60) })} /></label>
  </div>;
}

function workflowStage(state: string) {
  if (TERMINAL.has(state) && state !== "COMPLETED") return { index: 0, total: WORKFLOW_STAGES.length, label: "Stopped safely", complete: false };
  const matched = WORKFLOW_STAGES.findIndex((stage) => stage.states.test(state));
  const index = matched >= 0 ? matched : 0;
  return { index: index + 1, total: WORKFLOW_STAGES.length, label: WORKFLOW_STAGES[index]?.label ?? "Request", complete: state === "COMPLETED" };
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Timeline({ events }: { events: RunEvent[] }) {
  const [now, setNow] = useState(() => Date.now());
  const timelineActive = events.length > 0 && !TERMINAL.has(events.at(-1)!.nextState) && events.at(-1)!.nextState !== "PAUSED_BUDGET";
  useEffect(() => {
    if (!timelineActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timelineActive]);
  return <div className="engineer-timeline">{events.length ? events.map((event, index) => {
    const next = events[index + 1];
    const duration = (next ? new Date(next.timestamp).getTime() : now) - new Date(event.timestamp).getTime();
    const active = index === events.length - 1 && timelineActive;
    return <div key={event.eventId} className={`engineer-event${active ? " is-active" : ""}`}><span /><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.nextState.replaceAll("_", " ")}</strong><small>{event.reasonCode.replaceAll("_", " ")}</small><small>{active ? "Current activity" : "Duration"}: {formatDuration(duration)}</small></div></div>;
  }) : <p className="engineer-muted">Waiting for the first durable event…</p>}</div>;
}

function DiffViewer({ diff }: { diff: string }) {
  const files = useMemo(() => {
    if (!diff.trim()) return [];
    const chunks = diff.split(/(?=^diff --git )/m).filter(Boolean);
    return chunks.map((content, index) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(content);
      return { id: `${index}:${header?.[2] ?? "diff"}`, path: header?.[2] ?? `Changed file ${index + 1}`, content };
    });
  }, [diff]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (!files.length) return <p className="engineer-muted">The exact diff appears after implementation begins.</p>;
  return <div className="engineer-diff-viewer"><div className="engineer-diff-summary"><strong>{files.length} changed {files.length === 1 ? "file" : "files"}</strong><button onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(files.map((file) => file.id)))}>{collapsed.size ? "Expand all" : "Collapse all"}</button></div>{files.map((file) => {
    const isCollapsed = collapsed.has(file.id);
    return <section key={file.id} className="engineer-diff-file"><button className="engineer-diff-file-header" onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })}><span>{isCollapsed ? "›" : "⌄"}</span><code>{file.path}</code></button>{!isCollapsed ? <div className="engineer-diff-lines">{file.content.split("\n").map((line, index) => <div key={`${file.id}:${index}`} className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : line.startsWith("@@") ? "hunk" : "context"}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div> : null}</section>;
  })}</div>;
}

function ArtifactViewer({ runId, artifacts }: { runId: string; artifacts: EngineerArtifact[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof getEngineerArtifactPreview>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  useEffect(() => {
    // A late preview from run A must never appear after navigation to run B.
    requestGeneration.current += 1;
    setSelected(null);
    setPreview(null);
    setLoading(false);
    setPreviewError(null);
  }, [runId]);
  const openArtifact = async (artifactId: string) => {
    const generation = ++requestGeneration.current;
    setSelected(artifactId); setLoading(true); setPreviewError(null); setPreview(null);
    try { const result = await getEngineerArtifactPreview(runId, artifactId); if (requestGeneration.current === generation) setPreview(result); }
    catch (cause) { if (requestGeneration.current === generation) setPreviewError(cause instanceof Error ? cause.message : "Artifact preview is unavailable"); }
    finally { if (requestGeneration.current === generation) setLoading(false); }
  };
  return <div className="engineer-card engineer-artifacts"><div className="engineer-card-heading"><div><h2>Run artifacts</h2><p>Inspect trusted command logs, reports, plans, and checkpoints without leaving Zintus.</p></div><span className="engineer-chip">{artifacts.length}</span></div>{artifacts.length ? <div className="engineer-artifact-layout"><div className="engineer-artifact-list">{artifacts.map((artifact) => <button key={artifact.artifactId} className={selected === artifact.artifactId ? "selected" : ""} onClick={() => void openArtifact(artifact.artifactId)}><span><strong>{artifact.type.replaceAll("_", " ")}</strong><small>{(artifact.sizeBytes / 1_024).toFixed(1)} KB · {artifact.trusted ? "trusted" : "untrusted data"}</small></span><code>{artifact.sha256.slice(0, 20)}…</code></button>)}</div><div className="engineer-artifact-preview" aria-live="polite">{loading ? <p className="engineer-muted">Loading verified artifact…</p> : previewError ? <p className="engineer-error">{previewError}</p> : preview?.encoding === "utf8" && preview.content !== null ? <><div><strong>{preview.artifact.type.replaceAll("_", " ")}</strong><small>{preview.truncated ? `First ${preview.previewBytes.toLocaleString()} verified bytes` : `${preview.previewBytes.toLocaleString()} verified bytes`}</small></div><pre>{preview.content}</pre></> : preview ? <p className="engineer-muted">This artifact is binary or is not safe to preview as text. Its hash and metadata remain available in the evidence export.</p> : <p className="engineer-muted">Choose an artifact to inspect its hash-verified content.</p>}</div></div> : <p className="engineer-muted">Artifacts appear as planning, execution, and verification progress.</p>}</div>;
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
  const [recentRuns, setRecentRuns] = useState<EngineerRun[]>([]);
  const [recentRunsCursor, setRecentRunsCursor] = useState<string | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [folderSnapshot, setFolderSnapshot] = useState<{ name: string; files: number; bytes: number } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [budget, setBudget] = useState<EngineerBudgetSnapshot | null>(null);
  const [budgetMode, setBudgetMode] = useState<"recommended" | "custom">("recommended");
  const [customBudget, setCustomBudget] = useState<EngineerBudgetLimits>(DEFAULT_BUDGET);
  const [topUp, setTopUp] = useState(TOP_UP_DEFAULTS);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const refresh = useCallback(async (runId: string) => {
    const snapshot = await getEngineerSnapshot(runId);
    if (activeRunIdRef.current !== runId) return;
    const status = snapshot.status; const nextData = snapshot.data; const nextBudget = snapshot.status.budget;
    setRun((current) => !current || status.run.runId !== current.runId || status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    setData(nextData);
    setBudget(nextBudget);
    setEvents(snapshot.events);
  }, []);

  const refreshLiveSummary = useCallback(async (runId: string) => {
    const { status, budget: nextBudget } = await getEngineerLiveSummary(runId);
    if (activeRunIdRef.current !== runId) return;
    setRun((current) => current?.runId === runId && status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    if (nextBudget) setBudget((current) => !current || current.runId !== runId || nextBudget.revision >= current.revision ? nextBudget : current);
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const watch = useCallback((runId: string, afterSequence = 0) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void streamEngineerEvents(runId, (event) => {
      setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event]);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; void refreshLiveSummary(runId); }, 100);
    }, controller.signal, {
      afterSequence,
    }).then(() => {
      if (controller.signal.aborted) return;
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
      // Streams end only at a paused/terminal boundary (or the configured
      // review boundary), so reconcile heavy sections exactly once there.
      return refresh(runId);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Timeline disconnected");
    });
  }, [refresh, refreshLiveSummary]);

  const loadDashboard = useCallback(async (reportAuthorizationError = false) => {
    const connection = await fetchGatewayConnection();
    setGatewayState(connection.state);
    if (connection.state === "connected") setGatewayAuthenticated(true);
    const [canonical, history, connector] = await Promise.allSettled([getEngineerRepository(), listEngineerRunsPage(), getGithubConnector()]);
    if (canonical.status === "fulfilled") setRepository(canonical.value);
    if (history.status === "fulfilled") { setRecentRuns(history.value.runs); setRecentRunsCursor(history.value.nextCursor); }
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

  const loadOlderRuns = async () => {
    if (!recentRunsCursor) return;
    setBusy(true); setError(null);
    try {
      const page = await listEngineerRunsPage(20, recentRunsCursor);
      setRecentRuns((current) => [...current, ...page.runs.filter((run) => !current.some((item) => item.runId === run.runId))]);
      setRecentRunsCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load older runs"); }
    finally { setBusy(false); }
  };

  const connectGithub = async () => {
    setBusy(true); setError(null);
    try { window.location.href = await startGithubConnector(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to connect GitHub"); setBusy(false); }
  };
  const disconnectGithub = async () => { setBusy(true); try { await disconnectGithubConnector(); setGithubConnected(false); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to disconnect GitHub"); } finally { setBusy(false); } };

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
      setFolderSnapshot({ name: root.name, files, bytes });
    } catch (cause) {
      if ((cause as { name?: string })?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Unable to read the selected folder");
    } finally { setFolderBusy(false); }
  };
  const openRun = useCallback(async (runId: string) => {
    setError(null);
    abortRef.current?.abort();
    if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
    activeRunIdRef.current = runId;
    const [snapshot, storedPlan] = await Promise.all([
      getEngineerSnapshot(runId), getEngineerPlan(runId).catch(() => null),
    ]);
    if (activeRunIdRef.current !== runId) return;
    setRun(snapshot.status.run); setPlan(storedPlan); setData(snapshot.data); setBudget(snapshot.status.budget); setEvents(snapshot.events); setManagerError(snapshot.status.lastError);
    window.localStorage.setItem(RUN_STORAGE_KEY, runId);
    if (snapshot.status.run.state !== "PAUSED_BUDGET" && !TERMINAL.has(snapshot.status.run.state)) watch(runId, snapshot.latestEventSequence);
  }, [watch]);

  const returnToRuns = useCallback(() => {
    abortRef.current?.abort();
    activeRunIdRef.current = null;
    if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
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
      activeRunIdRef.current = created.runId;
      setRun(created); window.localStorage.setItem(RUN_STORAGE_KEY, created.runId);
      watch(created.runId);
      const proposal = await planEngineerRun(created.runId);
      setPlan(proposal);
      await refresh(created.runId);
    } catch (cause) {
      if (activeRunIdRef.current) await refresh(activeRunIdRef.current).catch(() => undefined);
      setError(cause instanceof Error ? cause.message : "Unable to create Engineer run");
    }
    finally { setBusy(false); }
  };

  const retryPlanning = async () => {
    if (!run) return;
    setBusy(true); setError(null); setManagerError(null);
    watch(run.runId, events.at(-1)?.sequence ?? 0);
    try { const proposal = await planEngineerRun(run.runId); setPlan(proposal); await refresh(run.runId); }
    catch (cause) { await refresh(run.runId).catch(() => undefined); setError(cause instanceof Error ? cause.message : "Unable to plan Engineer run"); }
    finally { setBusy(false); }
  };

  const downloadEvidence = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const response = await getEngineerEvidenceStream(run.runId);
      const savePicker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }> }).showSaveFilePicker;
      if (savePicker && response.body) {
        const handle = await savePicker({ suggestedName: `zintus-engineer-${run.runId}-evidence.ndjson`, types: [{ description: "Checksummed Zintus evidence", accept: { "application/x-ndjson": [".ndjson"] } }] });
        await response.body.pipeTo(await handle.createWritable());
      } else {
        downloadBlob(`zintus-engineer-${run.runId}-evidence.ndjson`, await response.blob());
      }
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
        const latestSequence = events.at(-1)?.sequence ?? 0;
        setRun(resumed); watch(resumed.runId, latestSequence);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the run budget"); }
    finally { setBusy(false); }
  };

  const latestState = run?.state ?? "NEW";
  const artifacts = data?.artifacts ?? [];
  const claims = (data?.claims ?? []) as Array<{ claimId?: string; claim?: string; status?: string; notes?: string }>;
  const tests = (data?.tests ?? []) as Array<{ testExecutionId?: string; type?: string; status?: string }>;
  const findings = (data?.securityFindings ?? []) as Array<{ securityFindingId?: string; severity?: string; category?: string; description?: string }>;
  const failures = (data?.failures ?? []) as Array<{ failureId?: string; reasonCode?: string; failureClass?: string }>;
  const gitOperations = (data?.gitOperations ?? []) as Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }>;
  const decisions = (data?.decisions ?? []) as EngineerDecisionItem[];
  const approval = data?.approval as { status?: string; riskTier?: string; deadlineAt?: string; manifestHash?: string; diffHash?: string; evidenceBundleHash?: string } | null | undefined;
  const reachedImplementation = events.some((event) => ["IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "VERIFICATION_RECOVERY", "REVERIFYING"].includes(event.nextState));
  const reachedVerification = events.some((event) => ["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE", "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING", "REVIEW_APPROVED", "REVIEW_CHANGES_REQUESTED", "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED"].includes(event.nextState));
  const visibleTabs = ["timeline", ...(reachedImplementation ? ["diff"] : []), ...(reachedVerification ? ["evidence"] : [])] as Array<"timeline" | "diff" | "evidence">;
  useEffect(() => {
    if ((tab === "diff" && !reachedImplementation) || (tab === "evidence" && !reachedVerification)) setTab("timeline");
  }, [reachedImplementation, reachedVerification, tab]);
  const stage = useMemo(() => workflowStage(latestState), [latestState]);
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
        <div className="engineer-actions"><span className="engineer-chip">{githubConnected ? "GitHub publication connected" : "Verified local repository"}</span>{githubConfigured && !githubConnected ? <button onClick={() => void connectGithub()} disabled={busy}>Connect GitHub</button> : null}{githubConnected ? <button onClick={() => void disconnectGithub()} disabled={busy}>Disconnect</button> : null}</div>
        {githubConnected ? <p className="engineer-muted">GitHub credentials are available for approved publication. Runs remain bound to the repository admitted by this local gateway.</p> : null}
        {!githubConfigured ? <p className="engineer-muted">GitHub is not configured on this gateway. Local repositories remain available.</p> : null}
        <div className="engineer-folder-picker">
          <div><strong>Inspect a local folder in this browser</strong><p className="engineer-muted">Read-only inventory only. This does not change the repository used by Engineer; execution remains bound to the verified gateway repository.</p></div>
          <div className="engineer-actions"><button onClick={() => void chooseLocalFolder()} disabled={folderBusy}>{folderBusy ? "Reading folder…" : "Inspect folder"}</button></div>
          {folderSnapshot ? <p className="engineer-muted"><strong>{folderSnapshot.name}</strong> · {folderSnapshot.files.toLocaleString()} files · {(folderSnapshot.bytes / 1024 / 1024).toFixed(1)} MB · browser-only inspection</p> : null}
        </div>
      </section>
      {recentRuns.length ? <section className="engineer-card" id="recent-runs">
        <div className="engineer-section-title"><span>02</span><div><h2>Recent durable runs</h2><p>Reopen any run from the gateway ledger, including after a browser restart.</p></div></div>
        <div className="engineer-list">{(showAllRuns ? recentRuns : recentRuns.slice(0, 2)).map((item) => <button key={item.runId} onClick={() => void openRun(item.runId)}>
          <span className={`engineer-status engineer-status--${item.state.toLowerCase()}`}>{item.state.replaceAll("_", " ")}</span>
          <div><strong>{item.requestNormalized || item.requestOriginal}</strong><code>{item.runId}</code></div>
        </button>)}</div>
        {recentRuns.length > 2 ? <button className="engineer-secondary" onClick={() => setShowAllRuns((value) => !value)}>{showAllRuns ? "Show fewer runs" : `Show ${recentRuns.length - 2} more runs`}</button> : null}
        {showAllRuns && recentRunsCursor ? <button className="engineer-secondary" disabled={busy} onClick={() => void loadOlderRuns()}>{busy ? "Loading…" : "Load older runs"}</button> : null}
      </section> : null}
      <section className="engineer-card engineer-new-run">
        <div className="engineer-section-title"><span>03</span><div><h2>New engineering run</h2><p>No chat transcript. One evidence-driven workflow.</p></div></div>
        <label>Feature or bug<textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={5} placeholder="Add a bounded feature with measurable acceptance criteria…" /></label>
        <div className="engineer-form-grid">
          <label>Provider<input value={repository.provider === "github" ? "GitHub" : "Local repository"} readOnly /></label>
          <label>Repository ID<input value={repository.repositoryId} readOnly /></label>
          <label>Owner<input value={repository.owner} readOnly /></label>
          <label>Name<input value={repository.name} readOnly /></label>
          <label>Base branch<input value={repository.baseBranch} readOnly /></label>
          <label>Verified base commit<input className="engineer-mono" value={repository.baseCommitSha} readOnly /></label>
        </div>
        <aside className="engineer-cost-card" aria-live="polite">
          <div><span className="engineer-kicker">Preflight cost estimate</span><strong>{formatUsd(costEstimate.lowerUsd)}–{formatUsd(costEstimate.upperUsd)}</strong></div>
          <span className="engineer-chip">{costEstimate.complexity} scope</span>
          <p>Estimate only; actual provider billing depends on context and retries. No model call is made until you create the evidence plan.</p>
          <ul>{costEstimate.checks.map((check) => <li key={check}>{check}</li>)}</ul>
        </aside>
        <section className="engineer-budget-picker" aria-labelledby="engineer-budget-title">
          <div className="engineer-card-heading"><div><h3 id="engineer-budget-title">Run budget</h3><p>Choose a hard ceiling before planning makes its first model call.</p></div><span className="engineer-chip" tabIndex={0} title="Budgets are reserved server-side. If a model would exceed the ceiling, execution pauses safely at the last durable checkpoint.">No overages</span></div>
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
      <RunHeader run={run} stage={stage} onBack={returnToRuns} />
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
      <RunHeader run={run} stage={stage} onBack={returnToRuns} />
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
      <nav className="engineer-tabs" aria-label="Engineer run views">{visibleTabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
      {busy && ["REQUEST_RECEIVED", "REQUEST_NORMALIZED", "PLANNING", "REPLANNING"].includes(latestState) ? <section className="engineer-card engineer-gate" role="status"><div><span className="engineer-kicker">Planning in progress</span><h2>Creating the evidence plan</h2><p>The durable timeline records this step. Planning is automatically aborted if it exceeds two minutes.</p></div><button className="engineer-primary" disabled>Planning…</button></section> : null}
      {!busy && ["PLANNING", "REPLANNING"].includes(latestState) && !plan ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Planning interrupted</span><h2>Retry the evidence plan</h2><p>The exact failure is recorded below. The durable run and prior human answers remain intact.</p></div><button className="engineer-primary" onClick={() => void retryPlanning()}>Retry planning</button></section> : null}
      {latestState === "PLAN_FROZEN" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Frozen contract</span><h2>Resume execution</h2><p>The plan is already immutable. Starting again will enqueue this exact manifest without re-freezing it.</p></div><button className="engineer-primary" disabled={busy} onClick={() => void startFrozen()}>{busy ? "Starting…" : "Start frozen plan"}</button></section> : null}
      {latestState === "BASE_BRANCH_STALE" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Base branch changed</span><h2>Recreate and verify on the current base</h2><p>The reviewed candidate will not be published. A new immutable run will plan, execute, test, and obtain fresh review and approval.</p></div><button className="engineer-primary" disabled={busy} onClick={() => void recoverStaleBase()}>{busy ? "Recovering…" : "Start controlled recovery"}</button></section> : null}
      <DecisionPresentation decisions={decisions} onResolve={busy ? undefined : resolveDecision} />
      {tab === "timeline" ? <section className="engineer-run-grid">
        <div className="engineer-card"><h2>Live timeline</h2><Timeline events={events} /></div>
        <aside className="engineer-card engineer-verification"><h2>{reachedVerification ? "Verification" : "Current stage"}</h2>{reachedVerification ? <><Metric label="Tests" value={tests.length ? `${tests.filter((item) => item.status === "PASSED").length}/${tests.length} passed` : "Pending"} /><Metric label="Security" value={findings.length ? `${findings.length} findings` : "No findings"} /><Metric label="Claims" value={claims.length ? `${claims.filter((item) => item.status === "VERIFIED").length}/${claims.length} verified` : "Pending"} /></> : <Metric label="Activity" value={latestState.replaceAll("_", " ")} />}<Metric label="Failures" value={String(failures.length)} /></aside>
      </section> : null}
      {tab === "diff" ? <section className="engineer-card"><div className="engineer-card-heading"><div><h2>{latestState === "PAUSED_BUDGET" ? "Partial diff" : "Reviewed diff"}</h2>{latestState === "PAUSED_BUDGET" ? <p>This checkpoint has not completed verification and cannot be published.</p> : null}</div><span className={latestState === "PAUSED_BUDGET" ? "engineer-unverified" : "engineer-chip"}>{latestState === "PAUSED_BUDGET" ? "Unverified partial work" : "hash-bound"}</span></div><DiffViewer diff={data?.diff ?? ""} /></section> : null}
      {tab === "evidence" ? <><ArtifactViewer key={run.runId} runId={run.runId} artifacts={artifacts} /><section className="engineer-evidence-grid"><div className="engineer-card"><div className="engineer-card-heading"><h2>Acceptance evidence</h2><button disabled={busy} onClick={() => void downloadEvidence()}>Export checksummed stream</button></div>{claims.length ? claims.map((claim) => <article className="engineer-claim" key={claim.claimId}><span className={`engineer-status engineer-status--${(claim.status ?? "").toLowerCase()}`}>{claim.status}</span><strong>{claim.claim}</strong><p>{claim.notes}</p></article>) : <p className="engineer-muted">Claims are synthesized only after independent review.</p>}<p className="engineer-muted">Bundles: {(data?.evidenceBundles ?? []).length}</p></div><div className="engineer-card"><h2>Security findings</h2>{findings.length ? findings.map((finding) => <article className="engineer-finding" key={finding.securityFindingId}><span>{finding.severity}</span><strong>{finding.category}</strong><p>{finding.description}</p></article>) : <p className="engineer-muted">No recorded findings.</p>}</div><PublicationOperations operations={gitOperations} /></section></> : null}
      {latestState === "HUMAN_APPROVAL_PENDING" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human gate</span><h2>Approve the exact reviewed result</h2><p>Risk: {approval?.riskTier ?? run.riskTier} · Deadline: {approval?.deadlineAt ? new Date(approval.deadlineAt).toLocaleString() : "policy controlled"}</p><code>Manifest {approval?.manifestHash}</code><code>Diff {approval?.diffHash}</code><code>Evidence {approval?.evidenceBundleHash}</code></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void decide("approve")}>Approve and publish</button><button disabled={busy} onClick={() => void decide("request-changes")}>Request changes</button><button disabled={busy} onClick={() => void extendApproval()}>Give me 24 hours</button><button className="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</button></div></section> : null}
      {latestState === "HUMAN_REVIEW_REQUIRED" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human review</span><h2>Review the verified candidate</h2><p>The isolated Reviewer escalated this result for a human decision. Inspect the Diff and Evidence tabs, then either continue to the approval gate or reject the candidate.</p></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void resolveHumanReview("approve")}>Continue to approval</button><button className="danger" disabled={busy} onClick={() => void resolveHumanReview("reject")}>Reject candidate</button></div></section> : null}
      {latestState === "REVIEW_APPROVED" && !approval ? <section className="engineer-card engineer-gate"><span className="engineer-kicker">Review approved</span><h2>Publication is not configured locally</h2><p>The candidate passed human review and is safe to inspect locally. Configure the GitHub publication credentials before enabling merge or pull-request creation.</p></section> : null}
      {CORRECTABLE_TERMINAL_STATES.has(latestState) ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Correctable terminal result</span><h2>Create a corrected run</h2><p>Zintus will preserve this immutable audit record, carry forward its request and acceptance criteria, add a bounded correction from the recorded failure evidence, and require fresh verification.</p></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void createCorrectedRun()}>{busy ? "Creating…" : "Create corrected run"}</button></div></section> : null}
      {TERMINAL.has(latestState) ? <section className={`engineer-card engineer-final engineer-final--${latestState === "COMPLETED" ? "success" : "blocked"}`}><span className="engineer-kicker">Final result</span><h2>{latestState === "COMPLETED" ? "Verified and published" : latestState.replaceAll("_", " ")}</h2><p>{latestState === "COMPLETED" ? "The Supervisor completed the evidence gates and publication workflow." : "The workflow stopped safely. Inspect failures and evidence before taking another action."}</p></section> : null}
      {TERMINAL.has(latestState) ? <DeferredHumanTaskSummary decisions={decisions} /> : null}
      {!TERMINAL.has(latestState) && latestState !== "HUMAN_APPROVAL_PENDING" && latestState !== "PAUSED_BUDGET" && !NON_CANCELLABLE_PUBLICATION_STATES.has(latestState) ? <button className="engineer-cancel" disabled={busy} onClick={() => void decide("cancel")}>Cancel run</button> : null}
      {error ? <p className="engineer-error">{error}</p> : null}
      {managerError ? <p className="engineer-error">{managerError}</p> : null}
    </main>
  );
}

function RunHeader({ run, stage, onBack }: { run: EngineerRun; stage: ReturnType<typeof workflowStage>; onBack: () => void }) { return <header className="engineer-run-header"><div><button className="engineer-kicker" onClick={onBack}>← All runs</button><span className="engineer-kicker">Zintus Engineer · {run.repository.name}</span><h1>{run.requestNormalized || run.requestOriginal}</h1><div className="engineer-run-meta"><span className={`engineer-risk engineer-risk--${run.riskTier.toLowerCase()}`}>{run.riskTier}</span><code>{run.runId}</code></div></div><div className="engineer-progress"><div><span>{run.state.replaceAll("_", " ")}</span><strong>{stage.complete ? "Complete" : stage.index === 0 ? stage.label : `Stage ${stage.index} of ${stage.total} · ${stage.label}`}</strong></div><progress max={stage.total} value={stage.complete ? stage.total : stage.index} /></div></header>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>; }
function PublicationOperations({ operations }: { operations: Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }> }) { return <div className="engineer-card"><h2>Publication operations</h2>{operations.length ? operations.map((operation) => <article className="engineer-claim" key={operation.gitOperationId}><span className={`engineer-status engineer-status--${(operation.status ?? "").toLowerCase()}`}>{operation.status}</span><strong>{operation.operationType?.replaceAll("_", " ")}</strong>{operation.remoteReference?.startsWith("https://") ? <a href={operation.remoteReference} target="_blank" rel="noreferrer">Open published result</a> : <code>{operation.remoteReference ?? operation.errorCode ?? operation.gitOperationId}</code>}</article>) : <p className="engineer-muted">No credentialed Git operation has started.</p>}</div>; }
