import type { CatalogModelDto } from "@/lib/gateway";
import {
  CAP_CTX,
  CAP_OFF,
  CAP_ON,
  formatContext,
  structuredOutputLabel,
  supportsJson,
} from "./format";

/**
 * OpenRouter-style capability chips for a catalog model: vision / tools / JSON
 * (green when supported, dim when not) plus a context-window chip. Same visual
 * vocabulary as the providers page's `CapabilityBadges`.
 */
export function CapabilityChips({
  model,
  showContext = true,
}: {
  model: CatalogModelDto;
  showContext?: boolean;
}) {
  const json = supportsJson(model.capabilities.structured_output);
  const items: Array<{ label: string; on: boolean; title: string }> = [
    {
      label: "Vision",
      on: model.capabilities.vision,
      title: model.capabilities.vision
        ? "Accepts image input"
        : "No image input",
    },
    {
      label: "Tools",
      on: model.capabilities.tools,
      title: model.capabilities.tools
        ? "Supports tool / function calling"
        : "No tool / function calling",
    },
    {
      label: "JSON",
      on: json,
      title: structuredOutputLabel(model.capabilities.structured_output),
    },
  ];
  return (
    <div
      className="provider-card-caps"
      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
    >
      {items.map((item) => (
        <span
          key={item.label}
          className="provider-chip"
          style={item.on ? CAP_ON : CAP_OFF}
          title={item.title}
        >
          {item.label}
        </span>
      ))}
      {showContext ? (
        <span
          className="provider-chip"
          style={CAP_CTX}
          title={`${model.context_window.toLocaleString()} token context window`}
        >
          {formatContext(model.context_window)} ctx
        </span>
      ) : null}
    </div>
  );
}
