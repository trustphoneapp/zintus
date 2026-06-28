"use client";

import { useEffect } from "react";
import { Icon } from "@/app/_components/Icons";
import type { CatalogModelDto } from "@/lib/gateway";
import { formatContext, priceLabel, structuredOutputLabel } from "./format";

function cell(value: React.ReactNode, on?: boolean): React.ReactNode {
  if (on === undefined) return value;
  return (
    <span style={{ color: on ? "var(--color-green)" : "var(--color-text-muted)" }}>
      {value}
    </span>
  );
}

/** Side-by-side comparison modal for 2–3 selected catalog models. */
export function CompareTable({
  models,
  onClose,
}: {
  models: CatalogModelDto[];
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: Array<{ label: string; render: (m: CatalogModelDto) => React.ReactNode }> = [
    { label: "Provider", render: (m) => m.owned_by },
    { label: "Context", render: (m) => `${formatContext(m.context_window)} (${m.context_window.toLocaleString()})` },
    { label: "Price", render: (m) => priceLabel(m).detail ?? priceLabel(m).headline },
    { label: "Input / 1M", render: (m) => (m.pricing.input_per_1m == null ? "unknown" : `$${m.pricing.input_per_1m}`) },
    { label: "Output / 1M", render: (m) => (m.pricing.output_per_1m == null ? "unknown" : `$${m.pricing.output_per_1m}`) },
    { label: "Vision", render: (m) => cell(m.capabilities.vision ? "Yes" : "No", m.capabilities.vision) },
    { label: "Tools", render: (m) => cell(m.capabilities.tools ? "Yes" : "No", m.capabilities.tools) },
    {
      label: "Structured output",
      render: (m) => cell(structuredOutputLabel(m.capabilities.structured_output), m.capabilities.structured_output !== "none"),
    },
    { label: "Free", render: (m) => cell(m.free ? "Yes" : "No", m.free) },
    { label: "Local", render: (m) => cell(m.local ? "Yes" : "No", m.local) },
    { label: "Data policy", render: (m) => m.data_policy.tag.replace(/_/g, " ") },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compare models"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "color-mix(in oklch, black 45%, transparent)",
      }}
      onClick={onClose}
    >
      <div
        className="vault-card"
        style={{
          maxWidth: 880,
          width: "100%",
          maxHeight: "85vh",
          overflow: "auto",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="provider-card-top">
          <div className="provider-card-title">Compare models</div>
          <button
            type="button"
            className="sidebar-thread-action"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px", color: "var(--color-text-muted)", fontWeight: 500 }} />
              {models.map((m) => (
                <th
                  key={m.id}
                  style={{ textAlign: "left", padding: "8px", fontWeight: 600, verticalAlign: "bottom" }}
                >
                  {m.display_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} style={{ borderTop: "0.5px solid var(--c-border)" }}>
                <td style={{ padding: "8px", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                  {row.label}
                </td>
                {models.map((m) => (
                  <td key={m.id} style={{ padding: "8px", fontFamily: "var(--font-mono)" }}>
                    {row.render(m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
