import type { CSSProperties } from "react";
import type { CatalogModelDto } from "@/lib/gateway";
import { CapabilityChips } from "./CapabilityChips";
import {
  DATA_POLICY_LABEL,
  formatLatencyMs,
  formatThroughputTps,
  formatUptime,
  hasMeasuredStats,
  modelStats,
  priceLabel,
} from "./format";

const PRICE_TONE: Record<string, CSSProperties> = {
  free: { color: "var(--color-green)" },
  local: { color: "#2563eb" },
  unknown: { color: "var(--color-text-muted)", fontStyle: "italic" },
  priced: { color: "var(--color-text)" },
};

/**
 * One catalog model card: display name + provider, context window, capability
 * badges, an HONEST price label (Free / Local / price unknown / $/1M) and a
 * data-policy badge. Reuses the providers page `provider-card` / `policy-badge`
 * styling. Whole card opens the detail panel; the compare checkbox is isolated.
 */
export function ModelCard({
  model,
  selectedForCompare,
  onOpen,
  onToggleCompare,
}: {
  model: CatalogModelDto;
  selectedForCompare: boolean;
  onOpen: () => void;
  onToggleCompare: () => void;
}) {
  const price = priceLabel(model);
  const stats = modelStats(model);
  const measured = hasMeasuredStats(stats);
  return (
    <div
      className={`provider-card${selectedForCompare ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="provider-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="provider-card-title">
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {model.display_name}
            </span>
          </div>
          <span className="provider-card-model">{model.owned_by}</span>
        </div>
        <label
          className="provider-card-badges"
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
          title="Add to compare"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selectedForCompare}
            onChange={onToggleCompare}
            aria-label={`Compare ${model.display_name}`}
          />
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>compare</span>
        </label>
      </div>

      <span
        className={`policy-badge ${model.data_policy.badge}`}
        title={model.data_policy.policy_url || model.data_policy.tag}
      >
        {DATA_POLICY_LABEL[model.data_policy.badge]}
      </span>

      <CapabilityChips model={model} />

      <div
        style={{
          marginTop: 10,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, ...PRICE_TONE[price.tone] }}>
          {price.headline}
        </span>
        {price.detail ? (
          <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
            {price.detail}
          </span>
        ) : null}
      </div>

      <div
        className="provider-card-stats"
        title={
          measured
            ? `Measured over a recent window (${stats?.samples ?? 0} recent requests).`
            : "Not enough recent requests to measure yet."
        }
        style={{ display: "flex", flexWrap: "wrap", gap: 10 }}
      >
        {measured ? (
          <>
            <span>p95 {formatLatencyMs(stats?.latency_p95_ms ?? null)}</span>
            <span>{formatUptime(stats?.uptime ?? null)} uptime</span>
            <span>{formatThroughputTps(stats?.throughput_tps ?? null)}</span>
          </>
        ) : (
          <span>no data yet</span>
        )}
      </div>
    </div>
  );
}
