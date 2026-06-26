"use client";

import { useEffect, useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import {
  fetchRouteOptions,
  type RouteOptionId,
  type RouteOptions,
} from "@/lib/gateway";

/**
 * Display labels for the gateway's BYOK-only quota-exhaustion actions. There is
 * intentionally NO paid/overflow entry: `/v1/route/options` never returns one
 * (managed keys are gated), and we render EXACTLY what it sends.
 */
const OPTION_LABEL: Record<
  RouteOptionId,
  { label: string; hint: string }
> = {
  compress_harder: {
    label: "Compress harder",
    hint: "Squeeze the prompt further to stretch the remaining free-tier quota",
  },
  switch_provider: {
    label: "Switch provider",
    hint: "Route to another healthy provider you've already keyed",
  },
  use_local: {
    label: "Use local model",
    hint: "Hand off to a detected local runtime at no API cost",
  },
  wait: {
    label: "Wait",
    hint: "Let the provider's quota reset before sending again",
  },
};

function fmtResetIn(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

/**
 * Surfaced under a provider card when its quota is low/exhausted: pulls the
 * gateway's `/v1/route/options` and renders the returned actionable choices,
 * the reason, and reset info. Display-only — it recommends, never bills.
 */
export function RouteOptionsPanel({
  provider,
  quotaPct,
}: {
  provider: ProviderId;
  quotaPct: number | null;
}) {
  const [data, setData] = useState<RouteOptions | null>(null);

  useEffect(() => {
    let active = true;
    const quotaHint =
      typeof quotaPct === "number" ? Math.max(0, Math.min(1, quotaPct / 100)) : undefined;
    void fetchRouteOptions(provider, quotaHint).then((res) => {
      if (active) setData(res);
    });
    return () => {
      active = false;
    };
  }, [provider, quotaPct]);

  if (!data || data.options.length === 0) {
    return null;
  }

  return (
    <div className="route-options" onClick={(e) => e.stopPropagation()}>
      <p className="route-options-reason">{data.reason}</p>
      <ul className="route-options-list">
        {data.options.map((opt) => {
          const meta = OPTION_LABEL[opt];
          if (!meta) return null;
          const isBest = opt === data.best;
          return (
            <li
              key={opt}
              className={`route-option${isBest ? " best" : ""}`}
              title={meta.hint}
            >
              <span className="route-option-label">{meta.label}</span>
              {isBest ? (
                <span className="route-option-tag">recommended</span>
              ) : null}
              {opt === "switch_provider" && data.alternatives.length > 0 ? (
                <span className="route-option-alts">
                  {data.alternatives
                    .slice(0, 3)
                    .map((a) => PROVIDER_BY_ID[a.provider]?.name ?? a.provider)
                    .join(", ")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.resetIn != null ? (
        <p className="route-options-reset">
          Resets in ~{fmtResetIn(data.resetIn)}
        </p>
      ) : data.resetReason ? (
        <p className="route-options-reset">{data.resetReason}</p>
      ) : null}
    </div>
  );
}
