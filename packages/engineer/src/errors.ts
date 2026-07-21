export class EngineerNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EngineerNotFoundError";
  }
}

/**
 * Constructor-time org-context rejection (contract §1). Thrown when an
 * `EngineerLedger` is bound to an org that is not a KNOWN, ACTIVE row in
 * `orgs(id)`. The default org is seeded active by the tenancy migration, so
 * default construction never trips this; a non-existent or SUSPENDED org does.
 */
export class EngineerOrgContextError extends Error {
  readonly code = "ENGINEER_ORG_CONTEXT_INVALID";
  constructor(readonly orgId: string) {
    super(`org context is not a known active org: ${orgId}`);
    this.name = "EngineerOrgContextError";
  }
}

export class StateVersionConflictError extends Error {
  readonly code = "STALE_CLIENT_STATE" as const;
  constructor(runId: string, expected: number, actual: number) {
    super(`state version conflict for ${runId}: expected ${expected}, actual ${actual}`);
    this.name = "StateVersionConflictError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;
  constructor(runId: string, key: string) {
    super(`idempotency key ${key} was already used with different transition data for ${runId}`);
    this.name = "IdempotencyConflictError";
  }
}

export class ApprovalAuthorityConflictError extends Error {
  readonly code = "ENGINEER_CANDIDATE_CHANGED";
  readonly action = "REFRESH_APPROVAL";

  constructor(readonly runId: string) {
    super("Candidate changed since this approval was displayed. Refresh the approval and review the current checkpoint before deciding.");
    this.name = "ApprovalAuthorityConflictError";
  }
}

export class VerifiedCandidateIntegrityError extends Error {
  readonly code = "ENGINEER_VERIFIED_CANDIDATE_CORRUPT";

  constructor(readonly runId: string) {
    super("Verified candidate promotion references missing or corrupt durable checkpoint authority.");
    this.name = "VerifiedCandidateIntegrityError";
  }
}

export class VerifiedCandidateRequiredError extends Error {
  readonly code = "ENGINEER_VERIFIED_CANDIDATE_REQUIRED";
  readonly action = "RETRY_OR_REJECT";

  constructor() {
    super("Human review cannot approve unpromoted work. Retry verification to produce a verified candidate or reject the run.");
    this.name = "VerifiedCandidateRequiredError";
  }
}

export class ManifestIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestIntegrityError";
  }
}

export class BudgetPausedError extends Error {
  constructor(runId: string, reason: string) {
    super(`run ${runId} paused safely: ${reason}`);
    this.name = "BudgetPausedError";
  }
}

export class BuilderModelCallLimitError extends Error {
  readonly runId: string;
  readonly limit: number;

  constructor(runId: string, limit: number) {
    super(`run ${runId} reached the durable Builder model-call limit of ${limit}`);
    this.name = "BuilderModelCallLimitError";
    this.runId = runId;
    this.limit = limit;
  }
}

