/**
 * A deliberately conservative, client-side planning estimate. This is not a
 * billing quote: provider prices and actual context size are only known after
 * admission. Keeping the estimate deterministic lets the UI warn before any
 * model call is made and avoids another network request.
 */
export type EngineerCostEstimate = {
  lowerUsd: number;
  upperUsd: number;
  complexity: "small" | "medium" | "large";
  checks: string[];
};

export function estimateEngineerCost(request: string, repositoryName = ""): EngineerCostEstimate {
  const normalized = request.trim();
  const size = normalized.length + repositoryName.length;
  const risky = /security|auth|payment|migration|database|production|breaking|compliance/i.test(normalized);
  const complexity: EngineerCostEstimate["complexity"] = risky || size > 1800 ? "large" : size > 700 ? "medium" : "small";
  const base = complexity === "small" ? 0.08 : complexity === "medium" ? 0.22 : 0.45;
  const upper = complexity === "small" ? 0.35 : complexity === "medium" ? 0.85 : 1.75;
  return {
    lowerUsd: base,
    upperUsd: upper,
    complexity,
    checks: [
      "Deterministic preflight runs before model calls",
      "Terra/Luna handle routine work; Sol is reserved for isolated final review or explicit escalation",
      "Human approval is required before publication",
    ],
  };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
