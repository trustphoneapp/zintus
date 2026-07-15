"use client";

import { useEffect, useState } from "react";
import { getEngineerObservability, type EngineerObservability } from "@/lib/engineer";

export default function EngineerOperationsPage() {
  const [snapshot, setSnapshot] = useState<EngineerObservability | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const next = await getEngineerObservability(); if (active) { setSnapshot(next); setError(null); } }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Engineer operations are unavailable"); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return <main className="engineer-screen">
    <header className="engineer-hero"><a href="/engineer" className="engineer-kicker">← Zintus Engineer</a><h1>Operations and cost health</h1><p>Durable ledger measurements only. Unknown data remains unknown; no model narrative is counted as evidence.</p></header>
    {error ? <section className="engineer-card"><p className="engineer-error">{error}</p></section> : null}
    {!snapshot && !error ? <section className="engineer-card"><p className="engineer-muted">Loading durable operations…</p></section> : null}
    {snapshot ? <>
      <section className="engineer-evidence-grid">
        <Metric label="Active runs" value={snapshot.activeRuns} />
        <Metric label="Pending approvals" value={snapshot.pendingApprovals} />
        <Metric label="Stuck runs" value={snapshot.stuckRuns} warning={snapshot.stuckRuns > 0} />
        <Metric label="Success rate" value={snapshot.successRate === null ? "Not enough data" : `${Math.round(snapshot.successRate * 100)}%`} />
        <Metric label="Estimated model cost" value={`$${snapshot.estimatedCostUsd.toFixed(4)}`} />
        <Metric label="Cached input tokens" value={snapshot.cachedInputTokens.toLocaleString()} />
        <Metric label="Retries" value={snapshot.retryAttempts} />
        <Metric label="Evidence bundles" value={`${snapshot.evidenceCompleteRuns}/${snapshot.totalRuns}`} />
      </section>
      <section className="engineer-card"><div className="engineer-card-heading"><h2>Run health</h2><small>Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}</small></div><div className="engineer-list">
        {snapshot.runHealth.length ? snapshot.runHealth.map((run) => <a href={`/engineer?run=${encodeURIComponent(run.runId)}`} key={run.runId}><span className={`engineer-status engineer-status--${run.stuck ? "failed" : run.state.toLowerCase()}`}>{run.stuck ? "STUCK" : run.state.replaceAll("_", " ")}</span><div><strong>{run.riskTier} risk · {Math.floor(run.ageInStateSeconds / 60)}m in state</strong><code>{run.runId} · {run.retryAttempts} retries · {run.failureCount} failures</code></div></a>) : <p className="engineer-muted">No durable runs yet.</p>}
      </div></section>
      <section className="engineer-evidence-grid"><Breakdown title="States" values={snapshot.runsByState} /><Breakdown title="Failure classes" values={snapshot.failuresByClass} /></section>
    </> : null}
  </main>;
}

function Metric({ label, value, warning = false }: { label: string; value: string | number; warning?: boolean }) { return <div className="engineer-card engineer-metric"><span>{label}</span><strong className={warning ? "engineer-error" : ""}>{value}</strong></div>; }
function Breakdown({ title, values }: { title: string; values: Record<string, number> }) { return <div className="engineer-card"><h2>{title}</h2>{Object.entries(values).length ? Object.entries(values).sort((a, b) => b[1] - a[1]).map(([label, value]) => <div className="engineer-metric" key={label}><span>{label.replaceAll("_", " ")}</span><strong>{value}</strong></div>) : <p className="engineer-muted">No records.</p>}</div>; }
