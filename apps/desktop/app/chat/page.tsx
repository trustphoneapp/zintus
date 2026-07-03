"use client";

import { ChatPanel } from "../_components/ChatPanel";

/**
 * Chat — a single centered conversation column (the Claude-desktop pattern).
 * The 22-provider pill rail intentionally does NOT live here: the composer has
 * a provider select, and the full rail belongs on /providers.
 */
export default function ChatPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: 880,
          margin: "0 auto",
        }}
      >
        <ChatPanel />
      </div>
    </div>
  );
}
