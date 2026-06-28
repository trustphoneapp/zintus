"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import {
  fetchRouteOptions,
  type RouteOptionId,
  type RouteOptions,
} from "@/lib/gateway";

/**
 * Display copy for the gateway's BYOK-only quota-exhaustion actions. There is
 * intentionally NO paid/credits/overflow entry: `/v1/route/options` never returns
 * one (managed keys are gated) and we render EXACTLY what it sends.
 */
const OPTION_LABEL: Record<RouteOptionId, { label: string; hint: string }> = {
  compress_harder: {
    label: "Compress harder",
    hint: "Squeeze the prompt further to stretch the remaining free-tier quota.",
  },
  switch_provider: {
    label: "Switch provider",
    hint: "Route to another healthy provider you've already keyed.",
  },
  use_local: {
    label: "Use a local model",
    hint: "Hand off to a detected local runtime at no API cost.",
  },
  wait: {
    label: "Wait for reset",
    hint: "Let the provider's free-tier quota reset before sending again.",
  },
};

function fmtResetIn(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

const BEST_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  color: "var(--color-green)",
  border: "1px solid color-mix(in oklch, var(--color-green) 35%, transparent)",
  background: "color-mix(in oklch, var(--color-green) 12%, transparent)",
};

/**
 * The per-card "why unavailable + best next action" advisor. Pulls the gateway's
 * `GET /v1/route/options` for one provider and renders its honest, no-upsell
 * reason, recommended action, alternatives, and reset window. Display-only — it
 * recommends, never bills. Renders nothing until/unless the gateway answers, so
 * an offline gateway shows no fabricated advice.
 */
export function RouteAdvisor({
  provider,
  quotaPct,
}: {
  provider: ProviderId;
  /** 0–100 remaining, or null when the gateway reports no denominator. */
  quotaPct: number | null;
}) {
  const [data, setData] = useState<RouteOptions | null>(null);

  useEffect(() => {
    let active = true;
    const quotaHint =
      typeof quotaPct === "number"
        ? Math.max(0, Math.min(1, quotaPct / 100))
        : undefined;
    void fetchRouteOptions(provider, quotaHint).then((res) => {
      if (active) setData(res);
    });
    return () => {
      active = false;
    };
  }, [provider, quotaPct]);

  if (!data) return null;

  const best = OPTION_LABEL[data.best];
  const others = data.options.filter((opt) => opt !== data.best);

  return (
    <div className="route-options" onClick={(e) => e.stopPropagation()}>
      {/* Why unavailable? — the gateway's plain-language reason. */}
      <p className="route-options-reason">{data.reason}</p>

      {/* Best next action — the single recommended move, surfaced as a chip. */}
      {best ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "8px 0 4px" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            Best next action
          </span>
          <span style={BEST_CHIP} title={best.hint}>
            {best.label}
          </span>
        </div>
      ) : null}
      {best ? (
        <p style={{ fontSize: 11, color: "var(--color-text-sub)", margin: "0 0 6px" }}>
          {best.hint}
        </p>
      ) : null}

      {/* Alternatives (only when "switch_provider" is on the table). */}
      {data.options.includes("switch_provider") &&
      data.alternatives.length > 0 ? (
        <ul className="route-options-list">
          {data.alternatives.slice(0, 3).map((alt) => (
            <li key={`${alt.provider}-${alt.model}`} className="route-option">
              <span className="route-option-label">
                {PROVIDER_BY_ID[alt.provider]?.name ?? alt.provider}
              </span>
              <span className="route-option-alts">
                {Number.isFinite(alt.estInputPer1M) && alt.estInputPer1M > 0
                  ? `~$${alt.estInputPer1M}/1M in`
                  : "free / unpriced"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Other actions the gateway offered, beyond the recommended one. */}
      {others.length > 0 ? (
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "2px 0 0" }}>
          Or:{" "}
          {others
            .map((opt) => OPTION_LABEL[opt]?.label)
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}

      {data.resetIn != null ? (
        <p className="route-options-reset">Resets in ~{fmtResetIn(data.resetIn)}</p>
      ) : data.resetReason ? (
        <p className="route-options-reset">{data.resetReason}</p>
      ) : null}
    </div>
  );
}
