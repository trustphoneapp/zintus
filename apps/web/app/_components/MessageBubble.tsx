"use client";

import { useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { UiMessage, ToolCall } from "@/lib/app-store";
import { formatImageBytes } from "@/lib/image-attachments";
import { Icon } from "./Icons";
import { TransparencyStrip } from "./TransparencyStrip";
import { CompressionBadge } from "./CompressionBadge";
import { Markdown, CodeBlock } from "./Markdown";

export type { ToolCall };

/** Strip a provider/owner suffix for a compact model label in the top line. */
function shortModel(model: string): string {
  return model.replace(/\s*\(.*\)\s*$/, "").trim();
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

export function MessageBubble({
  message,
  onRegenerate,
  isStreaming = false,
  toolCalls,
  structured,
}: {
  message: UiMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  /** Tool/function calls emitted by this assistant turn. */
  toolCalls?: ToolCall[];
  /** Structured / JSON output to render in a labeled code block. */
  structured?: unknown;
}) {
  const isUser = message.role === "user";
  const provider = message.providerId
    ? PROVIDER_BY_ID[message.providerId as ProviderId]
    : null;
  const [copied, setCopied] = useState(false);
  const hasContent = Boolean(message.content);
  const hasToolCalls = !isUser && Array.isArray(toolCalls) && toolCalls.length > 0;
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
      {!isUser && (provider || message.meta) ? (
        <div className="message-meta" style={{ flexWrap: "wrap", rowGap: 4 }}>
          {provider ? (
            <span
              className="message-provider-dot"
              style={{ background: provider.color }}
            />
          ) : null}
          <span>
            {(provider?.name ?? message.providerId ?? "Assistant").toUpperCase()}
            {message.model ? ` · ${shortModel(message.model)}` : ""}
            {typeof message.compileTokens === "number"
              ? ` · compile ~${message.compileTokens.toLocaleString()} tok`
              : ""}
          </span>
          {message.meta?.routeReason ? (
            // The headline "why this provider/model" — the prominent route reason
            // (full strip with the rest of the trace stays expandable below).
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 7px",
                borderRadius: 999,
                fontWeight: 600,
                color: "var(--color-purple-light, #7C3AED)",
                background:
                  "color-mix(in oklch, var(--color-purple-light, #7C3AED) 12%, transparent)",
              }}
              title="Why the router chose this provider and model for this turn"
            >
              {message.meta.routeReason}
            </span>
          ) : null}
          {message.meta ? (
            <span style={{ opacity: 0.85 }}>· {message.meta.latencyMs}ms</span>
          ) : null}
          {message.meta?.privacyHonored === true ? (
            <span
              style={{ color: "var(--color-green, #22c55e)", fontWeight: 600 }}
              title="Private mode was on and served by a no-training provider."
            >
              · ✓ private
            </span>
          ) : message.meta?.privacyHonored === false ? (
            <span
              style={{ color: "var(--color-yellow, #f59e0b)", fontWeight: 600 }}
              title="Private mode was on, but no no-training provider was available."
            >
              · ⚠ private not honored
            </span>
          ) : null}
        </div>
      ) : null}
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
              <Markdown content={message.content} />
            )}
            {isStreaming ? <span className="stream-caret" aria-hidden /> : null}
          </>
        ) : !isUser ? (
          <span className="message-thinking">
            <span className="thinking-dot" aria-hidden />
            Thinking…
          </span>
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
      {!isUser && message.compression ? (
        <CompressionBadge stats={message.compression} />
      ) : null}
      {!isUser && message.meta ? (
        <TransparencyStrip meta={message.meta} />
      ) : null}
      <div className="message-footer">
        <span className={`message-time${isUser ? " user" : ""}`}>{message.time}</span>
        {hasContent ? (
          <div className="message-actions">
            <button type="button" className="message-action" onClick={() => void copy()}>
              <Icon name="copy" size={13} />
              {copied ? "Copied" : "Copy"}
            </button>
            {!isUser && onRegenerate ? (
              <button
                type="button"
                className="message-action"
                onClick={onRegenerate}
              >
                <Icon name="refresh" size={13} />
                Regenerate
              </button>
            ) : null}
            {!isUser ? (
              <button
                type="button"
                className="message-action"
                onClick={report}
                title="Flag this AI response as offensive, unsafe, or inaccurate"
              >
                Report
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
