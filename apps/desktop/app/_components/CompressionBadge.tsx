"use client";

import type { CompressionStats } from "@/lib/gateway";

function fmtUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Honest, per-response proof that Tokzen compression saved tokens before the
 * prompt hit the provider — e.g. "Compressed 64% · saved 8,200 tokens (~$0.03
 * est)". Rendered ONLY when the gateway sent real savings (the parent passes a
 * non-null `stats`); the dollar figure is labelled an estimate because the
 * pricing table is illustrative, not a bill.
 */
export function CompressionBadge({ stats }: { stats: CompressionStats }) {
  // Reduction percent off the actual token counts (more precise than the
  // 2-decimal ratio header), clamped to a sane 0..99 display range.
  const reductionPct = Math.max(
    0,
    Math.min(99, Math.round((stats.tokensSaved / stats.originalTokens) * 100)),
  );

  return (
    <div
      className="compression-badge"
      title="Tokzen compressed your prompt before sending it to the provider. The cost figure is an estimate, not a charge."
    >
      <span className="compression-badge-icon" aria-hidden>
        ⤵
      </span>
      <span>
        Compressed {reductionPct}% · saved{" "}
        {stats.tokensSaved.toLocaleString()} tokens
        {stats.costSavedUsd != null
          ? ` (~${fmtUsd(stats.costSavedUsd)} est)`
          : ""}
      </span>
    </div>
  );
}
