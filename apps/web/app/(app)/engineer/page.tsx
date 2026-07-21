"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ZintusLogo } from "@/components/ZintusLogo";
import { LocalWorkspaceInstructionsButton } from "./online/OnlineEngineerControls";
import { PremiumPreviewAccess } from "@/app/judge/JudgeLiveAccess";
import {
  createEngineerRun,
  engineerDecision,
  resolveHumanEngineerReview,
  freezeEngineerPlan,
  getEngineerEvidenceStream,
  getEngineerDiff,
  getEngineerArtifactPreview,
  getEngineerLiveSummary,
  getEngineerHardeningReadiness,
  getEngineerJudgeSession,
  getEngineerPublicationReadiness,
  getEngineerPlan,
  getEngineerRepository,
  getGithubConnector,
  listEngineerRepositories,
  startGithubConnector,
  disconnectGithubConnector,
  getEngineerRunStatus,
  getEngineerSnapshot,
  listEngineerRunsPage,
  planEngineerRun,
  replanEngineerExplicitContract,
  retryEngineerProviderTimeout,
  resumeEngineerBudget,
  resolveEngineerDecision,
  startEngineerRun,
  streamEngineerEvents,
  topUpEngineerBudget,
  type EngineerBudgetSnapshot,
  type EngineerArtifact,
  type EngineerApproval,
  type EngineerRepository,
  type EngineerRun,
  type EngineerRunCapabilities,
  type EngineerRunStatus,
  type EngineerPublicationReadiness,
  type EngineerJudgeSession,
  type PlanProposal,
  type RunEvent,
} from "@/lib/engineer";
import type { EngineerDecisionItem } from "@/lib/engineer-decisions";
import { DecisionPresentation, DeferredHumanTaskSummary } from "./DecisionPresentation";
import { PublicationEntryNotice, VerifiedCandidateCard } from "./EngineerVerificationControls";
import { HardeningReadinessBanner } from "./EngineerHardeningReadiness";
import {
  clearEphemeralGatewayToken,
  fetchGatewayConnection,
  GATEWAY_CREDENTIAL_CHANGED_EVENT,
  setEphemeralGatewayToken,
  type GatewayConnectionState,
} from "@/lib/gateway";
import { estimateEngineerCost, formatUsd } from "@/lib/engineer-cost";
import { downloadBlob } from "@/lib/download";
import { deriveDiffProvenance, deriveSecurityStatus, DIFF_PROVENANCE_PRESENTATION, engineerTextSha256 } from "@/lib/engineer-truth";
import { frozenPlanCapabilities } from "@/lib/engineer-capabilities";
import { EngineerActionLock } from "@/lib/engineer-action-lock";
import { engineerCorrectionRecovery } from "@/lib/engineer-correction";
import {
  ENGINEER_BUDGET_CHIPS,
  ENGINEER_BUDGET_PRESETS,
  engineerBudgetPreset,
  formatEngineerTokenLimit,
  recommendedEngineerBudgetPresetIndex,
} from "@/lib/engineer-budget-presets";

