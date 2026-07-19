"use client";

// R3 integration (2026-07-19): P8's gateway HTTP routes
// (publication-candidates / approvals / publications + the dispatch/resume/
// reconcile controls, §3 of PHASE-CONTRACTS-P7-P10.md) are wired live in
// apps/gateway/src/handler.ts over the EngineerPublicationAuthorityFacade.
// This screen drives the real vertical: select → approve → publish
// (PREFLIGHT) → dispatch (credentialed branch/PR) → poll to RECEIPTED /
// RECONCILING. It is reachable from the primary run screen for a
// REVIEW_APPROVED run and from the Resolution Desk's resolved replacement.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getEngineerBudget, getEngineerHardeningReadiness, type EngineerBudgetSnapshot } from "@/lib/engineer";
import { EngineerActionLock } from "@/lib/engineer-action-lock";
import { HardeningReadinessBanner, type EngineerHardeningReadinessState } from "../EngineerHardeningReadiness";
import {
  ResolutionApiError,
  createApproval,
  createPublication,
  dispatchPublication,
  getPublication,
  getPublicationCandidates,
  type EngineerPublication,
  type PublicationCandidate,
  type PublicationApprovalResult,
} from "@/lib/engineer-resolution";
import {
  ApprovalRationaleControls,
  PREFLIGHT_MISMATCH_ERROR,
  PublicationCandidateList,
  PublicationEmptyState,
  PublicationErrorNotice,
  PublicationErrorState,
  PublicationStateTimeline,
} from "./PublicationControls";

const POLL_INTERVAL_MS = 4_000;

