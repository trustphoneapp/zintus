"use client";

import { useState } from "react";
import type { ChatMessageUi } from "@/lib/store";
import { CompressionBadge } from "./CompressionBadge";
import { Markdown } from "./Markdown";

/**
 * Renders a single chat message. Assistant messages render Markdown (parity with
 * web/mobile), show routed provider/model metadata + the compression badge, and
 * expose copy / regenerate actions. An empty assistant message shows a typing
 * indicator while the gateway response is in flight.
 */
export function MessageBubble({
  message,
  onRegenerate,
}: {
  message: ChatMessageUi;
  onRegenerate?: () => void;
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
    if (ok) {
      window.alert("Reported — response flagged on this device.");
    }
  }

  if (isUser) {
    return <div className="chat-bubble-user">{message.content}</div>;
  }

  const hasContent = Boolean(message.content);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {message.providerId ? (
        <p className="chat-bubble-meta">
          {message.providerId.toUpperCase()}
          {message.model ? ` · ${message.model}` : ""}
        </p>
      ) : null}
      <div className="chat-bubble-assistant">
        {hasContent ? (
          <Markdown content={message.content} />
        ) : (
          <span className="typing-dots" aria-label="Assistant is typing">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      {message.compression ? <CompressionBadge stats={message.compression} /> : null}
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
