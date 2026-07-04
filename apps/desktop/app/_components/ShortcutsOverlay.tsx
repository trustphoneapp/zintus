"use client";

import { useEffect, useState } from "react";

/**
 * Keyboard-shortcuts overlay (Light.dc prototype). Opened with ⌘/ (or from the
 * account popover / Settings). Lists only shortcuts the app actually handles.
 */
const ROWS: Array<[string, string]> = [
  ["New chat", "⌘N"],
  ["Command palette", "⌘K"],
  ["Search chat history", "⌘⇧F"],
  ["Send message", "⌘↵"],
  ["Settings", "⌘,"],
  ["This overlay", "⌘/"],
];

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("zintus:shortcuts", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("zintus:shortcuts", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        zIndex: 90,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          marginTop: "14vh",
          width: 460,
          maxWidth: "92vw",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 14,
          boxShadow: "var(--shadow-md)",
          padding: 22,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 12px", color: "var(--color-text)" }}>
          Keyboard shortcuts
        </h2>
        {ROWS.map(([label, keys], i) => (
          <div
            key={label}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "8px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
              fontSize: 13,
              color: "var(--color-text)",
            }}
          >
            {label}
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                background: "var(--color-elevated)",
                padding: "3px 8px",
                borderRadius: 6,
                color: "var(--color-text-sub)",
              }}
            >
              {keys}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
