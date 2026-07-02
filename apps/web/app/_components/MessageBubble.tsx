"use client";

import { useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { McpToolEvent } from "@/lib/gateway";
import type { UiMessage, ToolCall } from "@/lib/app-store";
import { formatImageBytes } from "@/lib/image-attachments";
import { summarizeArtifactBody, type Artifact } from "@/lib/artifacts";
import { Icon } from "./Icons";
import { CompressionBadge } from "./CompressionBadge";
import { Markdown, CodeBlock } from "./Markdown";

export type { ToolCall };

/** Strip a provider/owner suffix for a compact model label in the top line. */
function shortModel(model: string): string {
  return model.replace(/\s*\(.*\)\s*$/, "").trim();
}

/** Compact USD cost label, e.g. 0.00012 → "$0.00012", 0 → "$0". */
function fmtCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(2)}`;
}

/** Savings as a % of what the Sonnet baseline would have cost (costUsd +
 *  savedUsd), e.g. 95. Returns 0 when there's no priced baseline. */
function savedPercent(costUsd: number, savedUsd: number): number {
  const baseline = costUsd + savedUsd;
  return baseline > 0 ? Math.round((savedUsd / baseline) * 100) : 0;
}

/** Pretty, single-line args for the compact call card; multi-line for the pre. */
function formatArgs(args: unknown, pretty: boolean): string {
  let value: unknown = args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return args;
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return args;
    }
  }
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Returns a pretty-printed JSON string iff `content` is a JSON object/array. */
function asStructuredJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const args = formatArgs(call.arguments, false);
  return (
    <div
      className="tool-call-card"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: 12.5,
        lineHeight: 1.5,
        color: "#cbd5e1",
        background: "rgba(148,163,184,0.06)",
        border: "1px solid #232a36",
        borderLeft: "2px solid #6366f1",
        borderRadius: 8,
        padding: "6px 10px",
      }}
    >
      <span aria-hidden style={{ fontFamily: "system-ui, sans-serif" }}>
        🔧
      </span>
      <span style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}>
        <span style={{ color: "#a5b4fc", fontWeight: 600 }}>{call.name}</span>
        <span style={{ color: "#64748b" }}>(</span>
        {args}
        <span style={{ color: "#64748b" }}>)</span>
      </span>
    </div>
  );
}

/**
 * Server-side MCP tool-loop activity, grouped with the assistant turn that
 * triggered it. Calm + honest: each real `mcp_tool_call` becomes a "Calling
 * <tool>…" line; the paired `mcp_tool_result` (matched by id) becomes a "✓ result
 * (N chars)" or "✗ error: <message>" line. Args/results are summaries only (the
 * gateway never streamed the raw bodies — see lib/gateway.ts summarizers).
 */
function McpToolActivity({ events }: { events: McpToolEvent[] }) {
  // call id → tool label, so a result line can name the tool it belongs to.
  const labelById = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind === "call") {
      labelById.set(ev.id, ev.tool || ev.server || "tool");
    }
  }
  const lineStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "#94a3b8",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  };
  return (
    <div
      className="mcp-tool-activity"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        marginTop: 8,
        padding: "6px 10px",
        borderLeft: "2px solid #7C3AED",
        borderRadius: 8,
        background: "rgba(124,58,237,0.06)",
      }}
    >
      {events.map((ev, i) => {
        if (ev.kind === "call") {
          const label = ev.tool || ev.server || "tool";
          return (
            <div key={`c-${ev.id}-${i}`} style={lineStyle}>
              <span aria-hidden style={{ fontFamily: "system-ui, sans-serif" }}>
                🔧
              </span>{" "}
              Calling{" "}
              <span style={{ color: "#7C3AED", fontWeight: 600 }}>{label}</span>
              {ev.argsSummary ? (
                <span style={{ color: "#64748b" }}> ({ev.argsSummary})</span>
              ) : null}
              …
            </div>
          );
        }
        const label = labelById.get(ev.id);
        const prefix = label ? `${label} ` : "";
        return (
          <div key={`r-${ev.id}-${i}`} style={lineStyle}>
            {ev.ok ? (
              <span style={{ color: "#22c55e" }}>
                ✓ {prefix}result ({ev.summary})
              </span>
            ) : (
              <span style={{ color: "#f59e0b" }}>
                ✗ {prefix}error: {ev.summary}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MessageBubble({
  message,
  onRegenerate,
  isStreaming = false,
  toolCalls,
  mcpToolEvents,
  structured,
  artifacts,
  onOpenArtifact,
}: {
  message: UiMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  /** Tool/function calls emitted by this assistant turn. */
  toolCalls?: ToolCall[];
  /** Server-side MCP tool-loop activity for this assistant turn (display only). */
  mcpToolEvents?: McpToolEvent[];
  /** Structured / JSON output to render in a labeled code block. */
  structured?: unknown;
  /** Artifacts detected in this assistant turn (computed by the chat page). */
  artifacts?: Artifact[];
  /** Open the side panel to a given artifact. */
  onOpenArtifact?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const provider = message.providerId
    ? PROVIDER_BY_ID[message.providerId as ProviderId]
    : null;
  const [copied, setCopied] = useState(false);
  // The route metadata (provider/model/latency + full transparency strip) is
  // collapsed behind "details" by default, matching the design — the answer
  // leads; the receipt is one click away.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasContent = Boolean(message.content);
  const hasToolCalls = !isUser && Array.isArray(toolCalls) && toolCalls.length > 0;
  const hasMcpEvents =
    !isUser && Array.isArray(mcpToolEvents) && mcpToolEvents.length > 0;
  // Explicit structured prop wins; otherwise auto-detect a JSON-only answer
  // (skipped mid-stream, where a partial body would never parse).
  const structuredText =
    structured !== undefined
      ? JSON.stringify(structured, null, 2)
      : !isUser && !isStreaming && message.content
        ? asStructuredJson(message.content)
        : null;
  // When the answer body *itself* is JSON, render it as a code block instead of
  // forcing it through the markdown path (prose paths stay untouched).
  const contentIsJson = structured === undefined && structuredText !== null;
  // Substantial code/HTML/SVG blocks move to the side panel; the inline body
  // keeps a short reference instead of the whole block. (Markdown-document
  // artifacts stay inline — they ARE the prose.)
  const hasArtifacts = Array.isArray(artifacts) && artifacts.length > 0;
  const bodyContent =
    hasArtifacts && !contentIsJson
      ? summarizeArtifactBody(message.content, artifacts!)
      : message.content;

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (e.g. insecure context) — ignore
    }
  }

  function report() {
    // Play Gen-AI policy / Apple 1.2: an in-app way to flag offensive AI content.
    // Parity with desktop — saved on-device (same key/shape), not sent anywhere.
    const ok = window.confirm(
      "Flag this AI-generated response as offensive, unsafe, or inaccurate? " +
        "This stays on your device and helps you track problem providers.",
    );
    if (!ok) return;
    try {
      const KEY = "zintus:reported-responses.v1";
      const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[];
      list.push({
        providerId: message.providerId ?? null,
        model: message.model ?? null,
        at: Date.now(),
        excerpt: message.content.slice(0, 280),
      });
      localStorage.setItem(KEY, JSON.stringify(list));
      window.alert("Reported — flagged and saved on this device.");
    } catch {
      window.alert("Reported.");
    }
  }

  return (
    <div className={`message-row${isUser ? " user" : ""}`}>
      <div className={`message-bubble${isUser ? " user" : ""}`}>
        {message.content ? (
          <>
            {isUser ? (
              <p className="message-paragraph" style={{ whiteSpace: "pre-wrap" }}>
                {message.content}
              </p>
            ) : contentIsJson && structuredText ? (
              <CodeBlock lang="json" text={structuredText} label="JSON output" />
            ) : (
              <Markdown content={bodyContent} />
            )}
            {isStreaming ? <span className="stream-caret" aria-hidden /> : null}
          </>
        ) : !isUser ? (
          <span className="message-thinking">
            <span className="thinking-dot" aria-hidden />
            Thinking…
          </span>
        ) : null}
        {hasArtifacts && onOpenArtifact ? (
          <button
            type="button"
            className="artifact-affordance"
            onClick={() => onOpenArtifact(artifacts![0]!.id)}
            title="Open in the artifacts panel"
            style={{ marginTop: message.content ? 8 : 0 }}
          >
            <Icon name="layers" size={13} />
            {artifacts!.length} artifact{artifacts!.length === 1 ? "" : "s"} · open panel
          </button>
        ) : null}
        {hasToolCalls ? (
          <div
            className="tool-call-list"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: message.content ? 8 : 0,
            }}
          >
            {toolCalls!.map((call) => (
              <ToolCallCard key={call.id} call={call} />
            ))}
          </div>
        ) : null}
        {hasMcpEvents ? <McpToolActivity events={mcpToolEvents!} /> : null}
        {structured !== undefined && structuredText ? (
          <div style={{ marginTop: hasContent || hasToolCalls ? 8 : 0 }}>
            <CodeBlock lang="json" text={structuredText} label="Structured output" />
          </div>
        ) : null}
        {message.images && message.images.length > 0 ? (
          <div
            className="message-images"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginTop: message.content ? 8 : 0,
            }}
          >
            {message.images.map((img, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  maxWidth: 220,
                }}
              >
                {img.previewUrl ? (
                  <img
                    src={img.previewUrl}
                    alt={img.name}
                    style={{
                      maxWidth: 220,
                      maxHeight: 220,
                      width: "auto",
                      borderRadius: 8,
                      border: "1px solid #232a36",
                      objectFit: "cover",
                      display: "block",
                    }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display =
                        "none";
                    }}
                  />
                ) : null}
                <span
                  className="message-image-chip"
                  title={`${img.mimeType}${
                    img.width && img.height
                      ? ` · ${img.width}×${img.height}`
                      : ""
                  }`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: "#94a3b8",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid #232a36",
                    borderRadius: 6,
                    padding: "2px 8px",
                  }}
                >
                  <Icon name="image" size={11} />
                  {img.name} · {formatImageBytes(img.bytes)}
                  {img.exifStripped ? " · EXIF stripped" : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {/* Assistant footer: actions on the left, a "details" disclosure on the
          right that reveals the route receipt (design parity). User turns have
          no footer — just the bubble. */}
      {!isUser && hasContent ? (
        <div className="message-footer">
          <div className="message-actions">
            <button type="button" className="message-action" onClick={() => void copy()}>
              <Icon name="copy" size={13} />
              {copied ? "Copied" : "Copy"}
            </button>
            {onRegenerate ? (
              <button
                type="button"
                className="message-action"
                onClick={onRegenerate}
              >
                <Icon name="refresh" size={13} />
                Regenerate
              </button>
            ) : null}
            <button
              type="button"
              className="message-action"
              onClick={report}
              title="Flag this AI response as offensive, unsafe, or inaccurate"
            >
              Report
            </button>
          </div>
          {provider || message.meta ? (
            <button
              type="button"
              className="message-details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              <span aria-hidden>{detailsOpen ? "▾" : "▸"}</span> details
            </button>
          ) : null}
        </div>
      ) : null}

      {!isUser && detailsOpen && message.meta ? (
        (() => {
          const m = message.meta!;
          const pct = savedPercent(m.costUsd, m.savedUsd);
          const modelLabel = shortModel(message.model ?? m.model);
          return (
            <div className="message-details">
              {/* Metrics summary row — model · tokens · latency · cost · ↓saved. */}
              <div className="message-metrics">
                <span className="message-metrics-model">
                  {provider ? (
                    <span
                      className="message-provider-dot"
                      style={{ background: provider.color }}
                    />
                  ) : null}
                  {modelLabel}
                </span>
                <span className="message-metrics-nums">
                  <span>{m.inputTokens.toLocaleString()} tok</span>
                  <span className="sep">·</span>
                  <span>{m.latencyMs}ms</span>
                  <span className="sep">·</span>
                  <span>{fmtCost(m.costUsd)}</span>
                </span>
                {pct > 0 ? (
                  <span className="message-saved-pill">↓ {pct}% saved</span>
                ) : null}
              </div>

              {/* Receipt grid — the route metadata, one click away. */}
              <div className="message-details-grid">
                <span className="k">Provider</span>
                <span className="v">{provider?.name ?? m.provider}</span>
                <span className="k">Model</span>
                <span className="v mono">{message.model ?? m.model}</span>
                <span className="k">Input tokens</span>
                <span className="v mono">{m.inputTokens.toLocaleString()}</span>
                <span className="k">Output tokens</span>
                <span className="v mono">{m.outputTokens.toLocaleString()}</span>
                <span className="k">Latency</span>
                <span className="v mono">{m.latencyMs}ms</span>
                <span className="k">Cost</span>
                <span className="v mono">{fmtCost(m.costUsd)}</span>
                <span className="k">Saved vs Claude Sonnet</span>
                <span className="v mono green">{pct > 0 ? `↓ ${pct}% saved` : "—"}</span>
                <span className="k">Routing strategy</span>
                <span className="v">{m.routingStrategy}</span>
              </div>

              {m.routeReason ? (
                <p className="message-route-reason">{m.routeReason}</p>
              ) : null}
              {m.memoryUsed && m.memoryUsed.length > 0 ? (
                <p
                  className="message-route-reason"
                  title={m.memoryUsed.map((mm) => `• ${mm.content}`).join("\n")}
                >
                  {m.memoryUsed.length}{" "}
                  {m.memoryUsed.length === 1 ? "memory" : "memories"} used this turn
                  {" — background facts, not instructions"}
                </p>
              ) : null}
              {message.compression ? (
                <CompressionBadge stats={message.compression} />
              ) : null}
            </div>
          );
        })()
      ) : null}
    </div>
  );
}
