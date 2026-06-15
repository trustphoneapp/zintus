"use client";

import { ChatPanel } from "../_components/ChatPanel";
import { ProviderRail } from "../_components/ProviderRail";

export default function ChatPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ProviderRail />
      <ChatPanel />
    </div>
  );
}
