"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEngineerRun,
  engineerDecision,
  freezeEngineerPlan,
  getEngineerData,
  getEngineerRun,
  planEngineerRun,
  startEngineerRun,
  streamEngineerEvents,
  type EngineerRepository,
  type EngineerRun,
  type PlanProposal,
  type RunEvent,
} from "@/lib/engineer";

type EvidenceData = Awaited<ReturnType<typeof getEngineerData>>;
const TERMINAL = new Set(["COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION", "HUMAN_REVIEW_REQUIRED", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED"]);

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
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (runId: string) => {
    const [nextRun, nextData] = await Promise.all([getEngineerRun(runId), getEngineerData(runId)]);
    setRun(nextRun);
    setData(nextData);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const watch = useCallback((runId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void streamEngineerEvents(runId, (event) => {
      setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event]);
      void refresh(runId);
    }, controller.signal).then(() => refresh(runId)).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Timeline disconnected");
    });
  }, [refresh]);

  const submit = async () => {
    if (!request.trim() || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(repository.baseCommitSha)) return;
    setBusy(true); setError(null);
    try {
      const created = await createEngineerRun({ userId: "local-user", repository, request: request.trim() });
      setRun(created);
      const proposal = await planEngineerRun(created.runId);
      setPlan(proposal);
      setRun(await getEngineerRun(created.runId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create Engineer run"); }
    finally { setBusy(false); }
  };

  const freezeAndStart = async () => {
    if (!run || !plan) return;
    setBusy(true); setError(null);
    try {
      const frozen = await freezeEngineerPlan(run, plan.manifest);
      const queued = await startEngineerRun(frozen.runId);
      setRun(queued); setEvents([]); watch(queued.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start Engineer run"); }
    finally { setBusy(false); }
  };

  const decide = async (action: "approve" | "request-changes" | "reject" | "cancel") => {
    if (!run) return;
    setBusy(true); setError(null);
    try { await engineerDecision(run.runId, action, reason.trim() || `${action} from Zintus Engineer`); setReason(""); await refresh(run.runId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Decision failed"); }
    finally { setBusy(false); }
  };

  const latestState = run?.state ?? "NEW";
  const claims = (data?.claims ?? []) as Array<{ claimId?: string; claim?: string; status?: string; notes?: string }>;
  const tests = (data?.tests ?? []) as Array<{ testExecutionId?: string; type?: string; status?: string }>;
  const findings = (data?.securityFindings ?? []) as Array<{ securityFindingId?: string; severity?: string; category?: string; description?: string }>;
  const failures = (data?.failures ?? []) as Array<{ failureId?: string; reasonCode?: string; failureClass?: string }>;
  const approval = data?.approval as { status?: string; riskTier?: string; deadlineAt?: string; evidenceBundleHash?: string } | null | undefined;
  const progress = useMemo(() => Math.min(100, Math.round((events.length / 16) * 100)), [events.length]);

  if (!run) return (
    <main className="engineer-screen">
      <header className="engineer-hero"><span className="engineer-kicker">Zintus Engineer</span><h1>AI writes the code. Zintus proves whether it works.</h1><p>Define the exact repository snapshot and the outcome. Zintus plans, isolates, verifies, reviews, and waits for you before risky publication.</p></header>
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
      <RunHeader run={run} progress={10} />
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
          {error ? <p className="engineer-error">{error}</p> : null}
          <button className="engineer-primary" onClick={() => void freezeAndStart()} disabled={busy}>{busy ? "Starting…" : "Freeze plan and start"}</button>
        </aside>
      </section>
    </main>
  );

  return (
    <main className="engineer-screen">
      <RunHeader run={run} progress={TERMINAL.has(latestState) ? 100 : progress} />
      <nav className="engineer-tabs" aria-label="Engineer run views">{(["timeline", "diff", "evidence"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
      {tab === "timeline" ? <section className="engineer-run-grid">
        <div className="engineer-card"><h2>Live timeline</h2><div className="engineer-timeline">{events.length ? events.map((event) => <div key={event.eventId} className="engineer-event"><span /><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.nextState.replaceAll("_", " ")}</strong><small>{event.reasonCode.replaceAll("_", " ")}</small></div></div>) : <p className="engineer-muted">Waiting for the first durable event…</p>}</div></div>
        <aside className="engineer-card engineer-verification"><h2>Verification</h2><Metric label="Tests" value={tests.length ? `${tests.filter((item) => item.status === "PASSED").length}/${tests.length} passed` : "Pending"} /><Metric label="Security" value={findings.length ? `${findings.length} findings` : "No findings"} /><Metric label="Claims" value={claims.length ? `${claims.filter((item) => item.status === "VERIFIED").length}/${claims.length} verified` : "Pending"} /><Metric label="Failures" value={String(failures.length)} /></aside>
      </section> : null}
      {tab === "diff" ? <section className="engineer-card"><div className="engineer-card-heading"><h2>Reviewed diff</h2><span className="engineer-chip">hash-bound</span></div><pre className="engineer-diff">{data?.diff || "The exact diff appears after implementation begins."}</pre></section> : null}
      {tab === "evidence" ? <section className="engineer-evidence-grid"><div className="engineer-card"><h2>Acceptance evidence</h2>{claims.length ? claims.map((claim) => <article className="engineer-claim" key={claim.claimId}><span className={`engineer-status engineer-status--${(claim.status ?? "").toLowerCase()}`}>{claim.status}</span><strong>{claim.claim}</strong><p>{claim.notes}</p></article>) : <p className="engineer-muted">Claims are synthesized only after independent review.</p>}</div><div className="engineer-card"><h2>Security findings</h2>{findings.length ? findings.map((finding) => <article className="engineer-finding" key={finding.securityFindingId}><span>{finding.severity}</span><strong>{finding.category}</strong><p>{finding.description}</p></article>) : <p className="engineer-muted">No recorded findings.</p>}</div></section> : null}
      {latestState === "HUMAN_APPROVAL_PENDING" ? <section className="engineer-card engineer-gate"><div><span className="engineer-kicker">Human gate</span><h2>Approve the exact reviewed result</h2><p>Risk: {approval?.riskTier ?? run.riskTier} · Deadline: {approval?.deadlineAt ? new Date(approval.deadlineAt).toLocaleString() : "policy controlled"}</p><code>{approval?.evidenceBundleHash}</code></div><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Decision rationale" rows={3} /><div className="engineer-actions"><button className="engineer-primary" disabled={busy} onClick={() => void decide("approve")}>Approve and publish</button><button disabled={busy} onClick={() => void decide("request-changes")}>Request changes</button><button className="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</button></div></section> : null}
      {TERMINAL.has(latestState) ? <section className={`engineer-card engineer-final engineer-final--${latestState === "COMPLETED" ? "success" : "blocked"}`}><span className="engineer-kicker">Final result</span><h2>{latestState === "COMPLETED" ? "Verified and published" : latestState.replaceAll("_", " ")}</h2><p>{latestState === "COMPLETED" ? "The Supervisor completed the evidence gates and publication workflow." : "The workflow stopped safely. Inspect failures and evidence before taking another action."}</p></section> : null}
      {!TERMINAL.has(latestState) && latestState !== "HUMAN_APPROVAL_PENDING" ? <button className="engineer-cancel" disabled={busy} onClick={() => void decide("cancel")}>Cancel run</button> : null}
      {error ? <p className="engineer-error">{error}</p> : null}
    </main>
  );
}

function RunHeader({ run, progress }: { run: EngineerRun; progress: number }) { return <header className="engineer-run-header"><div><span className="engineer-kicker">Zintus Engineer · {run.repository.name}</span><h1>{run.requestNormalized || run.requestOriginal}</h1><div className="engineer-run-meta"><span className={`engineer-risk engineer-risk--${run.riskTier.toLowerCase()}`}>{run.riskTier}</span><code>{run.runId}</code></div></div><div className="engineer-progress"><div><span>{run.state.replaceAll("_", " ")}</span><strong>{progress}%</strong></div><progress max="100" value={progress} /></div></header>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>; }

