"use client";

import { useEffect } from "react";
import { Icon } from "@/app/_components/Icons";
import type { CatalogModelDto } from "@/lib/gateway";
import { CapabilityChips } from "./CapabilityChips";
import {
  DATA_POLICY_LABEL,
  priceLabel,
  resolveProviderId,
  structuredOutputLabel,
} from "./format";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        borderBottom: "0.5px solid var(--c-border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
      <span style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{value}</span>
    </div>
  );
}

/**
 * Slide-over detail panel for one catalog model: full metadata + a "Use this
 * model" action (selects the provider, persists the chosen model for the chat
 * composer, navigates to /chat) and an "Add to compare" toggle. Closes on Escape
 * or backdrop click.
 */
export function ModelDetailPanel({
  model,
  selectedForCompare,
  onClose,
  onUse,
  onToggleCompare,
}: {
  model: CatalogModelDto;
  selectedForCompare: boolean;
  onClose: () => void;
  onUse: () => void;
  onToggleCompare: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const price = priceLabel(model);
  // "Use this model" needs a real ProviderId; if we can't resolve the owner the
  // action is disabled rather than silently selecting the wrong provider.
  const providerId = resolveProviderId(model.owned_by);
  const { pricing } = model;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${model.display_name} details`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        justifyContent: "flex-end",
        background: "color-mix(in oklch, black 45%, transparent)",
      }}
      onClick={onClose}
    >
      <div
        className="vault-card"
        style={{
          width: "min(440px, 100%)",
          height: "100%",
          borderRadius: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="provider-card-top" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div className="provider-card-title">{model.display_name}</div>
            <span className="provider-card-model">
              {model.owned_by} · {model.id}
            </span>
          </div>
          <button
            type="button"
            className="sidebar-thread-action"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <span
          className={`policy-badge ${model.data_policy.badge}`}
          title={model.data_policy.policy_url || model.data_policy.tag}
        >
          {DATA_POLICY_LABEL[model.data_policy.badge]}
        </span>

        <CapabilityChips model={model} />

        <div>
          <Row label="Provider" value={model.owned_by} />
          <Row label="Model id" value={model.id} />
          <Row label="Context window" value={`${model.context_window.toLocaleString()} tokens`} />
          <Row label="Price" value={price.detail ?? price.headline} />
          <Row
            label="Input / 1M"
            value={pricing.input_per_1m == null ? "unknown" : `$${pricing.input_per_1m}`}
          />
          <Row
            label="Output / 1M"
            value={pricing.output_per_1m == null ? "unknown" : `$${pricing.output_per_1m}`}
          />
          <Row label="Vision" value={model.capabilities.vision ? "Yes" : "No"} />
          <Row label="Tools" value={model.capabilities.tools ? "Yes" : "No"} />
          <Row
            label="Structured output"
            value={structuredOutputLabel(model.capabilities.structured_output)}
          />
          <Row label="Free tier" value={model.free ? "Yes" : "No"} />
          <Row label="Local" value={model.local ? "Yes" : "No"} />
          <Row label="Data policy" value={model.data_policy.tag.replace(/_/g, " ")} />
          {model.data_policy.retention ? (
            <Row label="Retention" value={model.data_policy.retention} />
          ) : null}
        </div>

        {model.data_policy.policy_url ? (
          <a
            href={model.data_policy.policy_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: "var(--color-text-muted)" }}
          >
            View provider data policy →
          </a>
        ) : null}

        <div className="actions" style={{ marginTop: "auto" }}>
          <button
            type="button"
            onClick={onUse}
            disabled={!providerId}
            title={
              providerId
                ? "Select this model and open chat"
                : "Cannot resolve this model's provider"
            }
          >
            Use this model
          </button>
          <button type="button" className="secondary" onClick={onToggleCompare}>
            {selectedForCompare ? "Remove from compare" : "Add to compare"}
          </button>
        </div>
      </div>
    </div>
  );
}
