export class EngineerNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EngineerNotFoundError";
  }
}

export class StateVersionConflictError extends Error {
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
  constructor(runId: string, key: string) {
    super(`idempotency key ${key} was already used with different transition data for ${runId}`);
    this.name = "IdempotencyConflictError";
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
