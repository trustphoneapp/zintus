import { useState } from "react";
import {
  getDecisionPresentation,
  getDeferredHumanTaskSummary,
  getPresentedDecisionOptions,
  type EngineerDecisionItem,
} from "@/lib/engineer-decisions";

export function DecisionPresentation({ decisions, onResolve, disabled = false, stage }: {
  decisions: EngineerDecisionItem[];
  onResolve?: (decisionId: string, optionId: string) => void | Promise<void>;
  disabled?: boolean;
  stage?: { index: number; total: number; label: string; complete?: boolean };
}) {
  // Resolved planning choices remain in the durable audit trail, but they are
  // not an inbox item. Rendering them as "Needs your answer now" after the
  // run has advanced makes users repeat decisions they already made.
  const openDecisions = decisions.filter((decision) => decision.status === "OPEN");
  if (!openDecisions.length) return null;

  return (
    <section className="engineer-card engineer-decisions" aria-labelledby="engineer-decisions-heading">
      {stage ? <div className="engineer-decision-stage"><span>{stage.complete ? "Workflow complete" : `Stage ${stage.index} of ${stage.total}`}</span><progress max={stage.total} value={stage.complete ? stage.total : stage.index} /><strong>{stage.label}</strong></div> : null}
      <div className="engineer-card-heading">
        <div>
          <span className="engineer-kicker">Decision inbox</span>
          <h2 id="engineer-decisions-heading">Clear choices, bounded impact</h2>
        </div>
        <span className="engineer-chip">{openDecisions.length} {openDecisions.length === 1 ? "decision" : "decisions"}</span>
      </div>
      <div className="engineer-decision-list">
        {openDecisions.map((decision) => <DecisionCard key={decision.decisionId} decision={decision} onResolve={onResolve} disabled={disabled} />)}
      </div>
    </section>
  );
}

function DecisionCard({ decision, onResolve, disabled = false }: {
  decision: EngineerDecisionItem;
  onResolve?: (decisionId: string, optionId: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const presentation = getDecisionPresentation(decision.classification);
  const options = getPresentedDecisionOptions(decision);
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);

  const apply = async (optionId: string) => {
    if (!onResolve || disabled || pendingOptionId) return;
    setPendingOptionId(optionId);
    try { await onResolve(decision.decisionId, optionId); }
    finally { setPendingOptionId(null); }
  };

  return (
    <article className={`engineer-decision engineer-decision--${presentation.tone}`}>
      <header className="engineer-decision-header">
        <div>
          <span className={`engineer-decision-kind engineer-decision-kind--${presentation.tone}`}>{presentation.label}</span>
          <h3>{decision.question}</h3>
          <p>{presentation.summary}</p>
        </div>
        <span className="engineer-decision-classification">{decision.classification.replace("_", " ")}</span>
      </header>
      <div className="engineer-decision-reasons" aria-label="Decision reasons">
        {decision.reasonCodes.map((reasonCode) => <span key={reasonCode}>{reasonCode.replaceAll("_", " ")}</span>)}
      </div>
      {decision.provenance?.trust === "UNTRUSTED_MODEL_OUTPUT"
        ? <p className="engineer-muted">AI-generated choice text from untrusted planning context. Verify the impact and deterministic reason codes before choosing.</p>
        : null}
      <div className="engineer-decision-options" role="list" aria-label={`Options for ${decision.question}`}>
        {options.map((option) => {
          const selected = decision.selectedOptionId === option.optionId;
          return (
            <div className={`engineer-decision-option risk-${option.riskTier.toLowerCase()}${option.recommended ? " is-recommended" : ""}${selected ? " is-selected" : ""}`} role="listitem" key={option.optionId}>
              <div className="engineer-decision-option-title">
                <strong>{option.label}</strong>
                {option.recommended ? <span>Recommended</span> : null}
                {selected ? <span className="engineer-decision-applied">Applied</span> : null}
              </div>
              <p>{option.impact}</p>
              <small>{option.riskTier} risk · {option.reversibility.replaceAll("_", " ").toLowerCase()}</small>
              {decision.status === "OPEN" && decision.classification !== "AUTO" && !option.synthetic && onResolve
                ? <button type="button" disabled={disabled || pendingOptionId !== null} onClick={() => void apply(option.optionId)}>{pendingOptionId === option.optionId ? "Applying choice…" : "Choose this option"}</button>
                : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function DeferredHumanTaskSummary({ decisions }: { decisions: EngineerDecisionItem[] }) {
  const summary = getDeferredHumanTaskSummary(decisions);
  return (
    <section className="engineer-card engineer-deferred-summary" aria-labelledby="engineer-deferred-heading">
      <div>
        <span className="engineer-kicker">End-of-run checklist</span>
        <h2 id="engineer-deferred-heading">Deferred human tasks</h2>
        <p>{summary.count
          ? `${summary.count} non-blocking ${summary.count === 1 ? "decision remains" : "decisions remain"} for a human.`
          : "No deferred human decisions remain."}</p>
      </div>
      {summary.tasks.length ? <ol>
        {summary.tasks.map((task) => <li key={task.decisionId}><strong>{task.question}</strong><span>Recommended: {task.recommendedOption}</span></li>)}
      </ol> : <span className="engineer-deferred-clear">Clear</span>}
    </section>
  );
}
