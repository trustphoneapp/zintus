import {
  getDecisionPresentation,
  getDeferredHumanTaskSummary,
  getPresentedDecisionOptions,
  type EngineerDecisionItem,
} from "@/lib/engineer-decisions";

export function DecisionPresentation({ decisions, onResolve }: {
  decisions: EngineerDecisionItem[];
  onResolve?: (decisionId: string, optionId: string) => void | Promise<void>;
}) {
  if (!decisions.length) return null;

  return (
    <section className="engineer-card engineer-decisions" aria-labelledby="engineer-decisions-heading">
      <div className="engineer-card-heading">
        <div>
          <span className="engineer-kicker">Decision inbox</span>
          <h2 id="engineer-decisions-heading">Clear choices, bounded impact</h2>
        </div>
        <span className="engineer-chip">{decisions.length} {decisions.length === 1 ? "decision" : "decisions"}</span>
      </div>
      <div className="engineer-decision-list">
        {decisions.map((decision) => <DecisionCard key={decision.decisionId} decision={decision} onResolve={onResolve} />)}
      </div>
    </section>
  );
}

function DecisionCard({ decision, onResolve }: {
  decision: EngineerDecisionItem;
  onResolve?: (decisionId: string, optionId: string) => void | Promise<void>;
}) {
  const presentation = getDecisionPresentation(decision.classification);
  const options = getPresentedDecisionOptions(decision);

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
      <div className="engineer-decision-options" role="list" aria-label={`Options for ${decision.question}`}>
        {options.map((option) => {
          const selected = decision.selectedOptionId === option.optionId;
          return (
            <div className={`engineer-decision-option${option.recommended ? " is-recommended" : ""}${selected ? " is-selected" : ""}`} role="listitem" key={option.optionId}>
              <div className="engineer-decision-option-title">
                <strong>{option.label}</strong>
                {option.recommended ? <span>Recommended</span> : null}
                {selected ? <span className="engineer-decision-applied">Applied</span> : null}
              </div>
              <p>{option.impact}</p>
              <small>{option.riskTier} risk · {option.reversibility.replaceAll("_", " ").toLowerCase()}</small>
              {decision.status === "OPEN" && decision.classification !== "AUTO" && !option.synthetic && onResolve
                ? <button type="button" onClick={() => void onResolve(decision.decisionId, option.optionId)}>Choose this option</button>
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
