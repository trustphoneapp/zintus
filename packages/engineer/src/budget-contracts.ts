import { z } from "zod";
import { LogicalModelTierSchema, RunStateSchema } from "./contracts.js";

const IdentifierSchema = z.string().min(1).max(200);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const MoneySchema = z.number().finite().nonnegative().max(100);

export const DEFAULT_ENGINEER_BUDGET = Object.freeze({
  costBudgetUsd: 20,
  tokenBudget: 200_000,
  timeBudgetSeconds: 3_600,
  lifetimeCostBudgetUsd: 100,
  lifetimeTokenBudget: 1_000_000,
  lifetimeTimeBudgetSeconds: 86_400,
});

export const EngineerBudgetSelectionSchema = z.object({
  costBudgetUsd: MoneySchema.default(DEFAULT_ENGINEER_BUDGET.costBudgetUsd),
  tokenBudget: z.number().int().nonnegative().max(1_000_000).default(DEFAULT_ENGINEER_BUDGET.tokenBudget),
  timeBudgetSeconds: z.number().int().positive().max(86_400).default(DEFAULT_ENGINEER_BUDGET.timeBudgetSeconds),
  lifetimeCostBudgetUsd: MoneySchema.default(DEFAULT_ENGINEER_BUDGET.lifetimeCostBudgetUsd),
  lifetimeTokenBudget: z.number().int().nonnegative().max(1_000_000).default(DEFAULT_ENGINEER_BUDGET.lifetimeTokenBudget),
  lifetimeTimeBudgetSeconds: z.number().int().positive().max(86_400).default(DEFAULT_ENGINEER_BUDGET.lifetimeTimeBudgetSeconds),
}).strict().superRefine((value, context) => {
  for (const [limit, lifetime] of [
    ["costBudgetUsd", "lifetimeCostBudgetUsd"],
    ["tokenBudget", "lifetimeTokenBudget"],
    ["timeBudgetSeconds", "lifetimeTimeBudgetSeconds"],
  ] as const) {
    if (value[limit] > value[lifetime]) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${limit} cannot exceed ${lifetime}`, path: [limit] });
    }
  }
});

export const BudgetStatusSchema = z.enum(["ACTIVE", "WARNING", "PAUSED"]);
export const BudgetPauseReasonSchema = z.enum([
  "COST_LIMIT_REACHED",
  "TOKEN_LIMIT_REACHED",
  "TIME_LIMIT_REACHED",
  "MODEL_USAGE_UNKNOWN",
]);

export const EngineerBudgetSnapshotSchema = z.object({
  runId: IdentifierSchema,
  status: BudgetStatusSchema,
  limits: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative(), timeSeconds: z.number().int().nonnegative() }).strict(),
  lifetimeLimits: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative(), timeSeconds: z.number().int().nonnegative() }).strict(),
  used: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative(), timeSeconds: z.number().int().nonnegative() }).strict(),
  reserved: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative() }).strict(),
  ambiguous: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative() }).strict(),
  remaining: z.object({ costUsd: MoneySchema, tokens: z.number().int().nonnegative(), timeSeconds: z.number().int().nonnegative() }).strict(),
  warningThreshold: z.number().min(0.5).max(0.99),
  pauseReason: BudgetPauseReasonSchema.nullable(),
  resumeState: RunStateSchema.nullable(),
  revision: z.number().int().positive(),
  updatedAt: IsoTimestampSchema,
}).strict();

export const BudgetTopUpSchema = z.object({
  addCostBudgetUsd: MoneySchema.default(0),
  addTokenBudget: z.number().int().nonnegative().max(1_000_000).default(0),
  addTimeBudgetSeconds: z.number().int().nonnegative().max(86_400).default(0),
}).strict().superRefine((value, context) => {
  if (value.addCostBudgetUsd === 0 && value.addTokenBudget === 0 && value.addTimeBudgetSeconds === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "at least one positive budget increment is required" });
  }
});

export const BudgetReservationSchema = z.object({
  reservationId: IdentifierSchema,
  runId: IdentifierSchema,
  logicalTier: LogicalModelTierSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reservedCostUsd: MoneySchema,
  createdAt: IsoTimestampSchema,
}).strict();

export type EngineerBudgetSelection = z.infer<typeof EngineerBudgetSelectionSchema>;
export type EngineerBudgetSnapshot = z.infer<typeof EngineerBudgetSnapshotSchema>;
export type BudgetTopUp = z.infer<typeof BudgetTopUpSchema>;
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
export type BudgetPauseReason = z.infer<typeof BudgetPauseReasonSchema>;