function PublicationDeskInner() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("run");

  const [candidates, setCandidates] = useState<PublicationCandidate[] | null>(null);
  const [selected, setSelected] = useState<PublicationCandidate | null>(null);
  const [rationale, setRationale] = useState("");
  const [approval, setApproval] = useState<PublicationApprovalResult | null>(null);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [publication, setPublication] = useState<EngineerPublication | null>(null);
  const [budget, setBudget] = useState<EngineerBudgetSnapshot | null>(null);
  const [readiness, setReadiness] = useState<EngineerHardeningReadinessState>("READY");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [selfApprovalError, setSelfApprovalError] = useState(false);
  const [preflightMismatch, setPreflightMismatch] = useState(false);

  const actionLockRef = useRef(new EngineerActionLock());

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await getPublicationCandidates(id);
      setCandidates(next);
      await getEngineerHardeningReadiness().then((result) => setReadiness(result.state)).catch(() => setReadiness("UNKNOWN"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Approval and publication screen is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (runId) void load(runId); }, [runId, load]);

  // Ambiguous remote outcomes never auto-replay; polling the read-only GET is
  // how the UI learns a RECONCILING publication resolved, without ever
  // re-issuing the publish request itself.
  useEffect(() => {
    if (!publicationId) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await getPublication(publicationId);
        if (active) setPublication(next);
      } catch { /* transient poll failure; next tick retries */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [publicationId]);

  useEffect(() => {
    if (!runId) return;
    void getEngineerBudget(runId).then(setBudget).catch(() => setBudget(null));
  }, [runId, publication?.state]);

  const withMutation = useCallback(async (action: string, work: () => Promise<void>) => {
    await actionLockRef.current.run("publication-desk", async () => {
      setPendingAction(action);
      try { await work(); }
      catch (cause) {
        if (cause instanceof ResolutionApiError && cause.code === "SELF_APPROVAL") { setSelfApprovalError(true); return; }
        if (cause instanceof ResolutionApiError && cause.code === "PREFLIGHT_MISMATCH") { setPreflightMismatch(true); setApproval(null); return; }
        setError(cause instanceof Error ? cause.message : "The action could not be completed");
      }
      finally { setPendingAction((current) => current === action ? null : current); }
    });
  }, []);

  const decide = useCallback(async (decision: "APPROVE" | "REJECT") => {
    if (!selected) return;
    setSelfApprovalError(false);
    await withMutation(decision === "APPROVE" ? "approval:approve" : "approval:reject", async () => {
      const result = await createApproval(selected.checkpointId, { checkpointHash: selected.checkpointHash, decision, rationale: rationale.trim() || undefined });
      setApproval(result);
    });
  }, [selected, rationale, withMutation]);

  const publish = useCallback(async () => {
    if (!runId || !approval || approval.status !== "APPROVED") return;
    setPreflightMismatch(false);
    await withMutation("publication:publish", async () => {
      const created = await createPublication(runId, { approvalId: approval.approvalId, operation: "BRANCH_PR" });
      setPublicationId(created.publicationId);
      setPublication(created);
    });
  }, [runId, approval, withMutation]);

  // Dispatch drives the credentialed branch/PR effect. DISPATCHED is committed
  // server-side BEFORE the remote call, so a crash never re-issues it; polling
  // the read-only GET is how the UI learns the settled RECEIPTED / RECONCILING
  // outcome. The button never re-issues a remote effect for a DISPATCHED
  // operation — the server reconciles instead.
  const dispatch = useCallback(async () => {
    if (!publicationId) return;
    await withMutation("publication:dispatch", async () => {
      const next = await dispatchPublication(publicationId);
      setPublication(next);
    });
  }, [publicationId, withMutation]);

  const disabled = pendingAction !== null;

  return (
    <main className="engineer-screen">
      <header className="engineer-hero">
        <a href={runId ? `/engineer?run=${encodeURIComponent(runId)}` : "/engineer"} className="engineer-kicker">← Back to run</a>
        <h1>Approval and publication</h1>
        <p>Every candidate's lineage, the human approval decision, and what the publish operation actually did — including when its remote outcome is unknown.</p>
      </header>

      {!runId ? <PublicationErrorState message="No run selected. Open this screen from a specific run." /> : null}
      {readiness !== "READY" ? <HardeningReadinessBanner state={readiness} /> : null}
      {error ? <PublicationErrorState message={error} /> : null}
      {loading && runId ? <section className="engineer-card"><p className="engineer-muted">Loading publication candidates…</p></section> : null}

      {!loading && !error && candidates && candidates.length === 0 ? <PublicationEmptyState /> : null}

      {!loading && candidates && candidates.length > 0 ? <>
        <section className="engineer-card" aria-labelledby="publication-candidates-heading">
          <h2 id="publication-candidates-heading">Publication candidates</h2>
          <PublicationCandidateList candidates={candidates} selectedCheckpointId={selected?.checkpointId ?? null} onSelect={(candidate) => { setSelected(candidate); setApproval(null); setSelfApprovalError(false); setPreflightMismatch(false); }} />
        </section>

        {selected && !approval ? (
          <section className="engineer-card engineer-gate" aria-labelledby="publication-approval-heading">
            <div>
              <span className="engineer-kicker">Human approval</span>
              <h2 id="publication-approval-heading">Decide on {selected.checkpointId}</h2>
              <p>Lineage: {selected.lineage === "ORIGINAL" ? "Original" : "P7 replacement"} · {selected.lineageVerified ? "Verified by the companion-aware lineage verifier" : "Lineage not yet verified"}</p>
            </div>
            <ApprovalRationaleControls
              pendingAction={pendingAction}
              disabled={disabled}
              rationale={rationale}
              onRationaleChange={setRationale}
              selfApprovalError={selfApprovalError}
              onApprove={() => void decide("APPROVE")}
              onReject={() => void decide("REJECT")}
            />
          </section>
        ) : null}

        {approval && approval.status === "APPROVED" && !publicationId ? (
          <section className="engineer-card engineer-gate" aria-labelledby="publication-publish-heading">
            <div>
              <span className="engineer-kicker">Approved</span>
              <h2 id="publication-publish-heading">Ready to publish</h2>
              <p>Approved by the current authorized approver. Preflight will re-validate the branch, base, and repository immediately before any Git effect.</p>
            </div>
            {preflightMismatch ? <PublicationErrorNotice {...PREFLIGHT_MISMATCH_ERROR()} /> : null}
            <button type="button" className="engineer-primary" disabled={disabled} onClick={() => void publish()}>{pendingAction === "publication:publish" ? "Publishing…" : "Publish"}</button>
          </section>
        ) : null}

        {approval && approval.status === "REJECTED" ? (
          <section className="engineer-card"><p className="engineer-muted">This candidate was rejected. Select a different candidate to continue.</p></section>
        ) : null}

        {publication && publication.state === "PREFLIGHT" ? (
          <section className="engineer-card engineer-gate" aria-labelledby="publication-dispatch-heading">
            <div>
              <span className="engineer-kicker">Preflight passed</span>
              <h2 id="publication-dispatch-heading">Dispatch the credentialed branch and pull request</h2>
              <p>The publication is recorded and preflight matched. Dispatch commits the DISPATCHED state before any remote call, so an interrupted dispatch is reconciled by a human and never re-issued as a second pull request.</p>
            </div>
            <button type="button" className="engineer-primary" disabled={disabled} onClick={() => void dispatch()}>{pendingAction === "publication:dispatch" ? "Dispatching…" : "Dispatch publication"}</button>
          </section>
        ) : null}

        {publication ? <PublicationStateTimeline state={publication.state} receipt={publication.receipt} reconciliation={publication.reconciliation} budget={budget} /> : null}
      </> : null}
    </main>
  );
}

export default function PublicationDeskPage() {
  return <Suspense fallback={<main className="engineer-screen"><section className="engineer-card"><p className="engineer-muted">Loading…</p></section></main>}>
    <PublicationDeskInner />
  </Suspense>;
}
