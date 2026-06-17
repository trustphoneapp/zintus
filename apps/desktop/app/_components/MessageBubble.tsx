"use client";

import type { ChatMessageUi } from "@/lib/store";

/**
 * Renders a single chat message as a bubble. Assistant messages show routed
 * provider/model metadata; an empty assistant message renders a streaming
 * (typing) indicator while the gateway response is in flight.
 */
export function MessageBubble({ message }: { message: ChatMessageUi }) {
  const isUser = message.role === "user";

  if (isUser) {
    return <div className="chat-bubble-user">{message.content}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {message.providerId ? (
        <p className="chat-bubble-meta">
          {message.providerId.toUpperCase()}
          {message.model ? ` · ${message.model}` : ""}
        </p>
      ) : null}
      <div className="chat-bubble-assistant">
        {message.content ? (
          message.content
        ) : (
          <span className="typing-dots" aria-label="Assistant is typing">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
    </div>
  );
}
