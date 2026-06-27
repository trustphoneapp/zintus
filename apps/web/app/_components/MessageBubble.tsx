"use client";

import { useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { UiMessage } from "@/lib/app-store";
import { Icon } from "./Icons";
import { TransparencyStrip } from "./TransparencyStrip";
import { CompressionBadge } from "./CompressionBadge";
import { Markdown } from "./Markdown";

export function MessageBubble({
  message,
  onRegenerate,
  isStreaming = false,
}: {
  message: UiMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const provider = message.providerId
    ? PROVIDER_BY_ID[message.providerId as ProviderId]
    : null;
  const [copied, setCopied] = useState(false);
  const hasContent = Boolean(message.content);

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
      {!isUser && provider ? (
        <div className="message-meta">
          <span
            className="message-provider-dot"
            style={{ background: provider.color }}
          />
          <span>
            {provider.name.toUpperCase()} · {message.model ?? provider.name}
            {typeof message.compileTokens === "number"
              ? ` · compile ~${message.compileTokens.toLocaleString()} tok`
              : ""}
          </span>
        </div>
      ) : null}
      <div className={`message-bubble${isUser ? " user" : ""}`}>
        {message.content ? (
          <>
            {isUser ? (
              <p className="message-paragraph" style={{ whiteSpace: "pre-wrap" }}>
                {message.content}
              </p>
            ) : (
              <Markdown content={message.content} />
            )}
            {isStreaming ? <span className="stream-caret" aria-hidden /> : null}
          </>
        ) : (
          <span className="message-thinking">
            <span className="thinking-dot" aria-hidden />
            Thinking…
          </span>
        )}
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
