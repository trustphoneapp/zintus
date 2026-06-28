"use client";

import { useState } from "react";
import type { ChatMessageUi } from "@/lib/store";
import { CompressionBadge } from "./CompressionBadge";
import { Markdown, CodeBlock } from "./Markdown";

/** A tool/function call emitted by an assistant turn. */
export interface ToolCall {
  id: string;
  name: string;
  arguments?: unknown;
}

function formatUsd(value: number): string {
  return value < 0.01 ? `~$${value.toFixed(4)}` : `~$${value.toFixed(2)}`;
}

/** Pretty, single-line args for the compact call card. */
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
 * Renders a single chat message. Assistant messages render Markdown (parity with
 * web/mobile), show routed provider/model metadata + the compression badge, and
 * expose copy / regenerate actions. An empty assistant message shows a typing
 * indicator while the gateway response is in flight.
 *
 * Tool/function calls are passed as props. Structured (JSON) output is rendered
 * either from an explicit `structured` prop OR auto-detected when the assistant's
 * answer body is itself JSON — which is how a `response_format: json_object` turn
 * (the composer's JSON toggle) surfaces, with no fake structure ever claimed.
 */
export function MessageBubble({
  message,
  onRegenerate,
  isStreaming = false,
  toolCalls,
  structured,
}: {
  message: ChatMessageUi;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  /** Tool/function calls emitted by this assistant turn. */
  toolCalls?: ToolCall[];
  /** Structured / JSON output to render in a labeled code block. */
  structured?: unknown;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  function report() {
    // Play Gen-AI policy / Apple 1.2: an in-app way to flag offensive AI content.
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

  if (isUser) {
    const images = message.images ?? [];
    return (
      <div className="chat-bubble-user">
        {images.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: message.content ? 6 : 0 }}>
            {images.map((img, i) => (
              <span
                key={`${img.name}-${i}`}
                title={`${img.name} · ${img.width}×${img.height}${img.exifStripped ? " · EXIF stripped" : ""}`}
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                {img.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img.previewUrl}
                    alt={img.name}
                    width={120}
                    height={120}
                    style={{ maxWidth: 120, maxHeight: 120, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.18)" }}
                  />
                ) : (
                  // Object URL didn't survive (e.g. after reload): show metadata only,
                  // never base64 — the bytes are not kept in history.
                  <span style={{ fontSize: 12, opacity: 0.85 }}>🖼 {img.name}</span>
                )}
              </span>
            ))}
          </div>
        ) : null}
        {message.content}
      </div>
    );
  }

  const hasContent = Boolean(message.content);
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  // Explicit structured prop wins; otherwise auto-detect a JSON-only answer
  // (skipped mid-stream, where a partial body would never parse).
  const structuredText =
    structured !== undefined
      ? JSON.stringify(structured, null, 2)
      : !isStreaming && message.content
        ? asStructuredJson(message.content)
        : null;
  // When the answer body *itself* is JSON, render it as a code block instead of
  // forcing it through the markdown path (prose paths stay untouched).
  const contentIsJson = structured === undefined && structuredText !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {message.providerId || message.meta?.routeReason ? (
        <p
          className="chat-bubble-meta"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
        >
          {message.providerId ? (
            <span>
              {message.providerId.toUpperCase()}
              {message.model ? ` · ${message.model}` : ""}
            </span>
          ) : null}
          {message.meta?.routeReason ? (
            // The headline "why this provider/model" — the prominent route reason
            // (the rest of the transparency strip stays below). Mirrors web's
            // MessageBubble top-line treatment.
            <span
              title="Why the router chose this provider and model for this turn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "1px 7px",
                borderRadius: 999,
                fontWeight: 600,
                color: "var(--color-accent, #7C3AED)",
                background:
                  "color-mix(in oklch, var(--color-accent, #7C3AED) 14%, transparent)",
              }}
            >
              {message.meta.routeReason}
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="chat-bubble-assistant">
        {hasContent ? (
          contentIsJson && structuredText ? (
            <CodeBlock lang="json" text={structuredText} label="JSON output" />
          ) : (
            <Markdown content={message.content} />
          )
        ) : !hasToolCalls && structured === undefined ? (
          <span className="typing-dots" aria-label="Assistant is typing">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {hasToolCalls ? (
          <div
            className="tool-call-list"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: hasContent ? 8 : 0,
            }}
          >
            {toolCalls!.map((call) => (
              <ToolCallCard key={call.id} call={call} />
            ))}
          </div>
        ) : null}
        {structured !== undefined && structuredText ? (
          <div style={{ marginTop: hasContent || hasToolCalls ? 8 : 0 }}>
            <CodeBlock lang="json" text={structuredText} label="Structured output" />
          </div>
        ) : null}
      </div>
      {message.compression ? <CompressionBadge stats={message.compression} /> : null}
      {message.meta ? (
        <div className="response-meta-strip">
          {message.meta.routingStrategy ? (
            <span>via {message.meta.routingStrategy}</span>
          ) : null}
          {message.meta.latencyMs != null ? (
            <span>{message.meta.latencyMs} ms</span>
          ) : null}
          {message.meta.outputTokens != null ? (
            <span>{message.meta.outputTokens} out tok</span>
          ) : null}
          {message.meta.savedVsBaselineUsd != null &&
          message.meta.savedVsBaselineUsd > 0 ? (
            <span className="response-meta-saved">
              ≈ {formatUsd(message.meta.savedVsBaselineUsd)} vs Claude Sonnet
            </span>
          ) : null}
        </div>
      ) : null}
      {hasContent ? (
        <div className="chat-bubble-actions">
          <button type="button" className="chat-bubble-action" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
          {onRegenerate ? (
            <button type="button" className="chat-bubble-action" onClick={onRegenerate}>
              Regenerate
            </button>
          ) : null}
          <button
            type="button"
            className="chat-bubble-action"
            style={{ color: "var(--color-warn, #f59e0b)" }}
            onClick={report}
          >
            Report
          </button>
        </div>
      ) : null}
    </div>
  );
}
