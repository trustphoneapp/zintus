"use client";

import { TerminalPane } from "../_components/TerminalPane";

export default function TerminalPage() {
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <TerminalPane />
    </div>
  );
}
