"use client";

import { useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { UiMessage } from "@/lib/app-store";
import { Icon } from "./Icons";

function renderLine(line: string, index: number) {
  if (line.startsWith("```")) {
    return null;
  }

  if (line.startsWith("- ")) {
    return (
      <div key={index} className="message-list-item">
        <span className="message-bullet">▸</span>
        <span>{line.slice(2)}</span>
      </div>
    );
  }

  if (line.trim()) {
    return (
      <p key={index} className="message-paragraph">
        {line}
      </p>
    );
  }

  return <div key={index} className="message-spacer" />;
}

export function MessageBubble({
  message,
  onRegenerate,
}: {
  message: UiMessage;
  onRegenerate?: () => void;
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
        {message.content
          ? message.content.split("\n").map((line, index) => renderLine(line, index))
          : <span className="message-thinking">Thinking…</span>}
      </div>
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
