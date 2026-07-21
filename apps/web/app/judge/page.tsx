import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Zintus Engineer — Verified engineering",
  description: "A guided walkthrough of Zintus Engineer's bounded, evidence-first software workflow.",
};

const acceptanceCriteria = [
  "Exports DagScheduler with bounded concurrency and dependency ordering.",
  "Rejects missing or cyclic dependencies before an unsafe run begins.",
  "Propagates cancellation, timeout, and dependency failure without executing blocked tasks.",
  "Tests prove priority updates, timeout cleanup, and failure fan-out.",
];

const events = [
  ["01", "Repository intelligence", "Runtime, test command, and existing controls inspected."],
  ["02", "Frozen engineering contract", "Scope, criteria, tests, and stage budgets were locked."],
  ["03", "Isolated implementation", "The candidate was produced inside a pinned, offline sandbox."],
  ["04", "Independent verification", "Required tests, scope, and evidence were checked deterministically."],
  ["05", "Human-ready candidate", "A hash-bound checkpoint was retained for review."],
] as const;

const diffLines = [
  ["@@ -1,5 +1,39 @@", "hunk"],
  ["+export class DagScheduler {", "addition"],
  ["+  private readonly tasks = new Map<string, TaskRecord>();", "addition"],
  ["+  private running = 0;", "addition"],
  ["+", "addition"],
  ["+  addTask<T>(id: string, executor: Executor<T>, options = {}): Promise<T> {", "addition"],
  ["+    this.assertDependencyGraph(id, options.dependencies ?? []);", "addition"],
  ["+    return this.enqueue(id, executor, options);", "addition"],
  ["+  }", "addition"],
  ["+", "addition"],
  ["+  cancelTask(id: string): void {", "addition"],
  ["+    this.abortOrReject(id);", "addition"],
  ["+  }", "addition"],
  ["+}", "addition"],
] as const;

