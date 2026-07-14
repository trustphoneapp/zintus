"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A copyable terminal block, reusing the marketing `.m-terminal` styling so the
 * download page matches the homepage InstallSection. `label` is the small
 * header tag (e.g. "DOCKER"); `lines` are rendered as `$ <line>` rows and the
 * copy button writes them joined by newlines.
 */
export function CommandBlock({ label, lines }: { label: string; lines: readonly string[] }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    // Revert the check + accent tint ~1.5s after the copy.
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="m-terminal" style={{ marginTop: "0.9rem" }}>
      <div className="m-terminal-header">
        <span style={{ fontSize: 11, color: "var(--marketing-muted)", letterSpacing: "0.05em" }}>
          {label}
        </span>
        <button
          type="button"
          className={`m-terminal-copy${copied ? " copied" : ""}`}
          aria-label={`Copy ${label} commands`}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code
          style={{
            fontFamily: "var(--font-jetbrains-mono), 'JetBrains Mono', monospace",
            fontSize: "0.88rem",
            display: "block",
          }}
        >
          {lines.map((line, i) => (
            <div key={i}>
              <span style={{ color: "var(--marketing-accent)" }}>$ </span>
              <span style={{ color: "var(--marketing-text)" }}>{line}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
