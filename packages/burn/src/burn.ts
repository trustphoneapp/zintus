import { multiplierFor } from "./markup.js";
import type { ModelClass, ModelRates } from "./rates.js";

/**
 * The burn calculator: turns a token-usage breakdown plus billing-grade rates
 * into an integer-microcent receipt.
 *
 * Money unit: MICROCENTS (µ¢). $1 = 100¢ = 1,000,000 µ¢, so a USD-per-1M-token
 * rate is numerically the µ¢-per-token rate ($5/1M tokens = 5 µ¢/token). That
 * identity keeps every leg an integer `Math.round(tokens × rate)` with no
 * float accumulation across a ledger — ledgers sum integers, never floats.
 *
 * Every burn is a RECEIPT, not a number: raw provider cost, the public
 * multiplier, and the markup are separate displayable fields, because the
 * markup is public product data (see `markup.ts`), and because reconciliation
 * needs raw-vs-billed per request.
 */

/** Token counts for one completed request, normalized for billing. */
export interface UsageBreakdown {
  /** Total prompt tokens, INCLUDING any `cacheReadTokens` subset. */
  inputTokens: number;
  /** Completion tokens. */
  outputTokens: number;
  /** Reasoning/"thinking" tokens, when reported. Billed at the output rate. */
  reasoningTokens?: number;
  /**
   * Whether `reasoningTokens` are already counted inside `outputTokens`.
   * OpenAI-compatible APIs include them (subset — default true); Gemini's
   * `thoughtsTokenCount` is separate from `candidatesTokenCount` (pass false).
   * Getting this wrong double-bills or under-bills every reasoning request.
   */
  reasoningIncludedInOutput?: boolean;
  /** Prompt-cache read tokens. Subset of `inputTokens`. */
  cacheReadTokens?: number;
  /** Prompt-cache write tokens. Billed IN ADDITION to `inputTokens`. */
  cacheWriteTokens?: number;
}

/** One priced component of a burn. */
export interface BurnLeg {
  kind: "input" | "cache_read" | "cache_write" | "output" | "reasoning";
  tokens: number;
  /** USD per 1M tokens ( = µ¢ per token) this leg was priced at. */
  ratePer1M: number;
  microcents: number;
}

/** The full, displayable result of pricing one request. */
export interface BurnReceipt {
  provider: ModelRates["provider"];
  model: string;
  class: ModelClass;
  legs: BurnLeg[];
  /** Provider list cost: exact sum of `legs[].microcents`. */
  rawMicrocents: number;
  /** The public markup multiplier applied (see PUBLIC_MARKUP). */
  multiplier: number;
  /** What the user is charged: round(raw × multiplier). */
  billedMicrocents: number;
  /** Zintus's margin on this request: billed − raw. */
  markupMicrocents: number;
  /** Price-snapshot version the rates came from, when known. */
  snapshotVersion?: number;
}

function clampTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function leg(kind: BurnLeg["kind"], tokens: number, ratePer1M: number): BurnLeg {
  return { kind, tokens, ratePer1M, microcents: Math.round(tokens * ratePer1M) };
}

/**
 * Price one request. Pure and deterministic: same inputs → same receipt.
 *
 * Leg semantics:
 *  - cache-read tokens are carved OUT of the input leg and priced at the
 *    cache-read rate (falling back to the full input rate when the provider's
 *    discount is unlisted — conservative, never undercharges);
 *  - cache-write tokens are additional to input (Anthropic-style);
 *  - reasoning tokens add an output-rate leg only when NOT already inside
 *    `outputTokens` (`reasoningIncludedInOutput: false`, the Gemini case) —
 *    otherwise they're informational and already paid for in the output leg.
 */
export function burn(
  usage: UsageBreakdown,
  rates: ModelRates,
  options?: { multiplier?: number; snapshotVersion?: number },
): BurnReceipt {
  const input = clampTokens(usage.inputTokens);
  const output = clampTokens(usage.outputTokens);
  const reasoning = clampTokens(usage.reasoningTokens);
  const cacheRead = Math.min(clampTokens(usage.cacheReadTokens), input);
  const cacheWrite = clampTokens(usage.cacheWriteTokens);
  const uncachedInput = input - cacheRead;

  const legs: BurnLeg[] = [
    leg("input", uncachedInput, rates.inPer1M),
  ];
  if (cacheRead > 0) {
    legs.push(leg("cache_read", cacheRead, rates.cacheReadPer1M ?? rates.inPer1M));
  }
  if (cacheWrite > 0) {
    legs.push(leg("cache_write", cacheWrite, rates.cacheWritePer1M ?? rates.inPer1M));
  }
  legs.push(leg("output", output, rates.outPer1M));
  if (reasoning > 0 && usage.reasoningIncludedInOutput === false) {
    legs.push(leg("reasoning", reasoning, rates.outPer1M));
  }

  const rawMicrocents = legs.reduce((sum, l) => sum + l.microcents, 0);
  const multiplier = options?.multiplier ?? multiplierFor(rates.class);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new RangeError(
      `burn multiplier must be a finite number >= 1, got ${multiplier}`,
    );
  }
  const billedMicrocents = Math.round(rawMicrocents * multiplier);

  const receipt: BurnReceipt = {
    provider: rates.provider,
    model: rates.model,
    class: rates.class,
    legs,
    rawMicrocents,
    multiplier,
    billedMicrocents,
    markupMicrocents: billedMicrocents - rawMicrocents,
  };
  if (options?.snapshotVersion !== undefined) {
    receipt.snapshotVersion = options.snapshotVersion;
  }
  return receipt;
}

/** Microcents per credit: 1 credit = 1¢ (the GitHub Copilot convention). */
export const MICROCENTS_PER_CREDIT = 10_000;

/**
 * Convert microcents to whole credits. `"ceil"` (ledger deduction: partial
 * credits round against the house's favor being silently free) vs `"exact"`
 * (display: fractional credits, 4 decimal places of a cent).
 */
export function microcentsToCredits(
  microcents: number,
  mode: "ceil" | "exact" = "ceil",
): number {
  const credits = microcents / MICROCENTS_PER_CREDIT;
  return mode === "ceil" ? Math.ceil(credits) : credits;
}

/** Format microcents as a USD string for display, e.g. 1_234_500 → "$1.2345". */
export function formatUsd(microcents: number): string {
  const usd = microcents / 1_000_000;
  // Show enough precision for sub-cent burns without trailing noise on whole
  // amounts: at least 2 decimals, up to 6.
  const text = usd.toFixed(6).replace(/(\.\d\d[1-9]*)0+$/, "$1");
  return `$${text}`;
}