export default function JudgeReplayPage() {
  return (
    <main className="judge-page">
      <header className="judge-nav">
        <Link className="judge-back" href="/engineer">← Back to Engineer</Link>
        <Link className="judge-brand" href="/">Zintus <span>Engineer</span></Link>
        <span className="judge-replay-badge">Evidence-first workflow</span>
      </header>

      <section className="judge-hero">
        <p className="judge-kicker">Bounded autonomous engineering</p>
        <h1>AI proposes. The engineering system proves.</h1>
        <p className="judge-lede">See how Zintus turns an engineering request into a bounded, reviewable candidate: scope first, deterministic execution, independent verification, then a human decision.</p>
        <div className="judge-hero-actions">
          <a className="judge-primary" href="#run">Inspect the verified run</a>
          <a className="judge-secondary" href="#architecture">See the architecture</a>
        </div>
      </section>

      <section className="judge-assurance" aria-label="Engineering safeguards">
        <div><strong>1</strong><span>frozen contract</span></div>
        <div><strong>0</strong><span>unbounded retries</span></div>
        <div><strong>100%</strong><span>reviewable evidence</span></div>
        <div><strong>1</strong><span>human decision</span></div>
      </section>

      <section className="judge-section" id="architecture">
        <div className="judge-section-heading"><p className="judge-kicker">The required lane</p><h2>One deterministic path from request to verified candidate</h2></div>
        <div className="judge-lane">
          <div className="judge-lane-item judge-lane-source"><b>Repository source</b><span>Local folder, GitHub, or cloud</span></div>
          <i aria-hidden="true" />
          <div className="judge-lane-item"><b>Repository intelligence</b><span>Runtime, entry points, existing controls</span></div>
          <i aria-hidden="true" />
          <div className="judge-lane-item"><b>Frozen engineering contract</b><span>Scope, criteria, tests, stage budget</span></div>
          <i aria-hidden="true" />
          <div className="judge-lane-item"><b>Deterministic execution</b><span>Sandbox, diff, tests, security, scope</span></div>
          <i aria-hidden="true" />
          <div className="judge-lane-item"><b>Scoped reviewer</b><span>The model proposes; the gateway decides</span></div>
          <i aria-hidden="true" />
          <div className="judge-lane-item judge-lane-final"><b>Verified candidate checkpoint</b><span>Hash-bound evidence retained for review</span></div>
        </div>
      </section>

      <section className="judge-section" id="run">
        <div className="judge-run-heading">
          <div><p className="judge-kicker">Example candidate</p><h2>Build a dependency-aware DAG task scheduler</h2><p>Medium complexity TypeScript task · isolated execution · evidence retained for review</p></div>
          <span className="judge-status">Verified candidate</span>
        </div>

        <div className="judge-run-grid">
          <article className="judge-card judge-contract">
            <div className="judge-card-title"><span>01</span><div><h3>Frozen contract</h3><p>These requirements were locked before implementation.</p></div></div>
            <ol>
              {acceptanceCriteria.map((criterion, index) => <li key={criterion}><span>{String(index + 1).padStart(2, "0")}</span>{criterion}</li>)}
            </ol>
            <div className="judge-contract-footer"><code>scope: src/scheduler.ts · test/scheduler.test.ts</code><span>Budget reserved before execution</span></div>
          </article>

          <aside className="judge-card judge-evidence-summary">
            <p className="judge-kicker">Evidence summary</p>
            <dl>
              <div><dt>Required criteria</dt><dd>4 / 4</dd></div>
              <div><dt>Allowed files</dt><dd>2 / 2</dd></div>
              <div><dt>Security findings</dt><dd>0</dd></div>
              <div><dt>Final decision</dt><dd className="judge-pass">Approve</dd></div>
            </dl>
            <p className="judge-evidence-note">In a live run, each claim is linked to immutable test and artifact evidence before the candidate reaches a human decision.</p>
          </aside>
        </div>

        <article className="judge-card judge-diff-card">
          <div className="judge-diff-head"><div><p className="judge-kicker">Scoped change</p><h3>src/scheduler.ts</h3></div><span>+13 · −0</span></div>
          <pre className="judge-diff" aria-label="Unified diff">{diffLines.map(([line, kind], index) => <code className={kind} key={`${index}-${line}`}><span>{String(index + 1).padStart(2, "0")}</span>{line}{"\n"}</code>)}</pre>
          <p className="judge-caption">A live run exposes the complete reviewable patch and checksummed evidence bundle.</p>
        </article>
      </section>

      <section className="judge-section judge-execution">
        <div className="judge-section-heading"><p className="judge-kicker">Traceability</p><h2>A durable timeline, not a chat transcript</h2></div>
        <ol className="judge-timeline">
          {events.map(([number, title, detail]) => <li key={number}><span>{number}</span><div><h3>{title}</h3><p>{detail}</p></div><b>Required</b></li>)}
        </ol>
      </section>

      <section className="judge-section">
        <div className="judge-section-heading"><p className="judge-kicker">Guardrails that matter</p><h2>What Zintus enforces before a change becomes reviewable</h2></div>
        <div className="judge-controls">
          <article><span>Scope</span><h3>Only approved paths</h3><p>The frozen contract limits files, commands, acceptance criteria, and the repository base commit.</p></article>
          <article><span>Budget</span><h3>Reserve before calls</h3><p>Each stage receives an explicit allowance. The system pauses rather than silently spending past it.</p></article>
          <article><span>Sandbox</span><h3>Untrusted code stays isolated</h3><p>Builder commands run in a pinned, non-root, offline workspace with no host secrets.</p></article>
          <article><span>Verification</span><h3>Tests are the evidence</h3><p>A candidate is measured against its frozen criteria, not against a reviewer&apos;s new preferences.</p></article>
          <article><span>Review</span><h3>Advisories do not hijack delivery</h3><p>Out-of-scope hardening becomes an explicit option, not an automatic repair loop that burns budget.</p></article>
          <article><span>Recovery</span><h3>Failures remain legible</h3><p>Durable events, checkpoints, and bounded corrections preserve the trail when a run pauses or fails.</p></article>
        </div>
      </section>

      <section className="judge-section judge-bundle">
        <div><p className="judge-kicker">Evidence package</p><h2>A reviewable change has more than generated code.</h2><p>In live mode, the engineer retains a content-addressed package for the candidate and exposes it in the review screen.</p></div>
        <dl>
          <div><dt>Frozen manifest</dt><dd>Scope, criteria, permitted commands, model and stage limits.</dd></div>
          <div><dt>Scoped patch</dt><dd>Unified diff with paths, file count, and copy/download support.</dd></div>
          <div><dt>Verification record</dt><dd>Executed commands, results, security checks, and acceptance mapping.</dd></div>
          <div><dt>Candidate checkpoint</dt><dd>Hash-bound identity retained before any human publication decision.</dd></div>
        </dl>
      </section>

      <footer className="judge-footer">Zintus Engineer · Bounded, evidence-first software delivery</footer>
    </main>
  );
}