export class AdvisoryIntegrityError extends Error { readonly code = "ENGINEER_ADVISORY_INTEGRITY_FAILURE"; constructor() { super("Advisory backlog authority failed integrity verification."); this.name = "AdvisoryIntegrityError"; } }
export class AdvisoryMaterializationRequiredError extends Error { readonly code = "ENGINEER_ADVISORY_MATERIALIZATION_REQUIRED"; constructor() { super("This legacy candidate has no advisory materialization authority."); this.name = "AdvisoryMaterializationRequiredError"; } }
export class AdvisoryChangedError extends Error { readonly code = "ENGINEER_ADVISORY_CHANGED"; readonly action = "REFRESH_ADVISORIES"; constructor() { super("Advisory changed. Refresh advisories before deciding."); this.name = "AdvisoryChangedError"; } }
export class AdvisoryTransitionInvalidError extends Error { readonly code = "ENGINEER_ADVISORY_TRANSITION_INVALID"; constructor() { super("Advisory transition is invalid from its current status."); this.name = "AdvisoryTransitionInvalidError"; } }
export class AdvisoryCursorInvalidError extends Error { readonly code = "ENGINEER_ADVISORY_CURSOR_INVALID"; constructor() { super("Advisory cursor is invalid for this owner, run, or filter."); this.name = "AdvisoryCursorInvalidError"; } }
export class HardeningAuthorityInvalidError extends Error { readonly code = "ENGINEER_HARDENING_AUTHORITY_INVALID"; constructor() { super("Hardening authority failed exact checkpoint, quote, or selection verification."); this.name = "HardeningAuthorityInvalidError"; } }
export class HardeningSelectionInvalidError extends Error { readonly code = "ENGINEER_HARDENING_SELECTION_INVALID"; constructor() { super("Hardening selection must contain only open, actionable advisories from the verified parent candidate."); this.name = "HardeningSelectionInvalidError"; } }
export class HardeningQuoteExpiredError extends Error { readonly code = "ENGINEER_HARDENING_QUOTE_EXPIRED"; constructor() { super("Hardening quote expired. Request a fresh deterministic quote."); this.name = "HardeningQuoteExpiredError"; } }
export class HardeningQuoteVersionStaleError extends Error { readonly code = "HARDENING_QUOTE_VERSION_STALE"; readonly refreshAction = "CREATE_UPDATED_QUOTE"; constructor() { super("This legacy quote is readable but cannot authorize new hardening work. Create an updated quote."); this.name = "HardeningQuoteVersionStaleError"; } }
export class HardeningQuoteInputTooLargeError extends Error { readonly code = "HARDENING_QUOTE_INPUT_TOO_LARGE"; readonly refreshAction = "REDUCE_HARDENING_SELECTION"; constructor() { super("The complete Builder request exceeds the deterministic hardening input cap. Reduce the hardening selection."); this.name = "HardeningQuoteInputTooLargeError"; } }
export class HardeningPricingUnavailableError extends Error { readonly code = "ENGINEER_HARDENING_PRICING_UNAVAILABLE"; constructor() { super("Frozen hardening routing or pricing authority is unavailable."); this.name = "HardeningPricingUnavailableError"; } }
export class DatabaseIntegrityCorruptionError extends Error {
  readonly code = "DATABASE_INTEGRITY_CORRUPTION";
  readonly retryable = false;
  constructor(readonly childRunId: string, readonly reservationId: string) {
    super("Durable paid-call database authority is corrupt. Automatic recovery stopped without mutating liability.");
    this.name = "DatabaseIntegrityCorruptionError";
  }
}
export class HardeningPromptCacheAuthorityUnavailableError extends Error {
  readonly code = "HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE";
  readonly retryable = true;
  constructor() {
    super("The local hardening prompt-cache authority is unavailable. Paid hardening is paused until the original secret is restored and the gateway is restarted.");
    this.name = "HardeningPromptCacheAuthorityUnavailableError";
  }
}
export class HardeningPromptCacheAuthorityMismatchError extends Error {
  readonly code = "HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH";
  readonly retryable = true;
  constructor() {
    super("The configured hardening prompt-cache secret cannot reproduce its durable machine and reservation authority. Restore the original secret and restart the gateway.");
    this.name = "HardeningPromptCacheAuthorityMismatchError";
  }
}
export class ReplacementLineageUnverifiedError extends Error {
  readonly code = "ENGINEER_REPLACEMENT_LINEAGE_UNVERIFIED";
  readonly retryable = false;
  constructor(readonly runId: string, readonly reason: string) {
    super(`Replacement run ${runId} cannot be granted promotion, approval, or publication authority because its resolution lineage did not verify (${reason}).`);
    this.name = "ReplacementLineageUnverifiedError";
  }
}
export class HardeningGenericOperationForbiddenError extends Error {
  readonly code = "HARDENING_GENERIC_OPERATION_FORBIDDEN";
  readonly retryable = false;
  constructor() {
    super("Optional hardening must use its signed seed, immutable budget, and dedicated execution lane.");
    this.name = "HardeningGenericOperationForbiddenError";
  }
}
export class HardeningWorkspaceRecoveryAuthorityInvalidError extends Error {
  readonly code = "HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID";
  readonly retryable = false;
  constructor(readonly runId:string) {
    super("Optional hardening stopped safely because its signed workspace recovery authority is missing, ambiguous, or does not match the retained bytes. Start a new bounded hardening run from the last verified parent candidate.");
    this.name = "HardeningWorkspaceRecoveryAuthorityInvalidError";
  }
}
export class HardeningReviewerRecoveryAuthorityInvalidError extends Error {
  readonly code = "HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID";
  readonly retryable = false;
  constructor(readonly runId:string) {
    super("Optional hardening stopped safely because the durable Reviewer recovery footprint is partial, ambiguous, or does not match its classified result. Inspect the retained evidence and start a new bounded hardening run if needed.");
    this.name = "HardeningReviewerRecoveryAuthorityInvalidError";
  }
}
export class DatabaseIntegrityFatalMarkerConflictError extends Error {
  readonly code = "DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT";
  readonly retryable = false;
  constructor(readonly runId: string) {
    super("The durable database-integrity fatal marker is occupied by non-canonical data. Automatic recovery remains stopped.");
    this.name = "DatabaseIntegrityFatalMarkerConflictError";
  }
}
export class DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError extends Error {
  readonly code = "DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT_AUTHORITY_INVALID";
  readonly retryable = false;
  constructor(readonly runId: string) {
    super("Both deterministic database-integrity marker IDs contain non-canonical data. Automatic recovery remains stopped.");
    this.name = "DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError";
  }
}
export class ReviewCaptureUnavailableError extends Error {
  readonly code = "ENGINEER_REVIEW_CAPTURE_PREDATES_V38";
  readonly retryable = false;
  constructor(readonly reviewerSessionId: string) {
    super("This review predates reviewer-input/normalized-output capture (schema v38) and cannot be replayed. Its sealed classification remains immutable, but no replay authority was ever recorded for it.");
    this.name = "ReviewCaptureUnavailableError";
  }
}