type EvidenceData = Awaited<ReturnType<typeof getEngineerSnapshot>>["data"];
const TERMINAL = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
const HUMAN_DECISION_STATES = new Set(["CLARIFICATION_REQUIRED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING"]);
const RUN_STORAGE_KEY = "zintus-engineer-active-run";
const NON_CANCELLABLE_PUBLICATION_STATES = new Set(["PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "PR_CREATION_FAILED", "BASE_BRANCH_STALE"]);
const WORKFLOW_STAGES = [
  { label: "Request", states: /^(REQUEST_|CLARIFICATION)/ },
  { label: "Plan", states: /^(PLANNING|PLAN_|REPLANNING)/ },
  { label: "Sandbox", states: /^(QUEUED|SANDBOX_|CONTEXT_)/ },
  { label: "Build", states: /^(IMPLEMENTING|MODEL_PROVIDER_|FAST_CHECKS|UNIT_TESTING|INTEGRATION_TESTING|E2E_TESTING|FLAKE_|VERIFICATION_|REVERIFYING)/ },
  { label: "Review", states: /^(SECURITY_|CODE_REVIEW|EVIDENCE_|REVIEW)/ },
  { label: "Human decision", states: /^(HUMAN_|FIX_REQUESTED|PAUSED_BUDGET)/ },
  { label: "Publication", states: /^(PR_|BASE_BRANCH|COMPLETED)/ },
] as const;
const TOP_UP_DEFAULTS = { addCostBudgetUsd: 2, addTokenBudget: 50_000, addTimeBudgetSeconds: 900 };
const FOLDER_INVENTORY_MAX_FILES = 5_000;
const FOLDER_INVENTORY_MAX_ENTRIES = 10_000;
const FOLDER_INVENTORY_MAX_DEPTH = 32;
const FOLDER_TREE_MAX_NODES = 160;

interface FolderTreeNode {
  name: string;
  kind: "directory" | "file";
  size?: number;
  children?: FolderTreeNode[];
}

function EngineerTopbar({ gatewayState }: { gatewayState: GatewayConnectionState }) {
  return <header className="engineer-topbar"><div className="engineer-topbar-title"><ZintusLogo size="sm" showWordmark={false} /><div><strong>Zintus Engineer</strong><small>AI writes the code. Zintus proves whether it works.</small></div></div><span className={`engineer-status engineer-status--${gatewayState}`}><i aria-hidden="true" />{gatewayState.replaceAll("-", " ")}</span></header>;
}

function BudgetSlider({ index, recommendedIndex, onChange }: { index: number; recommendedIndex: number; onChange: (index: number) => void }) {
  const preset = engineerBudgetPreset(index);
  const minutes = Math.round(preset.limits.timeBudgetSeconds / 60);
  const fill = ENGINEER_BUDGET_PRESETS.length > 1 ? (index / (ENGINEER_BUDGET_PRESETS.length - 1)) * 100 : 0;
  return <section className="engineer-budget-picker engineer-budget-slider" aria-labelledby="engineer-budget-title">
    <div className="engineer-card-heading"><div><h3 id="engineer-budget-title">Run budget</h3><p>Set a hard ceiling before planning makes its first model call.</p></div><span className="engineer-chip" tabIndex={0} title="Budgets are reserved server-side. If a model would exceed the ceiling, execution pauses safely at the last durable checkpoint.">No overages</span></div>
    <div className="engineer-budget-readout" aria-live="polite"><div><span>Max cost</span><strong>${preset.limits.costBudgetUsd}</strong></div><div><span>Max tokens</span><strong>{formatEngineerTokenLimit(preset.limits.tokenBudget)}</strong></div><div><span>Max minutes</span><strong>{minutes}</strong></div></div>
    <div className="engineer-budget-range"><div className="engineer-budget-range-fill" style={{ width: `${fill}%` }} /><input aria-label="Run budget preset" type="range" min="0" max={ENGINEER_BUDGET_PRESETS.length - 1} step="1" value={index} onChange={(event) => onChange(Number(event.target.value))} /></div>
    <div className="engineer-budget-ticks">{ENGINEER_BUDGET_PRESETS.map((item, itemIndex) => <button type="button" key={item.id} className={itemIndex === index ? "active" : ""} onClick={() => onChange(itemIndex)}>{item.tickLabel}</button>)}</div>
    <div className="engineer-budget-presets">{ENGINEER_BUDGET_CHIPS.map((chip) => {
      const targetIndex = chip.label === "Recommended" ? recommendedIndex : chip.presetIndex;
      return <button type="button" key={chip.label} className={targetIndex === index ? "active" : ""} onClick={() => onChange(targetIndex)}>{chip.label}{chip.label === "Recommended" ? <small>{engineerBudgetPreset(recommendedIndex).tickLabel} for this task</small> : null}</button>;
    })}</div>
    <p className="engineer-budget-note">The run pauses at ${preset.limits.costBudgetUsd}, {preset.limits.tokenBudget.toLocaleString()} tokens, or {minutes} minutes—whichever comes first. You can inspect partial work and explicitly top up later.</p>
  </section>;
}

function FolderTree({ nodes }: { nodes: FolderTreeNode[] }) {
  if (!nodes.length) return null;
  return <div className="engineer-folder-tree">{nodes.map((node) => node.kind === "directory"
    ? <details key={`directory:${node.name}`}><summary><span>›</span><code>{node.name}</code><small>{node.children?.length ?? 0} entries</small></summary><FolderTree nodes={node.children ?? []} /></details>
    : <div className="engineer-folder-file" key={`file:${node.name}`}><span>·</span><code>{node.name}</code><small>{((node.size ?? 0) / 1_024).toFixed(1)} KB</small></div>)}</div>;
}

function BudgetHud({ budget, manifest }: { budget: EngineerBudgetSnapshot | null; manifest: PlanProposal["manifest"] | null }) {
  const limits = budget?.limits ?? (manifest ? { costUsd: manifest.costBudgetUsd, tokens: manifest.tokenBudget, timeSeconds: manifest.timeBudgetSeconds } : null);
  if (!limits) return null;
  if (!budget) return <section className="engineer-budget-hud engineer-budget-hud--pending"><div><span className="engineer-kicker">Run budget</span><strong>${limits.costUsd} · {limits.tokens.toLocaleString()} tokens · {Math.round(limits.timeSeconds / 60)} min</strong></div><small>Live spend appears when execution begins.</small></section>;
  const activeReservedCost = Math.max(0, budget.reserved.costUsd - budget.ambiguous.costUsd);
  const activeReservedTokens = Math.max(0, budget.reserved.tokens - budget.ambiguous.tokens);
  const hasAmbiguousProviderUsage = budget.ambiguous.costUsd > 0 || budget.ambiguous.tokens > 0;
  const rows = [
    { label: "Cost", value: budget.used.costUsd + budget.reserved.costUsd, max: limits.costUsd, display: `$${budget.used.costUsd.toFixed(2)} settled + $${activeReservedCost.toFixed(2)} active${hasAmbiguousProviderUsage ? ` + $${budget.ambiguous.costUsd.toFixed(2)} awaiting provider reconciliation` : ""}` },
    { label: "Tokens", value: budget.used.tokens + budget.reserved.tokens, max: limits.tokens, display: `${budget.used.tokens.toLocaleString()} settled + ${activeReservedTokens.toLocaleString()} active${hasAmbiguousProviderUsage ? ` + ${budget.ambiguous.tokens.toLocaleString()} awaiting provider reconciliation` : ""}` },
    { label: "Time", value: budget.used.timeSeconds, max: limits.timeSeconds, display: `${Math.round(budget.used.timeSeconds / 60)} min elapsed` },
  ];
  return <section className={`engineer-budget-hud engineer-budget-hud--${budget.status.toLowerCase()}`} aria-label="Live run budget">
    <div className="engineer-budget-hud-title"><div><span className="engineer-kicker">Live autonomy budget</span><strong>{budget.status === "PAUSED" ? "Paused at the hard ceiling" : budget.status === "WARNING" ? "Approaching a limit" : "Within limits"}</strong></div><small>Settled + active + provider-ambiguous allowance · updated {new Date(budget.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>
    <div className="engineer-budget-bars">{rows.map((row) => { const percent = row.max > 0 ? Math.min(100, (row.value / row.max) * 100) : 100; return <div key={row.label} className="engineer-budget-row"><div><span>{row.label}</span><strong>{row.display}</strong><small>{Math.max(0, 100 - percent).toFixed(0)}% remaining</small></div><progress max="100" value={percent} /></div>; })}</div>
    {hasAmbiguousProviderUsage ? <p className="engineer-budget-note" role="status">A timed-out provider request may still be billed. Zintus keeps that allowance fenced and will not replay it automatically.</p> : null}
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
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copy = async (label: string, content: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(content);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus(`${label} copy failed`);
    }
  };
  const proposedFileContent = (fileDiff: string): string | null => {
    // A unified patch contains only changed hunks for existing files. New files
    // can be reconstructed locally without pretending that partial hunks are a
    // complete final file.
    if (!/^new file mode /m.test(fileDiff)) return null;
    const lines = fileDiff.split("\n");
    const hunkLines = lines.filter((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith(" "));
    if (hunkLines.some((line) => line.startsWith("-") || line.startsWith(" "))) return null;
    return hunkLines.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)).join("\n");
  };
  if (!files.length) return <div className="engineer-diff-empty"><strong>No code changes yet</strong><p>Implementation has not produced a diff. Return here after the Builder writes a file; this review workspace never triggers a model call.</p></div>;
  return <div className="engineer-diff-viewer"><div className="engineer-diff-summary"><div><strong>{files.length} changed {files.length === 1 ? "file" : "files"}</strong><small>Local review tools only · no gateway request or model cost</small></div><div className="engineer-diff-actions"><button onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(files.map((file) => file.id)))}>{collapsed.size ? "Expand all" : "Collapse all"}</button><button onClick={() => void copy("All changes", diff)}>Copy all changes</button><button onClick={() => downloadBlob("zintus-engineer.patch.diff", new Blob([diff], { type: "text/x-diff;charset=utf-8" }))}>Download patch</button></div></div>{copyStatus ? <p className="engineer-copy-status" role="status">{copyStatus}</p> : null}<nav className="engineer-diff-file-list" aria-label="Changed files">{files.map((file) => <button key={file.id} onClick={() => document.getElementById(`diff-${file.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}><code>{file.path}</code></button>)}</nav>{files.map((file) => {
    const isCollapsed = collapsed.has(file.id);
    const finalContent = proposedFileContent(file.content);
    return <section id={`diff-${file.id}`} key={file.id} className="engineer-diff-file"><div className="engineer-diff-file-header"><button onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })}><span>{isCollapsed ? "›" : "⌄"}</span><code>{file.path}</code></button><div className="engineer-diff-file-actions"><button onClick={() => void copy(`${file.path} diff`, file.content)}>Copy diff</button>{finalContent !== null ? <button onClick={() => void copy(`${file.path} content`, finalContent)}>Copy file content</button> : null}</div></div>{!isCollapsed ? <div className="engineer-diff-lines">{file.content.split("\n").map((line, index) => <div key={`${file.id}:${index}`} className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : line.startsWith("@@") ? "hunk" : "context"}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div> : null}</section>;
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
  const onlineMode = usePathname() === "/engineer/online";
  const [request, setRequest] = useState("");
  const [repository, setRepository] = useState<EngineerRepository>({ repositoryId: "local-repository", provider: "local", owner: "local", name: "zintus", baseBranch: "main", baseCommitSha: "" });
  const [run, setRun] = useState<EngineerRun | null>(null);
  const [runCapabilities, setRunCapabilities] = useState<EngineerRunCapabilities | null>(null);
  const [plan, setPlan] = useState<PlanProposal | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [data, setData] = useState<EvidenceData | null>(null);
  const [tab, setTab] = useState<"timeline" | "diff" | "evidence">("timeline");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerError, setManagerError] = useState<string | null>(null);
  const [activity, setActivity] = useState<EngineerRunStatus["activity"] | null>(null);
  const [displayedDiffHash, setDisplayedDiffHash] = useState<string | null>(null);
  const [gatewayToken, setGatewayToken] = useState("");
  const [gatewayAuthenticated, setGatewayAuthenticated] = useState(false);
  const [gatewayState, setGatewayState] = useState<GatewayConnectionState>("offline");
  const [hardeningReadiness,setHardeningReadiness]=useState<"READY"|"DEGRADED"|"UNKNOWN">("UNKNOWN");
  const [publicationReadiness, setPublicationReadiness] = useState<EngineerPublicationReadiness | null>(null);
  const [judgeSession, setJudgeSession] = useState<EngineerJudgeSession | null>(null);
  const [judgeSessionChecked, setJudgeSessionChecked] = useState(false);
  const [showAdvancedGateway, setShowAdvancedGateway] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [admittedRepositories, setAdmittedRepositories] = useState<EngineerRepository[]>([]);
  const [recentRuns, setRecentRuns] = useState<EngineerRun[]>([]);
  const [recentRunsCursor, setRecentRunsCursor] = useState<string | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [folderSnapshot, setFolderSnapshot] = useState<{ name: string; files: number; bytes: number; truncated: boolean; scannedMs: number; tree: FolderTreeNode[] } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [budget, setBudget] = useState<EngineerBudgetSnapshot | null>(null);
  const [budgetPresetIndex, setBudgetPresetIndex] = useState(2);
  const [budgetPresetTouched, setBudgetPresetTouched] = useState(false);
  const [topUp, setTopUp] = useState(TOP_UP_DEFAULTS);
  const [topUpPending, setTopUpPending] = useState(false);
  const [topUpNotice, setTopUpNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const planningRequestRef = useRef<AbortController | null>(null);
  const createRunIdRef = useRef<string | null>(null);
  const cancellationRequestedRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const topUpPendingRef = useRef(false);
  const actionLockRef = useRef(new EngineerActionLock());
  const recommendedPresetIndex = useMemo(() => recommendedEngineerBudgetPresetIndex(request), [request]);

  useEffect(() => {
    const prefilled = window.sessionStorage.getItem("zintus-engineer-prefill-request");
    if (!prefilled) return;
    window.sessionStorage.removeItem("zintus-engineer-prefill-request");
    setRequest(prefilled);
  }, []);

  useEffect(() => {
    if (!budgetPresetTouched) setBudgetPresetIndex(recommendedPresetIndex);
  }, [budgetPresetTouched, recommendedPresetIndex]);

  useEffect(() => {
    let active = true;
    void getEngineerJudgeSession()
      .then((session) => { if (active) setJudgeSession(session); })
      .catch(() => { if (active) setJudgeSession(null); })
      .finally(() => { if (active) setJudgeSessionChecked(true); });
    return () => { active = false; };
  }, []);

  const withRunMutation = useCallback(async (action: string, work: () => Promise<void>) => {
    await actionLockRef.current.run("run-control", async () => {
      setPendingAction(action);
      setBusy(true);
      try { await work(); }
      finally {
        setPendingAction((current) => current === action ? null : current);
        setBusy(false);
      }
    });
  }, []);

  const refresh = useCallback(async (runId: string) => {
    const snapshot = await getEngineerSnapshot(runId);
    if (activeRunIdRef.current !== runId) return;
    const status = snapshot.status; const nextData = snapshot.data; const nextBudget = snapshot.status.budget;
    setRun((current) => !current || status.run.runId !== current.runId || status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    setActivity(status.activity);
    setRunCapabilities(status.capabilities);
    setData(nextData);
    setBudget(nextBudget);
    setEvents(snapshot.events);
  }, []);

  const refreshLiveSummary = useCallback(async (runId: string) => {
    const { status, budget: nextBudget } = await getEngineerLiveSummary(runId);
    if (activeRunIdRef.current !== runId) return;
    setRun((current) => current?.runId === runId && status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    setActivity(status.activity);
    setRunCapabilities(status.capabilities);
    if (nextBudget) setBudget((current) => !current || current.runId !== runId || nextBudget.revision >= current.revision ? nextBudget : current);
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); planningRequestRef.current?.abort(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const watch = useCallback((runId: string, afterSequence = 0) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void streamEngineerEvents(runId, (event) => {
      setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event]);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        if (event.reasonCode === "VERIFIED_CANDIDATE_PROMOTED" || /^(HUMAN_APPROVAL_|HUMAN_(APPROVED|REJECTED|REQUESTED_CHANGES))/.test(event.reasonCode)) void refresh(runId);
        else void refreshLiveSummary(runId);
      }, 100);
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

  useEffect(() => {
    if (!run || TERMINAL.has(run.state) || run.state === "PAUSED_BUDGET" || HUMAN_DECISION_STATES.has(run.state)) return;
    const runId = run.runId;
    const update = async () => {
      await refreshLiveSummary(runId).catch(() => undefined);
      if (run.state === "IMPLEMENTING") {
        const diff = await getEngineerDiff(runId).catch(() => null);
        if (diff !== null && activeRunIdRef.current === runId) {
          setData((current) => current ? { ...current, diff } : current);
        }
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 2_000);
    return () => window.clearInterval(timer);
  }, [refreshLiveSummary, run?.runId, run?.state]);

  useEffect(() => {
    let current = true;
    setDisplayedDiffHash(null);
    void engineerTextSha256(data?.diff ?? "").then((hash) => { if (current) setDisplayedDiffHash(hash); });
    return () => { current = false; };
  }, [data?.diff, run?.runId]);

  const loadDashboard = useCallback(async (reportAuthorizationError = false) => {
    const connection = await fetchGatewayConnection();
    setGatewayState(connection.state);
    if (connection.state === "connected") setGatewayAuthenticated(true);
    const [canonical, history, connector, hardening, admissions] = await Promise.allSettled([
      getEngineerRepository(), listEngineerRunsPage(), getGithubConnector(), getEngineerHardeningReadiness(), listEngineerRepositories(),
    ]);
    if (canonical.status === "fulfilled") setRepository(canonical.value);
    if (history.status === "fulfilled") { setRecentRuns(history.value.runs); setRecentRunsCursor(history.value.nextCursor); }
    if (connector.status === "fulfilled") { setGithubConfigured(connector.value.configured); setGithubConnected(connector.value.connected); }
    setHardeningReadiness(hardening.status==="fulfilled"?hardening.value.state:"UNKNOWN");
    if (admissions.status === "fulfilled") setAdmittedRepositories(admissions.value);
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

  // AppShell may establish or renew the shared in-memory loopback session while
  // this page is mounted. Reconcile the Engineer dashboard immediately so its
  // local status and durable runs do not wait for a refresh or token entry.
  useEffect(() => {
    const reconnect = () => { void loadDashboard(); };
    window.addEventListener(GATEWAY_CREDENTIAL_CHANGED_EVENT, reconnect);
    return () => window.removeEventListener(GATEWAY_CREDENTIAL_CHANGED_EVENT, reconnect);
  }, [loadDashboard]);

  // The browser may open before the local gateway has finished its preflight.
  // Retry only while it is unreachable so zero-terminal onboarding heals
  // automatically after the gateway becomes ready, without token re-entry or
  // a manual page refresh.
  useEffect(() => {
    if (gatewayState !== "offline") return;
    const reconnect = () => { void loadDashboard(); };
    const timer = window.setInterval(reconnect, 3_000);
    window.addEventListener("focus", reconnect);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reconnect);
    };
  }, [gatewayState, loadDashboard]);

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
  const disconnectGithub = async () => {
    setBusy(true); setError(null);
    try {
      await disconnectGithubConnector();
      setGithubConnected(false);
      setAdmittedRepositories((current) => current.filter((item) => item.provider !== "github"));
      setRepository(await getEngineerRepository());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to disconnect GitHub"); }
    finally { setBusy(false); }
  };

  const selectGithubRepository = async (candidate: EngineerRepository) => {
    setBusy(true); setError(null);
    try {
      if (candidate.provider !== "github") throw new Error("This repository is not admitted through the GitHub connector.");
      setRepository(candidate);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to select the admitted GitHub repository"); }
    finally { setBusy(false); }
  };

  const useLocalRepository = async () => {
    setBusy(true); setError(null);
    try { setRepository(await getEngineerRepository()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load the verified local repository"); }
    finally { setBusy(false); }
  };

  // Browser-only inspection is intentionally read-only. The selected directory
  // never leaves this tab; the local gateway remains the execution/editing
  // surface. Write access is requested only after an explicit user action.
  const chooseLocalFolder = async () => {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<unknown> }).showDirectoryPicker;
    if (!picker) { setError("Folder access is unavailable in this browser. Use Chrome or the local gateway."); return; }
    setFolderBusy(true); setError(null);
    try {
      const root = await picker({ mode: "read" }) as { name: string; values?: () => AsyncIterable<unknown> };
      const started = performance.now();
      let files = 0; let bytes = 0; let entries = 0; let treeNodes = 0; let truncated = false;
      const visit = async (directory: { values?: () => AsyncIterable<unknown> }, depth: number): Promise<FolderTreeNode[]> => {
        const nodes: FolderTreeNode[] = [];
        if (!directory.values || truncated) return nodes;
        if (depth > FOLDER_INVENTORY_MAX_DEPTH) { truncated = true; return nodes; }
        for await (const entry of directory.values()) {
          entries += 1;
          if (entries > FOLDER_INVENTORY_MAX_ENTRIES || files >= FOLDER_INVENTORY_MAX_FILES) { truncated = true; return nodes; }
          const item = entry as { kind?: string; name?: string; values?: () => AsyncIterable<unknown>; getFile?: () => Promise<{ size: number }> };
          if (item.kind === "directory") {
            if (item.name === ".git" || item.name === "node_modules") continue;
            const children = await visit(item, depth + 1);
            if (treeNodes < FOLDER_TREE_MAX_NODES) {
              treeNodes += 1;
              nodes.push({ name: item.name ?? "folder", kind: "directory", children });
            } else truncated = true;
          } else if (item.kind === "file" && item.getFile) {
            const file = await item.getFile(); files += 1; bytes += file.size;
            if (treeNodes < FOLDER_TREE_MAX_NODES) {
              treeNodes += 1;
              nodes.push({ name: item.name ?? "file", kind: "file", size: file.size });
            } else truncated = true;
          }
          if (truncated && treeNodes >= FOLDER_TREE_MAX_NODES) return nodes;
        }
        return nodes;
      };
      const tree = await visit(root, 0);
      setFolderSnapshot({ name: root.name, files, bytes, truncated, scannedMs: Math.round(performance.now() - started), tree });
    } catch (cause) {
      if ((cause as { name?: string })?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Unable to read the selected folder");
    } finally { setFolderBusy(false); }
  };
  const openRun = useCallback(async (runId: string) => {
    setError(null);
    abortRef.current?.abort();
    if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
    activeRunIdRef.current = runId;
    const [snapshot, storedPlan, nextPublicationReadiness] = await Promise.all([
      getEngineerSnapshot(runId),
      getEngineerPlan(runId).catch(() => null),
      getEngineerPublicationReadiness().catch(() => ({ state: "UNAVAILABLE", message: "Verified locally. Publication readiness could not be confirmed from this gateway." } as EngineerPublicationReadiness)),
    ]);
    if (activeRunIdRef.current !== runId) return;
    setRun(snapshot.status.run); setRunCapabilities(snapshot.status.capabilities); setPlan(storedPlan); setData(snapshot.data); setBudget(snapshot.status.budget); setEvents(snapshot.events); setManagerError(snapshot.status.lastError); setActivity(snapshot.status.activity); setPublicationReadiness(nextPublicationReadiness);
    window.localStorage.setItem(RUN_STORAGE_KEY, runId);
    window.history.replaceState(null, "", `${window.location.pathname}?run=${encodeURIComponent(runId)}`);
    if (snapshot.status.run.state !== "PAUSED_BUDGET" && !TERMINAL.has(snapshot.status.run.state)) watch(runId, snapshot.latestEventSequence);
  }, [watch]);

  const returnToRuns = useCallback(() => {
    abortRef.current?.abort();
    activeRunIdRef.current = null;
    if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
    window.localStorage.removeItem(RUN_STORAGE_KEY);
    window.history.replaceState(null, "", window.location.pathname);
    setRun(null); setRunCapabilities(null); setPlan(null); setData(null); setBudget(null); setEvents([]); setManagerError(null); setActivity(null); setPublicationReadiness(null); setError(null);
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    // Sidebar navigation always lands on /engineer and should show the intake
    // screen. A durable run is restored only through an explicit run URL, so
    // browser storage cannot make the Engineer home feel permanently stuck.
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) { void loadDashboard(); return; }
    let active = true;
    void openRun(runId).catch((cause) => {
      if (!active) return;
      // A gateway restart or transient handshake failure must never orphan a
      // durable run from the person who started it. Keep both the URL and the
      // stored pointer; the dashboard can reconnect and the user can retry the
      // exact same run without inventing a replacement.
      setError(cause instanceof Error ? `Unable to reopen this run yet: ${cause.message}` : "Unable to reopen this run yet. Check the gateway connection and try again.");
      void loadDashboard();
    });
    return () => { active = false; };
  }, [loadDashboard, openRun]);

  const submit = async () => {
    if (!request.trim() || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(repository.baseCommitSha)) return;
    await withRunMutation("create-plan", async () => {
      setError(null);
      cancellationRequestedRef.current = false;
      try {
        const selectedBudget = judgeSession
          ? { costBudgetUsd: judgeSession.limits.costUsd, tokenBudget: judgeSession.limits.tokens, timeBudgetSeconds: judgeSession.limits.timeSeconds }
          : engineerBudgetPreset(budgetPresetIndex).limits;
        const runId = createRunIdRef.current ?? crypto.randomUUID();
        createRunIdRef.current = runId;
        const created = await createEngineerRun({ runId, repository, request: request.trim(), budget: selectedBudget });
        activeRunIdRef.current = created.runId;
        setRun(created); window.localStorage.setItem(RUN_STORAGE_KEY, created.runId);
        window.history.replaceState(null, "", `${window.location.pathname}?run=${encodeURIComponent(created.runId)}`);
        watch(created.runId);
        const planningRequest = new AbortController();
        planningRequestRef.current = planningRequest;
        const proposal = await planEngineerRun(created.runId, created.stateVersion, planningRequest.signal);
        setPlan(proposal);
        await refresh(created.runId);
      } catch (cause) {
        if (activeRunIdRef.current) await refresh(activeRunIdRef.current).catch(() => undefined);
        if (!cancellationRequestedRef.current &&
            (cause as { name?: string; code?: string })?.name !== "AbortError" &&
            (cause as { code?: string })?.code !== "VERIFICATION_SCOPE_DECISION_REQUIRED") {
          setError(cause instanceof Error ? cause.message : "Unable to create Engineer run");
        }
      }
      finally { planningRequestRef.current = null; }
    });
  };

  const retryPlanning = async () => {
    if (!run) return;
    await withRunMutation("retry-planning", async () => {
      setError(null); setManagerError(null);
      cancellationRequestedRef.current = false;
      watch(run.runId, events.at(-1)?.sequence ?? 0);
      const planningRequest = new AbortController();
      planningRequestRef.current = planningRequest;
      try { const proposal = await planEngineerRun(run.runId, run.stateVersion, planningRequest.signal); setPlan(proposal); await refresh(run.runId); }
      catch (cause) { await refresh(run.runId).catch(() => undefined); if (!cancellationRequestedRef.current && (cause as { name?: string })?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Unable to plan Engineer run"); }
      finally { planningRequestRef.current = null; }
    });
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
    await withRunMutation(`decision:${decisionId}`, async () => {
      setError(null);
      try {
        const result = await resolveEngineerDecision(run, decisionId, optionId, "Selected through the Zintus decision inbox.");
        if (result.plan) setPlan(result.plan);
        if (result.planningError) setError(result.planningError);
        // A decision closes the previous stream at CLARIFICATION_REQUIRED. Start
        // a fresh stream from the retained cursor before refreshing, otherwise a
        // successful background replan can leave the button stuck on “Applying”.
        watch(run.runId, events.at(-1)?.sequence ?? 0);
        await refresh(run.runId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to resolve decision");
      }
    });
  }, [events, refresh, run, watch, withRunMutation]);

  const freezeAndStart = async () => {
    if (!run || !plan) return;
    await withRunMutation("freeze-start", async () => {
      setError(null);
      try {
        const frozen = await freezeEngineerPlan(run, plan.manifest);
        setRun(frozen);
        const queued = await startEngineerRun(frozen.runId, frozen.stateVersion);
        setRun(queued); setEvents([]); watch(queued.runId);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start Engineer run"); }
    });
  };

  const regenerateCorrectedPlan = async () => {
    if (!run || run.state !== "PLAN_READY") return;
    await withRunMutation("replan-explicit-contract", async () => {
      setError(null);
      try {
        const corrected = await replanEngineerExplicitContract(run.runId, run.stateVersion);
        setPlan(corrected);
        await refresh(run.runId);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to regenerate the frozen contract"); }
    });
  };

  const startFrozen = async () => {
    if (!run || run.state !== "PLAN_FROZEN") return;
    await withRunMutation("start-frozen", async () => {
      setError(null);
      try { const queued = await startEngineerRun(run.runId, run.stateVersion); setRun(queued); setEvents([]); watch(queued.runId); }
      catch (cause) { const status = await getEngineerRunStatus(run.runId).catch(() => null); if (status) { setRun(status.run); setManagerError(status.lastError); } setError(cause instanceof Error ? cause.message : "Unable to start Engineer run"); }
    });
  };

  const openResolutionDesk = () => {
    if (!run) return;
    window.location.assign(`/engineer/resolution?run=${encodeURIComponent(run.runId)}`);
  };

  // R8-3 P1 #2 + P1 #3: the two stranded legacy-gate states (BASE_BRANCH_STALE and
  // HUMAN_APPROVAL_PENDING) are recovered EXCLUSIVELY through the Resolution Desk —
  // the single correction authority. The retired stale-base bypass and the legacy
  // approve/reject/extend controls are gone; both states now open a durable case
  // (the R7-4 adoption path accepts these stranded states) where a bounded
  // corrected run is authorized against the current base.
  const openStrandedRunInResolutionDesk = () => {
    if (!run) return;
    window.location.assign(`/engineer/resolution?run=${encodeURIComponent(run.runId)}`);
  };

  const prepareNewBoundedRun = () => {
    if (!run) return;
    const sourceRequest = run.requestOriginal;
    // A caller-generated ID is an idempotency identity, not a form field. A
    // fresh bounded request must never reuse the exhausted run's identity just
    // because the user accepts the prefilled text without editing it first.
    createRunIdRef.current = null;
    returnToRuns();
    setRequest(sourceRequest);
    setBudgetPresetTouched(false);
    setBudgetPresetIndex(recommendedEngineerBudgetPresetIndex(sourceRequest));
  };

  const approval = data?.approval as EngineerApproval | null | undefined;
  const verifiedCandidate = data?.verifiedCandidate ?? null;

  // R8-3 P1 #3: the legacy approval WRITE decisions (approve / request-changes /
  // reject) and approval extension are removed from the UI — recovery for a
  // stranded run runs exclusively through the Resolution Desk. Only cancel (the
  // run's stop authority) remains here.
  const decide = async (action: "cancel") => {
    if (!run) return;
    // Cancellation is an emergency stop authority, not a normal workflow
    // mutation. Planning owns the general action lock while its request is in
    // flight; putting cancel behind that lock makes the one control intended to
    // interrupt planning unavailable. The gateway persists cancellation before
    // draining model/sandbox work, so this direct request is still idempotent.
    if (cancelling) return;
    cancellationRequestedRef.current = true;
    planningRequestRef.current?.abort();
    setCancelling(true);
    setPendingAction("cancel");
    setError(null);
    try {
      await engineerDecision(run.runId, action, reason.trim() || `${action} from Zintus Engineer`, undefined);
      setReason("");
      await refresh(run.runId);
    }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Cancellation failed";
      setError(message);
    }
    finally {
      setPendingAction((current) => current === "cancel" ? null : current);
      setCancelling(false);
    }
  };

  const resolveHumanReview = async (decision: "reject" | "retry") => {
    if (!run) return;
    await withRunMutation(`human-review:${decision}`, async () => {
      setError(null);
      try {
        await resolveHumanEngineerReview(run.runId, decision, reason.trim() || `${decision} human review from Zintus Engineer`, run.stateVersion);
        setReason(""); await refresh(run.runId);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Human review decision failed"); }
    });
  };

  const applyTopUp = async (resume: boolean) => {
    if (!run || !budget || topUpBudgetCapability?.availability !== "AVAILABLE" || topUpPendingRef.current) return;
    topUpPendingRef.current = true;
    setTopUpPending(true);
    setBusy(true); setError(null);
    try {
      const expectedRevision = topUpBudgetCapability.expectedBudgetRevision;
      if (typeof expectedRevision !== "number") throw new Error("The gateway budget capability is incomplete. Refresh the run before changing its allowance.");
      const updated = await topUpEngineerBudget(run.runId, { operationId: crypto.randomUUID(), expectedRevision, ...topUp });
      setBudget(updated);
      setTopUpNotice(`Allowance added once. New ceiling: $${updated.limits.costUsd} / ${updated.limits.tokens.toLocaleString()} tokens.`);
      if (resume) {
        try {
          // Re-read the authoritative state after top-up. A different tab may
          // have changed the run while this request was in flight; never resume
          // from a stale client-side version.
          const latest = await getEngineerRunStatus(run.runId);
          setRun(latest.run); setRunCapabilities(latest.capabilities); setManagerError(latest.lastError);
          const resumeCapability = latest.capabilities.actions.find((item) => item.action === "RESUME_BUDGET");
          if (resumeCapability?.availability !== "AVAILABLE" || typeof resumeCapability.expectedBudgetRevision !== "number") {
            throw new Error(resumeCapability?.message ?? "The gateway did not authorize a budget resume. Refresh the run before trying again.");
          }
          const resumed = await resumeEngineerBudget(run.runId, { expectedStateVersion: resumeCapability.expectedStateVersion, expectedBudgetRevision: resumeCapability.expectedBudgetRevision });
          const latestSequence = events.at(-1)?.sequence ?? 0;
          setRun(resumed); watch(resumed.runId, latestSequence);
        } catch (cause) {
          await refresh(run.runId);
          setTopUpNotice("Allowance was added exactly once, but resume did not complete. Use Resume with current allowance; do not add it again.");
          throw cause;
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the run budget"); }
    finally { topUpPendingRef.current = false; setTopUpPending(false); setBusy(false); }
  };

  const resumeCurrentBudget = async () => {
    if (!run || !budget || resumeBudgetCapability?.availability !== "AVAILABLE" || typeof resumeBudgetCapability.expectedStateVersion !== "number" || typeof resumeBudgetCapability.expectedBudgetRevision !== "number") return;
    const expectedStateVersion = resumeBudgetCapability.expectedStateVersion;
    const expectedBudgetRevision = resumeBudgetCapability.expectedBudgetRevision;
    await withRunMutation("resume-budget", async () => {
      setError(null);
      try {
        const resumed = await resumeEngineerBudget(run.runId, { expectedStateVersion, expectedBudgetRevision });
        const latestSequence = events.at(-1)?.sequence ?? 0;
        setRun(resumed); setManagerError(null); watch(resumed.runId, latestSequence);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to resume with the current budget"); }
    });
  };

  const retryProviderTimeout = async () => {
    if (!run || run.state !== "MODEL_PROVIDER_RETRY_PENDING") return;
    await withRunMutation("retry-provider", async () => {
      setError(null);
      try {
        const resumed = await retryEngineerProviderTimeout(run.runId, run.stateVersion);
        const latestSequence = events.at(-1)?.sequence ?? 0;
        setRun(resumed); setManagerError(null); watch(resumed.runId, latestSequence);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to retry from the workspace checkpoint"); }
    });
  };

  const latestState = run?.state ?? "NEW";
  // Resolving a decision performs the next planning pass on the gateway. Until
  // that response arrives, the prior CLARIFICATION_REQUIRED snapshot is stale:
  // never show its retry panel or leave the just-selected choice actionable.
  const decisionApplyInFlight = pendingAction?.startsWith("decision:") ?? false;
  const artifacts = data?.artifacts ?? [];
  const claims = (data?.claims ?? []) as Array<{ claimId?: string; claim?: string; criterionId?: string | null; status?: string; notes?: string }>;
  const humanReviewBlockers = claims.filter((claim) => claim.status !== "VERIFIED" && claim.criterionId).slice(0, 3);
  const tests = (data?.tests ?? []) as Array<{ testExecutionId?: string; type?: string; status?: string }>;
  const findings = (data?.securityFindings ?? []) as Array<{ securityFindingId?: string; severity?: string; category?: string; description?: string; status?: string }>;
  const failures = (data?.failures ?? []) as Array<{ failureId?: string; reasonCode?: string; failureClass?: string }>;
  const correctionRecovery = engineerCorrectionRecovery(latestState, findings, failures);
  // The gateway is the authority on whether this immutable run can be adopted
  // by the Resolution Desk. Do not infer that solely from a terminal state:
  // HUMAN_REVIEW_REQUIRED may also expose a safe, bounded correction case.
  const resolutionDeskAvailable = runCapabilities?.actions.some((capability) =>
    capability.action === "OPEN_RESOLUTION_CASE" && capability.availability === "AVAILABLE",
  ) ?? false;
  const gitOperations = (data?.gitOperations ?? []) as Array<{ gitOperationId?: string; operationType?: string; status?: string; evidenceBundleHash?: string | null; remoteReference?: string | null; errorCode?: string | null }>;
  const evidenceBundles = (data?.evidenceBundles ?? []) as Array<{ evidenceBundleId?: string; bundleHash?: string }>;
  const decisions = (data?.decisions ?? []) as EngineerDecisionItem[];
  const diffProvenance = deriveDiffProvenance({
    state: latestState,
    displayedDiffHash,
    reviewBinding: data?.reviewBinding ?? null,
    evidenceBundles,
    approval,
    gitOperations,
  });
  const diffPresentation = DIFF_PROVENANCE_PRESENTATION[diffProvenance];
  const securityStatus = deriveSecurityStatus({ events, findingCount: findings.length, errors: data?.errors ?? [] });
  // The server is the recovery authority.  In particular, an ambiguous
  // Reviewer result must offer a reviewer-only retry, never a replacement run.
  const reviewerRetryCapability = runCapabilities?.actions.find((capability) => capability.action === "RETRY_REVIEWER");
  const isResolutionReplacement = runCapabilities?.budget.isResolutionReplacement ?? false;
  const humanReviewCanRetry = reviewerRetryCapability?.availability === "AVAILABLE";
  const reviewerRetryExhausted = reviewerRetryCapability?.reasonCode === "REVIEWER_RETRY_LIMIT_REACHED";
  const reviewerTimeoutHumanGate = latestState === "HUMAN_REVIEW_REQUIRED" && failures.some((failure) =>
    failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" ||
    failure.reasonCode === "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW");
  const humanReviewFailureReasons = failures
    .map((failure) => failure.reasonCode)
    .filter((reasonCode): reasonCode is string => Boolean(reasonCode))
    .filter((reasonCode, index, values) => values.indexOf(reasonCode) === index)
    .slice(0, 3);
  const reachedImplementation = events.some((event) => ["IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "VERIFICATION_RECOVERY", "REVERIFYING"].includes(event.nextState));
  const reachedVerification = events.some((event) => ["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE", "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING", "REVIEW_APPROVED", "REVIEW_CHANGES_REQUESTED", "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED"].includes(event.nextState));
  const visibleEvidenceErrors = reachedVerification ? (data?.errors ?? []) : [];
  const visibleTabs = ["timeline", ...(reachedImplementation ? ["diff"] : []), ...(reachedVerification ? ["evidence"] : [])] as Array<"timeline" | "diff" | "evidence">;
  useEffect(() => {
    if ((tab === "diff" && !reachedImplementation) || (tab === "evidence" && !reachedVerification)) setTab("timeline");
  }, [reachedImplementation, reachedVerification, tab]);
  const stage = useMemo(() => workflowStage(latestState), [latestState]);
  const costEstimate = useMemo(() => estimateEngineerCost(request, repository.name), [request, repository.name]);
  const planCapabilities = useMemo(() => plan ? frozenPlanCapabilities(plan.manifest, { githubConnected }) : [], [githubConnected, plan]);
  const budgetUsage = budget ? Math.max(
    budget.limits.costUsd > 0 ? (budget.used.costUsd + budget.reserved.costUsd) / budget.limits.costUsd : 0,
    budget.limits.tokens > 0 ? (budget.used.tokens + budget.reserved.tokens) / budget.limits.tokens : 0,
    budget.limits.timeSeconds > 0 ? budget.used.timeSeconds / budget.limits.timeSeconds : 0,
  ) : 0;
  const actionCapability = useCallback((action: EngineerRunCapabilities["actions"][number]["action"]) =>
    runCapabilities?.actions.find((item) => item.action === action) ?? null, [runCapabilities]);
  const resumeBudgetCapability = actionCapability("RESUME_BUDGET");
  const topUpBudgetCapability = actionCapability("TOP_UP_BUDGET");
  const prepareNewIntakeCapability = actionCapability("PREPARE_NEW_INTAKE");
  const canFreezePlan = actionCapability("FREEZE_PLAN")?.availability === "AVAILABLE";
  const canStartExecution = actionCapability("START_EXECUTION")?.availability === "AVAILABLE";
  const canRetryProvider = actionCapability("RETRY_PROVIDER")?.availability === "AVAILABLE";
  const canRetryPlanning = actionCapability("PLAN")?.availability === "AVAILABLE";
  const canCancelRun = actionCapability("CANCEL_RUN")?.availability === "AVAILABLE";
  const canResumePausedBudget = resumeBudgetCapability?.availability === "AVAILABLE";
  const canTopUpPausedBudget = topUpBudgetCapability?.availability === "AVAILABLE";
  const approachingBudget = budget?.status === "WARNING" || budgetUsage >= (budget?.warningThreshold ?? 0.8);
  const liveDiff = data?.diff ?? "";
  const liveChangedFiles = liveDiff.match(/^diff --git /gm)?.length ?? 0;
  const liveAddedLines = liveDiff.match(/^\+(?!\+\+)/gm)?.length ?? 0;
  const machineStage = /^(PLANNING|REPLANNING|QUEUED|SANDBOX_|CONTEXT_BUILDING|IMPLEMENTING|FAST_CHECKS|UNIT_TESTING|INTEGRATION_TESTING|E2E_TESTING|SECURITY_REVIEW|CODE_REVIEW|EVIDENCE_SYNTHESIS|REVIEWING|VERIFICATION_|REVERIFYING)/.test(latestState);

  if (!run && onlineMode && !judgeSession) return (
    <main className="engineer-screen engineer-screen--online">
      <EngineerTopbar gatewayState={gatewayState} />
      <section className="engineer-premium-preview engineer-premium-preview--access" aria-labelledby="online-engineer-title">
        <div>
          <span className="engineer-kicker">Zintus Engineer · Premium</span>
          <h1 id="online-engineer-title">{judgeSessionChecked ? "Online Engineer is not configured in this local app." : "Opening your secure online Engineer run…"}</h1>
          <p>{judgeSessionChecked ? "The automatic Premium session is available only after the web app is deployed with its server-side Engineer configuration. This screen did not start a model run or spend any budget." : "Connecting to the server-side Engineer session. Once connected, this page shows the real repository, plan, durable timeline, diff, evidence, and review controls—not a separate demo flow."}</p>
        </div>
        {judgeSessionChecked ? <a className="engineer-premium-preview-link" href="/engineer">Use local Engineer</a> : <PremiumPreviewAccess />}
      </section>
      {error ? <p className="engineer-error">{error}</p> : null}
    </main>
  );

  if (!run) return (
    <main className="engineer-screen">
      <EngineerTopbar gatewayState={gatewayState} />
      {!onlineMode ? <Link className="engineer-explainer-banner" href="/engineer/live">
        <span><strong>Want to know how Zintus Engineering works?</strong><small>Explore the required lane, evidence model, and a protected live walkthrough.</small></span>
        <b aria-hidden="true">Open walkthrough</b>
      </Link> : null}
      {!onlineMode ? <section className="engineer-premium-preview" aria-labelledby="online-engineer-title"><div><span className="engineer-kicker">Zintus Engineer · Premium</span><h2 id="online-engineer-title">{judgeSession ? "OpenAI access enabled." : judgeSessionChecked ? "Online Engineer is not configured here." : "Checking online Engineer access…"}</h2><p>{judgeSession ? "Run Zintus Engineer online, inspect the live plan, code diff, tests, and evidence, then decide what happens next. Your browser never receives an OpenAI key." : judgeSessionChecked ? "This local app can still use your private workspace, but the hosted online run is available only on a deployment with the server-side Engineer configuration." : "Zintus is checking whether this deployment can issue a protected server-side Engineer session."}</p></div><div className="engineer-premium-preview-actions">{judgeSession ? <Link className="engineer-premium-preview-link" href="/engineer/online">Start online run <span aria-hidden="true">→</span></Link> : <a className="engineer-premium-preview-link" href="#gateway-access">Use local Engineer <span aria-hidden="true">↓</span></a>}<small>{judgeSession ? "Online is the default. A local workspace is optional." : "Start the gateway and use a verified base commit for local runs."}</small></div></section> : null}
      {!onlineMode ? <section className="engineer-local-option" aria-labelledby="local-workspace-title"><div><span className="engineer-kicker">Optional private workspace</span><h2 id="local-workspace-title">Need to work with files on this computer?</h2><p>Connect a local workspace only when you want Zintus to inspect and test private files that are not in a connected repository. It is never required for online Engineer.</p></div><div className="engineer-local-option-actions"><a className="engineer-local-option-link" href="#gateway-access">Connect local workspace <span aria-hidden="true">↓</span></a><LocalWorkspaceInstructionsButton /></div></section> : null}
      <HardeningReadinessBanner state={hardeningReadiness} />
      {!onlineMode ? <section className="engineer-card" id="gateway-access">
        <div className="engineer-section-title"><span>01</span><div><h2>Gateway</h2><p>{gatewayState === "connected" ? "Connected through a secure local session. No token copy is required." : gatewayState === "authentication-required" ? "This gateway was explicitly configured to require an operator token." : gatewayState === "local-handshake-unavailable" ? "The gateway is running, but the secure local handshake could not complete. Restart the gateway and web app." : "Start the local gateway to connect automatically."}</p></div></div>
        <div className="engineer-actions"><span className={`engineer-status engineer-status--${gatewayState}`}>{gatewayState.replaceAll("-", " ")}</span><button onClick={() => setShowAdvancedGateway((value) => !value)}>{showAdvancedGateway ? "Hide advanced security" : "Advanced security"}</button></div>
        {showAdvancedGateway ? <div className="engineer-actions"><label>Operator token<input type="password" value={gatewayToken} autoComplete="off" onChange={(event) => setGatewayToken(event.target.value)} placeholder="Paste GATEWAY_TOKEN" /></label><button disabled={!gatewayToken.trim()} onClick={() => { setEphemeralGatewayToken(gatewayToken); setGatewayToken(""); setGatewayAuthenticated(true); void loadDashboard(true); }}>Use token for this tab</button>{gatewayAuthenticated ? <button onClick={() => { clearEphemeralGatewayToken(); setGatewayAuthenticated(false); void loadDashboard(); }}>Clear token</button> : null}</div> : null}
      </section> : null}
      <section className="engineer-card" id="repository-connector">
        <div className="engineer-section-title"><span>{onlineMode ? "01" : "02"}</span><div><h2>Repository</h2><p>{onlineMode ? "This run is bound to the connected workspace selected by the hosted Engineer gateway." : "Choose the exact source snapshot. Local remains the safe default."}</p></div></div>
        {onlineMode ? <div className="engineer-connector-grid"><div className="engineer-connector selected"><span aria-hidden="true">✓</span><div><strong>Connected workspace</strong><small>{repository.owner}/{repository.name} · {repository.baseBranch} · verified {repository.baseCommitSha ? repository.baseCommitSha.slice(0, 12) : "loading"}</small></div><i>Active</i></div></div> : <><div className="engineer-connector-grid">
          <button type="button" className={`engineer-connector${repository.provider === "local" ? " selected" : ""}`} onClick={() => void useLocalRepository()} disabled={busy}>
            <span aria-hidden="true">⌂</span><div><strong>Local repository</strong><small>{repository.provider === "local" ? `${repository.owner}/${repository.name}` : "Verified by the local gateway"}</small></div><i>{repository.provider === "local" ? "Active" : "Use local"}</i>
          </button>
          <button type="button" className={`engineer-connector${repository.provider === "github" ? " selected" : ""}`} onClick={() => { if (!githubConnected && githubConfigured) void connectGithub(); }} disabled={busy || !githubConfigured}>
            <span aria-hidden="true">GH</span><div><strong>GitHub</strong><small>{!githubConfigured ? "Not configured on this gateway" : githubConnected ? `${admittedRepositories.filter((item) => item.provider === "github").length} admitted repositories` : "Connect with scoped OAuth"}</small></div><i>{githubConnected ? "Connected" : "Connect"}</i>
          </button>
        </div>
        <div className="engineer-actions">{githubConfigured && !githubConnected ? <button onClick={() => void connectGithub()} disabled={busy}>Connect GitHub</button> : null}{githubConnected ? <button onClick={() => void disconnectGithub()} disabled={busy}>Disconnect GitHub</button> : null}<a href="/engineer/operations">Operations and cost health →</a></div>
        {githubConnected ? <div className="engineer-github-repositories"><strong>Engineer-admitted repositories</strong>{admittedRepositories.filter((item) => item.provider === "github").length ? <div>{admittedRepositories.filter((candidate) => candidate.provider === "github").map((candidate) => <button type="button" key={candidate.repositoryId} className={repository.provider === "github" && repository.repositoryId === candidate.repositoryId ? "selected" : ""} onClick={() => void selectGithubRepository(candidate)} disabled={busy}><span><strong>{candidate.owner}/{candidate.name}</strong><small>{candidate.baseBranch} · verified {candidate.baseCommitSha.slice(0, 12)}</small></span><i>{repository.provider === "github" && repository.repositoryId === candidate.repositoryId ? "Selected" : "Choose"}</i></button>)}</div> : <p className="engineer-muted">GitHub is connected, but no repository has a durable Engineer admission yet. Connector access alone never authorizes code execution.</p>}</div> : null}
        {!githubConfigured ? <p className="engineer-muted">GitHub is not configured on this gateway. Local repositories remain available.</p> : null}
        <div className="engineer-folder-picker">
          <div><strong>Inspect a local folder in this browser</strong><p className="engineer-muted">Read-only inventory only. This does not change the repository used by Engineer; execution remains bound to the verified gateway repository.</p></div>
          <div className="engineer-actions"><button onClick={() => void chooseLocalFolder()} disabled={folderBusy}>{folderBusy ? "Reading folder…" : "Inspect folder"}</button></div>
          {folderSnapshot ? <div className="engineer-folder-snapshot"><p className="engineer-muted"><strong>{folderSnapshot.name}</strong> · {folderSnapshot.files.toLocaleString()} files · {(folderSnapshot.bytes / 1024 / 1024).toFixed(1)} MB · scanned in {folderSnapshot.scannedMs.toLocaleString()} ms{folderSnapshot.truncated ? " · preview safely truncated" : ""}</p><FolderTree nodes={folderSnapshot.tree} /></div> : null}
        </div></>}
      </section>
      {recentRuns.length ? <section className="engineer-card" id="recent-runs">
        <div className="engineer-section-title"><span>03</span><div><h2>Recent durable runs</h2><p>Reopen a gateway-ledger run after any browser restart.</p></div></div>
        <div className="engineer-list">{(showAllRuns ? recentRuns : recentRuns.slice(0, 2)).map((item) => <button key={item.runId} onClick={() => void openRun(item.runId)}>
          <span className={`engineer-status engineer-status--${item.state.toLowerCase()}`}>{item.state.replaceAll("_", " ")}</span>
          <div><strong>{item.requestNormalized || item.requestOriginal}</strong><code>{item.runId}</code></div>
        </button>)}</div>
        {recentRuns.length > 2 ? <button className="engineer-secondary" onClick={() => setShowAllRuns((value) => !value)}>{showAllRuns ? "Show fewer runs" : `Show ${recentRuns.length - 2} more runs`}</button> : null}
        {showAllRuns && recentRunsCursor ? <button className="engineer-secondary" disabled={busy} onClick={() => void loadOlderRuns()}>{busy ? "Loading…" : "Load older runs"}</button> : null}
      </section> : null}
      <section className="engineer-card engineer-new-run">
        <div className="engineer-section-title"><span>{onlineMode ? "02" : "04"}</span><div><h2>New engineering run</h2><p>One bounded request. One evidence-driven workflow.</p></div></div>
        <label>Feature or bug<textarea value={request} onChange={(event) => { createRunIdRef.current = null; setRequest(event.target.value); }} rows={5} placeholder="Add a bounded feature with measurable acceptance criteria…" /></label>
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
        {judgeSession ? <section className="engineer-budget-picker"><div className="engineer-card-heading"><div><h3>Live demo budget</h3><p>This session is server-enforced. The browser cannot raise it.</p></div><span className="engineer-chip">No overages</span></div><div className="engineer-budget-readout"><div><span>Max cost</span><strong>${judgeSession.limits.costUsd}</strong></div><div><span>Max tokens</span><strong>{formatEngineerTokenLimit(judgeSession.limits.tokens)}</strong></div><div><span>Max minutes</span><strong>{Math.round(judgeSession.limits.timeSeconds / 60)}</strong></div></div><p className="engineer-budget-note">Prepared environment only · one run for this session · expires {new Date(judgeSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · publication and budget top-ups are disabled.</p></section> : <BudgetSlider index={budgetPresetIndex} recommendedIndex={recommendedPresetIndex} onChange={(index) => { setBudgetPresetTouched(true); setBudgetPresetIndex(index); }} />}
        {error ? <p className="engineer-error">{error}</p> : null}
        <button className="engineer-primary" onClick={() => void submit()} disabled={busy || !request.trim() || !repository.baseCommitSha}>{busy ? "Planning…" : "Create evidence plan"}</button>
      </section>
    </main>
  );

  if (plan && run.state === "PLAN_READY") {
    const explicitContractError = [error, managerError].find((value) => Boolean(value?.includes("Frozen contract does not preserve explicit user requirements"))) ?? null;
    return (
    <main className="engineer-screen">
      <RunHeader run={run} stage={stage} onBack={returnToRuns} />
      <HardeningReadinessBanner state={hardeningReadiness} />
      {isResolutionReplacement ? <section className="engineer-card engineer-gate"><span className="engineer-kicker">Bounded correction</span><h2>This run continues a prior verified record</h2><p>Zintus created this replacement from a signed Resolution Desk directive. Its budget is fixed, its lineage is checked before publication, and the original run remains preserved for audit.</p></section> : null}
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
          <div><span>Denied paths</span>{plan.manifest.deniedPaths.length ? plan.manifest.deniedPaths.map((path) => <code key={path}>{path}</code>) : <p>None beyond mandatory Supervisor protections.</p>}</div>
          <div><span>Commands</span>{plan.manifest.allowedCommands.map((command) => <code key={command}>{command}</code>)}</div>
          <div><span>Prohibited commands</span>{plan.manifest.prohibitedCommands.length ? plan.manifest.prohibitedCommands.map((command) => <code key={command}>{command}</code>) : <p>Supervisor policy still blocks shell, network, credential, push, merge, and deploy operations.</p>}</div>
          <div><span>Capability summary</span>{planCapabilities.map((capability) => <p key={capability.id}><strong>{capability.label}</strong><br />{capability.summary}</p>)}</div>
          <div><span>Hard budget</span><strong>${plan.manifest.costBudgetUsd} · {plan.manifest.tokenBudget.toLocaleString()} tokens</strong><small>{Math.round(plan.manifest.timeBudgetSeconds / 60)} minutes · pauses at the first limit</small></div>
          <div><span>Architecture</span><p>{plan.planningAnalysis.architectureSummary}</p></div>
          <div><span>Assumptions</span>{plan.planningAnalysis.assumptions.length ? plan.planningAnalysis.assumptions.map((item) => <p key={item.assumptionId}>{item.statement} · {Math.round(item.confidence * 100)}% confidence</p>) : <p>None recorded.</p>}</div>
          <div><span>Estimated files</span>{plan.planningAnalysis.touchedFileEstimates.map((item) => <code key={item.path}>{item.path}</code>)}</div>
          {error ? <p className="engineer-error">{error}</p> : null}
          {managerError ? <p className="engineer-error">{managerError}</p> : null}
          {explicitContractError ? <section className="engineer-contract-block" role="alert"><strong>Contract correction required</strong><p>The plan cannot freeze because it weakened an explicit user requirement. Regenerating sends this exact failure back to the Planner in the same run; no Builder or Reviewer is started.</p><button className="engineer-primary" onClick={() => void regenerateCorrectedPlan()} disabled={busy}>{pendingAction === "replan-explicit-contract" ? "Regenerating…" : "Regenerate corrected plan"}</button></section> : null}
          <button className="engineer-primary" onClick={() => void freezeAndStart()} disabled={busy || Boolean(explicitContractError) || !canFreezePlan}>{pendingAction === "freeze-start" ? "Starting…" : "Freeze plan and start"}</button>
        </aside>
      </section>
      <DecisionPresentation decisions={decisions} onResolve={resolveDecision} disabled={busy} stage={stage} />
    </main>
    );
  }

  return (
    <main className="engineer-screen">
      <RunHeader run={run} stage={stage} onBack={returnToRuns} />
      <HardeningReadinessBanner state={hardeningReadiness} />
      {isResolutionReplacement ? <section className="engineer-card engineer-gate"><span className="engineer-kicker">Bounded correction</span><h2>This run continues a prior verified record</h2><p>Zintus created this replacement from a signed Resolution Desk directive. Its budget is fixed, its lineage is checked before publication, and the original run remains preserved for audit.</p></section> : null}
      <BudgetHud budget={budget} manifest={plan?.manifest ?? null} />
      {approachingBudget && latestState !== "PAUSED_BUDGET" ? <section className="engineer-budget-warning" role="status">
        <div><strong>Approaching the run budget</strong><p>{topUpNotice ?? `Zintus has reserved or used ${Math.min(100, Math.round(budgetUsage * 100))}% of at least one limit. It will pause safely before spending beyond your ceiling.`}</p></div>
        <span className="engineer-chip">No action needed · active top-ups are locked</span>
      </section> : null}
      {latestState === "PAUSED_BUDGET" ? <section className="engineer-card engineer-budget-paused">
        <div className="engineer-budget-paused-header"><div><span className="engineer-kicker">Run paused · model admission stopped</span><h2>Your work is checkpointed</h2><p>{resumeBudgetCapability?.message ?? topUpBudgetCapability?.message ?? "The gateway is reconciling the safe next action for this checkpoint."}</p></div><span className="engineer-unverified">Unverified partial work</span></div>
        {canTopUpPausedBudget ? <BudgetTopUp value={topUp} onChange={(value) => { setTopUp(value); setTopUpNotice(null); }} disabled={busy || topUpPending} /> : <p className="engineer-muted" role="status">{topUpBudgetCapability?.message ?? "This run's budget cannot be increased."}</p>}
        {topUpNotice ? <p className="engineer-muted" role="status">{topUpNotice} Review the ceiling before adding more.</p> : null}
        <div className="engineer-actions">{canResumePausedBudget ? <button className="engineer-primary" disabled={busy || topUpPending || !budget} onClick={() => void resumeCurrentBudget()}>{pendingAction === "resume-budget" ? "Resuming…" : "Resume with current allowance"}</button> : null}{canTopUpPausedBudget ? <button className={canResumePausedBudget ? undefined : "engineer-primary"} disabled={busy || topUpPending || !budget || Boolean(topUpNotice)} onClick={() => void applyTopUp(true)}>{topUpPending ? "Applying one top-up…" : topUpNotice ? "Allowance already added" : "Top up once and resume checkpoint"}</button> : null}{prepareNewIntakeCapability?.availability === "AVAILABLE" ? <button className={!canResumePausedBudget ? "engineer-primary" : undefined} disabled={busy} onClick={prepareNewBoundedRun}>Prepare a new request</button> : null}<button disabled={busy || !reachedImplementation} onClick={() => setTab("diff")}>View partial diff</button></div>
      </section> : null}
      {latestState === "MODEL_PROVIDER_RETRY_PENDING" ? <section className="engineer-card engineer-budget-paused" role="alert">
        <div className="engineer-budget-paused-header"><div><span className="engineer-kicker">Provider timeout · balance is not the issue</span><h2>Your workspace checkpoint is retained</h2><p>The model request exceeded its execution timeout. Zintus stopped automatic replay to prevent duplicate charges. Planning, the frozen manifest, and current workspace are preserved.</p>{managerError ? <p className="engineer-error">{managerError}</p> : null}</div><span className="engineer-unverified">Unverified partial work</span></div>
        <div className="engineer-actions"><button className="engineer-primary" disabled={busy || !canRetryProvider} onClick={() => void retryProviderTimeout()}>{pendingAction === "retry-provider" ? "Retrying…" : "Retry from workspace checkpoint"}</button><button disabled={busy || !reachedImplementation} onClick={() => setTab("diff")}>Inspect partial diff</button></div>
      </section> : null}
      {visibleEvidenceErrors.length ? <section className="engineer-card"><p className="engineer-error">Some evidence sections are unavailable: {visibleEvidenceErrors.map((item) => item.section).join(", ")}. Empty values below are not treated as successful checks.</p></section> : null}
      {decisionApplyInFlight ? <section className="engineer-card engineer-gate" role="status" aria-live="polite"><div><span className="engineer-kicker">Applying your choice</span><h2>Planning the next stage</h2><p>Your answer has been submitted. Zintus is recording it and preparing the next evidence plan; do not choose it again.</p></div></section> : null}
      {machineStage && latestState !== "PAUSED_BUDGET" && !decisionApplyInFlight ? <section className="engineer-card engineer-gate" role="status" aria-live="polite"><div><span className="engineer-kicker">Truthful live activity</span><h2>{activity?.active ? `${activity.role?.toLowerCase() ?? "worker"} is active` : "No worker is currently active"}</h2><p>{activity?.detail ?? "Waiting for an authoritative worker signal."}</p>{latestState === "IMPLEMENTING" ? <p>{liveChangedFiles ? `${liveChangedFiles} changed ${liveChangedFiles === 1 ? "file" : "files"} · ${liveAddedLines.toLocaleString()} added lines in the live checkpoint.` : "No workspace change has been recorded yet."}</p> : null}</div><div><Metric label="Reserved now" value={budget ? `${Math.max(0, budget.reserved.tokens - budget.ambiguous.tokens).toLocaleString()} active · ${budget.ambiguous.tokens.toLocaleString()} ambiguous` : "Unavailable"} /><Metric label="Worker signal" value={activity?.active ? "ACTIVE" : "IDLE"} /></div></section> : null}
      <nav className="engineer-tabs" aria-label="Engineer run views">{visibleTabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
      {!reachedImplementation ? <p className="engineer-stage-availability"><strong>Nothing is missing.</strong> Diff appears after implementation changes a file. Evidence appears after tests and independent verification. No implementation change has been recorded for this run yet.</p> : !reachedVerification ? <p className="engineer-stage-availability">Evidence appears after tests and independent verification begin.</p> : null}
      {!decisionApplyInFlight && !activity?.active && ["PLANNING", "REPLANNING"].includes(latestState) && !plan ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Planning interrupted</span><h2>Retry the evidence plan</h2><p>The exact failure is recorded below. The durable run and prior human answers remain intact.</p></div><button className="engineer-primary" disabled={busy || !canRetryPlanning} onClick={() => void retryPlanning()}>{pendingAction === "retry-planning" ? "Retrying…" : "Retry planning"}</button></section> : null}
      {latestState === "PLAN_FROZEN" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Frozen contract</span><h2>Resume execution</h2><p>The plan is already immutable. Starting again will enqueue this exact manifest without re-freezing it.</p></div><button className="engineer-primary" disabled={busy || !canStartExecution} onClick={() => void startFrozen()}>{pendingAction === "start-frozen" ? "Starting…" : "Start frozen plan"}</button></section> : null}
      {latestState === "BASE_BRANCH_STALE" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Base branch changed</span><h2>Recover this run in the Resolution Desk</h2><p>The reviewed candidate will not be published because the base branch advanced. Open the Resolution Desk to adopt this run as a durable case and authorize a bounded corrected run that re-plans, executes, tests, and re-reviews on the current base — the single correction authority, with an explicit budget before any model call.</p></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={openStrandedRunInResolutionDesk}>Open in Resolution Desk</button></div></section> : null}
      {!decisionApplyInFlight ? <DecisionPresentation decisions={decisions} onResolve={resolveDecision} disabled={busy} stage={stage} /> : null}
      {verifiedCandidate ? <VerifiedCandidateCard candidate={verifiedCandidate} /> : null}
      {tab === "timeline" ? <section className="engineer-run-grid">
        <div className="engineer-card"><h2>Live timeline</h2><Timeline events={events} /></div>
        <aside className="engineer-card engineer-verification"><h2>{reachedVerification ? "Verification" : "Current stage"}</h2>{reachedVerification ? <><Metric label="Tests" value={tests.length ? `${tests.filter((item) => item.status === "PASSED").length}/${tests.length} passed` : "Pending"} /><Metric label="Security" value={securityStatus.label} /><Metric label="Claims" value={claims.length ? `${claims.filter((item) => item.status === "VERIFIED").length}/${claims.length} verified` : "Pending"} /></> : <Metric label="Activity" value={latestState.replaceAll("_", " ")} />}<Metric label="Failures" value={String(failures.length)} /></aside>
      </section> : null}
      {tab === "diff" ? <section className="engineer-card"><div className="engineer-card-heading"><div><h2>{diffPresentation.title}</h2><p>{diffPresentation.description}</p></div><span className={diffPresentation.verified ? "engineer-chip" : "engineer-unverified"}>{diffProvenance}</span></div><DiffViewer diff={data?.diff ?? ""} /></section> : null}
      {tab === "evidence" ? <><ArtifactViewer key={run.runId} runId={run.runId} artifacts={artifacts} /><section className="engineer-evidence-grid"><div className="engineer-card"><div className="engineer-card-heading"><h2>Acceptance evidence</h2><button disabled={busy} onClick={() => void downloadEvidence()}>Export checksummed stream</button></div>{claims.length ? claims.map((claim) => <article className="engineer-claim" key={claim.claimId}><span className={`engineer-status engineer-status--${(claim.status ?? "").toLowerCase()}`}>{claim.status}</span><strong>{claim.claim}</strong><p>{claim.notes}</p></article>) : <p className="engineer-muted">Claims are synthesized only after independent review.</p>}<p className="engineer-muted">Bundles: {(data?.evidenceBundles ?? []).length}</p></div><div className="engineer-card"><h2>Security findings</h2>{findings.length ? findings.map((finding) => <article className="engineer-finding" key={finding.securityFindingId}><span>{finding.severity}</span><strong>{finding.category}</strong><p>{finding.description}</p></article>) : <p className="engineer-muted">{securityStatus.status === "NO_FINDINGS" ? "No findings." : securityStatus.status === "UNAVAILABLE" ? "Security results are unavailable. Retry loading the evidence before making a decision." : "Security review is pending."}</p>}</div><PublicationOperations operations={gitOperations} /></section></> : null}
      {latestState === "HUMAN_APPROVAL_PENDING" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Legacy approval retired</span><h2>Recover this stranded run in the Resolution Desk</h2><p>The legacy human-approval lane is retired, so this machine-verified candidate can no longer be approved here. Open the Resolution Desk to adopt this run as a durable case and authorize a bounded corrected run that re-verifies and publishes through the current surface. This immutable audit record is preserved.</p><code>Manifest {approval?.manifestHash}</code><code>Diff {approval?.diffHash}</code><code>Evidence {approval?.evidenceBundleHash}</code></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={openStrandedRunInResolutionDesk}>Open in Resolution Desk</button></div></section> : null}
      {latestState === "HUMAN_REVIEW_REQUIRED" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human review</span><h2>{reviewerRetryExhausted ? "Reviewer unavailable after two attempts" : reviewerTimeoutHumanGate ? "Verified work is ready for your inspection" : "Verification needs your decision"}</h2><p>{reviewerRetryExhausted ? "Required tests and deterministic security verification completed, but the external Reviewer did not return after its one allowed recovery. Zintus preserved the verified checkpoint and has disabled further paid Reviewer retries. You can inspect or export the evidence; approval and publication remain locked without Reviewer evidence." : reviewerTimeoutHumanGate ? "Required tests and independent verification completed. The external Reviewer timed out, so Zintus stopped before another automatic charge. Inspect the evidence, then explicitly retry the Reviewer only if you approve using the remaining allowance; approval and publication stay locked until review evidence exists." : "Zintus stopped at a machine-verification gate. Review the exact blocker below, then choose a bounded recovery or reject the candidate. Human review cannot bypass machine verification."}</p>{!reviewerTimeoutHumanGate && humanReviewBlockers.length ? <ul className="engineer-blocker-list">{humanReviewBlockers.map((claim) => <li key={claim.claimId}><strong>{claim.criterionId}</strong>: {claim.notes}</li>)}</ul> : null}{!reviewerTimeoutHumanGate && humanReviewFailureReasons.length ? <ul className="engineer-blocker-list" aria-label="Verification blockers">{humanReviewFailureReasons.map((reasonCode) => <li key={reasonCode}><strong>{reasonCode.replaceAll("_", " ")}</strong></li>)}</ul> : null}</div><textarea value={reason} onChange={(event) => setReason((event.target.value))} placeholder="Decision rationale (required for rejection)" rows={3} /><div className="engineer-actions"><button disabled={busy || !reachedImplementation} onClick={() => setTab("diff")}>View verified diff</button><button disabled={busy || !reachedVerification} onClick={() => setTab("evidence")}>View test evidence</button>{resolutionDeskAvailable ? <button className="engineer-primary" disabled={busy} onClick={openResolutionDesk}>Open Resolution Desk</button> : null}{humanReviewCanRetry ? <button className="engineer-primary" disabled={busy || !reason.trim()} onClick={() => void resolveHumanReview("retry")}>{pendingAction === "human-review:retry" ? "Retrying review…" : reviewerTimeoutHumanGate ? "Retry Reviewer with approval" : "Retry reviewer from checkpoint"}</button> : null}<button className="danger" disabled={busy || !reason.trim()} onClick={() => void resolveHumanReview("reject")}>{pendingAction === "human-review:reject" ? "Rejecting…" : "Reject candidate"}</button></div></section> : null}
      {latestState === "REVIEW_APPROVED" && !approval ? <PublicationEntryNotice runId={run.runId} readiness={publicationReadiness} /> : null}
      {correctionRecovery === "corrected-run" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Correctable terminal result</span><h2>Resolve this run</h2><p>Open the Resolution Desk to inspect canonical blockers, choose a bounded correction budget, and preserve this immutable audit record.</p></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={openResolutionDesk}>Open Resolution Desk</button></div></section> : null}
      {correctionRecovery === "new-bounded-run" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">New bounded request required</span><h2>Revise and start a fresh run</h2><p>This failure has no safe structured patch to carry forward automatically. Zintus will preload the original request so you can narrow its scope and review a new budget before any model call.</p></div><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={prepareNewBoundedRun}>Prepare new bounded request</button></div></section> : null}
      {TERMINAL.has(latestState) ? <section className={`engineer-card engineer-final engineer-final--${latestState === "COMPLETED" ? "success" : "blocked"}`}><span className="engineer-kicker">Final result</span><h2>{latestState === "COMPLETED" ? "Verified and published" : latestState.replaceAll("_", " ")}</h2><p>{latestState === "COMPLETED" ? "The Supervisor completed the evidence gates and publication workflow." : latestState === "RETRY_BUDGET_EXHAUSTED" ? "Automatic repair stopped after the same required check failed again, protecting your budget from repeated paid attempts. Open the test evidence to see the exact failure before creating a corrected run." : "The workflow stopped safely. Inspect failures and evidence before taking another action."}</p></section> : null}
      {latestState === "COMPLETED" ? <DeferredHumanTaskSummary decisions={decisions} /> : null}
      {!TERMINAL.has(latestState) && !NON_CANCELLABLE_PUBLICATION_STATES.has(latestState) ? <button className="engineer-cancel" disabled={cancelling || !canCancelRun} onClick={() => void decide("cancel")}>{cancelling ? "Cancelling…" : "Cancel run"}</button> : null}
      {error ? <p className="engineer-error">{error}</p> : null}
      {managerError && managerError !== error && latestState !== "MODEL_PROVIDER_RETRY_PENDING" ? <p className="engineer-error">{managerError}</p> : null}
    </main>
  );
}


function RunHeader({ run, stage, onBack }: { run: EngineerRun; stage: ReturnType<typeof workflowStage>; onBack: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const task = run.requestNormalized || run.requestOriginal;
  return <header className="engineer-run-header">
    <div className="engineer-run-heading">
      <div className="engineer-run-breadcrumb"><button className="engineer-kicker" onClick={onBack}>← All runs</button><span className="engineer-kicker">Zintus Engineer · {run.repository.name}</span></div>
      <h1 className={`engineer-run-task${expanded ? " expanded" : ""}`}>{task}</h1>
      <div className="engineer-run-meta"><button type="button" className="engineer-task-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse task" : "Show full task"}</button><span className={`engineer-risk engineer-risk--${run.riskTier.toLowerCase()}`}>{run.riskTier}</span><code>{run.runId}</code></div>
    </div>
    <div className="engineer-progress"><div><span>{run.state.replaceAll("_", " ")}</span><strong>{stage.complete ? "Complete" : stage.index === 0 ? stage.label : `Stage ${stage.index} of ${stage.total} · ${stage.label}`}</strong></div><progress max={stage.total} value={stage.complete ? stage.total : stage.index} /></div>
  </header>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>; }
function PublicationOperations({ operations }: { operations: Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }> }) { return <div className="engineer-card"><h2>Publication operations</h2>{operations.length ? operations.map((operation) => <article className="engineer-claim" key={operation.gitOperationId}><span className={`engineer-status engineer-status--${(operation.status ?? "").toLowerCase()}`}>{operation.status}</span><strong>{operation.operationType?.replaceAll("_", " ")}</strong>{operation.remoteReference?.startsWith("https://") ? <a href={operation.remoteReference} target="_blank" rel="noreferrer">Open published result</a> : <code>{operation.remoteReference ?? operation.errorCode ?? operation.gitOperationId}</code>}</article>) : <p className="engineer-muted">No credentialed Git operation has started.</p>}</div>; }
