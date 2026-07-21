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
import { getEngineerBudget, getEngineerHardeningReadiness, getEngineerPublicationReadiness, type EngineerBudgetSnapshot } from "@/lib/engineer";
import { EngineerActionLock } from "@/lib/engineer-action-lock";
import { fetchGatewayConnection } from "@/lib/gateway";
import { HardeningReadinessBanner, type EngineerHardeningReadinessState } from "../EngineerHardeningReadiness";
import {
  ResolutionApiError,
  createApproval,
  createPublication,
  dispatchPublication,
  getPublication,
  markPublicationFailed,
  recheckPublicationReconciliation,
  reconcilePublicationReceipt,
  selectPublicationCandidate,
  type EngineerPublication,
  type PublicationCandidate,
  type PublicationApprovalResult,
} from "@/lib/engineer-resolution";
import { hydratePublicationDesk } from "@/lib/engineer-publication-hydrate";
import type { ActionErrorDetail } from "../EngineerActionErrorNotice";
import {
  ApprovalRationaleControls,
  PREFLIGHT_MISMATCH_ERROR,
  PublicationCandidateList,
  PublicationEmptyState,
  PublicationErrorNotice,
  PublicationErrorState,
  PublicationReconcilingControls,
  PublicationStateTimeline,
  reconciliationErrorDetail,
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
  const [reconcileError, setReconcileError] = useState<ActionErrorDetail | null>(null);

  const actionLockRef = useRef(new EngineerActionLock());

  // FINDING #3 fix: hydrate from the SERVER on every load/refresh. The run's
  // durable CURRENT publication projection (state + approval + selected
  // candidate) is restored from the server — not React state — so a browser
  // refresh mid-publication restores the EXACT in-flight publication instead of
  // dropping back to the candidate list and losing it. When there is no active
  // publication, `current` is null and the candidate-selection flow runs as
  // before.
  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      // Publication links may be opened directly, before AppShell has renewed
      // the memory-only loopback session. Establish it before protected reads
      // so a healthy local gateway never renders a misleading raw 401.
      const connection = await fetchGatewayConnection();
      if (connection.state !== "connected") {
        throw new Error(connection.state === "offline"
          ? "Your local Engineer gateway is not running. Start it, then try again."
          : "Connecting to your local Engineer gateway was not completed. Check the local connection and try again.");
      }
      const publicationReadiness = await getEngineerPublicationReadiness();
      if (publicationReadiness.state !== "READY") {
        throw new Error(publicationReadiness.message);
      }
      const { candidates: nextCandidates, current } = await hydratePublicationDesk(id);
      setCandidates(nextCandidates);
      if (current) {
        setSelected({
          checkpointId: current.checkpointId,
          checkpointHash: current.checkpointHash,
          lineage: current.lineage,
          lineageVerified: current.lineageVerified,
        });
        // A current publication only ever exists on an APPROVED approval (later
        // CONSUMED by the publish); REJECTED never yields one. Restore the
        // approval so the decision gate stays closed on refresh, mapping the
        // durable CONSUMED status back to APPROVED for the UI's gate model.
        if (current.approvalStatus === "REJECTED") {
          setApproval({ approvalId: current.approvalId, status: "REJECTED" });
        } else {
          setApproval({ approvalId: current.approvalId, status: "APPROVED" });
        }
        setPublicationId(current.publicationId);
        setPublication({ state: current.state, receipt: current.receipt, reconciliation: current.reconciliation });
      }
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

  const selectCandidate = useCallback(async (candidate: PublicationCandidate) => {
    if (!runId) return;
    await withMutation("candidate:select", async () => {
      // Do not let React's selected styling impersonate a durable authority.
      // Approval only becomes available after the server has derived and
      // persisted this exact candidate selection from its checkpoint.
      const persisted = await selectPublicationCandidate(runId, candidate.checkpointId);
      setSelected(persisted);
      setApproval(null);
      setSelfApprovalError(false);
      setPreflightMismatch(false);
    });
  }, [runId, withMutation]);

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

  // R7-3 (finding #4): RECONCILING is operable. Each control drives a reconcile
  // route under the SAME desk action-lock, surfaces its own typed error via
  // `reconciliationErrorDetail`, and sets the publication to the DURABLE view the
  // server returns — no control fakes a success (a rejected verified receipt stays
  // RECONCILING with the binding error shown). The read-only poll keeps refreshing.
  const runReconcileAction = useCallback(async (action: string, work: () => Promise<EngineerPublication>) => {
    await actionLockRef.current.run("publication-desk", async () => {
      setPendingAction(action);
      setReconcileError(null);
      try {
        const next = await work();
        setPublication(next);
      } catch (cause) {
        setReconcileError(reconciliationErrorDetail(cause));
      } finally {
        setPendingAction((current) => (current === action ? null : current));
      }
    });
  }, []);

  const recheck = useCallback(async () => {
    if (!publicationId) return;
    await runReconcileAction("reconcile:recheck", () => recheckPublicationReconciliation(publicationId));
  }, [publicationId, runReconcileAction]);

  const submitReceipt = useCallback(async (input: { prUrl: string; commitSha: string; detail: string }) => {
    if (!publicationId) return;
    await runReconcileAction("reconcile:receipt", () => reconcilePublicationReceipt(publicationId, {
      prUrl: input.prUrl, commitSha: input.commitSha, detail: input.detail || undefined,
    }));
  }, [publicationId, runReconcileAction]);

  const markFailed = useCallback(async (detail: string) => {
    if (!publicationId) return;
    await runReconcileAction("reconcile:mark-failed", () => markPublicationFailed(publicationId, { detail }));
  }, [publicationId, runReconcileAction]);

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
          <PublicationCandidateList candidates={candidates} selectedCheckpointId={selected?.checkpointId ?? null} onSelect={(candidate) => void selectCandidate(candidate)} />
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

        {publication && publication.state === "RECONCILING" ? (
          <PublicationReconcilingControls
            disabled={disabled}
            pendingAction={pendingAction}
            error={reconcileError}
            onRecheck={() => void recheck()}
            onSubmitReceipt={(input) => void submitReceipt(input)}
            onMarkFailed={(detail) => void markFailed(detail)}
          />
        ) : null}
      </> : null}
    </main>
  );
}

export default function PublicationDeskPage() {
  return <Suspense fallback={<main className="engineer-screen"><section className="engineer-card"><p className="engineer-muted">Loading…</p></section></main>}>
    <PublicationDeskInner />
  </Suspense>;
}
