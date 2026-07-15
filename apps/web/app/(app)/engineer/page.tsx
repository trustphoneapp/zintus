"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEngineerRun,
  engineerDecision,
  extendEngineerApproval,
  freezeEngineerPlan,
  getEngineerEvidenceExport,
  getEngineerData,
  getEngineerPlan,
  getEngineerRepository,
  getEngineerRunStatus,
  listEngineerRuns,
  planEngineerRun,
  recoverEngineerStaleBase,
  resolveEngineerDecision,
  startEngineerRun,
  streamEngineerEvents,
  type EngineerRepository,
  type EngineerRun,
  type PlanProposal,
  type RunEvent,
} from "@/lib/engineer";
import type { EngineerDecisionItem } from "@/lib/engineer-decisions";
import { DecisionPresentation, DeferredHumanTaskSummary } from "./DecisionPresentation";
import { clearEphemeralGatewayToken, setEphemeralGatewayToken } from "@/lib/gateway";

type EvidenceData = Awaited<ReturnType<typeof getEngineerData>>;
const TERMINAL = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "HUMAN_REVIEW_REQUIRED", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);
const RUN_STORAGE_KEY = "zintus-engineer-active-run";
const cursorKey = (runId: string) => `zintus-engineer-event-cursor:${runId}`;
const STATE_PROGRESS: Record<string, number> = { REQUEST_RECEIVED: 2, REQUEST_NORMALIZED: 5, PLANNING: 7, PLAN_READY: 10, PLAN_FROZEN: 12, QUEUED: 15, SANDBOX_WARM_CLAIMING: 18, SANDBOX_COLD_PROVISIONING: 18, SANDBOX_PREFLIGHT: 22, SANDBOX_READY: 25, CONTEXT_BUILDING: 30, IMPLEMENTING: 42, FAST_CHECKS: 50, UNIT_TESTING: 58, INTEGRATION_TESTING: 66, E2E_TESTING: 72, SECURITY_REVIEW: 78, REVIEWING: 86, REVIEW_APPROVED: 90, HUMAN_APPROVAL_PENDING: 94, HUMAN_APPROVED: 96, PR_PREFLIGHT: 97, PR_CREATING: 98, PR_CREATED: 99 };

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
  const [recentRuns, setRecentRuns] = useState<EngineerRun[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (runId: string) => {
    const [status, nextData] = await Promise.all([getEngineerRunStatus(runId), getEngineerData(runId)]);
    setRun((current) => !current || status.run.runId !== current.runId || status.run.stateVersion >= current.stateVersion ? status.run : current);
    setManagerError(status.lastError);
    setData(nextData);
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

  const loadDashboard = useCallback(async () => {
    const [canonical, history] = await Promise.allSettled([getEngineerRepository(), listEngineerRuns()]);
    if (canonical.status === "fulfilled") setRepository(canonical.value);
    if (history.status === "fulfilled") setRecentRuns(history.value);
    if (canonical.status === "fulfilled" || history.status === "fulfilled") setError(null);
    if (canonical.status === "rejected" && history.status === "rejected") {
      setError(canonical.reason instanceof Error ? canonical.reason.message : "Engineer gateway is unavailable");
    }
  }, []);

  const openRun = useCallback(async (runId: string) => {
    setError(null);
    const [status, storedPlan, storedData] = await Promise.all([
      getEngineerRunStatus(runId), getEngineerPlan(runId).catch(() => null), getEngineerData(runId),
    ]);
    setRun(status.run); setPlan(storedPlan); setData(storedData); setEvents([]); setManagerError(status.lastError);
    window.localStorage.setItem(RUN_STORAGE_KEY, runId);
    // The stream replays durable history from sequence zero and closes after a
    // terminal ledger is drained, so reopened completed runs get a full timeline.
    watch(runId);
  }, [watch]);

  const returnToRuns = useCallback(() => {
    abortRef.current?.abort();
    window.localStorage.removeItem(RUN_STORAGE_KEY);
    setRun(null); setPlan(null); setData(null); setEvents([]); setManagerError(null); setError(null);
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
      const created = await createEngineerRun({ repository, request: request.trim() });
      setRun(created); window.localStorage.setItem(RUN_STORAGE_KEY, created.runId);
      const proposal = await planEngineerRun(created.runId);
      setPlan(proposal);
      const [status, nextData] = await Promise.all([getEngineerRunStatus(created.runId), getEngineerData(created.runId)]); setRun(status.run); setData(nextData); setManagerError(status.lastError);
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

  const latestState = run?.state ?? "NEW";
  const claims = (data?.claims ?? []) as Array<{ claimId?: string; claim?: string; status?: string; notes?: string }>;
  const tests = (data?.tests ?? []) as Array<{ testExecutionId?: string; type?: string; status?: string }>;
  const findings = (data?.securityFindings ?? []) as Array<{ securityFindingId?: string; severity?: string; category?: string; description?: string }>;
  const failures = (data?.failures ?? []) as Array<{ failureId?: string; reasonCode?: string; failureClass?: string }>;
  const gitOperations = (data?.gitOperations ?? []) as Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }>;
  const decisions = (data?.decisions ?? []) as EngineerDecisionItem[];
  const approval = data?.approval as { status?: string; riskTier?: string; deadlineAt?: string; manifestHash?: string; diffHash?: string; evidenceBundleHash?: string } | null | undefined;
  const progress = useMemo(() => TERMINAL.has(latestState) ? 100 : STATE_PROGRESS[latestState] ?? 35, [latestState]);

  if (!run) return (
    <main className="engineer-screen">
      <header className="engineer-hero"><span className="engineer-kicker">Zintus Engineer</span><h1>AI writes the code. Zintus proves whether it works.</h1><p>Define the exact repository snapshot and the outcome. Zintus plans, isolates, verifies, reviews, and waits for you before risky publication.</p><a href="/engineer/operations">Open operations and cost health →</a></header>
      <section className="engineer-card">
        <div className="engineer-section-title"><span>00</span><div><h2>Secure gateway access</h2><p>Required for authenticated publication. The token stays in memory and is cleared on reload.</p></div></div>
        <label>Gateway operator token<input type="password" value={gatewayToken} autoComplete="off" onChange={(event) => setGatewayToken(event.target.value)} placeholder="Paste GATEWAY_TOKEN" /></label>
        <div className="engineer-actions">
          <button onClick={() => { setEphemeralGatewayToken(gatewayToken); setGatewayToken(""); setGatewayAuthenticated(Boolean(gatewayToken.trim())); void loadDashboard(); }}>{gatewayAuthenticated ? "Replace token" : "Use token for this tab"}</button>
          {gatewayAuthenticated ? <button onClick={() => { clearEphemeralGatewayToken(); setGatewayAuthenticated(false); }}>Clear token</button> : null}
        </div>
      </section>
      {recentRuns.length ? <section className="engineer-card">
        <div className="engineer-section-title"><span>02</span><div><h2>Recent durable runs</h2><p>Reopen any run from the gateway ledger, including after a browser restart.</p></div></div>
        <div className="engineer-list">{recentRuns.map((item) => <button key={item.runId} onClick={() => void openRun(item.runId)}>
          <span className={`engineer-status engineer-status--${item.state.toLowerCase()}`}>{item.state.replaceAll("_", " ")}</span>
          <div><strong>{item.requestNormalized || item.requestOriginal}</strong><code>{item.runId}</code></div>
        </button>)}</div>
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
      {tab === "diff" ? <section className="engineer-card"><div className="engineer-card-heading"><h2>Reviewed diff</h2><span className="engineer-chip">hash-bound</span></div><pre className="engineer-diff">{data?.diff || "The exact diff appears after implementation begins."}</pre></section> : null}
      {tab === "evidence" ? <section className="engineer-evidence-grid"><div className="engineer-card"><div className="engineer-card-heading"><h2>Acceptance evidence</h2><button disabled={busy} onClick={() => void downloadEvidence()}>Export checksummed JSON</button></div>{claims.length ? claims.map((claim) => <article className="engineer-claim" key={claim.claimId}><span className={`engineer-status engineer-status--${(claim.status ?? "").toLowerCase()}`}>{claim.status}</span><strong>{claim.claim}</strong><p>{claim.notes}</p></article>) : <p className="engineer-muted">Claims are synthesized only after independent review.</p>}<p className="engineer-muted">Bundles: {(data?.evidenceBundles ?? []).length}</p></div><div className="engineer-card"><h2>Security findings</h2>{findings.length ? findings.map((finding) => <article className="engineer-finding" key={finding.securityFindingId}><span>{finding.severity}</span><strong>{finding.category}</strong><p>{finding.description}</p></article>) : <p className="engineer-muted">No recorded findings.</p>}</div><PublicationOperations operations={gitOperations} /></section> : null}
      {latestState === "HUMAN_APPROVAL_PENDING" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human gate</span><h2>Approve the exact reviewed result</h2><p>Risk: {approval?.riskTier ?? run.riskTier} · Deadline: {approval?.deadlineAt ? new Date(approval.deadlineAt).toLocaleString() : "policy controlled"}</p><code>Manifest {approval?.manifestHash}</code><code>Diff {approval?.diffHash}</code><code>Evidence {approval?.evidenceBundleHash}</code></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void decide("approve")}>Approve and publish</button><button disabled={busy} onClick={() => void decide("request-changes")}>Request changes</button><button disabled={busy} onClick={() => void extendApproval()}>Give me 24 hours</button><button className="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</button></div></section> : null}
      {TERMINAL.has(latestState) ? <section className={`engineer-card engineer-final engineer-final--${latestState === "COMPLETED" ? "success" : "blocked"}`}><span className="engineer-kicker">Final result</span><h2>{latestState === "COMPLETED" ? "Verified and published" : latestState.replaceAll("_", " ")}</h2><p>{latestState === "COMPLETED" ? "The Supervisor completed the evidence gates and publication workflow." : "The workflow stopped safely. Inspect failures and evidence before taking another action."}</p></section> : null}
      {TERMINAL.has(latestState) ? <DeferredHumanTaskSummary decisions={decisions} /> : null}
      {!TERMINAL.has(latestState) && latestState !== "HUMAN_APPROVAL_PENDING" ? <button className="engineer-cancel" disabled={busy} onClick={() => void decide("cancel")}>Cancel run</button> : null}
      {error ? <p className="engineer-error">{error}</p> : null}
      {managerError ? <p className="engineer-error">{managerError}</p> : null}
    </main>
  );
}

function RunHeader({ run, progress, onBack }: { run: EngineerRun; progress: number; onBack: () => void }) { return <header className="engineer-run-header"><div><button className="engineer-kicker" onClick={onBack}>← All runs</button><span className="engineer-kicker">Zintus Engineer · {run.repository.name}</span><h1>{run.requestNormalized || run.requestOriginal}</h1><div className="engineer-run-meta"><span className={`engineer-risk engineer-risk--${run.riskTier.toLowerCase()}`}>{run.riskTier}</span><code>{run.runId}</code></div></div><div className="engineer-progress"><div><span>{run.state.replaceAll("_", " ")}</span><strong>{progress}%</strong></div><progress max="100" value={progress} /></div></header>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>; }
function PublicationOperations({ operations }: { operations: Array<{ gitOperationId?: string; operationType?: string; status?: string; remoteReference?: string | null; errorCode?: string | null }> }) { return <div className="engineer-card"><h2>Publication operations</h2>{operations.length ? operations.map((operation) => <article className="engineer-claim" key={operation.gitOperationId}><span className={`engineer-status engineer-status--${(operation.status ?? "").toLowerCase()}`}>{operation.status}</span><strong>{operation.operationType?.replaceAll("_", " ")}</strong>{operation.remoteReference?.startsWith("https://") ? <a href={operation.remoteReference} target="_blank" rel="noreferrer">Open published result</a> : <code>{operation.remoteReference ?? operation.errorCode ?? operation.gitOperationId}</code>}</article>) : <p className="engineer-muted">No credentialed Git operation has started.</p>}</div>; }
